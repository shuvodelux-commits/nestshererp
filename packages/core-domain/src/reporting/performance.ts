import { divideRoundHalfUp, Qty } from '@sher/shared-utils';

import { PERCENT_SCALE } from '../catalog/product';

/**
 * Product performance (§5.20, "Sales performance and profit forecasting").
 *
 * Every figure here is arithmetic over numbers the caller read from journal
 * lines and stock movements — nothing in this file knows where a sale is
 * stored, and nothing in it may become a second definition of profit (INV-10).
 * Revenue is `SALES`, cost is `COGS`, and gross profit is the difference: the
 * same two account balances the Money report shows, split by product.
 */

/**
 * Percentages are integer basis points — 12.34% is 1234 (R-C3, no floats), the
 * same scale the product's own discount percentage already uses.
 */
export const PERCENT_BASIS = BigInt(100 * 10 ** PERCENT_SCALE);

export interface ProductPerformanceInput {
  readonly productId: string;
  readonly unitsSold: number;
  readonly revenueMinor: number;
  readonly cogsMinor: number;
  /** Units held at the start and end of the range, for stock turn. */
  readonly openingQty: number;
  readonly closingQty: number;
}

export interface ProductPerformance extends ProductPerformanceInput {
  readonly grossProfitMinor: number;
  readonly marginBp: number;
  readonly stockTurnBp: number;
}

export function grossProfitMinor(revenueMinor: number, cogsMinor: number): number {
  return revenueMinor - cogsMinor;
}

/**
 * Margin on revenue, in basis points. Zero revenue has no margin — reporting
 * one would be a division by zero dressed up as a business fact.
 */
export function marginBp(revenueMinor: number, cogsMinor: number): number {
  if (revenueMinor === 0) return 0;
  const profit = BigInt(grossProfitMinor(revenueMinor, cogsMinor));
  return Number(divideRoundHalfUp(profit * PERCENT_BASIS, BigInt(revenueMinor)));
}

/**
 * Stock turn — units sold ÷ average units held — in basis points, so 2.50
 * turns reads 25000. A product that sold while never being held (a vendor
 * consignment line, say) has no turn rather than an infinite one.
 */
export function stockTurnBp(unitsSold: number, openingQty: number, closingQty: number): number {
  const average = Qty(openingQty).add(Qty(closingQty)).raw;
  if (average <= 0) return 0;
  // Averaging by 2 is folded into the denominator so the division rounds once.
  return Number(divideRoundHalfUp(BigInt(unitsSold) * PERCENT_BASIS * 2n, BigInt(average)));
}

export function productPerformance(row: ProductPerformanceInput): ProductPerformance {
  return {
    ...row,
    grossProfitMinor: grossProfitMinor(row.revenueMinor, row.cogsMinor),
    marginBp: marginBp(row.revenueMinor, row.cogsMinor),
    stockTurnBp: stockTurnBp(row.unitsSold, row.openingQty, row.closingQty),
  };
}

/**
 * Best and worst movers by gross profit, biggest first and smallest first.
 *
 * A product nobody sold in the range is not a "worst mover" — it is absent
 * from the sales data entirely, and calling it the worst would answer a
 * question about stock with a fact about sales. The caller decides whether to
 * include unsold products by what it passes in.
 */
export function rankMovers(
  rows: readonly ProductPerformance[],
  limit: number,
): { readonly best: readonly ProductPerformance[]; readonly worst: readonly ProductPerformance[] } {
  if (limit <= 0) return { best: [], worst: [] };
  const byProfit = [...rows].sort((a, b) =>
    a.grossProfitMinor === b.grossProfitMinor
      ? a.productId.localeCompare(b.productId)
      : b.grossProfitMinor - a.grossProfitMinor,
  );
  return {
    best: byProfit.slice(0, limit),
    worst: [...byProfit].reverse().slice(0, limit),
  };
}
