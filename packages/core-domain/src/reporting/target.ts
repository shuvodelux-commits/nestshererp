import { divideRoundHalfUp } from '@sher/shared-utils';

import { PERCENT_BASIS } from './performance';

/**
 * The shop's monthly target and where the month is heading (§5.20, O-10 closed
 * by owner decision 2026-08-30).
 *
 * The decision was the simplest honest one: **one target typed per month for
 * the whole shop**, and a **run-rate projection** — what the month becomes if
 * the rest of it goes like the part that has happened. Not a trend across
 * prior months, not a target derived from history.
 *
 * A projection is an estimate and the SRS forbids presenting it as a posted
 * figure, which is why it is returned in its own field with its own name and
 * never added into a total.
 */

export type TargetBasis = 'PROFIT' | 'SALES';

export interface TargetProgressInput {
  /** What the shop set for the month; `null` when no target was typed. */
  readonly targetMinor: number | null;
  /** Posted actual so far, from the journal. */
  readonly actualMinor: number;
  /** Days of the month that have finished or are in progress, 1-based. */
  readonly elapsedDays: number;
  readonly daysInMonth: number;
}

export interface TargetProgress {
  readonly targetMinor: number | null;
  readonly actualMinor: number;
  /** Actual ÷ target in basis points; `null` without a target. */
  readonly achievedBp: number | null;
  /** Where the month lands at the current daily rate. Always an estimate. */
  readonly projectedMinor: number;
  /** Projected − target; negative is a shortfall. `null` without a target. */
  readonly projectedGapMinor: number | null;
  readonly elapsedDays: number;
  readonly daysInMonth: number;
}

export function targetProgress(input: TargetProgressInput): TargetProgress {
  const elapsed = Math.min(Math.max(input.elapsedDays, 0), input.daysInMonth);
  // Before the first day has begun there is no rate to extend, so the
  // projection is what has actually been posted — zero — rather than a
  // division by zero or a number invented from one hour of trading.
  const projectedMinor =
    elapsed <= 0
      ? input.actualMinor
      : Number(
          divideRoundHalfUp(
            BigInt(input.actualMinor) * BigInt(input.daysInMonth),
            BigInt(elapsed),
          ),
        );

  const target = input.targetMinor;
  return {
    targetMinor: target,
    actualMinor: input.actualMinor,
    achievedBp:
      target === null || target === 0
        ? null
        : Number(divideRoundHalfUp(BigInt(input.actualMinor) * PERCENT_BASIS, BigInt(target))),
    projectedMinor,
    projectedGapMinor: target === null ? null : projectedMinor - target,
    elapsedDays: elapsed,
    daysInMonth: input.daysInMonth,
  };
}

