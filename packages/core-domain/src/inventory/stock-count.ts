import { Qty } from '@sher/shared-utils';

/**
 * A count sheet: what the shelf holds against what the system says (§5.13,
 * owner decisions 2026-08-26).
 *
 * Pure, and called from the browser as well as the server — the sheet shows
 * every difference moving as each quantity is typed, and the service runs the
 * same function again against live stock when Post is pressed.
 *
 * **Nothing here posts anything.** A difference becomes a stock adjustment
 * through the use case that already owns stock movement, so a counted shortage
 * consumes lots exactly as a typed one does.
 */

export interface CountLineDraft {
  readonly productId: string;
  /** What the system says. Scale 3. */
  readonly systemQty: number;
  /** What is actually on the shelf. Scale 3. `null` means not counted yet. */
  readonly countedQty: number | null;
  /** Poisha per unit, scale 4 — what a surplus would come in at. */
  readonly avgUnitCost: number;
}

export interface CountLineTotals {
  readonly productId: string;
  readonly systemQty: number;
  readonly countedQty: number;
  /** Counted − system: positive is found, negative is missing. */
  readonly qtyDelta: number;
  /**
   * What that difference is worth at the product's own average cost.
   *
   * Indicative on the screen and **not** what posts: the shortage's real value
   * is whatever the lots it consumes actually cost, which only the costing
   * kernel can say. The sheet shows this so a shopkeeper can see the size of
   * what they are about to post.
   */
  readonly valueMinor: number;
}

export interface CountTotals {
  readonly lines: readonly CountLineTotals[];
  readonly countedLines: number;
  readonly differenceCount: number;
  /** Value of everything missing, as a positive number. */
  readonly shortageValueMinor: number;
  readonly surplusValueMinor: number;
}

export function countTotals(lines: readonly CountLineDraft[]): CountTotals {
  const counted = lines.flatMap((line) => {
    if (line.countedQty === null) return [];
    const qtyDelta = Qty(line.countedQty).subtract(Qty(line.systemQty)).raw;
    return [
      {
        productId: line.productId,
        systemQty: Qty(line.systemQty).raw,
        countedQty: Qty(line.countedQty).raw,
        qtyDelta,
        valueMinor: valueOf(qtyDelta, line.avgUnitCost),
      },
    ];
  });

  const differences = counted.filter((line) => line.qtyDelta !== 0);
  return {
    lines: counted,
    countedLines: counted.length,
    differenceCount: differences.length,
    shortageValueMinor: differences
      .filter((line) => line.qtyDelta < 0)
      .reduce((sum, line) => sum + Math.abs(line.valueMinor), 0),
    surplusValueMinor: differences
      .filter((line) => line.qtyDelta > 0)
      .reduce((sum, line) => sum + line.valueMinor, 0),
  };
}

/**
 * Quantity (scale 3) × unit cost (taka, scale 4) → poisha, rounded half-up
 * once, keeping the sign.
 *
 * The same product `stockValueMinor` forms; written here signed, because a
 * count's difference goes both ways and a value function that refuses negative
 * quantities cannot describe a shortage.
 */
function valueOf(qtyDelta: number, avgUnitCost: number): number {
  const magnitude = BigInt(Math.abs(qtyDelta)) * BigInt(Math.max(avgUnitCost, 0));
  const poisha = Number(((magnitude * 2n) / 100_000n + 1n) / 2n);
  return qtyDelta < 0 ? -poisha : poisha;
}
