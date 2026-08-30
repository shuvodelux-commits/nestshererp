/**
 * Matching the shop's ledger against the bank's statement (§5.17, Phase 11).
 *
 * **Deterministic and rule-based, on purpose.** No model, no learning, no
 * probability the owner cannot see. Every result carries the reasons that
 * produced it, so `Suggested Match` can say *why* on the screen — a match a
 * shopkeeper cannot check is a match they have to trust, and trusting a
 * reconciliation engine is exactly the habit that hides an error for a year.
 *
 * **Two gates, and nothing gets past them.** The amount must be equal to the
 * poisha, and the direction must be the same. Everything else — reference,
 * date, description — only decides how *confident* an equal-amount pair is, and
 * a pair failing either gate is not a candidate at all. This is why one poisha
 * of difference is never matched: on a reconciliation, an amount that is nearly
 * right is a different transaction, or a transaction entered wrongly, and both
 * of those are things the owner must see rather than have tidied away.
 *
 * **Automatic means certain, and certainty includes being alone.** A pair is
 * auto-matched only when it is unique on both sides: two payments of ৳2,500 on
 * the same day produce two suggestions, never a guess about which is which.
 *
 * Nothing here writes anything. The engine returns links, and a link is the
 * only thing reconciliation is ever allowed to create.
 */

/** One row of either side. The engine does not care which side it came from. */
export interface MatchableRow {
  readonly id: string;
  readonly businessDate: string;
  /** Signed poisha: money in positive, money out negative. */
  readonly amountMinor: number;
  readonly reference: string | null;
  readonly description: string;
}

export interface MatchReason {
  readonly label: string;
  readonly detail: string;
  /** Whether this signal supported the pairing — the screen shows ✓ or a note. */
  readonly ok: boolean;
}

export interface MatchPair {
  readonly ledgerId: string;
  readonly statementLineId: string;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

/**
 * A pair the engine will not act on: the reference says these are the same
 * transaction and the amount says they are not. Someone typed a figure wrongly,
 * and only a person can decide which figure was wrong.
 */
export interface MatchConflict {
  readonly ledgerId: string;
  readonly statementLineId: string;
  readonly reference: string;
  readonly ledgerAmountMinor: number;
  readonly statementAmountMinor: number;
}

export interface MatchOutcome {
  readonly auto: readonly MatchPair[];
  readonly suggested: readonly MatchPair[];
  readonly conflicts: readonly MatchConflict[];
}

/**
 * Every threshold the engine uses, in one place.
 *
 * Deliberately a single exported constant: the owner decision of 2026-08-30
 * says the thresholds must be adjustable centrally without rewriting the
 * screen, and a number spread across four functions is a number nobody can
 * safely change.
 */
export const MATCH_RULES = {
  /** Amount and direction agree. Every candidate starts here. */
  baseScore: 40,
  /** The bank's own transaction id, matched exactly. The strongest signal. */
  referenceScore: 35,
  /** Same calendar date. */
  sameDateScore: 25,
  /** Settlement timing: the bank posted a day or three after the shop did. */
  dateToleranceScores: [15, 10, 5] as readonly number[],
  /** Narration similarity. Supporting only — never enough on its own. */
  strongDescriptionScore: 10,
  weakDescriptionScore: 5,
  strongDescriptionSimilarity: 0.7,
  weakDescriptionSimilarity: 0.4,
  /** Beyond this many days apart, only an exact reference keeps a pair alive. */
  dateToleranceDays: 3,
  /** Below this, the pair is not worth showing anybody. */
  suggestScore: 45,
} as const;

export type MatchRules = typeof MATCH_RULES;

export function matchStatement(
  ledger: readonly MatchableRow[],
  statement: readonly MatchableRow[],
  rules: MatchRules = MATCH_RULES,
): MatchOutcome {
  const candidates: MatchPair[] = [];
  const conflicts: MatchConflict[] = [];

  for (const ours of ledger) {
    for (const theirs of statement) {
      const sharedReference = sameReference(ours, theirs);

      // Same reference, different amount: the loudest signal there is that
      // something is wrong, and never a reason to match.
      if (sharedReference !== null && ours.amountMinor !== theirs.amountMinor) {
        conflicts.push({
          ledgerId: ours.id,
          statementLineId: theirs.id,
          reference: sharedReference,
          ledgerAmountMinor: ours.amountMinor,
          statementAmountMinor: theirs.amountMinor,
        });
        continue;
      }

      const pair = score(ours, theirs, sharedReference !== null, rules);
      if (pair !== null) candidates.push(pair);
    }
  }

  return assign(candidates, conflicts, rules);
}

/* ------------------------------------------------------------------ scoring */

function score(
  ours: MatchableRow,
  theirs: MatchableRow,
  referenceMatches: boolean,
  rules: MatchRules,
): MatchPair | null {
  // Gate 1: same direction. Money out is never money in, whatever else agrees.
  if (Math.sign(ours.amountMinor) !== Math.sign(theirs.amountMinor)) return null;
  // Gate 2: the same amount, to the poisha.
  if (ours.amountMinor !== theirs.amountMinor) return null;

  const gap = daysBetween(ours.businessDate, theirs.businessDate);
  if (gap === null) return null;
  if (gap > rules.dateToleranceDays && !referenceMatches) return null;

  const reasons: MatchReason[] = [
    { label: 'Same amount', detail: 'To the poisha', ok: true },
    { label: 'Same direction', detail: ours.amountMinor > 0 ? 'Money in' : 'Money out', ok: true },
  ];
  let total = rules.baseScore;

  if (referenceMatches) {
    total += rules.referenceScore;
    reasons.push({ label: 'Reference', detail: 'Matches exactly', ok: true });
  } else {
    reasons.push({
      label: 'Reference',
      detail: ours.reference === null || theirs.reference === null ? 'Unavailable' : 'Different',
      ok: false,
    });
  }

  if (gap === 0) {
    total += rules.sameDateScore;
    reasons.push({ label: 'Date', detail: 'Same day', ok: true });
  } else {
    total += rules.dateToleranceScores[gap - 1] ?? 0;
    reasons.push({
      label: 'Date',
      detail: `Differs by ${String(gap)} day${gap === 1 ? '' : 's'}`,
      ok: false,
    });
  }

  const similarity = describeSimilarity(ours.description, theirs.description);
  if (similarity >= rules.strongDescriptionSimilarity) {
    total += rules.strongDescriptionScore;
    reasons.push({ label: 'Description', detail: 'Very similar', ok: true });
  } else if (similarity >= rules.weakDescriptionSimilarity) {
    total += rules.weakDescriptionScore;
    reasons.push({ label: 'Description', detail: 'Somewhat similar', ok: false });
  } else {
    reasons.push({ label: 'Description', detail: 'Different wording', ok: false });
  }

  return { ledgerId: ours.id, statementLineId: theirs.id, score: total, reasons };
}

/* --------------------------------------------------------------- assignment */

/**
 * Turns candidate pairs into one-to-one links, best first.
 *
 * A row can appear in one link only: once a statement line is spoken for, every
 * other pairing that used it is gone. That is what makes "one of ours is one of
 * theirs" true rather than aspirational, and it is why a duplicate payment
 * cannot quietly satisfy two statement lines.
 *
 * Auto requires more than the best score. It requires that nothing else came
 * close — a competing candidate above the suggestion floor demotes both, so the
 * owner decides which ৳2,500 is which.
 */
function assign(
  candidates: readonly MatchPair[],
  conflicts: readonly MatchConflict[],
  rules: MatchRules,
): MatchOutcome {
  const ordered = [...candidates].sort(
    (a, b) => b.score - a.score || a.ledgerId.localeCompare(b.ledgerId),
  );

  const takenLedger = new Set<string>();
  const takenStatement = new Set<string>();
  const auto: MatchPair[] = [];
  const suggested: MatchPair[] = [];

  for (const pair of ordered) {
    if (takenLedger.has(pair.ledgerId) || takenStatement.has(pair.statementLineId)) continue;
    if (pair.score < rules.suggestScore) continue;

    takenLedger.add(pair.ledgerId);
    takenStatement.add(pair.statementLineId);

    if (isCertain(pair, candidates, rules)) auto.push(pair);
    else suggested.push(pair);
  }

  return { auto, suggested, conflicts };
}

/**
 * Certain enough to link without asking: the pair agrees on the reference or on
 * the date, and neither of its rows has another plausible partner.
 */
function isCertain(
  pair: MatchPair,
  candidates: readonly MatchPair[],
  rules: MatchRules,
): boolean {
  const decisive = pair.reasons.some(
    (reason) => reason.ok && (reason.label === 'Reference' || reason.label === 'Date'),
  );
  if (!decisive) return false;

  const contested = candidates.some(
    (other) =>
      other !== pair &&
      other.score >= rules.suggestScore &&
      (other.ledgerId === pair.ledgerId || other.statementLineId === pair.statementLineId),
  );

  return !contested;
}

/* ----------------------------------------------------------------- signals */

function sameReference(a: MatchableRow, b: MatchableRow): string | null {
  const ours = normalizeReference(a.reference);
  const theirs = normalizeReference(b.reference);
  if (ours === null || theirs === null) return null;

  return ours === theirs ? ours : null;
}

/** A reference the bank prints as `TX-889` is the one the shop typed as `tx889`. */
function normalizeReference(reference: string | null): string | null {
  if (reference === null) return null;

  const normalized = reference.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Too short to be evidence: three characters collide by accident constantly.
  return normalized.length < 4 ? null : normalized;
}

/** Whole days between two ISO dates, or `null` if either is not a date. */
export function daysBetween(a: string, b: string): number | null {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return null;

  return Math.round(Math.abs(left - right) / 86_400_000);
}

/**
 * How much two narrations have in common, 0…1 — shared words over the smaller
 * side, which is the shape that treats "Deposit" against "Cash deposit from
 * Karim" as similar without pretending they are the same sentence.
 */
export function describeSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;

  return shared / Math.min(left.size, right.size);
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9ঀ-৿]+/)
      .filter((word) => word.length > 2),
  );
}
