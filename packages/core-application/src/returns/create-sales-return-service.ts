import { refillLots, rejectSalesReturn, salesReturnPosting, salesReturnTotals } from '@sher/core-domain';
import type { LotRefill, ReturnableLine, SalesReturnRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { SalesReturnResponse } from '@sher/core-contracts';
import { Qty, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { InventoryRepository } from '../inventory/inventory-repository';
import type { MoneyRepository } from '../money/money-repository';
import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PasswordHasher } from '../ports/password-hasher';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from '../purchasing/payment-account';
import type { SalesReturnRepository } from './sales-return-repository';
import { toSalesReturnResponse } from './sales-return-view';

/**
 * Goods coming back from a customer (Phase 7, §5.11, §2.5, owner decisions
 * 2026-08-26).
 *
 * **WRITE CLASS: T** (R-D). One transaction: permission → idempotency → the
 * invoice and its caps → period guard → refund limit (and the PIN that lifts
 * it) → the account the money comes out of → the document, the goods back into
 * their own lots, the moving-average cache and one journal entry → audit and
 * outbox. Goods accepted at the counter without the refund recorded is not half
 * a return; it is a shop that has paid twice.
 *
 * **A return is always against its invoice.** What may come back is what that
 * invoice sold minus what has already come back, valued at what the customer
 * actually paid for it and costed at what actually left the shelf. Nothing the
 * screen computed is trusted: the modal runs `salesReturnTotals` for the figures
 * the shopkeeper watches, and this service runs the same function again on the
 * invoice's own rows (DR13.12).
 *
 * **Damage is not handled here** (owner decision, 2026-08-26). The return
 * accepts the quantity the shop actually takes back and puts all of it into
 * stock; goods later found unsellable are written off through the stock
 * adjustment screen that already exists, with reason `DAMAGE`.
 */

export interface SalesReturnLineInput {
  readonly saleLineId: string;
  readonly qty: number;
}

export interface CreateSalesReturnCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly saleId: string;
  readonly lines: readonly SalesReturnLineInput[];
  readonly reason: string;
  readonly note: string | null;
  readonly refundMinor: number;
  readonly refundAccountCode: string | null;
  readonly approvalPin: string | null;
  readonly businessDate?: string | undefined;
  readonly backdateReason: string | null;
}

/** Domain refusal → the sentence a shopkeeper reads. The rule stays in the domain. */
const REFUSALS: Record<SalesReturnRejection, string> = {
  RETURN_HAS_NO_LINES: 'Choose what is coming back',
  AMOUNT_NOT_INTEGER_MINOR: 'Enter valid amounts',
  RETURN_QUANTITY_NOT_POSITIVE: 'A returned quantity must be more than zero',
  RETURN_LINE_NOT_ON_INVOICE: 'That item is not on this invoice',
  RETURN_EXCEEDS_SOLD: 'More is coming back than this invoice sold',
  REFUND_NEGATIVE: 'A refund cannot be less than zero',
  REFUND_EXCEEDS_RETURN: 'The refund is more than the goods coming back are worth',
  RETURN_HAS_NO_VALUE: 'These goods are worth nothing to return',
};

export class CreateSalesReturnService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly inventory: InventoryRepository,
    private readonly money: MoneyRepository,
    private readonly returns: SalesReturnRepository,
    private readonly numbering: NumberingService,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async create(command: CreateSalesReturnCommand): Promise<SalesReturnResponse> {
    const fingerprint = JSON.stringify([
      command.saleId,
      command.lines,
      command.reason,
      command.refundMinor,
      command.refundAccountCode,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SALES_RETURN_CREATE);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different return',
          );
        }
        return replay.response as SalesReturnResponse;
      }
      const posted = await this.returns.findReturnIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted);

      const invoice = await this.returns.findReturnableInvoice(tx, ctx, command.saleId);
      if (invoice === null) throw new AppError(ErrorCode.NOT_FOUND, 'Invoice not found');
      if (invoice.status === 'VOIDED') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This invoice was cancelled — there is nothing to return against it',
        );
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      const backdateReason = await this.guardDate(tx, ctx, businessDate, today, command.backdateReason);
      if (businessDate < invoice.businessDate) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A return cannot be dated before the sale it comes back from',
        );
      }

      /*
       * Consignment lines are shown on the modal and refused here: the goods
       * were never the shop's stock (INV-04), so there is no lot of its own to
       * put them back into and no COGS of its own to unwind.
       */
      const own = invoice.lines.filter((line) => line.source === 'OWN_STOCK');
      const sold: ReturnableLine[] = own.map((line) => ({
        saleLineId: line.saleLineId,
        productId: line.productId,
        qtySold: line.qtySold,
        qtyReturned: line.qtyReturned,
        netAmountMinor: line.netAmountMinor,
        costMinor: line.costMinor,
      }));

      const draft = {
        lines: command.lines.map((line) => ({ saleLineId: line.saleLineId, qty: line.qty })),
        refundMinor: command.refundMinor,
      };
      const rejection = rejectSalesReturn(draft, sold);
      if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[rejection]);
      const totals = salesReturnTotals(draft, sold);

      const approvedBy = await this.approveRefund(tx, ctx, totals.refundMinor, businessDate, command.approvalPin);

      /*
       * Resolved before anything is written, so a drawer nobody opened stops the
       * refund at the counter rather than after the goods are back on the shelf.
       * The refusal carries `CASH_DAY_NOT_STARTED`, exactly as a sale's does.
       */
      const resolved =
        totals.refundMinor === 0 || command.refundAccountCode === null
          ? null
          : await resolvePaymentAccount(
              { access: this.access, money: this.money },
              tx,
              ctx,
              command.refundAccountCode,
              businessDate,
            );
      const refundAccount = resolved?.code ?? null;
      if (totals.refundMinor > 0 && refundAccount === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose where the refund comes from');
      }

      /*
       * The credit clears **this invoice** first and whatever is left becomes an
       * advance. Spreading it across the customer's other invoices is what a
       * receipt does; a return belongs to the bill it came off, and a shopkeeper
       * asked why an old invoice changed would have no answer.
       */
      const settledMinor = Math.min(totals.creditMinor, Math.max(invoice.dueMinor, 0));

      const journal = salesReturnPosting(totals, {
        partyId: invoice.partyId,
        refundAccount,
        settledMinor,
      });

      const consumptions = await this.returns.lineConsumptions(tx, ctx, invoice.saleId);
      const already = await this.returns.refillsSoFar(tx, ctx, invoice.saleId);

      const positions = new Map<
        string,
        { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean; locationId: string }
      >();
      const lines = [];
      let lineNo = 0;
      for (const line of totals.lines) {
        const source = own.find((row) => row.saleLineId === line.saleLineId);
        if (source === undefined) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'That item is not on this invoice');
        }

        if (!positions.has(source.productId)) {
          const stored = await this.inventory.findStockPosition(tx, ctx, source.productId);
          positions.set(source.productId, {
            qtyOnHand: stored?.qtyOnHand ?? 0,
            avgUnitCost: stored?.avgUnitCost ?? 0,
            costStateId: stored?.costStateId ?? Ulid.generate(this.clock),
            exists: stored?.costStateId !== null && stored?.costStateId !== undefined,
            locationId: stored?.locationId ?? source.locationId,
          });
        }
        const position = positions.get(source.productId);
        if (position !== undefined) {
          positions.set(source.productId, {
            ...position,
            qtyOnHand: Qty(position.qtyOnHand).add(Qty(line.qty)).raw,
          });
        }

        const refills: readonly LotRefill[] = refillLots(
          line.qty,
          consumptions
            .filter((row) => row.saleLineId === line.saleLineId)
            .map((row) => ({ lotId: row.lotId, qty: row.qty, unitCostUsed: row.unitCostUsed })),
          already
            .filter((row) => row.saleLineId === line.saleLineId)
            .map((row) => ({ lotId: row.lotId, qty: row.qty, unitCostUsed: 0 })),
        );

        lineNo += 1;
        lines.push({
          id: Ulid.generate(this.clock),
          lineNo,
          saleLineId: line.saleLineId,
          productId: source.productId,
          locationId: source.locationId,
          qty: line.qty,
          valueMinor: line.valueMinor,
          costMinor: line.costMinor,
          movementId: Ulid.generate(this.clock),
          refills,
        });
      }

      const returnId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'SALES_RETURN',
        Number(businessDate.slice(0, 4)),
      );

      await this.returns.postSalesReturn(tx, ctx, {
        id: returnId,
        number,
        saleId: invoice.saleId,
        partyId: invoice.partyId,
        customerName: invoice.customerName,
        locationId: invoice.locationId,
        reason: command.reason,
        note: command.note,
        returnValueMinor: totals.returnValueMinor,
        refundMinor: totals.refundMinor,
        creditMinor: totals.creditMinor,
        settledMinor,
        cogsMinor: totals.returnCostMinor,
        refundAccountCode: refundAccount,
        approvedBy,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        backdateReason,
        operationId: command.operationId,
        lines,
        journalEntryId: Ulid.generate(this.clock),
        journalLines: journal.lines.map((line) => ({
          id: Ulid.generate(this.clock),
          account: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
        costStates: [...positions].map(([productId, position]) => ({
          id: position.costStateId,
          exists: position.exists,
          productId,
          locationId: position.locationId,
          // The goods go back at the cost they left at, so the average they were
          // part of is the average they rejoin — the same reasoning that keeps a
          // cancelled sale from moving anybody's cost.
          avgUnitCost: position.avgUnitCost,
          qtyOnHand: position.qtyOnHand,
        })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'sales_return',
        entityId: returnId,
        action: 'CREATE',
        before: null,
        after: {
          number,
          saleNumber: invoice.number,
          returnValueMinor: String(totals.returnValueMinor),
          refundMinor: String(totals.refundMinor),
          approvedBy: approvedBy ?? '',
          businessDate,
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'sales.return.posted',
        aggregateType: 'sales_return',
        aggregateId: returnId,
        payload: { number, saleId: invoice.saleId, returnValueMinor: totals.returnValueMinor },
      });

      const response = await this.detail(tx, ctx, returnId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * The business date this return posts on (§5.19, owner decision 2026-08-26).
   *
   * Today needs nothing. An earlier date needs `period.backdate` **and** a
   * reason, and must fall in a period still open. A later date is refused
   * outright: a shop cannot take goods back tomorrow.
   */
  private async guardDate(
    tx: Tx,
    ctx: TenantContext,
    businessDate: string,
    today: string,
    reason: string | null,
  ): Promise<string | null> {
    if (businessDate > today) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A return cannot be dated in the future');
    }
    if (businessDate !== today) {
      await this.access.require(tx, ctx, Permission.PERIOD_BACKDATE);
      if (reason === null || reason.trim() === '') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Say why this return is being entered on an earlier date',
        );
      }
    }
    await this.periods.assertOpen(tx, ctx, businessDate);
    return businessDate === today ? null : reason;
  }

  /**
   * The refund caps, and the PIN that lifts them (owner decision 2026-08-26).
   *
   * Two caps on the caller's role: one refund, and everything they have refunded
   * today. Over either, somebody whose own role allows the amount types their
   * PIN and their name is stored on the return — the counter keeps working when
   * the owner is out, and nothing leaves the drawer unaccounted for. `null` is
   * unlimited; `0` is a role that may take returns and never open the drawer.
   */
  private async approveRefund(
    tx: Tx,
    ctx: TenantContext,
    refundMinor: number,
    businessDate: string,
    pin: string | null,
  ): Promise<string | null> {
    if (refundMinor === 0) return null;

    const caps = await this.returns.refundCapsOf(tx, ctx, ctx.userId);
    const usedToday = await this.returns.cashRefundedToday(tx, ctx, ctx.userId, businessDate);
    const overPerReturn = caps.perReturnMinor !== null && refundMinor > caps.perReturnMinor;
    const overPerDay = caps.perDayMinor !== null && usedToday + refundMinor > caps.perDayMinor;
    if (!overPerReturn && !overPerDay) return null;

    if (pin === null) {
      throw new AppError(
        ErrorCode.APPROVAL_REQUIRED,
        overPerReturn
          ? 'This refund is more than you may hand back — ask a manager to approve it'
          : 'You have already refunded your limit for today — ask a manager to approve it',
      );
    }

    const candidates = await this.returns.approvalCandidates(tx, ctx, refundMinor, businessDate);
    for (const candidate of candidates) {
      if (await this.hasher.verify(pin, candidate.pinHash)) return candidate.userId;
    }
    // Deliberately one message for a wrong PIN and for a PIN belonging to
    // somebody who could not approve this much: telling them apart would let
    // anyone at the counter map out who holds which limit.
    throw new AppError(ErrorCode.APPROVAL_REQUIRED, 'That PIN cannot approve this refund');
  }

  private async detail(tx: Tx, ctx: TenantContext, returnId: string): Promise<SalesReturnResponse> {
    const row = await this.returns.findReturnById(tx, ctx, returnId);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'Return not found');
    return toSalesReturnResponse(row);
  }
}
