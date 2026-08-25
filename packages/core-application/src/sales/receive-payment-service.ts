import { allocateReceipt, receiptPosting } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { CustomerReceiptResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
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

export class ReceiveCustomerPaymentService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly parties: PartyRepository,
    private readonly money: MoneyRepository,
    private readonly sales: SaleRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async receive(command: ReceiveCustomerPaymentCommand): Promise<CustomerReceiptResponse> {
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
      await this.access.require(tx, ctx, Permission.SALE_RECEIVE_PAYMENT);

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
      if (customer === null) throw new AppError(ErrorCode.NOT_FOUND, 'Customer not found');
      if (!customer.roles.includes('CUSTOMER')) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, `“${customer.name}” is not a customer`);
      }
      if (customer.isSystemReserved) {
        // The walk-in party is every guest at once. Money "received" against it
        // would sit on a balance nobody can be asked for (§5.8).
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Walk-in customers pay at the counter — there is no balance to receive against',
        );
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

  private async detail(tx: Tx, ctx: TenantContext, id: string): Promise<CustomerReceiptResponse> {
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
    };
  }
}
