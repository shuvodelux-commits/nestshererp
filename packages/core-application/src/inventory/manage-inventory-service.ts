import {
  averageAfterReceipt, costIssue, openingStockPosting, rejectStockAdjustment,
  averageUnitCostFrom, rejectEntry, stockAdjustmentPosting, stockStatus, stockValueMinor,
  unitCostFromMoneyMinor,
} from '@sher/core-domain';
import type { AccountCode, CostLayer, StockAdjustmentReason, StockAdjustmentRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type {
  CostAdjustmentRow, InventoryLotPage, InventoryLotsQuery, InventoryOverviewResponse,
  InventoryReportQuery, InventoryValuationResponse, OpeningStockResponse,
  StockAdjustmentResponse, StockAdjustmentRow,
} from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Money, QTY_SCALE, Qty, Ulid, addDays, formatForDisplay } from '@sher/shared-utils';

import type { ProductRepository } from '../catalog/product-repository';
import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type {
  InventoryRepository, OpeningStockRecord, StockAdjustmentFilter, StockAdjustmentRecord,
} from './inventory-repository';
import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';

export interface RecordOpeningStockCommand {
  readonly ctx: TenantContext; readonly operationId: string; readonly productId: string;
  readonly qty: number; readonly businessDate?: string | undefined; readonly expiryDate: string | null;
  readonly source: string;
}

/**
 * One opening, inside a transaction the caller already owns.
 *
 * `unitCostMinor` is what §5.6 calls "opening stock with location and unit
 * cost": a shop's own record of what its shelf stock cost, which the CSV
 * carries and the product form does not. `null` means "value it at the
 * product's purchase price", which is exactly what the form does — one rule,
 * two entry points, no second valuation path.
 */
export interface OpeningStockInput {
  readonly operationId: string; readonly productId: string; readonly qty: number;
  readonly unitCostMinor: number | null; readonly businessDate?: string | undefined;
  readonly expiryDate: string | null; readonly source: string;
}

export interface AdjustStockCommand {
  readonly ctx: TenantContext; readonly operationId: string; readonly productId: string;
  readonly qtyDelta: number; readonly reason: StockAdjustmentReason; readonly note: string | null;
  readonly businessDate?: string | undefined; readonly source: string;
  /**
   * Where the value lands instead of `STOCK_ADJUSTMENT` (Phase 8, §5.19).
   *
   * Only warranty uses it, to charge a replacement given from own stock to
   * `WARRANTY_EXPENSE`. Everything else leaves it unset and posts exactly as
   * before.
   */
  readonly counterAccount?: AccountCode | undefined;
}

/** What one adjustment will do, resolved before anything is written. */
interface AdjustmentPlan {
  readonly valueMinor: number;
  readonly newLot: { readonly unitCost: number } | null;
  readonly consumptions: readonly {
    readonly lotId: string; readonly qty: number;
    readonly unitCostUsed: number; readonly closesLot: boolean;
  }[];
  readonly avgUnitCost: number;
  readonly qtyOnHandAfter: number;
}

function filterOf(query: InventoryReportQuery): StockAdjustmentFilter {
  return {
    fromDate: query.fromDate ?? null,
    toDate: query.toDate ?? null,
    productId: query.productId ?? null,
    limit: query.limit,
  };
}

/** Domain refusal → the sentence a shopkeeper reads. The rule stays in the domain. */
const ADJUSTMENT_REFUSALS: Record<StockAdjustmentRejection, string> = {
  QUANTITY_IS_ZERO: 'Enter how much to add or remove — zero changes nothing',
  QUANTITY_NOT_INTEGER_MINOR: 'Enter a valid quantity',
  UNKNOWN_REASON: 'Choose a reason for this stock change',
  NOTE_REQUIRED_FOR_OTHER: 'Write what happened — "Other" needs a note',
  ADJUSTMENT_HAS_NO_VALUE: 'This product has no cost yet, so its stock cannot be valued',
};

export interface VoidStockAdjustmentCommand {
  readonly ctx: TenantContext;
  readonly adjustmentId: string;
  readonly version: number;
  readonly reason: string;
}


export class ManageInventoryService {
  constructor(
    private readonly uow: UnitOfWork, private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore, private readonly periods: PeriodGuard,
    private readonly products: ProductRepository, private readonly inventory: InventoryRepository,
    private readonly numbering: NumberingService, private readonly audit: AuditWriter,
    private readonly outbox: Outbox, private readonly clock: Clock,
    private readonly settings: SettingsRepository,
  ) {}

  async recordOpening(command: RecordOpeningStockCommand): Promise<OpeningStockResponse> {
    const fingerprint = JSON.stringify([command.productId, command.qty, command.businessDate ?? null, command.expiryDate]);
    return this.uow.run(command.ctx, async (tx) => {
      await this.access.require(tx, command.ctx, Permission.PRODUCT_CREATE);
      const replay = await this.idempotency.find(tx, command.ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) throw new AppError(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'This operation id was already used with a different payload');
        return replay.response as OpeningStockResponse;
      }
      const permanentReplay = await this.inventory.findOpeningByOperationId(tx, command.ctx, command.operationId);
      if (permanentReplay !== null) return this.response(tx, command.ctx, permanentReplay);

      const response = await this.recordOpeningWithin(tx, command.ctx, {
        operationId: command.operationId, productId: command.productId, qty: command.qty,
        unitCostMinor: null, businessDate: command.businessDate,
        expiryDate: command.expiryDate, source: command.source,
      });
      await this.idempotency.save(tx, command.ctx, { operationId: command.operationId, requestFingerprint: fingerprint, response });
      return response;
    });
  }

  /**
   * One opening stock document, inside a transaction the **caller** owns.
   *
   * Split out for the guided CSV import (§5.6): a file posts all-or-nothing, so
   * the whole file is one transaction (R-D5) and the importer cannot call
   * `recordOpening` once per row. Every step below is the one the product form
   * runs — the same permission, the same one-opening-per-product rule, the same
   * `openingStockPosting`, the same movement, lot, journal, audit and outbox.
   * §5.6's "an import must never write balances or stock directly" is satisfied
   * by there being no other way in.
   */
  async recordOpeningWithin(tx: Tx, ctx: TenantContext, input: OpeningStockInput): Promise<OpeningStockResponse> {
    await this.access.require(tx, ctx, Permission.PRODUCT_CREATE);

    const today = this.clock.businessDate(ctx.timezone);
    const businessDate = input.businessDate ?? today;
    await this.periods.assertOpen(tx, ctx, businessDate);
    if (businessDate > today) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Opening stock date cannot be in the future');

    const product = await this.products.findById(tx, ctx, input.productId);
    if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
    if ((await this.inventory.findOpeningByProduct(tx, ctx, product.id)) !== null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Opening stock was already recorded for this product');
    }
    /*
     * A tracked product needs its date when the opening is typed by hand
     * (owner decision 2026-08-26) — the same rule a purchase now follows.
     *
     * **The CSV import is deliberately exempt.** A shop onboarding a hundred
     * products from an old paper ledger rarely has dates to hand, and a file
     * that refuses on row 300 stops the shop starting at all. Those batches
     * land undated, are badged "Missing expiry date" on the Inventory report,
     * and are filled in from the product screen as the shopkeeper works
     * through them.
     */
    if (product.tracksExpiry && input.expiryDate === null && input.source !== 'IMPORT') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter the expiry date for this opening batch');
    }
    if (!product.tracksExpiry && input.expiryDate !== null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'This product does not track expiry dates');
    }

    // The file may state what the stock actually cost; without one the product's
    // purchase price stands, exactly as it does from the form (§5.6).
    const unitCost = unitCostFromMoneyMinor(input.unitCostMinor ?? product.purchasePriceMinor);
    let posting;
    try { posting = openingStockPosting(input.qty, unitCost); }
    catch { throw new AppError(ErrorCode.VALIDATION_FAILED, 'Opening stock must have a positive quantity and value'); }

    let location = await this.inventory.findDefaultLocation(tx, ctx);
    if (location === null) location = await this.inventory.createDefaultLocation(tx, ctx, Ulid.generate(this.clock));
    const openingId = Ulid.generate(this.clock);
    const opening: OpeningStockRecord = {
      id: openingId, number: await this.numbering.allocate(tx, ctx, 'OPENING_STOCK', Number(businessDate.slice(0, 4))),
      operationId: input.operationId, productId: product.id, productName: product.name,
      locationId: location.id, locationName: location.name, qty: posting.qty,
      unitCost: posting.unitCost, valueMinor: posting.valueMinor, businessDate,
      expiryDate: input.expiryDate,
      entryMode: entryModeFor(businessDate, today), lotId: Ulid.generate(this.clock),
      movementId: Ulid.generate(this.clock), journalEntryId: Ulid.generate(this.clock),
      costStateId: Ulid.generate(this.clock),
      journalLines: posting.journal.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
    };
    await this.inventory.insertOpening(tx, ctx, opening);
    await this.audit.append(tx, ctx, { entityType: 'stock_opening', entityId: opening.id, action: 'CREATE', before: null, after: { productId: opening.productId, qty: opening.qty, valueMinor: opening.valueMinor, locationId: opening.locationId }, source: input.source });
    await this.outbox.append(tx, ctx, { eventType: 'inventory.opening-recorded', aggregateType: 'stock_opening', aggregateId: opening.id, payload: { productId: opening.productId, movementId: opening.movementId } });
    return this.response(tx, ctx, opening);
  }

  /**
   * Correct one product's stock (§5.10, §5.13). Write class T, ten steps, one
   * transaction.
   *
   * The money is deliberately **the exact change in inventory value**, not the
   * quantity multiplied by a cost and rounded separately: an increase is worth
   * what the new lot adds to the valuation, a decrease is worth what the
   * consumed lots stop contributing. Doing it the other way leaves a poisha
   * behind on every rounding boundary, and INV-05 — valuation equals the
   * `INVENTORY` account to the poisha — is precisely the invariant that would
   * fail. `STOCK_ADJUSTMENT` then absorbs exactly what `INVENTORY` moved, so
   * INV-01 and INV-05 both hold by construction rather than by a rounding line
   * somebody has to remember to post.
   */
  async adjustStock(command: AdjustStockCommand): Promise<StockAdjustmentResponse> {
    const draft = { qtyDelta: command.qtyDelta, reason: command.reason, note: command.note };
    const rejection = rejectStockAdjustment(draft);
    if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, ADJUSTMENT_REFUSALS[rejection]);

    const fingerprint = JSON.stringify([
      command.productId, command.qtyDelta, command.reason, command.note, command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      await this.access.require(tx, command.ctx, Permission.PRODUCT_EDIT);

      const replay = await this.idempotency.find(tx, command.ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'This operation id was already used with a different payload');
        }
        return replay.response as StockAdjustmentResponse;
      }
      // C10: the permanent unique index is the guarantee, not the 30-day cache.
      const posted = await this.inventory.findAdjustmentByOperationId(tx, command.ctx, command.operationId);
      if (posted !== null) return this.adjustmentResponse(tx, command.ctx, posted);

      const response = await this.adjustStockWithin(tx, command);
      await this.idempotency.save(tx, command.ctx, { operationId: command.operationId, requestFingerprint: fingerprint, response });
      return response;
    });
  }

  /**
   * Cancelling a stock adjustment (Phase 9.2, owner decision 2026-08-30).
   *
   * **WRITE CLASS: T.** The owner chose a real reversal over "post the opposite
   * adjustment": the goods go back exactly where they were, the value that left
   * `INVENTORY` returns, and the original document stays visible, struck
   * through and marked `VOIDED` with the reason — rather than two adjustments
   * sitting side by side with nothing saying one undid the other.
   *
   * **Everything is undone from what was stored**, never recomputed. An
   * adjustment cancelled a month later at today's moving average would take a
   * different value off `INVENTORY` than it put on, and the account would stop
   * equalling the valuation (INV-05).
   *
   * The one refusal is the honest one: if the stock an increase created has
   * since been sold, it is not there to take back, and the shop is told to
   * correct the shelf with another adjustment instead.
   */
  async voidAdjustment(command: VoidStockAdjustmentCommand): Promise<void> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.STOCK_ADJUSTMENT_VOID);

      if (command.reason.trim().length === 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say why this is being cancelled');
      }

      const original = await this.inventory.findAdjustmentForReversal(
        tx,
        ctx,
        command.adjustmentId,
      );
      if (original === null) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That stock change was not found');
      }
      if (original.status !== 'POSTED') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This stock change is already cancelled');
      }

      const today = this.clock.businessDate(ctx.timezone);
      // Both ends: the day the reversal posts on, and the day it belongs to.
      // The day the reversal posts on, and only that day: the document's own
      // month may be closed, and a cancellation still has to be possible.
      await this.periods.assertOpen(tx, ctx, today);

      const increase = original.qtyDelta > 0;
      if (increase && original.newLot !== null && original.newLot.qtyRemaining < original.qty) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Some of this stock has already been sold — correct the shelf with another adjustment instead',
        );
      }

      const reversalLines = original.journalLines.map((line) => ({
        id: Ulid.generate(this.clock),
        account: line.account as AccountCode,
        amountMinor: -line.amountMinor,
        partyId: line.partyId,
      }));
      if (rejectEntry({ lines: reversalLines }) !== null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This stock change cannot be reversed cleanly');
      }

      /*
       * The position after the undo, in value terms: the quantity goes back the
       * way it came and the value moves by exactly what the adjustment moved.
       * The average is then what that value comes to over that quantity — which
       * is the same arithmetic a receipt reversal uses, and keeps the cached
       * state agreeing with the lots behind it.
       */
      const qtyBefore = original.costState?.qtyOnHand ?? 0;
      const avgBefore = original.costState?.avgUnitCost ?? 0;
      const qtyAfter = increase
        ? Qty(qtyBefore).subtract(Qty(original.qty)).raw
        : Qty(qtyBefore).add(Qty(original.qty)).raw;
      const valueAfter = increase
        ? stockValueMinor(qtyBefore, avgBefore) - original.valueMinor
        : stockValueMinor(qtyBefore, avgBefore) + original.valueMinor;
      const avgAfter = averageUnitCostFrom(valueAfter, qtyAfter);

      const ok = await this.inventory.reverseAdjustment(tx, ctx, {
        adjustmentId: original.id,
        expectedVersion: command.version,
        businessDate: today,
        entryMode: entryModeFor(today, today),
        reason: command.reason.trim(),
        movementId: Ulid.generate(this.clock),
        // The mirror of what the adjustment did: an increase leaves, a decrease
        // comes back.
        direction: increase ? 'OUT' : 'IN',
        qty: original.qty,
        journalEntryId: Ulid.generate(this.clock),
        journalLines: reversalLines,
        closeLotId: increase ? (original.newLot?.id ?? null) : null,
        refills: increase
          ? []
          : original.consumptions.map((consumption) => ({
              lotId: consumption.lotId,
              qty: consumption.qty,
            })),
        costState: {
          id: original.costState?.id ?? Ulid.generate(this.clock),
          exists: original.costState !== null,
          qtyOnHand: qtyAfter,
          avgUnitCost: avgAfter,
        },
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this stock change — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'stock_adjustment',
        entityId: original.id,
        action: 'DELETE',
        before: {
          number: original.number,
          status: 'POSTED',
          qtyDelta: String(original.qtyDelta),
          valueMinor: String(original.valueMinor),
        },
        after: { number: original.number, status: 'VOIDED', reason: command.reason.trim() },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'inventory.stock-adjustment-cancelled',
        aggregateType: 'stock_adjustment',
        aggregateId: original.id,
        payload: { number: original.number, qtyDelta: original.qtyDelta },
      });
    });
  }

  /**
   * One stock change, **inside somebody else's transaction** (R-D5).
   *
   * The stock count posts a difference per product and must be all-or-nothing
   * across the whole sheet, so it cannot call `adjustStock` once per line —
   * each call would commit separately and a sheet that half-posted is the state
   * a correction must never end in. This is the same split the importer made
   * with `createWithin` and `recordOpeningWithin`, and for the same reason:
   * one writer, two entry points.
   *
   * Idempotency belongs to the caller. A form is idempotent on its own row; a
   * count is idempotent on the whole sheet.
   */
  async adjustStockWithin(tx: Tx, command: AdjustStockCommand): Promise<StockAdjustmentResponse> {
      const today = this.clock.businessDate(command.ctx.timezone);
      const businessDate = command.businessDate ?? today;
      await this.periods.assertOpen(tx, command.ctx, businessDate);
      if (businessDate > today) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A stock change cannot be dated in the future');

      const product = await this.products.findById(tx, command.ctx, command.productId);
      if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');

      const position = await this.inventory.findStockPosition(tx, command.ctx, product.id);
      const location = position ?? await this.defaultLocation(tx, command.ctx);
      const qtyOnHand = position?.qtyOnHand ?? 0;
      const avgUnitCost = position?.avgUnitCost ?? 0;
      const increase = command.qtyDelta > 0;
      const qty = Math.abs(command.qtyDelta);

      const plan = increase
        ? this.planIncrease(qty, qtyOnHand, avgUnitCost, product.purchasePriceMinor)
        : await this.planDecrease(tx, command.ctx, product.id, location.locationId, qty, qtyOnHand, avgUnitCost);

      let posting;
      try { posting = stockAdjustmentPosting(command.qtyDelta, plan.valueMinor, command.counterAccount); }
      catch { throw new AppError(ErrorCode.VALIDATION_FAILED, ADJUSTMENT_REFUSALS.ADJUSTMENT_HAS_NO_VALUE); }

      const adjustment: StockAdjustmentRecord = {
        id: Ulid.generate(this.clock),
        number: await this.numbering.allocate(tx, command.ctx, 'STOCK_ADJUSTMENT', Number(businessDate.slice(0, 4))),
        operationId: command.operationId,
        productId: product.id, productName: product.name,
        locationId: location.locationId, locationName: location.locationName,
        qtyDelta: command.qtyDelta, direction: posting.direction, qty: posting.qty,
        valueMinor: posting.valueMinor, reason: command.reason, note: command.note,
        businessDate, entryMode: entryModeFor(businessDate, today),
        movementId: Ulid.generate(this.clock),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.journal.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
        newLot: plan.newLot === null ? null : { id: Ulid.generate(this.clock), unitCost: plan.newLot.unitCost },
        consumptions: plan.consumptions.map((row) => ({ id: Ulid.generate(this.clock), ...row })),
        costState: {
          id: position?.costStateId ?? Ulid.generate(this.clock),
          exists: position !== null && position.costStateId !== null,
          avgUnitCost: plan.avgUnitCost,
          qtyOnHand: plan.qtyOnHandAfter,
        },
      };

      await this.inventory.insertAdjustment(tx, command.ctx, adjustment);
      await this.audit.append(tx, command.ctx, {
        entityType: 'stock_adjustment', entityId: adjustment.id, action: 'CREATE',
        // D4: exact before/after for a stock change, so the trail can be read
        // without recomputing anything.
        before: { qtyOnHand, valueMinor: this.positionValue(qtyOnHand, avgUnitCost) },
        after: {
          productId: adjustment.productId, qtyOnHand: plan.qtyOnHandAfter,
          qtyDelta: adjustment.qtyDelta, valueMinor: adjustment.valueMinor,
          reason: adjustment.reason,
        },
        source: command.source,
      });
      await this.outbox.append(tx, command.ctx, {
        eventType: 'inventory.stock-adjusted', aggregateType: 'stock_adjustment',
        aggregateId: adjustment.id,
        payload: { productId: adjustment.productId, movementId: adjustment.movementId },
      });

      return this.adjustmentResponse(tx, command.ctx, adjustment);
  }

  /**
   * A found unit is valued at what the shop's other units are worth, and at the
   * purchase price only when there are none to compare with — an increase has
   * no document of its own to take a cost from.
   */
  private planIncrease(qty: number, qtyOnHand: number, avgUnitCost: number, purchasePriceMinor: number): AdjustmentPlan {
    const unitCost = qtyOnHand > 0 && avgUnitCost > 0 ? avgUnitCost : unitCostFromMoneyMinor(purchasePriceMinor);
    const before = this.positionValue(qtyOnHand, avgUnitCost);
    const next = averageAfterReceipt(Math.max(qtyOnHand, 0), avgUnitCost, qty, unitCost);
    // Under AVERAGE the value that arrives is the difference the cache moves by;
    // under FIFO it is what the new lot contributes. They agree except at a
    // rounding boundary, and taking the difference is what keeps INV-05 exact.
    const valueMinor = Math.max(this.positionValue(next.qtyOnHand, next.avgUnitCost) - before, stockValueMinor(qty, unitCost));
    return {
      valueMinor,
      newLot: { unitCost },
      consumptions: [],
      avgUnitCost: next.avgUnitCost,
      qtyOnHandAfter: next.qtyOnHand,
    };
  }

  private async planDecrease(
    tx: Tx, ctx: TenantContext, productId: string, locationId: string,
    qty: number, qtyOnHand: number, avgUnitCost: number,
  ): Promise<AdjustmentPlan> {
    // §5.10: removing more than exists is refused rather than driven negative.
    // `negative_stock_policy` governs *selling* more than you have (§5.7), which
    // is a real counter situation; writing off damage that does not exist is a
    // typo, and the shopkeeper is told exactly how much is there.
    if (qty > qtyOnHand) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Only ${formatForDisplay(Math.max(qtyOnHand, 0), QTY_SCALE)} in stock — remove that much or less`,
      );
    }

    const layers = await this.inventory.listCostLayers(tx, ctx, productId, locationId);
    const issue = costIssue('FIFO', layers as readonly CostLayer[], qty, avgUnitCost, avgUnitCost, false);
    if (issue.shortageQty > 0) {
      // Cost state said the stock was there and the lots disagree — that is
      // INV-04 broken, not a user error, and guessing a cost would hide it.
      throw new AppError(ErrorCode.CONFLICT_STALE_VERSION, 'Stock lots are being changed by someone else — try again');
    }

    const remaining = new Map(layers.map((layer) => [layer.id, layer.qtyRemaining]));
    let valueMinor = 0;
    const consumptions = issue.allocations.map((allocation) => {
      const before = remaining.get(allocation.lotId) ?? 0;
      const after = Qty(before).subtract(Qty(allocation.qty)).raw;
      // Exactly what this lot stops contributing to the valuation — not the
      // allocation re-multiplied and rounded a second time.
      valueMinor += stockValueMinor(before, allocation.unitCost) - stockValueMinor(after, allocation.unitCost);
      return { lotId: allocation.lotId, qty: allocation.qty, unitCostUsed: allocation.unitCost, closesLot: after === 0 };
    });

    const qtyOnHandAfter = Qty(qtyOnHand).subtract(Qty(qty)).raw;
    return { valueMinor, newLot: null, consumptions, avgUnitCost, qtyOnHandAfter };
  }

  private positionValue(qtyOnHand: number, avgUnitCost: number): number {
    return qtyOnHand <= 0 ? 0 : stockValueMinor(qtyOnHand, avgUnitCost);
  }

  private async defaultLocation(tx: Tx, ctx: TenantContext): Promise<{ locationId: string; locationName: string }> {
    const existing = await this.inventory.findDefaultLocation(tx, ctx);
    const location = existing ?? await this.inventory.createDefaultLocation(tx, ctx, Ulid.generate(this.clock));
    return { locationId: location.id, locationName: location.name };
  }

  private async adjustmentResponse(tx: Tx, ctx: TenantContext, row: StockAdjustmentRecord): Promise<StockAdjustmentResponse> {
    const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
    const base = {
      id: row.id, number: row.number, productId: row.productId, productName: row.productName,
      locationId: row.locationId, locationName: row.locationName, qtyDelta: row.qtyDelta,
      direction: row.direction, qty: row.qty, reason: row.reason, note: row.note,
      businessDate: row.businessDate, qtyOnHandAfter: row.costState.qtyOnHand,
    };
    return showCost ? { ...base, valueMinor: row.valueMinor } : base;
  }

  /** The Damaged & Written-off section of the Inventory Report (§5.10). */
  async adjustments(ctx: TenantContext, query: InventoryReportQuery): Promise<readonly StockAdjustmentRow[]> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.PRODUCT_VIEW);
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      const rows = await this.inventory.listAdjustments(tx, ctx, filterOf(query));
      return rows.map((row) => {
        const { valueMinor, createdAt, ...base } = row;
        const visible = { ...base, createdAt: createdAt.toISOString() };
        return showCost ? { ...visible, valueMinor } : visible;
      });
    });
  }

  /** The Cost Adjustments section — why a valuation figure moved (DR13.8/DR13.9). */
  async costAdjustments(ctx: TenantContext, query: InventoryReportQuery): Promise<readonly CostAdjustmentRow[]> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.COST_VIEW);
      return this.inventory.listCostAdjustments(tx, ctx, filterOf(query));
    });
  }

  async overview(ctx: TenantContext, query?: InventoryReportQuery): Promise<InventoryOverviewResponse> {
    const filter = query === undefined
      ? { fromDate: null, toDate: null, productId: null, limit: 100 }
      : filterOf(query);
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.PRODUCT_VIEW);
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      const [stock, movements] = await Promise.all([this.inventory.listStock(tx, ctx), this.inventory.listMovements(tx, ctx, filter)]);
      return {
        stock: stock.map((row) => {
          const { avgUnitCost, ...base } = row;
          const visible = { ...base, stockStatus: stockStatus(row.qtyOnHand, row.minStockQty) };
          if (!showCost) return visible;
          return { ...visible, valueMinor: stockValueMinor(row.qtyOnHand, avgUnitCost) };
        }),
        movements: movements.map((row) => {
          const base = { ...row, createdAt: row.createdAt.toISOString() };
          return showCost ? base : withoutCost(base);
        }),
      };
    });
  }

  async opening(ctx: TenantContext, id: string): Promise<OpeningStockResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.PRODUCT_VIEW);
      const opening = await this.inventory.findOpeningById(tx, ctx, id);
      if (opening === null) throw new AppError(ErrorCode.NOT_FOUND, 'Opening stock not found');
      return this.response(tx, ctx, opening);
    });
  }

/**
   * Setting or correcting a batch's expiry date (§5.13, owner decision
   * 2026-08-26).
   *
   * Batches received while the date was optional — and every row of an imported
   * opening file — have no date, never expire and never block. This is how they
   * join the system: the shopkeeper opens the product they are already looking
   * at and fills the date in, from the same form that governs everything else
   * about that product. There is no separate expiry screen.
   *
   * `catalog.product.edit` is the gate, because this is editing what a product's
   * stock **is**, and the trail records the before and after — a date is a
   * business fact, and changing one changes which goods may be sold.
   */
  async setLotExpiry(command: {
    readonly ctx: TenantContext;
    readonly lotId: string;
    readonly expiryDate: string | null;
  }): Promise<void> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PRODUCT_EDIT);

      const lot = await this.inventory.findLotById(tx, ctx, command.lotId);
      if (lot === null) throw new AppError(ErrorCode.NOT_FOUND, 'That batch was not found');

      const product = await this.products.findById(tx, ctx, lot.productId);
      if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
      if (!product.tracksExpiry && command.expiryDate !== null) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `“${product.name}” does not track expiry dates`,
        );
      }

      const ok = await this.inventory.setLotExpiry(tx, ctx, command.lotId, command.expiryDate);
      if (!ok) throw new AppError(ErrorCode.NOT_FOUND, 'That batch was not found');

      await this.audit.append(tx, ctx, {
        entityType: 'inventory_lot',
        entityId: command.lotId,
        action: 'UPDATE',
        before: { expiryDate: lot.expiryDate ?? '' },
        after: { productId: lot.productId, expiryDate: command.expiryDate ?? '' },
        source: 'API',
      });
    });
  }

  async lots(ctx: TenantContext, query: InventoryLotsQuery): Promise<InventoryLotPage> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.INVENTORY_LOT_VIEW);
      // Absent `productId` is the Inventory Report reading every product; when
      // one is named it must exist, or a typo silently returns an empty list
      // that looks like "this product has no lots".
      if (query.productId !== undefined && (await this.products.findById(tx, ctx, query.productId)) === null) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
      }

      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      const method = await this.costingMethod(tx, ctx);
      /*
       * The window comes from the shop's setting, not from a constant: a
       * pharmacy watches ninety days ahead and a bakery two. Both dates are
       * business dates, so "expiring soon" means the same thing on the report
       * as it does at the counter.
       */
      const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
      const warnDays = Number(values.get(SettingKey.EXPIRY_WARN_DAYS) ?? '30');
      const asOf = this.clock.businessDate(ctx.timezone);
      const warnUntil = addDays(asOf, Number.isFinite(warnDays) ? warnDays : 30);

      const rows = await this.inventory.listLots(tx, ctx, {
        productId: query.productId ?? null,
        expiringOnly: query.expiringOnly ?? false,
        expiry: query.expiry ?? null,
        asOf,
        warnUntil,
        status: query.status ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
        sort: query.sort,
        direction: query.direction,
      });
      const hasMore = rows.length > query.limit;
      const pageRows = rows.slice(0, query.limit);
      const data = pageRows.map((row) => {
        const base = {
          id: row.id,
          productId: row.productId,
          productName: row.productName,
          locationId: row.locationId,
          locationName: row.locationName,
          ownerType: row.ownerType,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          sourceNumber: row.sourceNumber,
          qtyReceived: row.qtyReceived,
          qtyRemaining: row.qtyRemaining,
          expiryDate: row.expiryDate,
          status: row.status,
          businessDate: row.businessDate,
        };
        if (!showCost) return base;
        return {
          ...base,
          purchaseUnitCost: row.purchaseUnitCost,
          actualUnitCost: row.actualUnitCost,
          landedCostTotal: row.landedCostTotal,
          ...(method === 'FIFO'
            ? { valueMinor: stockValueMinor(row.qtyRemaining, row.actualUnitCost) }
            : {}),
        };
      });

      /*
       * Counted by the same query the rows come from (§2.7.I), so a filter chip
       * and the table under it can never disagree. The expired value is shown
       * only to somebody who may see cost — it is the size of a loss, which is
       * a cost figure (UI-40).
       */
      const summary = await this.inventory.expirySummary(tx, ctx, {
        productId: query.productId ?? null,
        asOf,
        warnUntil,
      });

      return {
        data,
        page: {
          nextCursor: hasMore ? pageRows.at(-1)?.id ?? null : null,
          hasMore,
        },
        valuationMethod: method,
        expiry: {
          expiredCount: summary.expiredCount,
          ...(showCost ? { expiredValueMinor: summary.expiredValueMinor } : {}),
          soonCount: summary.soonCount,
          missingCount: summary.missingCount,
          warnDays: Number.isFinite(warnDays) ? warnDays : 30,
        },
      };
    });
  }


  async valuation(ctx: TenantContext): Promise<InventoryValuationResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.COST_VIEW);
      const method = await this.costingMethod(tx, ctx);
      const [states, lots, journalAmounts] = await Promise.all([
        this.inventory.listCostStates(tx, ctx),
        this.inventory.listValuationLots(tx, ctx),
        this.inventory.listInventoryJournalAmounts(tx, ctx),
      ]);
      const fifoValues = new Map<string, ReturnType<typeof Money>>();
      for (const lot of lots) {
        const key = `${lot.productId}:${lot.locationId}`;
        const before = fifoValues.get(key) ?? Money(0);
        fifoValues.set(key, before.add(Money(stockValueMinor(lot.qtyRemaining, lot.actualUnitCost))));
      }
      const rows = states.map((state) => ({
        productId: state.productId,
        productName: state.productName,
        locationId: state.locationId,
        locationName: state.locationName,
        qtyOnHand: state.qtyOnHand,
        valueMinor: method === 'FIFO'
          ? (fifoValues.get(`${state.productId}:${state.locationId}`) ?? Money(0)).minor
          : stockValueMinor(state.qtyOnHand, state.avgUnitCost),
      }));
      const total = rows.reduce((sum, row) => sum.add(Money(row.valueMinor)), Money(0));
      const account = journalAmounts.reduce((sum, amount) => sum.add(Money(amount)), Money(0));
      const difference = total.subtract(account);
      return {
        method,
        rows,
        totalValueMinor: total.minor,
        inventoryAccountMinor: account.minor,
        differenceMinor: difference.minor,
        reconciled: difference.isZero(),
      };
    });
  }

  private async costingMethod(tx: Tx, ctx: TenantContext): Promise<'FIFO' | 'AVERAGE'> {
    const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
    return values.get(SettingKey.SALE_COSTING_METHOD) === 'AVERAGE' ? 'AVERAGE' : 'FIFO';
  }

  private async response(tx: Parameters<InventoryRepository['findDefaultLocation']>[0], ctx: TenantContext, row: OpeningStockRecord): Promise<OpeningStockResponse> {
    const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
    const base = { id: row.id, number: row.number, productId: row.productId, productName: row.productName, locationId: row.locationId, locationName: row.locationName, qty: row.qty, businessDate: row.businessDate, expiryDate: row.expiryDate };
    return showCost ? { ...base, unitCost: row.unitCost, valueMinor: row.valueMinor } : base;
  }
}

function withoutCost<T extends { readonly valueMinor?: number; readonly unitCost?: number }>(row: T): Omit<T, 'valueMinor' | 'unitCost'> {
  const { valueMinor: _value, unitCost: _cost, ...safe } = row;
  void _value;
  void _cost;
  return safe;
}

/**
 * `YYYY-MM-DD` plus a number of days, in UTC (§3.5).
 *
 * Written here rather than taken from a date library because the whole app
 * treats a business date as a string and never as a moment: the end of a warn
 * window must not depend on where the server is standing.
 */
