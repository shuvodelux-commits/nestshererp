import { ref } from 'vue';

/**
 * The signed-in session. One access token and the business it belongs to.
 *
 * A composable rather than a state library: there is exactly one piece of state
 * here, and adding Pinia for it would not survive the five questions in
 * "Anti-Overengineering". When slice 1.2 adds refresh-token rotation and slice
 * 1.4 adds a permission list, that is the moment to revisit it.
 */
const TOKEN_KEY = 'sher.accessToken';
const BUSINESS_KEY = 'sher.businessName';

const accessToken = ref<string | null>(localStorage.getItem(TOKEN_KEY));
const businessName = ref<string | null>(localStorage.getItem(BUSINESS_KEY));

export function useSession() {
  return {
    accessToken,
    businessName,
    isSignedIn: (): boolean => accessToken.value !== null,
    signIn(token: string, business: string): void {
      accessToken.value = token;
      businessName.value = business;
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(BUSINESS_KEY, business);
    },
    signOut(): void {
      accessToken.value = null;
      businessName.value = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(BUSINESS_KEY);
    },
  };
}
