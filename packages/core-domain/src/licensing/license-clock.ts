/**
 * The monotonic licence clock (owner decision 2026-09-02).
 *
 * An on-premise installation never phones home, so the only clock a licence can
 * be judged against is the shop's own — and that clock can be wound back. This
 * is what stops that buying anything: SherERP remembers the latest instant it
 * has ever seen, and judges the licence at **the later of** that mark and the
 * system clock. Time can stand still for the licence; it can never run
 * backwards.
 *
 * **Three things it deliberately does not do.** It never forces READ_ONLY on
 * its own — a shop whose CMOS battery died on a Friday night has a wrong clock,
 * not a dishonest owner. It never touches a business date, a period or a
 * posting: those come from the clock port like everything else, and a licence
 * concern must not move the shop's books by a day. And it never runs the mark
 * forward on its own: the mark only ever records a time the machine actually
 * reached.
 *
 * Pure: both instants are passed in (R-C8).
 */

/** Tolerated backwards drift before anything is said out loud. */
const DRIFT_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The instant a licence is judged at.
 *
 * `highWater` is the latest instant this machine has recorded seeing, or null
 * on an installation that has never written one — a fresh install, or one whose
 * state file was removed, both of which simply mean "the system clock is all we
 * have".
 */
export function effectiveLicenseNow(systemNow: Date, highWater: Date | null): Date {
  if (highWater === null) return systemNow;
  return systemNow.getTime() >= highWater.getTime() ? systemNow : highWater;
}

/** How far the machine's clock reads behind what it has already seen, in ms. */
export function clockBehindMs(systemNow: Date, highWater: Date | null): number {
  if (highWater === null) return 0;
  return Math.max(0, highWater.getTime() - systemNow.getTime());
}

/**
 * Whether the drift is worth telling somebody about.
 *
 * A few minutes is an NTP correction and saying so would be noise; a day is a
 * machine that will date-stamp its own paperwork wrong, which the owner wants
 * to know about for reasons that have nothing to do with the licence.
 */
export function clockLooksWrong(systemNow: Date, highWater: Date | null): boolean {
  return clockBehindMs(systemNow, highWater) > DRIFT_TOLERANCE_MS;
}

/**
 * The mark to store after this observation: the furthest forward ever seen.
 *
 * It answers "how far forward", never "should this reading be believed at all".
 * That second question is about the hardware rather than the licence — a clock
 * announcing 2038 is a dead battery, not a term — and it is answered where the
 * mark is actually written down, by `MachineLicenseState`, which simply does
 * not call this when the jump is past believing.
 */
export function advancedHighWater(systemNow: Date, highWater: Date | null): Date {
  return effectiveLicenseNow(systemNow, highWater);
}
