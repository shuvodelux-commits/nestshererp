import {
  allocateBudget,
  expectedSalesMinor,
  investmentMinor,
  planTotals,
  suggestFor,
} from '@sher/core-domain';
import type { PlanLineForBudget, PlanParams, PlanProduct } from '@sher/core-domain';
import { Permission, SettingKey } from '@sher/core-contracts';
import type { PlannerResponse, PlannerRowResponse } from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { PlannerProductRow, PurchasePlanRepository } from './purchase-plan-repository';

/**
 * What the shop should buy, worked out fresh every time the screen opens
 * (§5.9, owner decisions 2026-08-26).
 *
 * **WRITE CLASS: none.** This reads. It creates no document and posts nothing;
 * saving what it suggests is `PurchasePlanService`, and buying what was saved
 * is the ordinary purchase use case.
 *
 * **The arithmetic lives in `core-domain`** — the hybrid suggestion, the
 * priority bands, the budget run and the totals are all pure functions there,
 * called from here with data read once. The Vue screen calls the same functions
 * on the same numbers so a figure never changes meaning between the two, which
 * is what lets the planner recompute instantly as the shopkeeper types without
 * inventing a second set of rules.
 */
export interface PlannerQueryCommand {
  readonly ctx: TenantContext;
  readonly lookBackDays?: number | undefined;
  readonly coverDays?: number | undefined;
  readonly budgetMinor?: number | undefined;
  readonly supplierPartyId?: string | undefined;
  readonly search?: string | undefined;
  readonly needsOnly?: boolean | undefined;
  readonly limit: number;
}

export class PlannerService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly plans: PurchasePlanRepository,
    private readonly settings: SettingsRepository,
  ) {}

  async plan(command: PlannerQueryCommand): Promise<PlannerResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_PLAN_VIEW);
      const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);

      const params = await this.paramsFor(tx, ctx, command);

      const products = await this.plans.readPlannerProducts(tx, ctx, {
        lookBackDays: params.lookBackDays,
        supplierPartyId: command.supplierPartyId,
        search: command.search,
        limit: command.limit,
      });

      const suggestions = products.map((row) => ({
        row,
        suggestion: suggestFor(toPlanProduct(row), params),
      }));

      /*
       * A budget only ever reorders and trims what was already suggested, so it
       * runs over the same list rather than a second query. Without one, every
       * planned quantity is simply the suggestion — which is also why the rows
       * come back ranked either way: the order is the shop's buying order, not
       * a display preference.
       */
      const forBudget: PlanLineForBudget[] = suggestions.map(({ row, suggestion }) => ({
        productId: row.productId,
        priority: suggestion.priority,
        wantedQty: suggestion.suggestedQty,
        unitCostMinor: row.unitCostMinor,
        sellingPriceMinor: row.sellingPriceMinor,
        packQty: row.packQty,
        minOrderQty: row.minOrderQty,
      }));
      const budget = allocateBudget(forBudget, command.budgetMinor ?? null);
      const fundedBy = new Map(budget.lines.map((line) => [line.productId, line]));

      const ranked = [...suggestions].sort(
        (a, b) =>
          indexOf(budget.lines, a.row.productId) - indexOf(budget.lines, b.row.productId),
      );

      const rows: PlannerRowResponse[] = [];
      for (const { row, suggestion } of ranked) {
        const funded = fundedBy.get(row.productId);
        const plannedQty = funded?.fundedQty ?? suggestion.suggestedQty;

        // "Needs only" hides what is comfortable, which is most of a catalogue.
        // A line the budget zeroed still needs buying, so it stays.
        if (command.needsOnly === true && suggestion.suggestedQty <= 0) continue;

        const supplier = supplierFor(row);
        rows.push({
          productId: row.productId,
          displayName: row.displayName,
          unitName: row.unitName,
          supplierPartyId: supplier.id,
          supplierName: supplier.name,
          supplierSource: supplier.source,
          stockQty: row.stockQty,
          minStockQty: row.minStockQty,
          soldQty: row.soldQty,
          sellingDays: row.sellingDays,
          dailySalesQty: suggestion.dailySalesQty,
          coverDays: suggestion.coverDays,
          pendingQty: row.pendingQty,
          priority: suggestion.priority,
          suggestedQty: suggestion.suggestedQty,
          plannedQty,
          partlyFunded: funded?.partlyFunded ?? false,
          fromHistory: suggestion.fromHistory,
          packQty: row.packQty,
          minOrderQty: row.minOrderQty,
          ...(showMoney
            ? {
                unitCostMinor: row.unitCostMinor,
                sellingPriceMinor: row.sellingPriceMinor,
                investmentMinor: investmentMinor(plannedQty, row.unitCostMinor),
                expectedProfitMinor:
                  expectedSalesMinor(plannedQty, row.sellingPriceMinor) -
                  investmentMinor(plannedQty, row.unitCostMinor),
              }
            : {}),
        });
      }

      /*
       * The totals are omitted entirely without cost permission (UI-40, R-E8) —
       * absent from the body, not blanked. A response that ships the shop's
       * investment figure to a screen that hides it is the leak that rule
       * exists to catch.
       */
      const totals = showMoney
        ? planTotals(
            rows.map((row) => ({
              qty: row.plannedQty,
              unitCostMinor: row.unitCostMinor ?? 0,
              sellingPriceMinor: row.sellingPriceMinor ?? 0,
            })),
          )
        : null;

      return {
        data: rows,
        lookBackDays: params.lookBackDays,
        coverDays: params.coverDays,
        lineCount: rows.length,
        ...(totals === null
          ? {}
          : {
              totals: {
                ...totals,
                budgetMinor: command.budgetMinor ?? null,
                unusedBudgetMinor:
                  command.budgetMinor === undefined ? null : budget.remainingMinor,
              },
            }),
      };
    });
  }

  /**
   * The shop's normal way of buying, unless this trip is different.
   *
   * Settings hold the defaults and the screen may override them for one plan
   * (owner decision 2026-08-26), which is why the request wins when it sends a
   * value and the stored setting fills in when it does not.
   */
  private async paramsFor(
    tx: Tx,
    ctx: TenantContext,
    command: PlannerQueryCommand,
  ): Promise<PlanParams> {
    const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
    return {
      lookBackDays:
        command.lookBackDays ?? numberSetting(values, SettingKey.PLANNER_LOOK_BACK_DAYS, 30),
      coverDays: command.coverDays ?? numberSetting(values, SettingKey.PLANNER_COVER_DAYS, 30),
    };
  }
}

function numberSetting(
  values: ReadonlyMap<string, string>,
  key: string,
  fallback: number,
): number {
  const parsed = Number(values.get(key));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function toPlanProduct(row: PlannerProductRow): PlanProduct {
  return {
    productId: row.productId,
    stockQty: row.stockQty,
    soldQty: row.soldQty,
    sellingDays: row.sellingDays,
    pendingQty: row.pendingQty,
    minStockQty: row.minStockQty,
    packQty: row.packQty,
    minOrderQty: row.minOrderQty,
    unitCostMinor: row.unitCostMinor,
    sellingPriceMinor: row.sellingPriceMinor,
  };
}

/**
 * Who to send this product's order to (owner decision 2026-08-26).
 *
 * The box on the product form wins; a blank one falls back to the supplier the
 * shop has most often bought it from recently — not merely the last, because
 * one emergency purchase from a substitute would otherwise move the product
 * onto the wrong supplier's order until it was bought again.
 */
export function supplierFor(row: PlannerProductRow): {
  readonly id: string | null;
  readonly name: string | null;
  readonly source: 'USUAL' | 'HISTORY' | 'NONE';
} {
  if (row.usualSupplierId !== null) {
    return { id: row.usualSupplierId, name: row.usualSupplierName, source: 'USUAL' };
  }
  if (row.historySupplierId !== null) {
    return { id: row.historySupplierId, name: row.historySupplierName, source: 'HISTORY' };
  }
  return { id: null, name: null, source: 'NONE' };
}

function indexOf(lines: readonly { readonly productId: string }[], productId: string): number {
  const at = lines.findIndex((line) => line.productId === productId);
  return at < 0 ? Number.MAX_SAFE_INTEGER : at;
}
