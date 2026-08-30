import {
  allocateOldestFirst, correctionWindow, rejectSupplierPayment, supplierPaymentPosting,
} from '@sher/core-domain';
import type { SupplierPaymentRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { SupplierDueResponse, SupplierPaymentResponse } from '@sher/core-contracts';
import { Money, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { MoneyRepository } from '../money/money-repository';
import type { DocumentReversalRepository } from '../corrections/document-reversal-repository';
import { reverseMoneyDocument } from '../corrections/reverse-money-document';
import { entryModeFor } from '../notes/create-note-service';
import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from './payment-account';
import type { PurchaseRepository } from './purchase-repository';

/**
 * Paying a supplier (Phase 5, §5.9). **WRITE CLASS: B** (R-D).
 *
 * **Two buttons, one use case** (owner decision 2026-08-24). `Pay Supplier` on
 * the supplier's page is the large primary action and settles their oldest
 * bills first; `Pay this bill` on a purchase is the small secondary action and
 * is the same call with `purchaseId` set. They post the same document, the same
 * journal entry and the same allocations — the second is a narrower list of
 * bills, not a second payment engine.
 */

export interface PaySupplierCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly supplierPartyId: string;
  readonly amountMinor: number;
  readonly accountCode: string;
  readonly businessDate?: string | undefined;
  readonly note: string | null;
  /** Set by "Pay this bill"; `null` settles the oldest bills first. */
  readonly purchaseId: string | null;
}

export interface VoidSupplierPaymentCommand {
  readonly ctx: TenantContext;
  readonly paymentId: string;
  readonly version: number;
  readonly reason: string;
}

export interface CorrectSupplierPaymentCommand extends PaySupplierCommand {
  readonly paymentId: string;
  readonly version: number;
  readonly reason: string | null;
}

export interface SupplierDueCommand {

  readonly ctx: TenantContext;
  readonly supplierPartyId: string;
}

const REFUSALS: Record<SupplierPaymentRejection, string> = {
  AMOUNT_NOT_INTEGER_MINOR: 'Enter a valid amount',
  AMOUNT_NOT_POSITIVE: 'Enter an amount greater than zero',
  NOTHING_OUTSTANDING: 'Nothing is owed to this supplier right now',
  AMOUNT_EXCEEDS_OUTSTANDING: 'That is more than this supplier is owed',
};

export class PaySupplierService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly parties: PartyRepository,
    private readonly money: MoneyRepository,
    private readonly purchases: PurchaseRepository,
    private readonly reversals: DocumentReversalRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /** What the Pay Supplier dialog opens on: the debt, and the bills behind it. */
  /**
   * Cancelling a supplier payment (Phase 9.2, §2.5).
   *
   * **WRITE CLASS: T.** The money goes back into the account it left, the
   * bills it settled are owed again — the allocations are released, not
   * negated, because an allocation only ever said which bill this money was
   * pointed at — and the payment stays with its number, marked `VOIDED` and
   * carrying its reason.
   */
  async void(command: VoidSupplierPaymentCommand): Promise<void> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SUPPLIER_PAYMENT_VOID);

      await reverseMoneyDocument(
        {
          reversals: this.reversals,
          periods: this.periods,
          audit: this.audit,
          outbox: this.outbox,
          clock: this.clock,
        },
        tx,
        ctx,
        {
          documentType: 'SUPPLIER_PAYMENT',
          documentId: command.paymentId,
          expectedVersion: command.version,
          reason: command.reason,
          intent: 'VOID',
          entityType: 'supplier_payment',
          eventType: 'supplier.payment.cancelled',
        },
      );
    });
  }

  /**
   * Correcting a supplier payment (Phase 9.2, owner decisions 2026-08-30).
   *
   * Reversed and re-posted under the same number in one transaction, and
   * re-allocated oldest-first against what the supplier is owed **now** — the
   * old pointers went with the reversal, so nothing is patched.
   */
  async correct(command: CorrectSupplierPaymentCommand): Promise<void> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_PAY);

      const posted = await this.reversals.findPosted(
        tx,
        ctx,
        'SUPPLIER_PAYMENT',
        command.paymentId,
      );
      if (posted === null) throw new AppError(ErrorCode.NOT_FOUND, 'That payment was not found');

      const today = this.clock.businessDate(ctx.timezone);
      const originalDate = command.businessDate ?? posted.businessDate;
      const placement = correctionWindow(originalDate, today, await this.isOpen(tx, ctx, originalDate));
      const reason = command.reason?.trim() ?? '';
      if (placement.reasonRequired && reason === '') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          placement.entryMode === 'PRIOR_PERIOD'
            ? 'That month is closed, so this correction posts today — say why'
            : 'A correction dated in the past needs a reason',
        );
      }

      await reverseMoneyDocument(
        {
          reversals: this.reversals,
          periods: this.periods,
          audit: this.audit,
          outbox: this.outbox,
          clock: this.clock,
        },
        tx,
        ctx,
        {
          documentType: 'SUPPLIER_PAYMENT',
          documentId: command.paymentId,
          expectedVersion: command.version,
          reason: reason === '' ? 'Corrected' : reason,
          intent: 'CORRECT',
          // Both halves of a correction land on the same day (see the port).
          businessDate: placement.businessDate,
          entityType: 'supplier_payment',
          eventType: 'supplier.payment.corrected',
        },
      );

      const supplier = await this.parties.findById(tx, ctx, command.supplierPartyId);
      if (supplier === null) throw new AppError(ErrorCode.NOT_FOUND, 'Supplier not found');

      const account = await resolvePaymentAccount(
        { access: this.access, money: this.money },
        tx,
        ctx,
        command.accountCode,
        placement.businessDate,
        command.amountMinor,
      );

      const bills = await this.purchases.listOpenBills(
        tx,
        ctx,
        supplier.id,
        command.purchaseId,
      );
      const allocations = allocateOldestFirst(
        bills.map((bill) => ({
          purchaseId: bill.purchaseId,
          outstandingMinor: bill.outstandingMinor,
        })),
        command.amountMinor,
      );
      const posting = supplierPaymentPosting(account.code, supplier.id, command.amountMinor);

      const reposted = await this.purchases.repostPayment(tx, ctx, {
        id: command.paymentId,
        // The reversal bumped the version a moment ago.
        expectedVersion: command.version + 1,
        supplierPartyId: supplier.id,
        accountCode: account.code,
        amountMinor: command.amountMinor,
        note: command.note,
        sessionId: account.sessionId,
        businessDate: placement.businessDate,
        entryMode: placement.entryMode,
        correctionReason: reason === '' ? null : reason,
        originalBusinessDate: placement.originalBusinessDate,
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
        allocations: allocations.map((allocation) => ({
          id: Ulid.generate(this.clock),
          purchaseId: allocation.purchaseId,
          amountMinor: allocation.amountMinor,
        })),
      });
      if (!reposted) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this payment — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'supplier_payment',
        entityId: command.paymentId,
        action: 'UPDATE',
        before: {
          amountMinor: String(posted.amountMinor),
          businessDate: posted.businessDate,
        },
        after: {
          amountMinor: String(command.amountMinor),
          businessDate: placement.businessDate,
          entryMode: placement.entryMode,
          reason,
        },
        source: 'API',
      });
    });
  }

  /** Whether a business date's month still accepts postings (§5.14). */
  private async isOpen(tx: Tx, ctx: TenantContext, businessDate: string): Promise<boolean> {
    try {
      await this.periods.assertOpen(tx, ctx, businessDate);
      return true;
    } catch {
      return false;
    }
  }

  async due(command: SupplierDueCommand): Promise<SupplierDueResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_VIEW);

      const supplier = await this.parties.findById(tx, ctx, command.supplierPartyId);
      if (supplier === null) throw new AppError(ErrorCode.NOT_FOUND, 'Supplier not found');

      const today = this.clock.businessDate(ctx.timezone);
      const bills = await this.purchases.listOpenBills(tx, ctx, command.supplierPartyId, null);
      return {
        supplierPartyId: supplier.id,
        supplierName: supplier.name,
        outstandingMinor: bills.reduce((sum, bill) => sum + bill.outstandingMinor, 0),
        bills: bills.map((bill) => ({
          id: bill.purchaseId,
          number: bill.number,
          businessDate: bill.businessDate,
          dueDate: bill.dueDate,
          grandTotalMinor: bill.grandTotalMinor,
          dueMinor: bill.outstandingMinor,
          overdue: bill.dueDate !== null && bill.dueDate < today,
        })),
      };
    });
  }

  async pay(command: PaySupplierCommand): Promise<SupplierPaymentResponse> {
    const fingerprint = JSON.stringify([
      command.supplierPartyId,
      command.amountMinor,
      command.accountCode,
      command.businessDate ?? null,
      command.purchaseId,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_PAY);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different payment',
          );
        }
        return replay.response as SupplierPaymentResponse;
      }
      const posted = await this.purchases.findPaymentIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted);

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      await this.periods.assertOpen(tx, ctx, businessDate);
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A payment cannot be dated in the future');
      }

      const supplier = await this.parties.findById(tx, ctx, command.supplierPartyId);
      if (supplier === null) throw new AppError(ErrorCode.NOT_FOUND, 'Supplier not found');

      /*
       * The bills are read **inside the transaction**, and what is outstanding
       * is computed from them rather than from anything the dialog was showing:
       * between opening it and pressing Pay, somebody else may have settled the
       * same bill, and the allocation must be against what is true now.
       */
      const bills = await this.purchases.listOpenBills(
        tx,
        ctx,
        command.supplierPartyId,
        command.purchaseId,
      );
      if (command.purchaseId !== null && bills.length === 0) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That bill is not open for payment');
      }
      const outstandingMinor = bills.reduce((sum, bill) => sum + bill.outstandingMinor, 0);

      const rejection = rejectSupplierPayment({
        amountMinor: command.amountMinor,
        outstandingMinor,
      });
      if (rejection !== null) {
        const detail =
          rejection === 'AMOUNT_EXCEEDS_OUTSTANDING'
            ? `${REFUSALS[rejection]} — ${Money(outstandingMinor).format()}`
            : REFUSALS[rejection];
        throw new AppError(ErrorCode.VALIDATION_FAILED, detail);
      }

      const account = await resolvePaymentAccount(
        { access: this.access, money: this.money },
        tx,
        ctx,
        command.accountCode,
        businessDate,
        command.amountMinor,
      );

      const allocations = allocateOldestFirst(
        bills.map((bill) => ({
          purchaseId: bill.purchaseId,
          outstandingMinor: bill.outstandingMinor,
        })),
        command.amountMinor,
      );
      const posting = supplierPaymentPosting(account.code, supplier.id, command.amountMinor);

      const paymentId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'SUPPLIER_PAYMENT',
        Number(businessDate.slice(0, 4)),
      );

      await this.purchases.insertPayment(tx, ctx, {
        id: paymentId,
        number,
        operationId: command.operationId,
        supplierPartyId: supplier.id,
        accountCode: account.code,
        amountMinor: command.amountMinor,
        note: command.note,
        sessionId: account.sessionId,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
        allocations: allocations.map((allocation) => ({
          id: Ulid.generate(this.clock),
          purchaseId: allocation.purchaseId,
          amountMinor: allocation.amountMinor,
        })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'supplier_payment',
        entityId: paymentId,
        action: 'CREATE',
        before: { outstandingMinor: String(outstandingMinor) },
        after: {
          number,
          supplierPartyId: supplier.id,
          accountCode: account.code,
          amountMinor: String(command.amountMinor),
          businessDate,
          billCount: String(allocations.length),
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'purchase.supplier-paid',
        aggregateType: 'supplier_payment',
        aggregateId: paymentId,
        payload: { supplierPartyId: supplier.id, amountMinor: command.amountMinor },
      });

      const response = await this.detail(tx, ctx, paymentId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  private async detail(tx: Tx, ctx: TenantContext, id: string): Promise<SupplierPaymentResponse> {
    const payment = await this.purchases.findPaymentById(tx, ctx, id);
    if (payment === null) throw new AppError(ErrorCode.NOT_FOUND, 'Payment not found');
    const remaining = await this.purchases.listOpenBills(tx, ctx, payment.supplierPartyId, null);

    return {
      id: payment.id,
      number: payment.number,
      supplierPartyId: payment.supplierPartyId,
      supplierName: payment.supplierName,
      accountCode: payment.accountCode,
      accountName: await this.accountName(tx, ctx, payment.accountCode),
      amountMinor: payment.amountMinor,
      businessDate: payment.businessDate,
      note: payment.note,
      allocations: payment.allocations.map((allocation) => ({ ...allocation })),
      outstandingAfterMinor: remaining.reduce((sum, bill) => sum + bill.outstandingMinor, 0),
      createdAt: payment.createdAt.toISOString(),
      status: payment.status,
      entryMode: payment.entryMode,
      voidReason: payment.voidReason,
      version: payment.version,
    };
  }

  /** The account's own name, so a receipt says "Cash Drawer", not `CASH:01J…`. */
  private async accountName(tx: Tx, ctx: TenantContext, code: string): Promise<string> {
    const separatorAt = code.indexOf(':');
    const accountId = separatorAt === -1 ? '' : code.slice(separatorAt + 1);
    if (accountId === '') return code;
    const account = await this.money.findAccountById(tx, ctx, accountId);
    return account?.name ?? code;
  }
}
