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
const ACCESS_KEY = 'sher.accessToken';
const REFRESH_KEY = 'sher.refreshToken';
const BUSINESS_KEY = 'sher.businessName';
const USERNAME_KEY = 'sher.username';

const accessToken = ref<string | null>(localStorage.getItem(ACCESS_KEY));
const refreshToken = ref<string | null>(localStorage.getItem(REFRESH_KEY));
const businessName = ref<string | null>(localStorage.getItem(BUSINESS_KEY));
const username = ref<string | null>(localStorage.getItem(USERNAME_KEY));

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

    isSignedIn: (): boolean => accessToken.value !== null,

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
      accessToken.value = null;
      refreshToken.value = null;
      businessName.value = null;
      username.value = null;
      persist(ACCESS_KEY, null);
      persist(REFRESH_KEY, null);
      persist(BUSINESS_KEY, null);
      persist(USERNAME_KEY, null);
    },
  };
}
