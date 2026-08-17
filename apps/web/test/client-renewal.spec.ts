import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, request } from '../src/api/client';
import { useSession } from '../src/auth/session';

/**
 * Renewing an expired access token (§5.3: 15 minutes, against a 30-day refresh
 * token). Without this a screen left open for a quarter of an hour throws the
 * user back to the login page while their session is still perfectly valid.
 *
 * Responses are matched on URL rather than queued in order: `/config.json` is
 * fetched once and cached for the module's lifetime, so an ordered queue would
 * drift by one from the second test onward.
 */
const fetchMock = vi.fn();

function reply(status: number, body: unknown = undefined): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function unauthorized(): Response {
  return reply(401, { error: { code: 'UNAUTHENTICATED', message: 'Token expired' } });
}

function renewed(accessToken: string, refreshToken: string): Response {
  return reply(200, {
    data: { accessToken, refreshToken, user: { id: 'U', username: 'karim' } },
  });
}

/**
 * `onApi` answers everything that is not `/config.json` or the refresh call.
 * `onRefresh` answers the refresh call; the default renews successfully.
 */
function serve(options: {
  onApi: (url: string) => Response;
  onRefresh?: () => Response;
}): void {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/config.json') return Promise.resolve(reply(200, { apiBaseUrl: 'http://api.test' }));
    if (url.endsWith('/auth/refresh')) {
      return Promise.resolve((options.onRefresh ?? (() => renewed('new-access', 'new-refresh')))());
    }
    return Promise.resolve(options.onApi(url));
  });
}

function apiCalls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url !== '/config.json');
}

function authHeaderOf(url: string, occurrence: number): string | undefined {
  const matches = fetchMock.mock.calls.filter((call) => String(call[0]) === url);
  const init = matches[occurrence]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.['authorization'];
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  useSession().signIn({ accessToken: 'old-access', refreshToken: 'old-refresh' }, 'karim');
});

afterEach(() => {
  useSession().clear();
  vi.unstubAllGlobals();
});

describe('an expired access token', () => {
  it('is renewed and the original request retried, with the new token', async () => {
    let refused = false;
    serve({
      onApi: () => {
        if (refused) return reply(200, { data: { businessName: 'Karim Traders' } });
        refused = true;
        return unauthorized();
      },
    });

    const result = await request('/api/v1/dashboard/summary', { token: 'old-access' });

    expect(result).toEqual({ businessName: 'Karim Traders' });
    expect(apiCalls()).toEqual([
      'http://api.test/api/v1/dashboard/summary',
      'http://api.test/api/v1/auth/refresh',
      'http://api.test/api/v1/dashboard/summary',
    ]);

    // The retry must carry the *new* token — the caller still holds the old one.
    const url = 'http://api.test/api/v1/dashboard/summary';
    expect(authHeaderOf(url, 0)).toBe('Bearer old-access');
    expect(authHeaderOf(url, 1)).toBe('Bearer new-access');

    expect(useSession().accessToken.value).toBe('new-access');
    expect(useSession().refreshToken.value).toBe('new-refresh');
  });

  it('renews once for several requests that expire together', async () => {
    let toRefuse = 3;
    serve({
      onApi: () => {
        if (toRefuse > 0) {
          toRefuse -= 1;
          return unauthorized();
        }
        return reply(200, { data: 'ok' });
      },
    });

    const results = await Promise.all([
      request('/api/v1/a', { token: 'old-access' }),
      request('/api/v1/b', { token: 'old-access' }),
      request('/api/v1/c', { token: 'old-access' }),
    ]);

    expect(results).toEqual(['ok', 'ok', 'ok']);
    // Refresh tokens rotate: a second renewal would revoke the first one's
    // replacement and end the session outright.
    expect(apiCalls().filter((url) => url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('gives up and forgets the session when the refresh token is dead too', async () => {
    serve({ onApi: () => unauthorized(), onRefresh: () => unauthorized() });

    await expect(request('/api/v1/dashboard/summary', { token: 'old-access' })).rejects.toThrow(
      ApiError,
    );

    // Cleared, so the router sends the user to sign in rather than looping.
    expect(useSession().accessToken.value).toBeNull();
    expect(useSession().refreshToken.value).toBeNull();
  });

  it('retries only once — it never loops', async () => {
    serve({ onApi: () => unauthorized() });

    await expect(request('/api/v1/dashboard/summary', { token: 'old-access' })).rejects.toThrow(
      ApiError,
    );

    // Original, refresh, one retry. No more.
    expect(apiCalls()).toHaveLength(3);
  });
});

describe('requests that carry no token', () => {
  it('are not retried — a 401 from signing in is a real answer', async () => {
    serve({
      onApi: () =>
        reply(401, { error: { code: 'UNAUTHENTICATED', message: 'That login is not correct' } }),
    });

    await expect(
      request('/api/v1/auth/login', { method: 'POST', body: { identifier: 'x', password: 'y' } }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(apiCalls().filter((url) => url.endsWith('/auth/refresh'))).toHaveLength(0);
    // A wrong password must not sign the user out of a session they still hold.
    expect(useSession().accessToken.value).toBe('old-access');
  });
});
