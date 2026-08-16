import { createHash, randomBytes } from 'node:crypto';

import type { TenantContext, TokenIssuer } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import { signToken } from './jwt';

/** 256 bits of randomness — a refresh token is guessed, never derived. */
const REFRESH_TOKEN_BYTES = 32;

/** Binds the signing secret to the port, so use cases never see a secret. */
export class JwtTokenIssuer implements TokenIssuer {
  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  issueAccessToken(ctx: TenantContext): string {
    return signToken(ctx, this.secret, this.clock);
  }

  issueRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  /**
   * Plain SHA-256, deliberately — unlike a password, a refresh token is already
   * 256 bits of uniform randomness, so there is nothing for a slow hash to
   * defend against and a lookup happens on every request. The point of hashing
   * here is that a leaked database dump cannot be replayed as sessions.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  }
}
