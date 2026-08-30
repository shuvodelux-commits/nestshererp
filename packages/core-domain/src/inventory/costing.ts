import { divideRoundHalfUp, multiplyScaled, Qty, UnitCost } from '@sher/shared-utils';

export type CostingMethod = 'FIFO' | 'AVERAGE';

export interface CostLayer {
  readonly id: string;
  readonly qtyRemaining: number;
  readonly unitCost: number;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly expiryDate: string | null;
}

export interface LotAllocation {
  readonly lotId: string;
  readonly qty: number;
  readonly unitCost: number;
  readonly valueMinor: number;
}

export interface IssueCost {
  readonly allocations: readonly LotAllocation[];
  readonly shortageQty: number;
  readonly valueMinor: number;
  readonly provisional: boolean;
}

export interface AverageReceiptResult {
  readonly qtyOnHand: number;
  readonly avgUnitCost: number;
  readonly inventoryValueMinor: number;
}

/** Quantity scale 3 × unit-cost scale 4 → money scale 2, rounded once. */
export function stockValueMinor(qty: number, unitCost: number): number {
  const checkedQty = Qty(qty);
  const checkedCost = UnitCost(unitCost);
  if (checkedCost.raw < 0) throw new RangeError('Stock unit cost cannot be negative');
  return multiplyScaled(checkedQty.raw, checkedCost.raw, 5, 'Stock value');
}

/** Converts a two-decimal product/purchase price into scale-4 UnitCost exactly. */
export function unitCostFromMoneyMinor(moneyMinor: number): number {
  if (!Number.isSafeInteger(moneyMinor) || moneyMinor < 0) {
    throw new RangeError('Money cost must be a non-negative integer number of poisha');
  }
  const raw = BigInt(moneyMinor) * 100n;
  return safeNumber(raw, 'Unit cost');
}

/** DR13.5: moving average after a positive receipt, with one half-up rounding. */
export function averageAfterReceipt(
  currentQty: number,
  currentAvgUnitCost: number,
  receivedQty: number,
  receivedUnitCost: number,
): AverageReceiptResult {
  const beforeQty = Qty(currentQty);
  const incomingQty = Qty(receivedQty);
  const beforeCost = UnitCost(currentAvgUnitCost);
  const incomingCost = UnitCost(receivedUnitCost);

  if (beforeQty.raw < 0) throw new RangeError('Negative stock must be true-d up before averaging a receipt');
  if (incomingQty.raw <= 0) throw new RangeError('Received quantity must be greater than zero');
  if (beforeCost.raw < 0 || incomingCost.raw < 0) throw new RangeError('Unit cost cannot be negative');

  const nextQty = beforeQty.add(incomingQty).raw;
  const weighted =
    BigInt(beforeQty.raw) * BigInt(beforeCost.raw) +
    BigInt(incomingQty.raw) * BigInt(incomingCost.raw);
  const nextAverage = safeNumber(
    divideRoundHalfUp(weighted, BigInt(nextQty)),
    'Average unit cost',
  );

  return {
    qtyOnHand: nextQty,
    avgUnitCost: UnitCost(nextAverage).raw,
    inventoryValueMinor: stockValueMinor(nextQty, nextAverage),
  };
}

/**
 * DR13.2/DR13.2A deterministic physical allocation.
 *
 * When expiry tracking is active every eligible lot must carry an expiry date;
 * §5.10 says expiry is captured per lot, so silently treating an undated lot as
 * newest or oldest would invent a FEFO rule and may issue the wrong goods.
 */
export function allocateLots(
  layers: readonly CostLayer[],
  requestedQty: number,
  expiryTracked: boolean,
  /**
   * The business date an expired batch stops being sellable on (Phase 7.2,
   * owner decision 2026-08-26).
   *
   * When given, a dated layer whose date is **before** this one is not eligible
   * at all: expired goods are not stock a shop may sell, so the picker passes
   * over them and the shortage falls to the negative-stock or vendor-sourcing
   * answer instead. Null leaves every layer eligible, which is what a stock
   * adjustment needs — writing expired goods off has to be able to consume the
   * very lot that expired.
   *
   * A layer with **no** date never expires, so it stays eligible either way.
   */
  expiredOn: string | null = null,
): { readonly allocations: readonly LotAllocation[]; readonly shortageQty: number } {
  const wanted = Qty(requestedQty);
  if (wanted.raw <= 0) throw new RangeError('Issue quantity must be greater than zero');

  const eligible = layers
    .map(validateLayer)
    .filter((layer) => layer.qtyRemaining > 0)
    .filter(
      (layer) =>
        expiredOn === null || layer.expiryDate === null || layer.expiryDate >= expiredOn,
    );
  if (expiryTracked && eligible.some((layer) => layer.expiryDate === null)) {
    throw new RangeError('An expiry-tracked lot is missing its expiry date');
  }

  const sorted = [...eligible].sort((left, right) => compareLayers(left, right, expiryTracked));
  const allocations: LotAllocation[] = [];
  let remaining = wanted.raw;

  for (const layer of sorted) {
    if (remaining === 0) break;
    const qty = Math.min(remaining, layer.qtyRemaining);
    allocations.push({
      lotId: layer.id,
      qty,
      unitCost: layer.unitCost,
      valueMinor: stockValueMinor(qty, layer.unitCost),
    });
    remaining = Qty(remaining).subtract(Qty(qty)).raw;
  }

  return { allocations, shortageQty: remaining };
}

/** DR13.3/DR13.4: the accounting cost of an issue. */
export function costIssue(
  method: CostingMethod,
  layers: readonly CostLayer[],
  requestedQty: number,
  averageUnitCost: number,
  provisionalUnitCost: number,
  expiryTracked: boolean,
  /** See `allocateLots`: expired batches are skipped, not costed. */
  expiredOn: string | null = null,
): IssueCost {
  const selected = allocateLots(layers, requestedQty, expiryTracked, expiredOn);
  const shortageCost = UnitCost(provisionalUnitCost);
  if (shortageCost.raw < 0) throw new RangeError('Provisional cost cannot be negative');

  if (method === 'AVERAGE') {
    const average = UnitCost(averageUnitCost);
    if (average.raw < 0) throw new RangeError('Average cost cannot be negative');
    const effectiveCost = selected.shortageQty > 0 && average.raw === 0
      ? shortageCost.raw
      : average.raw;
    return {
      allocations: selected.allocations,
      shortageQty: selected.shortageQty,
      valueMinor: stockValueMinor(requestedQty, effectiveCost),
      provisional: selected.shortageQty > 0,
    };
  }

  const allocatedValue = selected.allocations.reduce(
    (total, allocation) => total + allocation.valueMinor,
    0,
  );
  const shortageValue = stockValueMinor(selected.shortageQty, shortageCost.raw);
  return {
    allocations: selected.allocations,
    shortageQty: selected.shortageQty,
    valueMinor: allocatedValue + shortageValue,
    provisional: selected.shortageQty > 0,
  };
}

function validateLayer(layer: CostLayer): CostLayer {
  if (layer.id === '') throw new RangeError('Lot id is required');
  const qty = Qty(layer.qtyRemaining);
  const cost = UnitCost(layer.unitCost);
  if (qty.raw < 0) throw new RangeError('Lot remaining quantity cannot be negative');
  if (cost.raw < 0) throw new RangeError('Lot unit cost cannot be negative');
  return { ...layer, qtyRemaining: qty.raw, unitCost: cost.raw };
}

function compareLayers(left: CostLayer, right: CostLayer, expiryTracked: boolean): number {
  if (expiryTracked && left.expiryDate !== right.expiryDate) {
    return (left.expiryDate ?? '').localeCompare(right.expiryDate ?? '');
  }
  const byBusinessDate = left.businessDate.localeCompare(right.businessDate);
  if (byBusinessDate !== 0) return byBusinessDate;
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return left.id.localeCompare(right.id);
}

function safeNumber(value: bigint, label: string): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > maximum || value < -maximum) throw new RangeError(`${label} exceeds the safe integer range`);
  return Number(value);
}

/**
 * The moving average a position comes to, given what it is worth and how much
 * of it there is — the inverse of `stockValueMinor`, rounded half-up once
 * (D-31).
 *
 * Reversals need it: taking a receipt or an adjustment back out of a position
 * means recomputing the average from the value that is left, and doing that
 * arithmetic by hand at each call site is how two of them end up a poisha
 * apart. `VoidPurchaseService` and `CreatePurchaseService` still compute it
 * inline; they should move to this.
 */
export function averageUnitCostFrom(valueMinor: number, qtyRaw: number): number {
  if (qtyRaw <= 0 || valueMinor <= 0) return 0;
  const scaled = (BigInt(valueMinor) * 100_000n * 2n) / BigInt(qtyRaw);
  return Number((scaled + 1n) / 2n);
}
