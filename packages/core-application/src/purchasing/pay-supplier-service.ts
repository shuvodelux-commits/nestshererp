import { allocateOldestFirst, rejectSupplierPayment, supplierPaymentPosting } from '@sher/core-domain';
import type { SupplierPaymentRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { SupplierDueResponse, SupplierPaymentResponse } from '@sher/core-contracts';
import { Money, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { MoneyRepository } from '../money/money-repository';
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
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /** What the Pay Supplier dialog opens on: the debt, and the bills behind it. */
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
