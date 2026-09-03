import { ref } from 'vue';

/**
 * The signed-in session: a short-lived access token, the long-lived refresh
 * token that renews it, and the business it belongs to.
 *
 * A composable rather than a state library — there is one small piece of state
 * here, and adding Pinia for it would not survive the five questions in
 * "Anti-Overengineering". Slice 1.4's permission list is the point to revisit.
 *
 * `localStorage` is a deliberate trade-off. It survives a tab close, which is
 * what makes PIN login on a returning session possible at all (§5.3), and it is
 * what the Phase 12 offline PWA will need anyway. The refresh token is
 * revocable server-side, so a stolen one can be killed — which is the mitigation
 * that matters more than the storage choice.
 */
/**
 * What this user may do, so the app stops drawing controls that would 403
 * (UI-09; §5.26 "hide the control in the UI **and** enforce server-side").
 *
 * Held in memory only, deliberately. It is a hint for drawing the screen, not
 * an authority — every endpoint checks for itself — and persisting it would
 * mean a role change quietly stayed invisible until the browser was closed.
 */
const permissions = ref<readonly string[]>([]);

/**
 * Which §5.21 features this shop has switched on, by setting key.
 *
 * Held beside the permissions and for the same reason: the shell has to decide
 * whether Vendors and Customer Groups exist at all before it can draw itself
 * (§5.6 — the tab is *absent* while the feature is off, not disabled). In
 * memory only, so switching a feature on in Settings takes effect on the next
 * shell mount rather than surviving in storage after it was switched off.
 */
const features = ref<readonly string[]>([]);

const ACCESS_KEY = 'sher.accessToken';
const REFRESH_KEY = 'sher.refreshToken';
const BUSINESS_KEY = 'sher.businessName';
const USERNAME_KEY = 'sher.username';
/**
 * The person who signed in on this machine while the line was down (§5.23,
 * Phase 12.4).
 *
 * Persisted, unlike everything else about an offline session's *shape*, because
 * an outage is exactly when a browser gets reloaded — a power blip, an
 * accidental refresh, the PWA being reopened — and there is no server to sign
 * in to again. What it holds is what the snapshot already put on this disk.
 */
const OFFLINE_KEY = 'sher.offlineSession';

/** What the snapshot knows about the person at the counter, and nothing more. */
export interface OfflineSessionUser {
  readonly id: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly permissions: readonly string[];
  readonly features: readonly string[];
}

function readOfflineSession(): OfflineSessionUser | null {
  const raw = localStorage.getItem(OFFLINE_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as OfflineSessionUser;
  } catch {
    return null;
  }
}

const accessToken = ref<string | null>(localStorage.getItem(ACCESS_KEY));
const refreshToken = ref<string | null>(localStorage.getItem(REFRESH_KEY));
const businessName = ref<string | null>(localStorage.getItem(BUSINESS_KEY));
const username = ref<string | null>(localStorage.getItem(USERNAME_KEY));
const offlineUser = ref<OfflineSessionUser | null>(readOfflineSession());

/*
 * An offline session that survived a reload carries its own permissions and
 * features back into memory. `loadMyAccess` cannot fill them — it needs a
 * server — and a shell drawn with neither would hide every screen the cashier
 * is standing there to use.
 */
if (offlineUser.value !== null) {
  permissions.value = [...offlineUser.value.permissions];
  features.value = [...offlineUser.value.features];
}

function persist(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

export function useSession() {
  return {
    accessToken,
    refreshToken,
    businessName,
    username,

    permissions,

    offlineUser,

    /**
     * Phase 12.4: an offline session counts.
     *
     * The router guard asks this, and during an outage the honest answer is
     * yes — somebody proved who they were against the PIN hash the snapshot
     * brought down, and the screens they are about to use read the local copy
     * and write to the outbox. It is not an authority: there is no access token
     * behind it, every call still fails as unreachable and every queued
     * operation is judged by the server on replay.
     */
    isSignedIn: (): boolean => accessToken.value !== null || offlineUser.value !== null,

    /** True while the person at the counter got in without the server. */
    isOfflineSession: (): boolean => accessToken.value === null && offlineUser.value !== null,

    /**
     * Whether to *offer* something. Never a security decision — the server
     * refuses regardless, and a screen that believed a lie here would gain
     * nothing by it.
     */
    can: (permission: string): boolean => permissions.value.includes(permission),

    setPermissions(granted: readonly string[]): void {
      permissions.value = [...granted];
    },

    features,

    /** Whether a §5.21 feature is on. Like `can`, a hint for drawing, never a gate. */
    featureEnabled: (feature: string): boolean => features.value.includes(feature),

    setFeatures(enabled: readonly string[]): void {
      features.value = [...enabled];
    },

    /**
     * True when this browser has been signed in before and can offer PIN entry.
     * The PIN is only ever accepted alongside this device's refresh token, so a
     * PIN alone is never a login (§5.3).
     */
    canUsePin: (): boolean => refreshToken.value !== null && username.value !== null,

    signIn(tokens: { accessToken: string; refreshToken: string }, user: string): void {
      accessToken.value = tokens.accessToken;
      refreshToken.value = tokens.refreshToken;
      username.value = user;
      persist(ACCESS_KEY, tokens.accessToken);
      persist(REFRESH_KEY, tokens.refreshToken);
      persist(USERNAME_KEY, user);
    },

    /**
     * Opens a session against the snapshot alone (§5.23, §9).
     *
     * The stored **online** session is cleared first, always — an offline
     * session replaces the online one rather than sitting beside it.
     *
     * Clearing it only when the username differed was not enough, and the case
     * it missed is the ordinary one: a machine switched off overnight boots with
     * yesterday's expired access token still on disk, the same person signs in
     * offline, and the token stays. Everything downstream then reads this as an
     * online session — `isOfflineSession` is false, so the handover watch never
     * starts and the machine never asks for a real sign-in when the line
     * returns, while `loadMyAccess` keeps trying that dead token and blanking
     * the very permissions this just set.
     *
     * Nothing is lost by it. When the line comes back the person signs in for
     * real, which is already the design — the push endpoint needs a session the
     * server issued, and this one has none by design.
     */
    signInOffline(user: OfflineSessionUser): void {
      accessToken.value = null;
      refreshToken.value = null;
      username.value = null;
      persist(ACCESS_KEY, null);
      persist(REFRESH_KEY, null);
      persist(USERNAME_KEY, null);
      offlineUser.value = user;
      permissions.value = [...user.permissions];
      features.value = [...user.features];
      persist(OFFLINE_KEY, JSON.stringify(user));
    },

    /**
     * Ends the offline session, leaving any online one alone.
     *
     * Used when the line comes back: the queue stays on disk, and the person
     * signs in for real so their work goes up under a session the server
     * recognises.
     */
    endOfflineSession(): void {
      if (offlineUser.value === null) return;
      offlineUser.value = null;
      permissions.value = [];
      features.value = [];
      persist(OFFLINE_KEY, null);
    },

    setBusinessName(name: string): void {
      businessName.value = name;
      persist(BUSINESS_KEY, name);
    },

    /**
     * Forgets the access token but **keeps** the refresh token and username, so
     * the next visit can offer PIN entry. Used when an access token expires.
     */
    lock(): void {
      accessToken.value = null;
      persist(ACCESS_KEY, null);
    },

    /** A real sign-out: nothing about this account stays on the device. */
    clear(): void {
      permissions.value = [];
      features.value = [];
      accessToken.value = null;
      refreshToken.value = null;
      businessName.value = null;
      username.value = null;
      offlineUser.value = null;
      persist(ACCESS_KEY, null);
      persist(REFRESH_KEY, null);
      persist(BUSINESS_KEY, null);
      persist(USERNAME_KEY, null);
      persist(OFFLINE_KEY, null);
    },
  };
}
