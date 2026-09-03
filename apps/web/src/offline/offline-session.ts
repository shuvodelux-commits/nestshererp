import { LIVE_FILE, localDbExists, localUsers } from '@sher/adapter-sqlite-wasm';
import { SystemClock } from '@sher/shared-utils';
import { watch } from 'vue';

import { useSession } from '../auth/session';
import type { OfflineSessionUser } from '../auth/session';
import { appIsBusy } from './app-busy';
import { checkConnectivity, useConnectivity } from './connectivity';
import { verifyPin } from './pin';

/**
 * Opening the counter on a machine that was switched off during the outage
 * (§5.23, §9, D-01, Phase 12.4).
 *
 * Everything else about offline trading assumes a tab that was already signed
 * in when the line dropped. This is the other half, and the one a shop actually
 * meets: the power came back at eight in the morning, the broadband did not,
 * and the computer boots to a login screen it cannot reach a server from.
 *
 * The snapshot already carries what is needed — each permitted user's id, name,
 * PIN hash and permissions, written down in §9 as *"the PIN hash travels; the
 * password hash never does"*. So the sign-in offered here is a person and four
 * digits, and a user with no PIN simply cannot work offline, which the screen
 * says rather than falling back to something weaker.
 *
 * **What this opens is a local session, not an authority.** There is no access
 * token behind it. Reads come from the copy on this disk, writes go to the
 * outbox, and every one of them is replayed by the server, later, through the
 * same online service the counter would have called — under the server's own
 * permission checks and against a device authority it may since have revoked.
 * A PIN accepted here never decides what the books accept.
 */

/** Time comes from the Clock port, here as everywhere else (B-clock). */
const clock = new SystemClock();

/** Why the machine cannot offer an offline sign-in, in the order it is asked. */
export type OfflineSignInBlock = 'ONLINE' | 'NO_COPY' | 'NO_USERS';

/** Somebody the snapshot says may open this counter. */
export interface OfflineCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly username: string | null;
}

/**
 * The last feature list the server gave this browser (§5.21).
 *
 * Mirrored to storage for one purpose: an offline session has to draw the same
 * shell as the online one, and the shell decides whether Vendors and Customer
 * Groups exist at all before it draws a single tab (§5.6 — the tab is *absent*
 * while the feature is off). The live list stays in memory as it always has;
 * this copy is only ever read when there is no server to ask.
 */
const FEATURES_KEY = 'sher.lastFeatures';

export function rememberFeatures(features: readonly string[]): void {
  try {
    localStorage.setItem(FEATURES_KEY, JSON.stringify(features));
  } catch {
    // A browser that will not store this still works; it draws the shell with
    // optional modules hidden, which is the safe direction.
  }
}

function lastKnownFeatures(): readonly string[] {
  const raw = localStorage.getItem(FEATURES_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Five wrong PINs, then a wait (§5.3's lockout, kept locally because there is
 * nobody to ask).
 *
 * On disk rather than in memory: a four-digit PIN has ten thousand values, and
 * a lockout that a page reload clears is not a lockout at all — it is a pause
 * for whoever is patient enough to press F5.
 */
const LOCK_KEY = 'sher.offlinePinLock';
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

interface LockState {
  readonly failures: number;
  readonly until: number;
}

function readLock(): LockState {
  const raw = localStorage.getItem(LOCK_KEY);
  if (raw === null) return { failures: 0, until: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<LockState>;
    return { failures: Number(parsed.failures ?? 0), until: Number(parsed.until ?? 0) };
  } catch {
    return { failures: 0, until: 0 };
  }
}

function writeLock(state: LockState): void {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify(state));
  } catch {
    // Nothing to do: a browser refusing storage also refuses the snapshot, so
    // there is no offline sign-in to protect.
  }
}

/** Seconds left on a lockout, or 0 when there is none. */
export function lockedForSeconds(): number {
  const { until } = readLock();
  const left = until - clock.now().getTime();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Who may sign in here, or why nobody may.
 *
 * `ONLINE` first, deliberately: if the server can be reached then the real
 * sign-in is available, and offering the offline one beside it would invite a
 * cashier to take the weaker door every morning.
 */
export async function offlineSignInOptions(): Promise<
  { readonly users: readonly OfflineCandidate[] } | { readonly blocked: OfflineSignInBlock }
> {
  if (await checkConnectivity()) return { blocked: 'ONLINE' };
  if (!(await localDbExists(LIVE_FILE))) return { blocked: 'NO_COPY' };

  try {
    const users = await localUsers();
    if (users.length === 0) return { blocked: 'NO_USERS' };
    return {
      users: users.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        username: user.username,
      })),
    };
  } catch {
    return { blocked: 'NO_COPY' };
  }
}

export type OfflineSignInResult =
  | { readonly ok: true; readonly user: OfflineSessionUser }
  | { readonly ok: false; readonly reason: 'WRONG_PIN'; readonly attemptsLeft: number }
  | { readonly ok: false; readonly reason: 'LOCKED'; readonly seconds: number }
  | { readonly ok: false; readonly reason: 'NO_SUCH_USER' };

/**
 * Checks the PIN against the hash the snapshot brought down and, if it matches,
 * opens the session.
 *
 * The derivation is deliberately slow — that slowness is the whole protection
 * on a hash sitting on a shop computer — so callers show a "Checking…" state and
 * let a frame paint before awaiting this.
 */
export async function signInOffline(userId: string, pin: string): Promise<OfflineSignInResult> {
  const locked = lockedForSeconds();
  if (locked > 0) return { ok: false, reason: 'LOCKED', seconds: locked };

  const users = await localUsers();
  const user = users.find((candidate) => candidate.id === userId);
  if (user === undefined) return { ok: false, reason: 'NO_SUCH_USER' };

  if (!(await verifyPin(pin, user.pinHash))) {
    const failures = readLock().failures + 1;
    const until = failures >= MAX_FAILURES ? clock.now().getTime() + LOCK_MS : 0;
    writeLock({ failures: failures >= MAX_FAILURES ? 0 : failures, until });
    return until > 0
      ? { ok: false, reason: 'LOCKED', seconds: Math.ceil(LOCK_MS / 1000) }
      : { ok: false, reason: 'WRONG_PIN', attemptsLeft: MAX_FAILURES - failures };
  }

  writeLock({ failures: 0, until: 0 });
  const opened: OfflineSessionUser = {
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    permissions: user.permissions,
    features: lastKnownFeatures(),
  };
  useSession().signInOffline(opened);
  return { ok: true, user: opened };
}

/**
 * The handover, the moment the line comes back.
 *
 * An offline session cannot push its own queue: `POST /sync/push` needs a
 * session the server issued, and this one has no access token by design. So
 * when the server is reachable again the machine stops trading offline and asks
 * the person to sign in properly — the queue stays exactly where it is, on
 * disk, and goes up under a session the books recognise.
 *
 * It waits for `appIsBusy` to clear, reusing the rule the update bar already
 * follows (owner decision 2026-08-31): a cashier halfway through a bill is
 * never interrupted, however good the news is.
 *
 * **`ONLINE`, not "not offline".** Connectivity starts at `UNKNOWN` and every
 * screen treats that as online so it tries the server rather than serving a
 * stale copy — but here that reading would throw the cashier out at the very
 * first frame after a reload, in the middle of the outage, before the first
 * probe had answered. This one waits for the evidence.
 */
export function startOfflineSessionWatch(handOver: () => void): void {
  const session = useSession();
  const { state } = useConnectivity();

  watch(
    () => session.isOfflineSession() && state.value === 'ONLINE' && !appIsBusy.value,
    (ready) => {
      if (!ready) return;
      session.endOfflineSession();
      handOver();
    },
    { immediate: true },
  );
}
