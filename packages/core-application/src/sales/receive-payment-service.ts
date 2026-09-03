import { allocateReceipt, correctionWindow, receiptPosting } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { CustomerReceiptResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
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
import { resolvePaymentAccount } from '../purchasing/payment-account';
import type { SaleRepository } from './sale-repository';

/**
 * Money received from a customer against what they owe (§5.8).
 *
 * **WRITE CLASS: T** (R-D). One service, two entry points (owner decision
 * 2026-08-25): `Receive Payment` on the customer's hub settles their oldest
 * invoices first, and `Receive Payment` on one invoice is the same call with
 * that invoice named. Both allocate through the same domain function and post
 * the same entry, so the two screens can never disagree about what a payment
 * did — the identical argument that gave supplier payments one use case.
 *
 * Allocation moves no money. §5.9's "application changes allocation only" is
 * why `receipt_allocations` is a table of links: the cash side is one journal
 * entry regardless of how many invoices it happens to cover.
 */

export interface ReceiveCustomerPaymentCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly customerPartyId: string;
  readonly accountCode: string;
  readonly amountMinor: number;
  /** Empty means "oldest first, across everything they owe". */
  readonly saleIds: readonly string[];
  readonly businessDate?: string | undefined;
  readonly note: string | null;
}

export interface VoidReceiptCommand {
  readonly ctx: TenantContext;
  readonly receiptId: string;
  readonly version: number;
  readonly reason: string;
}

export interface CorrectReceiptCommand extends ReceiveCustomerPaymentCommand {
  readonly receiptId: string;
  readonly version: number;
  readonly reason: string | null;
}

export class ReceiveCustomerPaymentService {

  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly parties: PartyRepository,
    private readonly money: MoneyRepository,
    private readonly sales: SaleRepository,
    private readonly reversals: DocumentReversalRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async receive(command: ReceiveCustomerPaymentCommand): Promise<CustomerReceiptResponse> {
    return this.receiveForRole(command, Permission.SALE_RECEIVE_PAYMENT, 'CUSTOMER');
  }

  /** Vendor credit sales use the same receipt writer with vendor authority. */
  async receiveVendor(command: ReceiveCustomerPaymentCommand): Promise<CustomerReceiptResponse> {
    return this.receiveForRole(command, Permission.VENDOR_RECEIPT_RECORD, 'VENDOR');
  }

  private async receiveForRole(
    command: ReceiveCustomerPaymentCommand,
    permission: Permission,
    partyRole: 'CUSTOMER' | 'VENDOR',
  ): Promise<CustomerReceiptResponse> {
    if (!Number.isSafeInteger(command.amountMinor) || command.amountMinor <= 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter how much money was received');
    }

    const fingerprint = JSON.stringify([
      command.customerPartyId,
      command.accountCode,
      command.amountMinor,
      [...command.saleIds].sort(),
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, permission);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different receipt',
          );
        }
        return replay.response as CustomerReceiptResponse;
      }
      const posted = await this.sales.findReceiptIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted);

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      await this.periods.assertOpen(tx, ctx, businessDate);
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A receipt cannot be dated in the future');
      }

      const customer = await this.parties.findById(tx, ctx, command.customerPartyId);
      if (customer === null) throw new AppError(ErrorCode.NOT_FOUND, 'Party not found');
      if (!customer.roles.includes(partyRole)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `“${customer.name}” is not a ${partyRole.toLowerCase()}`,
        );
      }
      if (customer.isSystemReserved) {
        // The walk-in party is every guest at once. Money "received" against it
        // would sit on a balance nobody can be asked for (§5.8).
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Walk-in customers pay at the counter — there is no balance to receive against',
        );
      }
      if (!(await this.sales.lockReceivableParty(tx, ctx, customer.id))) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Party not found');
      }

      const account = await resolvePaymentAccount(
        { access: this.access, money: this.money },
        tx,
        ctx,
        command.accountCode,
        businessDate,
      );

      const invoices = await this.sales.listOpenInvoices(
        tx,
        ctx,
        customer.id,
        command.saleIds,
      );
      const { allocations, advanceMinor } = allocateReceipt(
        command.amountMinor,
        invoices.map((invoice) => ({
          saleId: invoice.id,
          outstandingMinor: invoice.outstandingMinor,
        })),
      );
      const settledMinor = command.amountMinor - advanceMinor;

      const posting = receiptPosting({
        partyId: customer.id,
        account: account.code,
        amountMinor: command.amountMinor,
        settledMinor,
      });

      const receiptId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'CUSTOMER_RECEIPT',
        Number(businessDate.slice(0, 4)),
      );

      await this.sales.insertReceipt(tx, ctx, {
        id: receiptId,
        number,
        operationId: command.operationId,
        customerPartyId: customer.id,
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
          saleId: allocation.saleId,
          amountMinor: allocation.amountMinor,
        })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'customer_receipt',
        entityId: receiptId,
        action: 'CREATE',
        before: null,
        after: {
          number,
          customerPartyId: customer.id,
          amountMinor: String(command.amountMinor),
          settledMinor: String(settledMinor),
          advanceMinor: String(advanceMinor),
          businessDate,
          invoiceCount: String(allocations.length),
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'customer.payment.received',
        aggregateType: 'customer_receipt',
        aggregateId: receiptId,
        payload: { customerPartyId: customer.id, amountMinor: command.amountMinor },
      });

      const response = await this.detail(tx, ctx, receiptId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * Cancelling a receipt (Phase 9.2, §2.5).
   *
   * **WRITE CLASS: T.** One reversing entry takes the money back out of the
   * account it went into, the allocations are released so the invoices it
   * settled are owed again, and the receipt stays with its number, marked
   * `VOIDED` and carrying the reason — which is mandatory: a customer's balance
   * going back up needs an explanation somebody can read months later.
   */
  async void(command: VoidReceiptCommand): Promise<CustomerReceiptResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.RECEIPT_VOID);

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
          documentType: 'CUSTOMER_RECEIPT',
          documentId: command.receiptId,
          expectedVersion: command.version,
          reason: command.reason,
          intent: 'VOID',
          entityType: 'customer_receipt',
          eventType: 'customer.receipt.cancelled',
        },
      );

      return this.detail(tx, ctx, command.receiptId);
    });
  }

  /**
   * Correcting a receipt — the wrong amount taken, or the wrong account
   * (Phase 9.2, owner decisions 2026-08-30).
   *
   * Reversed and re-posted under the same number in one transaction, and
   * **re-allocated from scratch**: the invoices the old figure settled were
   * released by the reversal, and the corrected amount is pointed at what the
   * customer actually owes now, oldest first, by the same domain function the
   * original receipt used.
   */
  async correct(command: CorrectReceiptCommand): Promise<CustomerReceiptResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SALE_RECEIVE_PAYMENT);

      const posted = await this.reversals.findPosted(
        tx,
        ctx,
        'CUSTOMER_RECEIPT',
        command.receiptId,
      );
      if (posted === null) throw new AppError(ErrorCode.NOT_FOUND, 'That receipt was not found');

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
          documentType: 'CUSTOMER_RECEIPT',
          documentId: command.receiptId,
          expectedVersion: command.version,
          reason: reason === '' ? 'Corrected' : reason,
          intent: 'CORRECT',
          // Both halves of a correction land on the same day (see the port).
          businessDate: placement.businessDate,
          entityType: 'customer_receipt',
          eventType: 'customer.receipt.corrected',
        },
      );

      const customer = await this.parties.findById(tx, ctx, command.customerPartyId);
      if (customer === null) throw new AppError(ErrorCode.NOT_FOUND, 'Customer not found');

      const account = await resolvePaymentAccount(
        { access: this.access, money: this.money },
        tx,
        ctx,
        command.accountCode,
        placement.businessDate,
      );

      const invoices = await this.sales.listOpenInvoices(tx, ctx, customer.id, command.saleIds);
      const { allocations, advanceMinor } = allocateReceipt(
        command.amountMinor,
        invoices.map((invoice) => ({
          saleId: invoice.id,
          outstandingMinor: invoice.outstandingMinor,
        })),
      );
      const settledMinor = command.amountMinor - advanceMinor;

      const posting = receiptPosting({
        partyId: customer.id,
        account: account.code,
        amountMinor: command.amountMinor,
        settledMinor,
      });

      const reposted = await this.sales.repostReceipt(tx, ctx, {
        id: command.receiptId,
        // The reversal bumped the version a moment ago.
        expectedVersion: command.version + 1,
        customerPartyId: customer.id,
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
          saleId: allocation.saleId,
          amountMinor: allocation.amountMinor,
        })),
      });
      if (!reposted) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this receipt — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'customer_receipt',
        entityId: command.receiptId,
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

      return this.detail(tx, ctx, command.receiptId);
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

  private async detail(
tx: Tx, ctx: TenantContext, id: string): Promise<CustomerReceiptResponse> {
    const row = await this.sales.findReceiptById(tx, ctx, id);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'Receipt not found');
    return {
      id: row.id,
      number: row.number,
      customerPartyId: row.customerPartyId,
      customerName: row.customerName,
      accountCode: row.accountCode,
      accountName: row.accountName,
      amountMinor: row.amountMinor,
      settledMinor: row.settledMinor,
      advanceMinor: row.advanceMinor,
      businessDate: row.businessDate,
      note: row.note,
      allocations: row.allocations.map((allocation) => ({
        saleId: allocation.saleId,
        saleNumber: allocation.saleNumber,
        amountMinor: allocation.amountMinor,
      })),
      status: row.status,
      entryMode: row.entryMode,
      voidReason: row.voidReason,
      version: row.version,
    };
  }
}
