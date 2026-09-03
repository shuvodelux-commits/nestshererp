/**
 * The console's single door to the control plane.
 *
 * Every request goes through here, which is what makes two things reliable
 * rather than remembered: the bearer token is attached once, and a
 * `REAUTH_REQUIRED` refusal is recognised in one place so every sensitive
 * action gets the same authenticator prompt (§24) instead of each screen
 * inventing its own.
 *
 * The token lives in `sessionStorage`, not `localStorage`: this console can
 * enter any customer's ERP, and a session that survives closing the browser is
 * a session an unattended laptop hands to whoever sits down next. The
 * server-side session row is the real authority — revoking it takes effect
 * immediately — but there is no reason to leave a usable token lying about.
 */
const TOKEN_KEY = 'sher.control.token';

export class ReauthRequired extends Error {
  constructor(readonly permission: string) {
    super('Confirm with your authenticator code to continue');
  }
}

export class ControlApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function storedToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = storedToken();
  const response = await fetch(`/api/control${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (response.ok) {
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: { permission?: string } };
  };
  const code = payload.error?.code ?? 'INTERNAL_ERROR';
  if (code === 'REAUTH_REQUIRED') {
    throw new ReauthRequired(payload.error?.details?.permission ?? '');
  }
  if (code === 'UNAUTHENTICATED') {
    clearToken();
  }
  throw new ControlApiError(code, payload.error?.message ?? 'Something went wrong');
}
