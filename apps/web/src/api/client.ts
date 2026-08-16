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

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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

  const payload = (await response.json()) as { data: T };
  return payload.data;
}
