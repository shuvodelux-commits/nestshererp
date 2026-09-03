import { fetchMyAccess } from '../api/auth';
import { ApiError } from '../api/client';
import { rememberFeatures } from '../offline/offline-session';
import { useSession } from './session';

/**
 * Loads what the signed-in user may do, so the shell can stop drawing controls
 * that would 403 (UI-09).
 *
 * Called once per shell mount rather than per screen: a role change takes effect
 * server-side immediately (§5.3), and a page navigation is the natural moment to
 * notice. Refreshing it on every click would be a request per click for
 * information that rarely changes.
 *
 * A failure is deliberately quiet. If this call cannot be made, the app draws
 * itself with nothing offered — which is the safe direction — and the endpoints
 * still refuse anything that was somehow reached. Surfacing an error banner here
 * would put an alarm on every screen for something the user cannot act on.
 */
let loaded = false;

/**
 * What the shell needs to know about how this went (Phase 12.4).
 *
 * `UNREACHABLE` is separated from every other failure because the two call for
 * opposite answers: a refusal means this user may do nothing, and an unreachable
 * server means nothing is known at all. Only the shell can act on it — it owns
 * the router — so it is reported rather than handled here.
 */
export type AccessLoad = 'LOADED' | 'SKIPPED' | 'REFUSED' | 'UNREACHABLE';

export async function loadMyAccess(force = false): Promise<AccessLoad> {
  const session = useSession();
  if (loaded && !force) return 'SKIPPED';
  if (session.accessToken.value === null) return 'SKIPPED';

  try {
    const me = await fetchMyAccess(session.accessToken.value);
    session.setPermissions(me.permissions);
    session.setFeatures(me.features);
    // Phase 12.4: the last list the server gave us, kept so a machine opened
    // cold during an outage draws the same tabs it drew yesterday.
    rememberFeatures(me.features);
    if (me.businessName !== '') session.setBusinessName(me.businessName);
    loaded = true;
    return 'LOADED';
  } catch (cause) {
    /*
     * Phase 12.4: a dead line is not a refusal, and must not be treated as one.
     *
     * Blanking is right when the server answered — the safe direction for a role
     * that was taken away. When the server never answered, it erases what is
     * already known: an offline session carries its own permissions, read from
     * the snapshot, and wiping them here leaves a cashier standing at a shell
     * with every screen hidden in the middle of the outage they were told they
     * could trade through.
     */
    if (cause instanceof ApiError && cause.code === 'NETWORK_UNREACHABLE') return 'UNREACHABLE';
    session.setPermissions([]);
    session.setFeatures([]);
    return 'REFUSED';
  }
}

/** After signing out, the next person to sign in must not inherit the last one's. */
export function forgetMyAccess(): void {
  loaded = false;
}
