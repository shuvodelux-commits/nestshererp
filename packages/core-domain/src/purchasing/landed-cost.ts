import { allocateLargestRemainder, Money, Qty } from '@sher/shared-utils';

/**
 * Transport, labour and customs, spread onto the goods they arrived with
 * (§5.12 M14, owner decisions 2026-08-26).
 *
 * Pure: no clock, no I/O, no floating point.
 *
 * **A landed cost is not an expense.** The van fare that brought the goods in is
 * part of what those goods cost; posting it to a expense account would
 * understate the stock sitting on the shelf and overstate this month's costs for
 * goods nobody has sold yet. It belongs in the lot, and `actual_unit_cost` is
 * where it lands. The original `purchase_unit_cost` is never touched, which is
 * §5.12's "original purchase cost remains traceable".
 *
 * **Two methods, chosen per line.** A van fare is caused by bulk, so it spreads
 * by quantity; a customs bill is charged on worth, so it spreads by value. One
 * method for a whole delivery would have to get one of the two wrong, which is
 * why the owner chose per-line with a sensible default per category.
 */

export const LANDED_COST_CATEGORIES = [
  'TRANSPORT',
  'LABOUR',
  'LOADING',
  'DELIVERY',
  'CUSTOMS',
  'OTHER',
] as const;

export type LandedCostCategory = (typeof LANDED_COST_CATEGORIES)[number];

export type LandedCostMethod = 'BY_VALUE' | 'BY_QTY' | 'MANUAL';

/**
 * What each category spreads by unless the shopkeeper says otherwise.
 *
 * The defaults are the physical cause of the cost: moving and handling goods is
 * work per unit, while duty and delivery charges follow what the goods are
 * worth. A shop that disagrees changes the line; a shop that never thinks about
 * it still gets the fare on the heavy sacks rather than the light expensive box.
 */
export const DEFAULT_LANDED_COST_METHOD: Readonly<Record<LandedCostCategory, LandedCostMethod>> = {
  TRANSPORT: 'BY_QTY',
  LABOUR: 'BY_QTY',
  LOADING: 'BY_QTY',
  DELIVERY: 'BY_VALUE',
  CUSTOMS: 'BY_VALUE',
  OTHER: 'BY_VALUE',
};

export function isLandedCostCategory(value: string): value is LandedCostCategory {
  return (LANDED_COST_CATEGORIES as readonly string[]).includes(value);
}

/** One purchase line, as far as spreading a cost over it is concerned. */
export interface LandedCostTarget {
  readonly purchaseLineId: string;
  readonly qty: number;
  /** What the line came to before any spreading — the BY_VALUE weight. */
  readonly lineTotalMinor: number;
  /** Exact poisha assigned by the operator when `method` is MANUAL. */
  readonly manualShareMinor?: number | undefined;
}

export interface LandedCostShare {
  readonly purchaseLineId: string;
  readonly shareMinor: number;
}

export type LandedCostRejection =
  | 'LANDED_COST_NOT_POSITIVE'
  | 'LANDED_COST_NOT_INTEGER_MINOR'
  | 'LANDED_COST_HAS_NO_TARGET'
  | 'LANDED_COST_TARGET_HAS_NO_WEIGHT'
  | 'LANDED_COST_MANUAL_ALLOCATION_INVALID'
  | 'LANDED_COST_MANUAL_ALLOCATION_MISMATCH';

export function rejectLandedCost(
  amountMinor: number,
  targets: readonly LandedCostTarget[],
  method: LandedCostMethod,
): LandedCostRejection | null {
  if (!Number.isSafeInteger(amountMinor)) return 'LANDED_COST_NOT_INTEGER_MINOR';
  if (amountMinor <= 0) return 'LANDED_COST_NOT_POSITIVE';
  if (targets.length === 0) return 'LANDED_COST_HAS_NO_TARGET';

  if (method === 'MANUAL') {
    const shares = targets.map((target) => target.manualShareMinor);
    if (shares.some((share) => share === undefined || !Number.isSafeInteger(share) || share < 0)) {
      return 'LANDED_COST_MANUAL_ALLOCATION_INVALID';
    }
    const total = shares.reduce<number>((sum, share) => sum + (share ?? 0), 0);
    return total === amountMinor ? null : 'LANDED_COST_MANUAL_ALLOCATION_MISMATCH';
  }

  // Nothing to spread across: a bill whose lines are all free cannot carry a
  // fare by value, and one with no quantity cannot carry it by weight. Refusing
  // is honest; splitting it evenly would invent a rule nobody chose.
  const total = weightsFor(targets, method).reduce((sum, weight) => sum + weight, 0);
  return total <= 0 ? 'LANDED_COST_TARGET_HAS_NO_WEIGHT' : null;
}

function weightsFor(
  targets: readonly LandedCostTarget[],
  method: LandedCostMethod,
): readonly number[] {
  return targets.map((target) =>
    method === 'BY_QTY' ? Math.max(target.qty, 0) : Math.max(target.lineTotalMinor, 0),
  );
}

/**
 * Share one cost out over the lines of its bill.
 *
 * §3.3's largest-remainder rule, borrowed rather than rewritten: the parts sum
 * to the whole exactly, so no poisha of a van fare goes missing between the
 * journal entry and the lots. INV-05 is the invariant that would catch it if
 * one ever did.
 */
export function allocateLandedCost(
  amountMinor: number,
  targets: readonly LandedCostTarget[],
  method: LandedCostMethod,
): readonly LandedCostShare[] {
  if (method === 'MANUAL') {
    const rejection = rejectLandedCost(amountMinor, targets, method);
    if (rejection !== null) throw new RangeError(`Landed cost refused: ${rejection}`);
    return targets.map((target) => ({
      purchaseLineId: target.purchaseLineId,
      shareMinor: target.manualShareMinor ?? 0,
    }));
  }
  const shares = allocateLargestRemainder(
    Money(amountMinor).minor,
    weightsFor(targets, method),
    'Landed cost',
  );
  return targets.map((target, index) => ({
    purchaseLineId: target.purchaseLineId,
    shareMinor: shares[index] ?? 0,
  }));
}

export interface LateCostSplit {
  /** Raises the lot that is still on the shelf. */
  readonly inventoryMinor: number;
  /** Charged to COGS, because those goods have already gone. */
  readonly cogsMinor: number;
}

/**
 * A cost that arrived after some of the goods were sold (owner decision
 * 2026-08-26).
 *
 * The part belonging to stock still on the shelf raises that lot. The part
 * belonging to units already sold cannot — the lot they came from is drawn
 * down, and raising it would put value back into stock that is not there — so
 * it goes to `COGS` instead. Split by the same largest-remainder rule as
 * everything else, over exactly two parts, so the two halves always add back to
 * the whole.
 *
 * Nothing here decides *when* that COGS entry is dated; that is the use case's
 * business, and it dates it the day the cost was recorded so a closed period is
 * never rewritten.
 */
export function splitLateLandedCost(
  shareMinor: number,
  qtyReceived: number,
  qtyRemaining: number,
): LateCostSplit {
  const received = Qty(qtyReceived).raw;
  const remaining = Math.min(Math.max(Qty(qtyRemaining).raw, 0), Math.max(received, 0));

  // Nothing received means nothing to hold the cost: it is all a cost of sale.
  if (received <= 0) return { inventoryMinor: 0, cogsMinor: shareMinor };

  const sold = received - remaining;
  const [inventoryMinor = 0, cogsMinor = 0] = allocateLargestRemainder(
    shareMinor,
    [remaining, sold],
    'Late landed cost',
  );
  return { inventoryMinor, cogsMinor };
}
