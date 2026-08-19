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

/**
 * An instant a number of seconds after another one.
 *
 * Lives here because this file is the only place allowed to construct a `Date`
 * (R-C8) — a token expiry is still a derived time, and deriving it inline
 * elsewhere is exactly the ambient-clock use the rule exists to prevent.
 */
export function addSeconds(instant: Date, seconds: number): Date {
  return new Date(instant.getTime() + seconds * 1000);
}

/**
 * An ISO-8601 string as an instant, or `null` when it is not one.
 *
 * Here for the same reason as `addSeconds`: this file is the only place allowed
 * to construct a `Date` (R-C8). Parsing a timestamp that arrived from outside —
 * a licence key, an API response, a stored string — is not reading the ambient
 * clock, but the rule is enforced syntactically and rightly so: an exception
 * carved out for "just parsing" is exactly how an ambient `new Date()` gets
 * back in.
 *
 * Returns null rather than throwing, because every current caller is reading
 * data it does not control and has a defined answer for "that was not a date".
 */
export function parseInstant(iso: string | undefined | null): Date | null {
  if (iso === undefined || iso === null || iso === '') return null;
  const instant = new Date(iso);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * The instant a tenant-local calendar day begins, as UTC.
 *
 * The inverse of `businessDate`, and it lives here for the same reason
 * `addSeconds` does: this file is the only place allowed to construct a `Date`
 * (R-C8). Filtering "everything that happened on the 18th" needs the boundary
 * as an instant, because `created_at` is stored in UTC — and in Dhaka the 18th
 * begins at 18:00 UTC on the 17th. Comparing the UTC date instead would put six
 * hours of the day in the wrong bucket, which is the §3.5 mistake where "both
 * numbers look plausible".
 *
 * `date` is `YYYY-MM-DD`. Resolved by asking what UTC offset the zone was
 * actually using at that moment rather than assuming a fixed one, so a zone
 * with daylight saving stays correct.
 */
export function startOfBusinessDay(date: string, tz: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`invalid business date: ${date}`);

  // First guess: treat the local wall time as if it were UTC. That is wrong by
  // exactly the zone's offset, which the second step measures and removes.
  const asIfUtc = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(asIfUtc.getTime())) throw new RangeError(`invalid business date: ${date}`);

  const offsetMs = zoneOffsetMs(asIfUtc, tz);
  const corrected = new Date(asIfUtc.getTime() - offsetMs);

  // One more pass: near a daylight-saving change the offset at the corrected
  // instant can differ from the offset at the guess.
  return new Date(asIfUtc.getTime() - zoneOffsetMs(corrected, tz));
}

/** How far ahead of UTC `tz` is at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const find = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) throw new RangeError(`cannot resolve ${type} in timezone ${tz}`);
    return Number(part.value);
  };

  // `hour` formats midnight as 24 with hour12:false in some runtimes.
  const hour = find('hour') % 24;
  const asUtc = Date.UTC(
    find('year'),
    find('month') - 1,
    find('day'),
    hour,
    find('minute'),
    find('second'),
  );

  return asUtc - instant.getTime();
}

/**
 * The tenant-local calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 * The read direction of `startOfBusinessDay`, and the one a screen needs: a
 * stored `TIMESTAMPTZ` must be shown as the day the shop would call it (UI-33 —
 * "no screen renders a raw UTC instant"), and an instant 18:30 UTC is already
 * tomorrow in Dhaka.
 *
 * Distinct from `Clock.businessDate(tz)`, which is *today* and therefore reads
 * the machine clock. This one is pure: it converts an instant it is given.
 */
export function businessDateAt(instant: Date, tz: string): string {
  return businessDateOf(instant, tz);
}

/**
 * The last instant of a tenant-local day, as UTC — 23:59:59.999 local.
 *
 * For an inclusive upper bound stored as a timestamp: "this offer runs until the
 * 7th" means through the whole of the 7th in the shop's own timezone. Derived
 * from the start of the following day rather than by adding 24 hours, so a zone
 * with daylight saving cannot shift it by an hour.
 */
export function endOfBusinessDay(date: string, tz: string): Date {
  const start = startOfBusinessDay(date, tz);
  // Midday of the following local day is safely inside it whatever the offset
  // does, so the day it names is the right one to take the start of.
  const nextDay = businessDateOf(new Date(start.getTime() + 36 * 60 * 60 * 1000), tz);
  return new Date(startOfBusinessDay(nextDay, tz).getTime() - 1);
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
