import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { advancedHighWater, clockBehindMs, effectiveLicenseNow } from '@sher/core-application';
import { parseInstant } from '@sher/shared-utils';

/**
 * What this **machine** remembers about its own licence (owner decision
 * 2026-09-02).
 *
 * Two facts, and both of them describe the computer rather than the business:
 * the latest instant SherERP has ever seen here, and — when a licence was
 * renewed after lapsing — the day the previous term ended.
 *
 * **It lives in a file beside the licence, and that is the point.** Machine
 * state must not travel: it is not in `.sherdb`, so an archive cannot carry it;
 * it is not in PostgreSQL, so restoring an old backup onto this computer cannot
 * wind it back, Reset Business Data cannot clear it, and an import cannot
 * introduce one. §5.25 already puts licence and machine configuration outside
 * the database for exactly this reason, and the backup secret lives the same
 * way (D-15).
 *
 * **The high-water mark is what stops a wound-back clock buying time.** The
 * licence is judged at the later of the system clock and this mark, so time can
 * stand still for a licence but never run backwards. It forces nothing on its
 * own — a shop whose CMOS battery died has a wrong clock, not a dishonest
 * owner — and it never touches a business date, a period or a posting.
 */

interface StoredState {
  /** ISO instant: the furthest forward this machine has ever seen. */
  readonly highestSeen: string | null;
  /** ISO instant: the end of the term the installed licence renewed after. */
  readonly renewedFrom: string | null;
}

/**
 * How often the mark is written down.
 *
 * Every request would be a file write per request for a value that matters at
 * the resolution of days. Five minutes bounds what a crash can lose to five
 * minutes of licence time, which is nothing.
 */
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How far ahead of the mark a system clock may read before it is disbelieved
 * (owner decision 2026-09-02).
 *
 * The mark is one-way, so a single bad reading is permanent: one boot with a
 * dead RTC announcing 2038 would write 2038 into the file, and from then on
 * every licence — including one renewed the next morning on a corrected clock
 * — evaluates as long expired, with nothing in the UI able to undo it. Deleting
 * a file on disk is not a recovery path a shopkeeper has.
 *
 * 400 days is deliberately generous: a full year, which is the licence term
 * itself, plus a month of slack, so a machine genuinely switched off for a
 * season — or for a whole year in storage — comes back and records the truth.
 * Beyond that the reading is not a shop that waited, it is hardware that lost
 * its clock, and the mark is left exactly where it was.
 *
 * **Rejected, not clamped, and that distinction is the whole fix.** Clamping to
 * "the mark plus 400 days" would heal itself straight back to 2038 on the very
 * next observation a moment later, because each one would measure its jump from
 * the value the last one just wrote. Refusing to move records nothing false and
 * stays refused. Nothing is bought by it either: `effectiveLicenseNow` still
 * judges at the later of the two instants, so a licence that has genuinely run
 * out on a correct clock still expires — the machine simply declines to
 * *remember* an instant it has no reason to believe it reached.
 */
const IMPLAUSIBLE_FORWARD_JUMP_MS = 400 * 24 * 60 * 60 * 1000;

export class MachineLicenseState {
  private highestSeen: Date | null = null;
  private renewedFrom: Date | null = null;
  private lastPersistedMs = 0;

  constructor(private readonly path: string) {
    const stored = this.read();
    this.highestSeen = instantOrNull(stored?.highestSeen);
    this.renewedFrom = instantOrNull(stored?.renewedFrom);
    this.lastPersistedMs = this.highestSeen?.getTime() ?? 0;
  }

  /**
   * Record that this instant has been reached, and answer with the instant the
   * licence should be judged at.
   *
   * `behindMs` is a **signed** offset, which is the one thing about it worth
   * saying out loud: positive is the ordinary case it is named for, a clock
   * reading behind what this machine has already seen, and negative is the
   * other broken clock — one reading so far ahead that the mark refused to
   * follow it (see `IMPLAUSIBLE_FORWARD_JUMP_MS`). Both end up on the
   * entitlement as `clockBehindMs`, and the Settings page turns each into its
   * own sentence, so the owner is told their machine's date is wrong instead of
   * being told a licence they have paid for has run out.
   */
  observe(systemNow: Date): { readonly effectiveNow: Date; readonly behindMs: number } {
    const effectiveNow = effectiveLicenseNow(systemNow, this.highestSeen);
    const aheadMs = this.aheadOfMarkMs(systemNow);
    const behindMs = aheadMs > 0 ? -aheadMs : clockBehindMs(systemNow, this.highestSeen);

    if (aheadMs === 0) {
      const advanced = advancedHighWater(systemNow, this.highestSeen);
      this.highestSeen = advanced;
      if (advanced.getTime() - this.lastPersistedMs >= PERSIST_INTERVAL_MS) {
        this.persist();
      }
    }

    return { effectiveNow, behindMs };
  }

  /**
   * How far the system clock leads the mark when that lead is past believing,
   * and zero whenever it is not.
   *
   * Zero on a machine with no mark at all: a fresh install has nothing to judge
   * a reading against, and refusing to write the first one would leave the
   * anti-rollback mark permanently empty.
   */
  private aheadOfMarkMs(systemNow: Date): number {
    if (this.highestSeen === null) return 0;
    const ahead = systemNow.getTime() - this.highestSeen.getTime();
    return ahead > IMPLAUSIBLE_FORWARD_JUMP_MS ? ahead : 0;
  }

  /** The end of the term the installed licence renewed after, if it did. */
  renewalFrom(): Date | null {
    return this.renewedFrom;
  }

  /**
   * Called when a licence is installed over one that had already run out, so
   * D-36's `RESTORED` can be shown honestly rather than guessed at. Passing
   * null clears it: an ordinary renewal, made before the term ended, is not a
   * restoration and must not read as one.
   */
  recordRenewal(previousValidUntil: Date | null): void {
    this.renewedFrom = previousValidUntil;
    this.persist();
  }

  /**
   * Write the state down.
   *
   * **Never throws into a request.** A read-only disk is a problem for the
   * shop's administrator, not a reason to refuse a sale: the mark stays in
   * memory for the life of the process and the licence goes on being judged
   * correctly.
   */
  private persist(): void {
    const state: StoredState = {
      highestSeen: this.highestSeen?.toISOString() ?? null,
      renewedFrom: this.renewedFrom?.toISOString() ?? null,
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      this.lastPersistedMs = this.highestSeen?.getTime() ?? 0;
    } catch {
      // Deliberately silent. Retried on the next interval.
    }
  }

  private read(): StoredState | null {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as StoredState;
    } catch {
      // Absent on a fresh install, and unreadable is treated the same way: the
      // system clock is then all there is, which is where every machine starts.
      return null;
    }
  }
}

function instantOrNull(value: string | null | undefined): Date | null {
  return parseInstant(value);
}
