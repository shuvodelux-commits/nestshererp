import { fetchMyAccess } from '../api/auth';
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

export async function loadMyAccess(force = false): Promise<void> {
  const session = useSession();
  if (loaded && !force) return;
  if (session.accessToken.value === null) return;

  try {
    const me = await fetchMyAccess(session.accessToken.value);
    session.setPermissions(me.permissions);
    if (me.businessName !== '') session.setBusinessName(me.businessName);
    loaded = true;
  } catch {
    session.setPermissions([]);
  }
}

/** After signing out, the next person to sign in must not inherit the last one's. */
export function forgetMyAccess(): void {
  loaded = false;
}
