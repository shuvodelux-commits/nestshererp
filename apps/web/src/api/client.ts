import type { LoginResponse } from '@sher/core-contracts';

import { useSession } from '../auth/session';

/**
 * The HTTP client.
 *
 * UI-07 / §6.5: the API base URL is read at **runtime** from `/config.json`.
 * `import.meta.env.VITE_API_URL` is banned — baking it in forces a per-customer
 * frontend build and collapses the one-artifact rule.
 */
export interface RuntimeConfig {
  readonly apiBaseUrl: string;
  /**
   * Google OAuth client id (D-07). Absent until the deployment supplies one —
   * the sign-in button says so rather than failing silently when it is missing.
   */
  readonly googleClientId?: string;
}

let configPromise: Promise<RuntimeConfig> | null = null;

export function loadConfig(): Promise<RuntimeConfig> {
  configPromise ??= fetch('/config.json').then(async (response) => {
    if (!response.ok) throw new Error(`Cannot read /config.json (${String(response.status)})`);
    return (await response.json()) as RuntimeConfig;
  });
  return configPromise;
}

/**
 * A failed request, carrying the server's own error code and message.
 *
 * UI-28: the screen shows these, never "Something went wrong". Clients switch on
 * `code`, never on `message` (§5.26).
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly token?: string | undefined;
  /** ULID, generated once per user intent and reused on retry (UI-34). */
  readonly idempotencyKey?: string;
}

/**
 * One renewal at a time, shared by every caller that hits a 401 together.
 *
 * Refresh tokens **rotate**: using one revokes it and issues a replacement. Two
 * renewals racing would each revoke the other's token and end the session
 * outright, so concurrent callers wait on the same promise instead.
 */
let renewalInFlight: Promise<boolean> | null = null;

function currentAccessToken(): string | null {
  return useSession().accessToken.value;
}

async function renewAccessToken(): Promise<boolean> {
  renewalInFlight ??= renewOnce().finally(() => {
    renewalInFlight = null;
  });
  return renewalInFlight;
}

/**
 * Called directly rather than through `api/auth`, which imports this module —
 * routing it back through there would be a circular import.
 */
async function renewOnce(): Promise<boolean> {
  const session = useSession();
  const refreshToken = session.refreshToken.value;
  if (refreshToken === null) return false;

  try {
    const renewed = await send<LoginResponse>('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    });
    session.signIn(renewed, renewed.user.username);
    return true;
  } catch {
    // The session is genuinely over — revoked, expired, or already rotated.
    // Forget it so the router sends the user to sign in rather than looping.
    session.clear();
    return false;
  }
}

async function send<T>(path: string, options: RequestOptions): Promise<T> {
  const { apiBaseUrl } = await loadConfig();
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // A dead network is not a server error code, and must not be reported as one.
    throw new ApiError('NETWORK_UNREACHABLE', 'Cannot reach the server. Check your connection.', 0);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    throw new ApiError(
      body.error?.code ?? 'INTERNAL_ERROR',
      body.error?.message ?? 'The server rejected this request.',
      response.status,
    );
  }

  // 204 carries no body — logging out returns nothing to unwrap.
  if (response.status === 204) return undefined as T;

  const payload = (await response.json()) as { data: T };
  return payload.data;
}

/**
 * Sends a request, renewing an expired access token once and retrying.
 *
 * Access tokens last 15 minutes; refresh tokens last 30 days (§5.3). Without
 * this, a screen left open for a quarter of an hour throws the user back to the
 * login page even though their session is still perfectly valid.
 *
 * Only requests that carried a bearer token are retried. Signing in, refreshing
 * and logging out send none, so a 401 from those is a real answer and is passed
 * straight through — which is also what stops a failed refresh from looping.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await send<T>(path, options);
  } catch (cause) {
    const expired = cause instanceof ApiError && cause.status === 401;
    if (!expired || options.token === undefined) throw cause;

    if (!(await renewAccessToken())) throw cause;

    // Deliberately re-read the token rather than reusing the one passed in:
    // the renewal above replaced it, and the caller still holds the old value.
    return send<T>(path, { ...options, token: currentAccessToken() ?? options.token });
  }
}
