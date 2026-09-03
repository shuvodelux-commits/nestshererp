import {
  rejectVendorPayment,
  rejectVendorReceipt,
  vendorPaymentPosting,
  vendorReceiptPosting,
} from '@sher/core-domain';
import type { VendorPaymentRejection, VendorReceiptRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  VendorMoneyDocumentResponse,
  VendorPaymentIntent,
  VendorReceiptIntent,
} from '@sher/core-contracts';
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
import { resolvePaymentAccount } from '../purchasing/payment-account';
import type { ReceiveCustomerPaymentService } from '../sales/receive-payment-service';
import type { VendorWorkspaceRepository } from './vendor-workspace-repository';

/**
 * Money between the shop and a vendor (Phase 8.3, owner decisions 2026-08-31).
 *
 * **Only two of the four things a shopkeeper can do here are written by this
 * service, and that is the point.** Settling what a vendor owes for goods
 * charged to them is an ordinary customer receipt against `AR` — the same
 * money, the same account, the same allocation oldest-first — so it is
 * *delegated* to `ReceiveCustomerPaymentService` rather than posted again here.
 * A second implementation would be a second set of allocation rules to keep in
 * step, and the first divergence would be silent.
 *
 * What is genuinely this service's own is the vendor's two private balances.
 * `VENDOR_PAYABLE` is created by the deemed purchase when a consignment item
 * sells (DR13.10) and **the supplier payment flow cannot touch it** — that flow
 * debits `AP` and allocates against purchase bills, and a consignment payable
 * has no bill. `VENDOR_ADVANCE` is money handed over before any of it sold, and
 * the refund of one.
 *
 * **The intent is always given, never inferred from the balance.** A shopkeeper
 * knows whether they are clearing a debt or paying ahead; the ledger afterwards
 * does not, and guessing would post the first advance of a season as a
 * settlement of whatever happened to be outstanding.
 */

export interface PayVendorCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly vendorPartyId: string;
  readonly intent: VendorPaymentIntent;
  readonly amountMinor: number;
  readonly accountCode: string;
  readonly note: string | null;
  readonly businessDate?: string | undefined;
}

export interface ReceiveFromVendorCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly vendorPartyId: string;
  readonly intent: VendorReceiptIntent;
  readonly amountMinor: number;
  readonly accountCode: string;
  readonly saleIds: readonly string[];
  readonly note: string | null;
  readonly businessDate?: string | undefined;
}

const PAYMENT_REFUSALS: Record<VendorPaymentRejection, string> = {
  AMOUNT_NOT_INTEGER_MINOR: 'Enter a valid amount',
  AMOUNT_NOT_POSITIVE: 'Enter how much is being paid',
  NOTHING_PAYABLE: 'This vendor is not owed anything — pay it as an advance instead',
  AMOUNT_EXCEEDS_PAYABLE: 'That is more than this vendor is owed',
};

const RECEIPT_REFUSALS: Record<VendorReceiptRejection, string> = {
  AMOUNT_NOT_INTEGER_MINOR: 'Enter a valid amount',
  AMOUNT_NOT_POSITIVE: 'Enter how much was received',
  NO_ADVANCE_HELD: 'This vendor is holding no advance to give back',
  AMOUNT_EXCEEDS_ADVANCE: 'That is more than the advance this vendor is holding',
};

export class VendorMoneyService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly workspace: VendorWorkspaceRepository,
    private readonly parties: PartyRepository,
    private readonly money: MoneyRepository,
    private readonly customerPayments: ReceiveCustomerPaymentService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /**
   * Money out: settling the consignment payable, or paying ahead of it.
   *
   * **WRITE CLASS: T.** One entry, one party, one account — and no allocation,
   * because there is nothing to allocate against. A vendor's payable is the sum
   * of their journal lines (INV-06), so the payment reduces it by existing; a
   * links table would be a second tally of the same fact.
   */
  async pay(command: PayVendorCommand): Promise<VendorMoneyDocumentResponse> {
    const fingerprint = JSON.stringify([
      command.vendorPartyId,
      command.intent,
      command.amountMinor,
      command.accountCode,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.VENDOR_PAYMENT_RECORD);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different payment',
          );
        }
        return replay.response as VendorMoneyDocumentResponse;
      }
      const posted = await this.workspace.findPaymentIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.paymentDetail(tx, ctx, posted);

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A payment cannot be dated in the future');
      }
      await this.periods.assertOpen(tx, ctx, businessDate);

      const vendor = await this.requireVendor(tx, ctx, command.vendorPartyId);

      /*
       * The balance is read **inside the transaction**, not taken from what the
       * dialog was showing: between opening it and pressing Pay, a sale of this
       * vendor's goods may have changed what is owed, and the guard has to be
       * against what is true now.
       */
      const balances = await this.workspace.accountBalances(tx, ctx, vendor.id);
      const rejection = rejectVendorPayment({
        amountMinor: command.amountMinor,
        payableMinor: balances.payableMinor,
        intent: command.intent,
      });
      if (rejection !== null) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          rejection === 'AMOUNT_EXCEEDS_PAYABLE'
            ? `${PAYMENT_REFUSALS[rejection]} — ${Money(balances.payableMinor).format()}`
            : PAYMENT_REFUSALS[rejection],
        );
      }

      const account = await resolvePaymentAccount(
        { access: this.access, money: this.money },
        tx,
        ctx,
        command.accountCode,
        businessDate,
        command.amountMinor,
      );
      const posting = vendorPaymentPosting(
        account.code,
        vendor.id,
        command.amountMinor,
        command.intent,
      );

      const paymentId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'VENDOR_PAYMENT',
        Number(businessDate.slice(0, 4)),
      );

      await this.workspace.insertPayment(tx, ctx, {
        id: paymentId,
        number,
        operationId: command.operationId,
        vendorPartyId: vendor.id,
        intent: command.intent,
        accountCode: account.code,
        amountMinor: command.amountMinor,
        note: command.note,
        sessionId: account.sessionId,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'vendor_payment',
        entityId: paymentId,
        action: 'CREATE',
        before: null,
        after: {
          vendorPartyId: vendor.id,
          intent: command.intent,
          amount: Money(command.amountMinor).format(),
          account: account.code,
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'vendor.payment.recorded',
        aggregateType: 'vendor_payment',
        aggregateId: paymentId,
        payload: {
          vendorPartyId: vendor.id,
          intent: command.intent,
          amountMinor: command.amountMinor,
        },
      });

      const response = await this.paymentDetail(tx, ctx, paymentId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * Money in from a vendor.
   *
   * `SETTLE_RECEIVABLE` is not posted here at all — goods charged to a vendor
   * created an ordinary `AR` receivable through an ordinary sale, so the money
   * settling it is an ordinary customer receipt and goes to the service that
   * owns receipts, allocations included. Only `REFUND_ADVANCE` is this
   * service's own, because only `VENDOR_ADVANCE` is the vendor's own.
   */
  async receive(command: ReceiveFromVendorCommand): Promise<VendorMoneyDocumentResponse> {
    if (command.intent === 'SETTLE_RECEIVABLE') {
      return this.settleReceivable(command);
    }
    return this.refundAdvance(command);
  }

  /** The customer receipt path, wearing the vendor's name on the way back. */
  private async settleReceivable(
    command: ReceiveFromVendorCommand,
  ): Promise<VendorMoneyDocumentResponse> {
    const receipt = await this.customerPayments.receiveVendor({
      ctx: command.ctx,
      operationId: command.operationId,
      customerPartyId: command.vendorPartyId,
      accountCode: command.accountCode,
      amountMinor: command.amountMinor,
      saleIds: command.saleIds,
      businessDate: command.businessDate,
      note: command.note,
    });

    return {
      id: receipt.id,
      number: receipt.number,
      kind: 'CUSTOMER_RECEIPT',
      intent: 'SETTLE_RECEIVABLE',
      vendorPartyId: command.vendorPartyId,
      amountMinor: receipt.amountMinor,
      accountCode: receipt.accountCode,
      accountName: receipt.accountName,
      businessDate: receipt.businessDate,
      note: command.note,
    };
  }

  private async refundAdvance(
    command: ReceiveFromVendorCommand,
  ): Promise<VendorMoneyDocumentResponse> {
    const fingerprint = JSON.stringify([
      command.vendorPartyId,
      command.intent,
      command.amountMinor,
      command.accountCode,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.VENDOR_RECEIPT_RECORD);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different receipt',
          );
        }
        return replay.response as VendorMoneyDocumentResponse;
      }
      const posted = await this.workspace.findReceiptIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.receiptDetail(tx, ctx, posted);

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A receipt cannot be dated in the future');
      }
      await this.periods.assertOpen(tx, ctx, businessDate);

      const vendor = await this.requireVendor(tx, ctx, command.vendorPartyId);
      const balances = await this.workspace.accountBalances(tx, ctx, vendor.id);
      const rejection = rejectVendorReceipt({
        amountMinor: command.amountMinor,
        advanceMinor: balances.advanceMinor,
      });
      if (rejection !== null) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          rejection === 'AMOUNT_EXCEEDS_ADVANCE'
            ? `${RECEIPT_REFUSALS[rejection]} — ${Money(balances.advanceMinor).format()}`
            : RECEIPT_REFUSALS[rejection],
        );
      }

      /*
       * No outflow argument: money is arriving. A drawer that happens to be
       * empty must never refuse a receipt, which is the same rule the customer
       * receipt path follows.
       */
      const account = await resolvePaymentAccount(
        { access: this.access, money: this.money },
        tx,
        ctx,
        command.accountCode,
        businessDate,
      );
      const posting = vendorReceiptPosting(account.code, vendor.id, command.amountMinor);

      const receiptId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'VENDOR_ADVANCE_REFUND',
        Number(businessDate.slice(0, 4)),
      );

      await this.workspace.insertReceipt(tx, ctx, {
        id: receiptId,
        number,
        operationId: command.operationId,
        vendorPartyId: vendor.id,
        intent: 'REFUND_ADVANCE',
        accountCode: account.code,
        amountMinor: command.amountMinor,
        note: command.note,
        sessionId: account.sessionId,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'vendor_receipt',
        entityId: receiptId,
        action: 'CREATE',
        before: null,
        after: {
          vendorPartyId: vendor.id,
          intent: 'REFUND_ADVANCE',
          amount: Money(command.amountMinor).format(),
          account: account.code,
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'vendor.receipt.recorded',
        aggregateType: 'vendor_receipt',
        aggregateId: receiptId,
        payload: { vendorPartyId: vendor.id, amountMinor: command.amountMinor },
      });

      const response = await this.receiptDetail(tx, ctx, receiptId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * A vendor, and actually a vendor.
   *
   * The role is checked because these two accounts belong to the vendor
   * relationship: posting `VENDOR_PAYABLE` against a party who is only a
   * customer would put a line on a ledger that has no business holding one.
   */
  private async requireVendor(
    tx: Tx,
    ctx: TenantContext,
    partyId: string,
  ): Promise<{ readonly id: string }> {
    const party = await this.parties.findById(tx, ctx, partyId);
    if (party === null) throw new AppError(ErrorCode.NOT_FOUND, 'That vendor was not found');
    if (!party.roles.includes('VENDOR')) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That party is not a vendor');
    }
    return party;
  }

  private async paymentDetail(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<VendorMoneyDocumentResponse> {
    const row = await this.workspace.findPaymentById(tx, ctx, id);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'That payment was not found');
    return {
      id: row.id,
      number: row.number,
      kind: 'VENDOR_PAYMENT',
      intent: row.intent === 'ADVANCE' ? 'ADVANCE' : 'SETTLE_PAYABLE',
      vendorPartyId: row.vendorPartyId,
      amountMinor: row.amountMinor,
      accountCode: row.accountCode,
      accountName: await this.accountName(tx, ctx, row.accountCode),
      businessDate: row.businessDate,
      note: row.note,
    };
  }

  private async receiptDetail(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<VendorMoneyDocumentResponse> {
    const row = await this.workspace.findReceiptById(tx, ctx, id);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'That receipt was not found');
    return {
      id: row.id,
      number: row.number,
      kind: 'VENDOR_RECEIPT',
      intent: 'REFUND_ADVANCE',
      vendorPartyId: row.vendorPartyId,
      amountMinor: row.amountMinor,
      accountCode: row.accountCode,
      accountName: await this.accountName(tx, ctx, row.accountCode),
      businessDate: row.businessDate,
      note: row.note,
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
