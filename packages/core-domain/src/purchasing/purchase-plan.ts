import { divideRoundHalfUp, Money, Qty, QTY_SCALE } from '@sher/shared-utils';

/**
 * What to buy, how much of it, and which of it matters most (§5.9, owner
 * decisions 2026-08-26).
 *
 * Pure: no clock, no I/O, no floating point. Quantities are scale-3 and money
 * is poisha, like everywhere else, and every division goes through D-31's
 * half-up rule rather than a second one written here.
 *
 * **The suggestion is deliberately hybrid.** A product that has genuinely been
 * selling is bought against its own speed — how much it sells a day, times how
 * many days of stock the shop wants to hold, less what is on the shelf and less
 * what is already on order. A product with almost no history has no speed worth
 * trusting, so it falls back to the reorder level the shopkeeper already set.
 * One rule for both would be wrong twice: velocity alone turns a single
 * wholesale sale into an order for hundreds, and reorder level alone leaves a
 * product that started selling three times faster quietly running out.
 *
 * **Nothing here posts anything.** A plan is a decision about the future; the
 * stock, the lots and the supplier's ledger happen later, when the plan is
 * converted and the ordinary purchase use case runs.
 */

export type PlanPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export const PLAN_PRIORITIES: readonly PlanPriority[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
] as const;

/**
 * How many separate days a product must have sold on before its daily rate is
 * believed (owner decision 2026-08-26).
 *
 * Separate **days**, not sales: one wholesale customer clearing fifty pieces in
 * a single visit is one day of demand, and treating it as a rate would have the
 * shop order hundreds. Three days is the point at which a pattern is a pattern.
 */
export const MIN_SELLING_DAYS = 3;

/** One base unit, scale-3. What a suggestion rounds to when there is no pack. */
const ONE_BASE_UNIT = 10 ** QTY_SCALE;

export interface PlanProduct {
  readonly productId: string;
  /**
   * What can actually be sold today: on-hand less expired batches and less
   * anything a vendor still owns. Buying against a figure that includes stock
   * the shop may not sell is how a shelf ends up double-stocked.
   */
  readonly stockQty: number;
  /** Base units sold across the look-back window. */
  readonly soldQty: number;
  /** How many distinct business dates it sold on, in that window. */
  readonly sellingDays: number;
  /** Planned but not yet bought, from every open plan. */
  readonly pendingQty: number;
  /** The reorder level on the product form. The fallback rule's whole basis. */
  readonly minStockQty: number;
  /** `1 Carton = 12 Piece` is `12000`. Null on an ordinary single-unit product. */
  readonly packQty: number | null;
  /** The smallest the supplier will sell. Null applies no minimum. */
  readonly minOrderQty: number | null;
  /** Last purchase cost per base unit, poisha. */
  readonly unitCostMinor: number;
  readonly sellingPriceMinor: number;
}

export interface PlanParams {
  /** Days of sales history the rate is measured over. */
  readonly lookBackDays: number;
  /** Days of stock the shop wants to hold. */
  readonly coverDays: number;
}

export interface PlanSuggestion {
  readonly productId: string;
  readonly priority: PlanPriority;
  /** Base units per day, scale-3. Zero when there is not enough history. */
  readonly dailySalesQty: number;
  /** Whole days the shelf will last. Null when nothing is selling. */
  readonly coverDays: number | null;
  /** What the planner would buy, already rounded to packs and minimums. */
  readonly suggestedQty: number;
  /** Whether the rate was trusted, or the reorder level was used instead. */
  readonly fromHistory: boolean;
}

/**
 * How fast it sells, per day, scale-3.
 *
 * Half-up on the last digit like every other division here (D-31): a product
 * selling 10 in 30 days is `0.333`, and the same figure whichever screen asks.
 */
export function dailySalesQty(soldQty: number, lookBackDays: number): number {
  if (lookBackDays <= 0 || soldQty <= 0) return 0;
  return Number(divideRoundHalfUp(BigInt(Qty(soldQty).raw), BigInt(lookBackDays)));
}

/**
 * Whole days the shelf lasts at that rate, or null when nothing is moving.
 *
 * Floored, not rounded: a shelf that lasts 6.9 days has run out on the seventh,
 * and rounding up would let a product about to go empty read as comfortable.
 */
export function coverDaysOf(stockQty: number, dailyQty: number): number | null {
  if (dailyQty <= 0) return null;
  if (stockQty <= 0) return 0;
  return Number(BigInt(Qty(stockQty).raw) / BigInt(dailyQty));
}

/**
 * Critical, High, Medium or Low (owner decision 2026-08-26).
 *
 * The bands are the target divided down, so they move with the shop's own
 * setting instead of hard-coding a week: against a 30-day target, a quarter of
 * it is a week and half of it is a fortnight. An empty shelf is Critical
 * whatever the rate says, and a product below the reorder level is never calmer
 * than High — the shopkeeper set that level for a reason and it outranks a
 * quiet fortnight.
 */
export function priorityOf(product: PlanProduct, params: PlanParams): PlanPriority {
  if (product.stockQty <= 0) return 'CRITICAL';

  const belowMin = product.minStockQty > 0 && product.stockQty < product.minStockQty;
  const daily =
    product.sellingDays >= MIN_SELLING_DAYS
      ? dailySalesQty(product.soldQty, params.lookBackDays)
      : 0;
  const cover = coverDaysOf(product.stockQty, daily);
  if (cover === null) return belowMin ? 'HIGH' : 'LOW';

  if (cover * 4 <= params.coverDays) return 'CRITICAL';
  if (cover * 2 <= params.coverDays || belowMin) return 'HIGH';
  return cover < params.coverDays ? 'MEDIUM' : 'LOW';
}

/**
 * Round a raw need up into something the supplier will actually sell.
 *
 * Order matters and only one order is correct: raise to the minimum first, then
 * round up to a whole pack. Rounding only ever increases, so the minimum
 * survives it — doing it the other way round can land just under the minimum
 * and stay there.
 */
export function roundToPack(
  rawQty: number,
  packQty: number | null,
  minOrderQty: number | null,
): number {
  if (rawQty <= 0) return 0;

  const floor = minOrderQty !== null && minOrderQty > 0 ? Math.max(rawQty, minOrderQty) : rawQty;
  const step = packQty !== null && packQty > 0 ? packQty : ONE_BASE_UNIT;
  const steps = (BigInt(floor) + BigInt(step) - 1n) / BigInt(step);
  return Qty(Number(steps * BigInt(step))).raw;
}

/**
 * The largest quantity a remaining budget can pay for, rounded **down** so it
 * stays inside the money (owner decision 2026-08-26).
 *
 * Returns zero when what the budget can afford is less than one pack or less
 * than the supplier's minimum — half a carton is not something anyone can buy,
 * and offering it would put a quantity on the supplier's order that would come
 * back refused.
 */
export function affordableQty(
  budgetMinor: number,
  unitCostMinor: number,
  packQty: number | null,
  minOrderQty: number | null,
): number {
  if (budgetMinor <= 0 || unitCostMinor <= 0) return 0;

  const rawQty = Number((BigInt(budgetMinor) * BigInt(ONE_BASE_UNIT)) / BigInt(unitCostMinor));
  if (rawQty <= 0) return 0;

  const step = packQty !== null && packQty > 0 ? packQty : ONE_BASE_UNIT;
  const down = Number((BigInt(rawQty) / BigInt(step)) * BigInt(step));
  if (down <= 0) return 0;
  if (minOrderQty !== null && minOrderQty > 0 && down < minOrderQty) return 0;
  return Qty(down).raw;
}

/** What one planned quantity ties up, in poisha. */
export function investmentMinor(qty: number, unitCostMinor: number): number {
  if (qty <= 0) return 0;
  return Money(unitCostMinor).multiply(Qty(qty)).minor;
}

/** What it should come back as, at today's selling price. */
export function expectedSalesMinor(qty: number, sellingPriceMinor: number): number {
  if (qty <= 0) return 0;
  return Money(sellingPriceMinor).multiply(Qty(qty)).minor;
}

/**
 * The whole suggestion for one product: its band, its rate, and what to buy.
 */
export function suggestFor(product: PlanProduct, params: PlanParams): PlanSuggestion {
  const fromHistory = product.sellingDays >= MIN_SELLING_DAYS && product.soldQty > 0;
  const daily = fromHistory ? dailySalesQty(product.soldQty, params.lookBackDays) : 0;

  /*
   * Velocity when it is trustworthy, the reorder level when it is not. Both
   * subtract what is already on the shelf and what is already on order — the
   * second is what stops a weekly plan from ordering the same goods again while
   * the first delivery is still on its way.
   */
  const target = fromHistory
    ? Qty(daily).multiply(Qty(params.coverDays * ONE_BASE_UNIT)).raw
    : product.minStockQty;
  const rawNeed = target - product.stockQty - product.pendingQty;

  return {
    productId: product.productId,
    priority: priorityOf(product, params),
    dailySalesQty: daily,
    coverDays: coverDaysOf(product.stockQty, daily),
    suggestedQty: roundToPack(Math.max(rawNeed, 0), product.packQty, product.minOrderQty),
    fromHistory,
  };
}

export interface PlanLineForBudget {
  readonly productId: string;
  readonly priority: PlanPriority;
  readonly wantedQty: number;
  readonly unitCostMinor: number;
  readonly sellingPriceMinor: number;
  readonly packQty: number | null;
  readonly minOrderQty: number | null;
}

export interface BudgetedLine {
  readonly productId: string;
  readonly fundedQty: number;
  /** True where the budget bought some of it but not all of it. */
  readonly partlyFunded: boolean;
}

export interface BudgetAllocation {
  readonly lines: readonly BudgetedLine[];
  readonly spentMinor: number;
  readonly remainingMinor: number;
}

/**
 * Rank for buying: the urgent first, and inside one band the ones worth most.
 *
 * The owner's rule of 2026-08-26 — "runs-out first, money second". Money is the
 * expected gross profit of the quantity being considered, not the margin
 * percentage: what the shop actually earns from spending on that line.
 */
export function comparePlanLines(a: PlanLineForBudget, b: PlanLineForBudget): number {
  const byPriority = PLAN_PRIORITIES.indexOf(a.priority) - PLAN_PRIORITIES.indexOf(b.priority);
  if (byPriority !== 0) return byPriority;

  const profitA =
    expectedSalesMinor(a.wantedQty, a.sellingPriceMinor) -
    investmentMinor(a.wantedQty, a.unitCostMinor);
  const profitB =
    expectedSalesMinor(b.wantedQty, b.sellingPriceMinor) -
    investmentMinor(b.wantedQty, b.unitCostMinor);
  if (profitA !== profitB) return profitB - profitA;

  // Ties broken by id so two runs over the same data agree with each other.
  return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
}

/**
 * Spend a budget down the ranked list (owner decision 2026-08-26).
 *
 * Every line is funded in full until one does not fit; that one takes whatever
 * is left, rounded down to something buyable; everything below it gets nothing
 * and stays on the screen at zero, so the shopkeeper can see what they gave up
 * rather than wondering why it vanished.
 *
 * A null budget is not a budget of zero — it means no budget was set, and every
 * line is funded as planned.
 */
export function allocateBudget(
  lines: readonly PlanLineForBudget[],
  budgetMinor: number | null,
): BudgetAllocation {
  const ranked = [...lines].sort(comparePlanLines);

  if (budgetMinor === null) {
    const spent = ranked.reduce(
      (total, line) => total + investmentMinor(line.wantedQty, line.unitCostMinor),
      0,
    );
    return {
      lines: ranked.map((line) => ({
        productId: line.productId,
        fundedQty: line.wantedQty,
        partlyFunded: false,
      })),
      spentMinor: spent,
      remainingMinor: 0,
    };
  }

  const funded: BudgetedLine[] = [];
  let remaining = Math.max(budgetMinor, 0);
  let spent = 0;
  let cutoffReached = false;

  for (const line of ranked) {
    if (cutoffReached || line.wantedQty <= 0) {
      funded.push({ productId: line.productId, fundedQty: 0, partlyFunded: false });
      continue;
    }

    const cost = investmentMinor(line.wantedQty, line.unitCostMinor);
    if (cost <= remaining) {
      funded.push({ productId: line.productId, fundedQty: line.wantedQty, partlyFunded: false });
      remaining -= cost;
      spent += cost;
      continue;
    }

    /*
     * The line the money runs out on. It takes what is left and the list stops
     * here: carrying on to fund a cheaper, less urgent product below it would
     * quietly reorder the shopkeeper's own priorities with their own money.
     */
    cutoffReached = true;
    const partQty = affordableQty(remaining, line.unitCostMinor, line.packQty, line.minOrderQty);
    const partCost = investmentMinor(partQty, line.unitCostMinor);
    funded.push({
      productId: line.productId,
      fundedQty: partQty,
      partlyFunded: partQty > 0,
    });
    remaining -= partCost;
    spent += partCost;
  }

  return { lines: funded, spentMinor: spent, remainingMinor: remaining };
}

export interface PlanTotalsLine {
  readonly qty: number;
  readonly unitCostMinor: number;
  readonly sellingPriceMinor: number;
}

export interface PlanTotals {
  readonly investmentMinor: number;
  readonly expectedSalesMinor: number;
  readonly expectedProfitMinor: number;
  /** Hundredths of a percent, like every other percentage stored here. */
  readonly marginPercentHundredths: number;
}

/**
 * What the plan costs and what it should bring back.
 *
 * Margin is against expected sales, not against cost: a shopkeeper reads "23%
 * margin" as a share of the money coming in. Zero sales gives zero margin
 * rather than a division by nothing.
 */
export function planTotals(lines: readonly PlanTotalsLine[]): PlanTotals {
  let investment = 0;
  let sales = 0;
  for (const line of lines) {
    investment += investmentMinor(line.qty, line.unitCostMinor);
    sales += expectedSalesMinor(line.qty, line.sellingPriceMinor);
  }

  const profit = sales - investment;
  const margin =
    sales === 0 ? 0 : Number(divideRoundHalfUp(BigInt(profit) * 10_000n, BigInt(sales)));

  return {
    investmentMinor: investment,
    expectedSalesMinor: sales,
    expectedProfitMinor: profit,
    marginPercentHundredths: margin,
  };
}
