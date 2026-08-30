import {
  averageUnitCostFrom, purchaseReturnPosting, purchaseReturnTotals, rejectEntry,
  rejectPurchaseReturn, stockValueMinor,
} from '@sher/core-domain';
import type { AccountCode, PurchaseReturnRejection, ReturnableBillLine } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { PurchaseReturnResponse } from '@sher/core-contracts';
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
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from '../purchasing/payment-account';
import type { PurchaseReturnRepository } from './purchase-return-repository';
import { toPurchaseReturnResponse } from './purchase-return-view';

/**
 * Goods going back to a supplier (Phase 7, §5.11, §2.5).
 *
 * **WRITE CLASS: T** (R-D). One transaction: permission → idempotency → the
 * bill and its two caps → period guard → the account any money lands in → the
 * document, the goods off the shelf out of their own lot, the moving-average
 * cache and one journal entry → audit and outbox.
 *
 * **The mirror of a customer return, with two differences that matter.**
 *
 * There is no refund limit and no PIN: money is coming *toward* the shop, and
 * nothing leaves the drawer. And the second cap is the lot — a bill line whose
 * goods have since been sold cannot be sent back, because the stock is not
 * there to send. The refusal says so in those words rather than talking about
 * lots, which is not a shopkeeper's vocabulary.
 */

export interface PurchaseReturnLineInput {
  readonly purchaseLineId: string;
  readonly qty: number;
}

export interface CreatePurchaseReturnCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly purchaseId: string;
  readonly lines: readonly PurchaseReturnLineInput[];
  readonly reason: string;
  readonly note: string | null;
  readonly receivedMinor: number;
  readonly receiptAccountCode: string | null;
  readonly businessDate?: string | undefined;
  readonly backdateReason: string | null;
}

const REFUSALS: Record<PurchaseReturnRejection, string> = {
  RETURN_HAS_NO_LINES: 'Choose what is going back',
  AMOUNT_NOT_INTEGER_MINOR: 'Enter valid amounts',
  RETURN_QUANTITY_NOT_POSITIVE: 'A returned quantity must be more than zero',
  RETURN_LINE_NOT_ON_BILL: 'That item is not on this bill',
  RETURN_EXCEEDS_RECEIVED: 'More is going back than this bill brought in',
  RETURN_EXCEEDS_STOCK: 'Those goods are not on the shelf any more — they have been sold',
  RECEIVED_NEGATIVE: 'Money taken back cannot be less than zero',
  RECEIVED_EXCEEDS_RETURN: 'More money is coming back than the goods are worth',
  RETURN_HAS_NO_VALUE: 'These goods are worth nothing to return',
};

export interface VoidPurchaseReturnCommand {
  readonly ctx: TenantContext;
  readonly returnId: string;
  readonly version: number;
  readonly reason: string;
}

export class CreatePurchaseReturnService {

  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly inventory: InventoryRepository,
    private readonly money: MoneyRepository,
    private readonly returns: PurchaseReturnRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /**
   * Cancelling a return to a supplier (Phase 9.2, §2.5).
   *
   * **WRITE CLASS: T.** The goods go back into the very lot they left — so
   * their cost, their expiry and their place in the FIFO queue are the ones
   * they always had — the supplier credit is reversed, and the document stays
   * with its number, marked `VOIDED` and carrying its reason.
   *
   * The asymmetry Phase 7 recorded is undone as it was made: whatever share of
   * the transport went to `STOCK_ADJUSTMENT` when the goods left comes back out
   * of it, because the reversal is the stored entry negated rather than a fresh
   * calculation.
   */
  async void(command: VoidPurchaseReturnCommand): Promise<void> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_RETURN_VOID);
      if (command.reason.trim().length === 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say why this is being cancelled');
      }

      const original = await this.returns.findReturnForReversal(tx, ctx, command.returnId);
      if (original === null) throw new AppError(ErrorCode.NOT_FOUND, 'That return was not found');
      if (original.status !== 'POSTED') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This return has already been cancelled');
      }

      const today = this.clock.businessDate(ctx.timezone);
      // The day the reversal posts on, and only that day: the document's own
      // month may be closed, and a cancellation still has to be possible.
      await this.periods.assertOpen(tx, ctx, today);

      const reversalLines = original.journalLines.map((line) => ({
        id: Ulid.generate(this.clock),
        account: line.account as AccountCode,
        amountMinor: -line.amountMinor,
        partyId: line.partyId,
      }));
      if (rejectEntry({ lines: reversalLines }) !== null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This return cannot be reversed cleanly');
      }

      const costStates = original.costStates.map((state) => {
        const back = original.lines
          .filter((line) => line.productId === state.productId)
          .reduce(
            (totals, line) => ({
              qty: Qty(totals.qty).add(Qty(line.qty)).raw,
              valueMinor: totals.valueMinor + line.costMinor,
            }),
            { qty: 0, valueMinor: 0 },
          );
        const qtyAfter = Qty(state.qtyOnHand).add(Qty(back.qty)).raw;
        const valueAfter = stockValueMinor(state.qtyOnHand, state.avgUnitCost) + back.valueMinor;
        return {
          id: state.id,
          exists: true,
          productId: state.productId,
          locationId: state.locationId,
          qtyOnHand: qtyAfter,
          avgUnitCost: averageUnitCostFrom(valueAfter, qtyAfter),
        };
      });

      const ok = await this.returns.reversePurchaseReturn(tx, ctx, {
        returnId: original.id,
        expectedVersion: command.version,
        businessDate: today,
        entryMode: entryModeFor(today, today),
        reason: command.reason.trim(),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: reversalLines,
        lines: original.lines.map((line) => ({
          movementId: Ulid.generate(this.clock),
          productId: line.productId,
          lotId: line.lotId,
          locationId: line.locationId,
          qty: line.qty,
          costMinor: line.costMinor,
        })),
        costStates,
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this return — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'purchase_return',
        entityId: original.id,
        action: 'DELETE',
        before: { number: original.number, status: 'POSTED' },
        after: { number: original.number, status: 'VOIDED', reason: command.reason.trim() },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'purchase.return.cancelled',
        aggregateType: 'purchase_return',
        aggregateId: original.id,
        payload: { number: original.number },
      });
    });
  }

  async create(command: CreatePurchaseReturnCommand): Promise<PurchaseReturnResponse> {

    const fingerprint = JSON.stringify([
      command.purchaseId,
      command.lines,
      command.reason,
      command.receivedMinor,
      command.receiptAccountCode,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_RETURN_CREATE);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different return',
          );
        }
        return replay.response as PurchaseReturnResponse;
      }
      const posted = await this.returns.findReturnIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted);

      const bill = await this.returns.findReturnableBill(tx, ctx, command.purchaseId);
      if (bill === null) throw new AppError(ErrorCode.NOT_FOUND, 'Purchase not found');
      if (bill.status !== 'POSTED') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This bill was cancelled — there is nothing to send back against it',
        );
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      const backdateReason = await this.guardDate(tx, ctx, businessDate, today, command.backdateReason);
      if (businessDate < bill.businessDate) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A return cannot be dated before the bill it goes back on',
        );
      }

      const billed: ReturnableBillLine[] = bill.lines.map((line) => ({
        purchaseLineId: line.purchaseLineId,
        productId: line.productId,
        lotId: line.lotId,
        qtyReceived: line.qtyReceived,
        qtyReturned: line.qtyReturned,
        qtyRemainingInLot: line.qtyRemainingInLot,
        billedNetMinor: line.billedNetMinor,
        actualUnitCost: line.actualUnitCost,
      }));

      const draft = {
        lines: command.lines.map((line) => ({
          purchaseLineId: line.purchaseLineId,
          qty: line.qty,
        })),
        receivedMinor: command.receivedMinor,
      };
      const rejection = rejectPurchaseReturn(draft, billed);
      if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[rejection]);
      const totals = purchaseReturnTotals(draft, billed);

      const resolved =
        totals.receivedMinor === 0 || command.receiptAccountCode === null
          ? null
          : await resolvePaymentAccount(
              { access: this.access, money: this.money },
              tx,
              ctx,
              command.receiptAccountCode,
              businessDate,
            );
      const receiptAccount = resolved?.code ?? null;
      if (totals.receivedMinor > 0 && receiptAccount === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose where the money goes');
      }

      /*
       * The credit clears **this bill** first, and whatever is left sits as an
       * advance with the supplier. Spreading it over their other bills is what a
       * payment does; a return belongs to the bill the goods came in on.
       */
      const settledMinor = Math.min(totals.creditMinor, Math.max(bill.outstandingMinor, 0));

      const journal = purchaseReturnPosting(totals, {
        supplierPartyId: bill.supplierPartyId,
        receiptAccount,
        settledMinor,
      });

      const positions = new Map<
        string,
        { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean; locationId: string }
      >();
      const lines = [];
      let lineNo = 0;
      for (const line of totals.lines) {
        const source = bill.lines.find((row) => row.purchaseLineId === line.purchaseLineId);
        if (source === undefined) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'That item is not on this bill');
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
            qtyOnHand: Qty(position.qtyOnHand).subtract(Qty(line.qty)).raw,
          });
        }

        lineNo += 1;
        lines.push({
          id: Ulid.generate(this.clock),
          lineNo,
          purchaseLineId: line.purchaseLineId,
          productId: source.productId,
          lotId: source.lotId,
          locationId: source.locationId,
          qty: line.qty,
          valueMinor: line.valueMinor,
          costMinor: line.costMinor,
          movementId: Ulid.generate(this.clock),
        });
      }

      const returnId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'PURCHASE_RETURN',
        Number(businessDate.slice(0, 4)),
      );

      await this.returns.postPurchaseReturn(tx, ctx, {
        id: returnId,
        number,
        purchaseId: bill.purchaseId,
        supplierPartyId: bill.supplierPartyId,
        supplierName: bill.supplierName,
        locationId: bill.locationId,
        reason: command.reason,
        note: command.note,
        returnValueMinor: totals.returnValueMinor,
        inventoryMinor: totals.inventoryMinor,
        receivedMinor: totals.receivedMinor,
        creditMinor: totals.creditMinor,
        settledMinor,
        receiptAccountCode: receiptAccount,
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
          // The goods leave at what their own lot held, so the average of what
          // stays behind does not move — the same reasoning a cancelled sale
          // uses when it puts goods back.
          avgUnitCost: position.avgUnitCost,
          qtyOnHand: position.qtyOnHand,
        })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'purchase_return',
        entityId: returnId,
        action: 'CREATE',
        before: null,
        after: {
          number,
          purchaseNumber: bill.number,
          returnValueMinor: String(totals.returnValueMinor),
          receivedMinor: String(totals.receivedMinor),
          businessDate,
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'purchase.return.posted',
        aggregateType: 'purchase_return',
        aggregateId: returnId,
        payload: {
          number,
          purchaseId: bill.purchaseId,
          returnValueMinor: totals.returnValueMinor,
        },
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

  /** Today needs nothing; an earlier date needs the permission and a reason. */
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

  private async detail(tx: Tx, ctx: TenantContext, returnId: string): Promise<PurchaseReturnResponse> {
    const row = await this.returns.findReturnById(tx, ctx, returnId);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'Return not found');
    return toPurchaseReturnResponse(row);
  }
}
