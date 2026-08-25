import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { StockCountResponse } from '@sher/core-contracts';
import { Qty, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { InventoryRepository } from './inventory-repository';
import type { ManageInventoryService } from './manage-inventory-service';
import type { NewStockCount, StockCountRepository } from './stock-count-repository';

/**
 * Counting the shelf against the system (§5.13, owner decisions 2026-08-26).
 *
 * **WRITE CLASS: T** (R-D). The whole sheet is one transaction: a count that
 * half-posted would leave a shop believing it had counted things it had not.
 *
 * **It posts no stock of its own.** Every difference goes through
 * `adjustStockWithin` — the same use case the Stock Adjustment dialog calls —
 * so a counted shortage consumes lots at their own cost and a counted surplus
 * enters at the product's current average, exactly as a typed adjustment does.
 * §5.13 forbids a reconciliation writing stock directly, and INV-01…INV-05
 * would break the moment it did.
 *
 * **The difference is recomputed at posting time** (owner decision). A count
 * takes an hour and the shop keeps selling; the sheet carries what the system
 * said when each line was counted, and anything that moved since is refused
 * with the list of products to recount. The books then match the shelf as it is
 * now, and nobody is silently corrected for a sale that really happened.
 */

export interface CountLineInput {
  readonly productId: string;
  /** What the shelf held, scale 3. */
  readonly countedQty: number;
  /** What the system said when this line was counted, scale 3. */
  readonly systemQty: number;
}

export interface PostStockCountCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly scopeLabel: string;
  readonly note: string | null;
  readonly lines: readonly CountLineInput[];
  readonly businessDate?: string | undefined;
  readonly backdateReason: string | null;
  /**
   * Post anyway, taking the live quantity as the new baseline for products that
   * moved while the sheet was open. The screen only offers this after showing
   * which products they were.
   */
  readonly acceptMoved: boolean;
}

export class StockCountService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly inventory: InventoryRepository,
    private readonly adjustments: ManageInventoryService,
    private readonly counts: StockCountRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async post(command: PostStockCountCommand): Promise<StockCountResponse> {
    const fingerprint = JSON.stringify([command.lines, command.businessDate ?? null]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.STOCK_COUNT_POST);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different count',
          );
        }
        return replay.response as StockCountResponse;
      }
      const posted = await this.counts.findCountIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted);

      if (command.lines.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Count something before posting');
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      const backdateReason = await this.guardDate(
        tx,
        ctx,
        businessDate,
        today,
        command.backdateReason,
      );

      /*
       * Live stock, read now — not what the sheet was drawn with. A product that
       * moved since it was counted is named rather than silently corrected: the
       * shopkeeper recounts it, or accepts the live figure as the baseline.
       */
      const moved: string[] = [];
      const planned = [];
      for (const line of command.lines) {
        const position = await this.inventory.findStockPosition(tx, ctx, line.productId);
        const liveQty = position?.qtyOnHand ?? 0;
        if (liveQty !== line.systemQty) moved.push(line.productId);
        planned.push({
          productId: line.productId,
          countedQty: Qty(line.countedQty).raw,
          systemQty: line.systemQty,
          postedSystemQty: liveQty,
          qtyDelta: Qty(line.countedQty).subtract(Qty(liveQty)).raw,
        });
      }

      if (moved.length > 0 && !command.acceptMoved) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Some of these products moved while you were counting — recount them, or post against what the system says now',
          { movedProductIds: moved.join(',') },
        );
      }

      const countId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'STOCK_COUNT',
        Number(businessDate.slice(0, 4)),
      );

      let shortageValueMinor = 0;
      let surplusValueMinor = 0;
      const lines = [];
      let lineNo = 0;
      for (const line of planned) {
        lineNo += 1;
        if (line.qtyDelta === 0) {
          // Recorded, but nothing posted: a sheet that kept only its differences
          // could not answer "was this product counted at all".
          lines.push({
            id: Ulid.generate(this.clock),
            lineNo,
            ...line,
            valueMinor: 0,
            adjustmentId: null,
          });
          continue;
        }

        const adjustment = await this.adjustments.adjustStockWithin(tx, {
          ctx,
          // The adjustment's own idempotency is the count's: the sheet is one
          // operation, and its lines are not retried separately.
          operationId: Ulid.generate(this.clock),
          productId: line.productId,
          qtyDelta: line.qtyDelta,
          reason: 'RECOUNT',
          note: `${number}${command.note === null ? '' : ` — ${command.note}`}`,
          businessDate,
          source: 'API',
        });

        const valueMinor = adjustment.valueMinor ?? 0;
        if (line.qtyDelta < 0) shortageValueMinor += Math.abs(valueMinor);
        else surplusValueMinor += Math.abs(valueMinor);

        lines.push({
          id: Ulid.generate(this.clock),
          lineNo,
          ...line,
          valueMinor: Math.abs(valueMinor),
          adjustmentId: adjustment.id,
        });
      }

      const draft: NewStockCount = {
        id: countId,
        number,
        locationId: (await this.inventory.findStockPosition(tx, ctx, planned[0]?.productId ?? ''))
          ?.locationId ?? (await this.defaultLocationId(tx, ctx)),
        scopeLabel: command.scopeLabel,
        note: command.note,
        lineCount: lines.length,
        differenceCount: lines.filter((line) => line.qtyDelta !== 0).length,
        shortageValueMinor,
        surplusValueMinor,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        backdateReason,
        operationId: command.operationId,
        lines,
      };
      await this.counts.insertCount(tx, ctx, draft);

      await this.audit.append(tx, ctx, {
        entityType: 'stock_count',
        entityId: countId,
        action: 'CREATE',
        before: null,
        after: {
          number,
          lineCount: String(draft.lineCount),
          differenceCount: String(draft.differenceCount),
          shortageValueMinor: String(shortageValueMinor),
          surplusValueMinor: String(surplusValueMinor),
          businessDate,
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'inventory.count-posted',
        aggregateType: 'stock_count',
        aggregateId: countId,
        payload: { number, differenceCount: draft.differenceCount },
      });

      const response = await this.detail(tx, ctx, countId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /** Past sheets, newest first — what a shop checks a recount against. */
  async list(ctx: TenantContext, limit: number): Promise<readonly StockCountResponse[]> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.STOCK_COUNT_POST);
      const rows = await this.counts.listCounts(tx, ctx, limit);
      return rows.map((row) => ({
        id: row.id,
        number: row.number,
        scopeLabel: row.scopeLabel,
        note: row.note,
        businessDate: row.businessDate,
        lineCount: row.lineCount,
        differenceCount: row.differenceCount,
        shortageValueMinor: row.shortageValueMinor,
        surplusValueMinor: row.surplusValueMinor,
        createdAt: row.createdAt.toISOString(),
        lines: row.lines.map((line) => ({
          id: line.id,
          productId: line.productId,
          productName: line.productName,
          unitName: line.unitName,
          countedQty: line.countedQty,
          systemQty: line.postedSystemQty,
          qtyDelta: line.qtyDelta,
          valueMinor: line.valueMinor,
        })),
      }));
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
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A count cannot be dated in the future');
    }
    if (businessDate !== today) {
      await this.access.require(tx, ctx, Permission.PERIOD_BACKDATE);
      if (reason === null || reason.trim() === '') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Say why this count is being entered on an earlier date',
        );
      }
    }
    await this.periods.assertOpen(tx, ctx, businessDate);
    return businessDate === today ? null : reason;
  }

  private async defaultLocationId(tx: Tx, ctx: TenantContext): Promise<string> {
    const location = await this.inventory.findDefaultLocation(tx, ctx);
    if (location === null) throw new AppError(ErrorCode.INTERNAL_ERROR, 'This shop has no store');
    return location.id;
  }

  private async detail(tx: Tx, ctx: TenantContext, countId: string): Promise<StockCountResponse> {
    const row = await this.counts.findCountById(tx, ctx, countId);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'Count not found');
    return {
      id: row.id,
      number: row.number,
      scopeLabel: row.scopeLabel,
      note: row.note,
      businessDate: row.businessDate,
      lineCount: row.lineCount,
      differenceCount: row.differenceCount,
      shortageValueMinor: row.shortageValueMinor,
      surplusValueMinor: row.surplusValueMinor,
      createdAt: row.createdAt.toISOString(),
      lines: row.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        productName: line.productName,
        unitName: line.unitName,
        countedQty: line.countedQty,
        systemQty: line.postedSystemQty,
        qtyDelta: line.qtyDelta,
        valueMinor: line.valueMinor,
      })),
    };
  }
}
