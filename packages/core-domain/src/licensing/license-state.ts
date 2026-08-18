/**
 * Licence lifecycle (D-36).
 *
 * ```
 * ACTIVE → EXPIRING (30 days before) → GRACE (30 days after) → READ_ONLY
 *                                                     RESTORED on renewal
 * ```
 *
 * **There is no state in which customer data is destroyed, hidden, or made
 * un-exportable.** A lapsed licence stops new business being written; it never
 * takes away business already done. That is the whole point of the ladder — an
 * on-premise shop whose renewal is late must still be able to read its own
 * ledgers and take a backup out.
 *
 * Pure: the current instant is passed in, never read (R-C8). Same input, same
 * output.
 */
export type LicenseState = 'ACTIVE' | 'EXPIRING' | 'GRACE' | 'READ_ONLY' | 'RESTORED';

/** 30 days, in milliseconds — both windows in D-36 are the same length. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface LicenseTerm {
  /** When the term ends. Contract-term based (D-36), not usage-based. */
  readonly validUntil: Date;
  /**
   * When this licence was issued. A licence issued *after* the previous one had
   * already lapsed is a renewal, and D-36 names that state `RESTORED` — a
   * distinct signal so the UI can say "you are back" rather than silently
   * looking like nothing was ever wrong.
   */
  readonly issuedAt: Date;
  /** When the previous term ended, if this licence replaced a lapsed one. */
  readonly renewedFrom?: Date | undefined;
}

/**
 * The state a licence is in at `now`.
 *
 * `RESTORED` is deliberately checked first and only claimed while the licence
 * is otherwise healthy: a renewal that is itself already expiring is expiring,
 * not restored, and telling the owner otherwise would hide the second problem
 * behind the first one's good news.
 */
export function licenseStateAt(term: LicenseTerm, now: Date): LicenseState {
  const remainingMs = term.validUntil.getTime() - now.getTime();

  if (remainingMs <= -WINDOW_MS) return 'READ_ONLY';
  if (remainingMs <= 0) return 'GRACE';

  if (remainingMs <= WINDOW_MS) return 'EXPIRING';

  // Healthy, and it replaced a term that had already run out — but only while
  // the renewal is still fresh, so "RESTORED" does not stick for a whole year.
  if (term.renewedFrom !== undefined && now.getTime() - term.issuedAt.getTime() <= WINDOW_MS) {
    return 'RESTORED';
  }

  return 'ACTIVE';
}

/**
 * Whether business writes are accepted.
 *
 * `GRACE` still writes: D-36 gives 30 days *after* expiry precisely so a late
 * renewal does not stop a shop trading. Only `READ_ONLY` refuses, and even then
 * reads and backup export continue.
 */
export function licenseAllowsWrites(state: LicenseState): boolean {
  return state !== 'READ_ONLY';
}
