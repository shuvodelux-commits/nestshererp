import type { TenantContext, TokenIssuer } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import { signToken } from './jwt';

/** Binds the signing secret to the port, so use cases never see a secret. */
export class JwtTokenIssuer implements TokenIssuer {
  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  issueAccessToken(ctx: TenantContext): string {
    return signToken(ctx, this.secret, this.clock);
  }
}
