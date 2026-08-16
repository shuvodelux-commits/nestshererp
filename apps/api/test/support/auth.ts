import { createHmac } from 'node:crypto';

import { SystemClock } from '@sher/shared-utils';

import type { SeededTenant } from './database';

const clock = new SystemClock();
const ONE_HOUR_SECONDS = 3600;

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Issues the token Phase 1's login flow will issue (D-07). Tests never fabricate
 * a tenant context any other way — the whole point is that tenant_id can only
 * arrive through a signed token.
 */
export function signToken(tenant: SeededTenant, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      sub: tenant.userId,
      tid: tenant.tenantId,
      tz: tenant.timezone,
      exp: Math.floor(clock.now().getTime() / 1000) + ONE_HOUR_SECONDS,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');

  return `${header}.${payload}.${signature}`;
}

export const TEST_JWT_SECRET = 'test-secret-not-used-in-production';
