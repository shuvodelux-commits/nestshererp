import { roundWholeTakaMinor } from '@sher/shared-utils';

/**
 * Read-only arithmetic preview for a NEW document's ALREADY-DISCOUNTED,
 * server-authoritative source lines.
 *
 * The final rounding rule (nearest ৳1, once after discounts) is owner-approved.
 * Where/how to allocate the resulting signed delta to source lines, journals,
 * taxes, customer/supplier obligations or payment sources is NOT approved.
 *
 * This helper must remain unmounted, unexported from the core-domain barrel and
 * never be used as an authorization to post. Existing historical documents
 * and returns use their frozen original amounts, NOT this calculation.
 */
export interface DiscountedSourceLine {
  /** Stable, nonempty source-line identity; never the product/Unit display name. */
  readonly sourceLineId: string;
  /** After line and bill discounts have already been allocated, in integer poisha. */
  readonly netAmountMinor: number;
}

export interface WholeTakaInvoicePreflight {
  /** Sum of source lines BEFORE the one allowed final whole-taka rounding. */
  readonly sourceNetMinor: number;
  /** Preview obligation after nearest-৳1 rounding (multiple of 100 poisha). */
  readonly roundedObligationMinor: number;
  /** Signed obligation minus original source net; must not be hidden in costs. */
  readonly roundingDeltaMinor: number;
  /** True means a later, independently approved source/journal allocation is needed. */
  readonly requiresSourceAllocation: boolean;
  /** Positive original price would become zero payable; new-sale policy remains OPEN. */
  readonly roundedPositiveToZero: boolean;
}

/**
 * This does not compute prices, unit factors, discounts, journal entries,
 * allocations, refunds, cash changes, COGS or sale/purchase persistence.
 * Source validation, tenant permissions and opening/closing cash-session
 * checks remain with their existing owning services.
 */
export function inspectNewInvoiceWholeTaka(
  discountedLines: readonly DiscountedSourceLine[],
): WholeTakaInvoicePreflight {
  if (discountedLines.length === 0) {
    throw new RangeError('A new invoice needs at least one discounted source line');
  }

  let sourceTotal = 0n;
  const seen = new Set<string>();
  for (const line of discountedLines) {
    if (typeof line.sourceLineId !== 'string' ||
        line.sourceLineId.trim().length === 0 ||
        seen.has(line.sourceLineId)) {
      throw new RangeError('Source line identities must be nonempty and unique');
    }
    seen.add(line.sourceLineId);
    if (!Number.isSafeInteger(line.netAmountMinor) || line.netAmountMinor < 0) {
      throw new RangeError('Discounted source money must be a nonnegative safe integer poisha');
    }
    sourceTotal += BigInt(line.netAmountMinor);
    if (sourceTotal > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('Discounted invoice source money exceeds safe integer range');
    }
  }
  if (sourceTotal === 0n) {
    throw new RangeError('A zero-source new invoice needs a separately approved free-goods policy');
  }

  const sourceNetMinor = Number(sourceTotal);
  // Exactly ONCE on the entire discounted header, never on each priced Box/Pcs.
  const roundedObligationMinor = roundWholeTakaMinor(sourceNetMinor);
  const roundingDeltaMinor = roundedObligationMinor - sourceNetMinor;
  return {
    sourceNetMinor,
    roundedObligationMinor,
    roundingDeltaMinor,
    requiresSourceAllocation: roundingDeltaMinor !== 0,
    roundedPositiveToZero: roundedObligationMinor === 0,
  };
}
