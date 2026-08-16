import { loadConfig } from '../api/client';

/**
 * Google sign-in via the OpenID Connect **redirect** flow (D-07).
 *
 * Deliberately not Google's `gsi/client` script. UI-06 requires every asset to
 * be self-hosted, and §6.5 puts COOP/COEP on the app origin for SQLite WASM in
 * Phase 12 — a third-party script tag breaks both. A plain redirect needs no
 * script at all, and no client secret either: `response_type=id_token` returns
 * the token straight to the browser, and the server verifies it.
 *
 * The Google console therefore needs an **Authorized redirect URI**, not only a
 * JavaScript origin: `<app origin>/auth/google/callback`.
 */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const NONCE_KEY = 'sher.googleNonce';

export const GOOGLE_REDIRECT_PATH = '/auth/google/callback';

function redirectUri(): string {
  return `${window.location.origin}${GOOGLE_REDIRECT_PATH}`;
}

/**
 * A single-use random value echoed back inside the ID token, so a token minted
 * for some other page cannot be replayed into this one. `sessionStorage`, not
 * `localStorage`: it belongs to this tab and this attempt only.
 */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(NONCE_KEY, nonce);
  return nonce;
}

/** Sends the browser to Google. Returns false when no client id is configured. */
export async function startGoogleSignIn(): Promise<boolean> {
  const { googleClientId } = await loadConfig();
  if (googleClientId === undefined || googleClientId === '') return false;

  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'id_token',
    scope: 'openid email',
    nonce: newNonce(),
    prompt: 'select_account',
  });

  window.location.assign(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  return true;
}

export interface GoogleCallbackResult {
  readonly idToken: string | null;
  readonly error: string | null;
}

/**
 * Reads the ID token Google left in the URL fragment and checks the nonce.
 *
 * The nonce check is a cross-check only — the server independently verifies the
 * signature, issuer, audience and expiry, and nothing here is trusted as proof
 * of identity.
 */
export function readGoogleCallback(): GoogleCallbackResult {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const expected = sessionStorage.getItem(NONCE_KEY);
  sessionStorage.removeItem(NONCE_KEY);

  const error = fragment.get('error');
  if (error !== null) return { idToken: null, error: `Google returned: ${error}` };

  const idToken = fragment.get('id_token');
  if (idToken === null) return { idToken: null, error: 'Google did not return a sign-in token.' };

  if (expected === null || claimedNonce(idToken) !== expected) {
    return { idToken: null, error: 'This sign-in did not start in this tab. Try again.' };
  }

  return { idToken, error: null };
}

/** Reads the nonce claim without verifying anything — the server does that. */
function claimedNonce(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (payload === undefined) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { nonce?: unknown };
    return typeof claims.nonce === 'string' ? claims.nonce : null;
  } catch {
    return null;
  }
}
