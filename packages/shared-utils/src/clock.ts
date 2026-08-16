/**
 * The Clock port (SRS 3.5, D-29).
 *
 * This is the ONLY file in the repository allowed to call `new Date()` or
 * `Date.now()` — `pnpm test:boundaries` fails the build on any other use.
 * Everything else takes time as an argument or through this interface, which is
 * what makes domain logic deterministic and testable.
 */
export interface Clock {
  /** The current instant, always UTC — timestamps are stored TIMESTAMPTZ in UTC. */
  now(): Date;
  /**
   * The tenant-local business date as `YYYY-MM-DD`.
   *
   * A sale at 00:30 Dhaka is 18:30 UTC the previous day; reports, ledgers,
   * Daybook and period locks all use this date, not the UTC one.
   */
  businessDate(tz: string): string;
}

function businessDateOf(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const find = (type: 'year' | 'month' | 'day'): string => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) throw new RangeError(`cannot resolve ${type} in timezone ${tz}`);
    return part.value;
  };

  return `${find('year')}-${find('month')}-${find('day')}`;
}

/** Reads the machine clock. Used everywhere outside tests. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  businessDate(tz: string): string {
    return businessDateOf(this.now(), tz);
  }
}

/**
 * A clock frozen at one instant, so a test asserts numbers instead of drifting.
 * Takes an ISO-8601 string because `new Date()` is banned everywhere else — a
 * test never has to construct a Date to use it.
 */
export class FixedClock implements Clock {
  private readonly instant: Date;

  constructor(iso: string) {
    const instant = new Date(iso);
    if (Number.isNaN(instant.getTime())) throw new RangeError(`invalid instant: ${iso}`);
    this.instant = instant;
  }

  now(): Date {
    return new Date(this.instant.getTime());
  }

  businessDate(tz: string): string {
    return businessDateOf(this.instant, tz);
  }
}
