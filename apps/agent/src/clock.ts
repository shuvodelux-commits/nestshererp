import { SystemClock } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

/**
 * The sidecar's one clock.
 *
 * `pnpm test:boundaries` allows `new Date()` in exactly one file in this
 * repository, and it is not this one — every process takes time through the
 * `Clock` port. That rule matters more here than almost anywhere: a signed
 * request carries an `issued_at` the control plane checks against a five-minute
 * window, and a support grant is judged against a wall clock on the shop's own
 * machine. Reading time from a port rather than from the ambient global is what
 * makes both of those a decision rather than an accident.
 */
export const clock: Clock = new SystemClock();

/** The one shape every signed document and every report uses. */
export function nowIso(): string {
  return clock.now().toISOString();
}

/** Milliseconds since the epoch, for elapsed-time arithmetic only. */
export function nowMs(): number {
  return clock.now().getTime();
}
