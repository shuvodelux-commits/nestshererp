import { randomUUID } from 'node:crypto';

/**
 * The E2E suite's way into SherERP: its own HTTP API (Phase 18.5).
 *
 * **The ERP owns the business state** (owner decision 2026-09-03). Every
 * customer, product, opening stock figure and opening cash balance the specs
 * trade against is created by calling the same endpoints the screens call, so
 * the movements, the lots and the journal entries behind every figure are the
 * real ones. Nothing here writes a balance.
 *
 * It is deliberately a thin client rather than a reuse of `apps/web/src/api`:
 * that module reads `/config.json` from a browser and renews tokens through a
 * session store, neither of which exists in a Node setup script.
 */

export const E2E_API_URL = process.env['E2E_API_URL'] ?? 'http://127.0.0.1:3100';

export class E2eApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${code} (${String(status)}): ${message}`);
  }
}

interface CallOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly token?: string;
  /** Sent as `Idempotency-Key`; every create endpoint requires one (§5.26). */
  readonly idempotent?: boolean;
  /** Return the whole envelope rather than unwrapping `data`. */
  readonly envelope?: boolean;
}

/**
 * A ULID, near enough for a test.
 *
 * The API only checks that `Idempotency-Key` is 26 characters — it is an opaque
 * key, and a spec needs uniqueness rather than sortability. Crockford's
 * alphabet excludes I, L, O and U, so a UUID's hex digits are safely inside it.
 */
export function operationKey(): string {
  return randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase().replace(/[ILOU]/g, 'X');
}

export async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.idempotent === true) headers['idempotency-key'] = operationKey();

  const response = await fetch(`${E2E_API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  const parsed: unknown = text === '' ? {} : JSON.parse(text);

  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } }).error ?? {};
    throw new E2eApiError(response.status, error.code ?? 'UNKNOWN', error.message ?? text);
  }

  return (options.envelope === true ? parsed : (parsed as { data?: T }).data ?? parsed) as T;
}

/** Signs in and returns the access token. */
export async function login(identifier: string, password: string): Promise<string> {
  const result = await call<{ accessToken: string }>('/api/v1/auth/login', {
    method: 'POST',
    body: { identifier, password },
  });
  return result.accessToken;
}
