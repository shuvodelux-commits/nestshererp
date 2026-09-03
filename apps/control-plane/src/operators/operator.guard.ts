import { Inject, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { OperatorPermission, OperatorRole } from '@sher/control-contracts';
import { REAUTH_ACTIONS, roleHas } from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import type { Request } from 'express';
import type pg from 'pg';

import { ControlError, ControlErrorCode } from '../common/errors';
import type { ControlPlaneConfig } from '../config';
import { verifyOperatorToken } from '../crypto/jwt';
import { CONTROL_CLOCK, CONTROL_CONFIG, CONTROL_POOL } from '../db/tokens';

/**
 * Who is asking, once the guard has established it.
 *
 * `reauthAt` travels with the principal rather than being looked up again by
 * each handler: §24's rule is about *this request*, and a handler that had to
 * remember to re-check would eventually be a handler that forgot.
 */
export interface OperatorPrincipal {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly email: string;
  readonly role: OperatorRole;
  readonly totpEnrolled: boolean;
  readonly reauthAt: Date | null;
  readonly ip: string;
  readonly userAgent: string;
}

export const RequirePermission = (permission: OperatorPermission): MethodDecorator =>
  SetMetadata('control:permission', permission);

/** Routes an un-enrolled operator may still reach, and nothing else. */
export const AllowUnenrolled = (): MethodDecorator => SetMetadata('control:allow-unenrolled', true);

export const Operator = createParamDecorator((_data: unknown, ctx: ExecutionContext): OperatorPrincipal => {
  const request = ctx.switchToHttp().getRequest<Request & { operator?: OperatorPrincipal }>();
  if (request.operator === undefined) {
    throw new ControlError(ControlErrorCode.UNAUTHENTICATED, 'Not signed in');
  }
  return request.operator;
});

/**
 * How long a re-authentication counts for, in seconds.
 *
 * Five minutes. Long enough to revoke three licences in a row without typing a
 * code three times; short enough that walking away from an unlocked laptop does
 * not leave the sensitive half of the console open behind you.
 */
const REAUTH_WINDOW_SECONDS = 5 * 60;

/**
 * The gate on every console route.
 *
 * Four checks in a fixed order, and the order matters: **is the token real**,
 * **is the session still alive**, **has this operator finished enrolling**, and
 * only then **may this role do this thing**. Looking up the session in the
 * database rather than trusting the token alone is what makes revocation
 * immediate — a JWT cannot be withdrawn, and this console can enter a
 * customer's ERP.
 *
 * The permission itself comes from `ROLE_PERMISSIONS` in the contracts package,
 * so the table an auditor reads is the table that is enforced. §23's example
 * separations — a support engineer who cannot reach the signer, a licence
 * operator who cannot deploy — are true here because the permission is simply
 * absent from the role's list, not because a handler remembered to check.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CONFIG) private readonly config: ControlPlaneConfig,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { operator?: OperatorPrincipal }>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new ControlError(ControlErrorCode.UNAUTHENTICATED, 'Not signed in');
    }

    const claims = verifyOperatorToken(header.slice('Bearer '.length), this.config.jwtSecret, this.clock.now());
    if (claims === null) {
      throw new ControlError(ControlErrorCode.UNAUTHENTICATED, 'Not signed in');
    }

    const found = await this.pool.query<{
      name: string;
      email: string;
      role: OperatorRole;
      totp_enrolled: boolean;
      disabled_at: Date | null;
      reauth_at: Date | null;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT o.name, o.email, o.role, o.totp_enrolled, o.disabled_at,
              s.reauth_at, s.revoked_at, s.expires_at
         FROM operator_sessions s
         JOIN operators o ON o.id = s.operator_id
        WHERE s.id = $1 AND s.operator_id = $2`,
      [claims.sid, claims.sub],
    );
    const row = found.rows[0];
    const now = this.clock.now();
    if (
      row === undefined ||
      row.revoked_at !== null ||
      row.disabled_at !== null ||
      row.expires_at.getTime() <= now.getTime()
    ) {
      throw new ControlError(ControlErrorCode.UNAUTHENTICATED, 'That session has ended');
    }

    const principal: OperatorPrincipal = {
      id: claims.sub,
      sessionId: claims.sid,
      name: row.name,
      email: row.email,
      role: row.role,
      totpEnrolled: row.totp_enrolled,
      reauthAt: row.reauth_at,
      ip: ipOf(request),
      userAgent: String(request.headers['user-agent'] ?? ''),
    };
    request.operator = principal;

    const allowUnenrolled = metadataOf<boolean>(context, 'control:allow-unenrolled') ?? false;
    if (!row.totp_enrolled && !allowUnenrolled) {
      throw new ControlError(
        ControlErrorCode.PERMISSION_DENIED,
        'Finish setting up your authenticator app before using the console',
      );
    }

    const permission = metadataOf<OperatorPermission>(context, 'control:permission');
    if (permission === undefined) return true;

    if (!roleHas(row.role, permission)) {
      throw new ControlError(
        ControlErrorCode.PERMISSION_DENIED,
        `Your role does not include ${permission}`,
      );
    }

    /*
     * §24. The sensitive actions each either reach into a customer's
     * installation or change what they are allowed to run, and being signed in
     * this morning is not evidence that the person at the keyboard now is the
     * operator.
     */
    if (REAUTH_ACTIONS.includes(permission)) {
      const fresh =
        principal.reauthAt !== null &&
        now.getTime() - principal.reauthAt.getTime() < REAUTH_WINDOW_SECONDS * 1000;
      if (!fresh) {
        throw new ControlError(
          ControlErrorCode.REAUTH_REQUIRED,
          'Confirm with your authenticator code to continue',
          { permission },
        );
      }
    }

    return true;
  }
}

/**
 * Route metadata, handler first and then the controller.
 *
 * What `Reflector.getAllAndOverride` does, written out: the decorator on a
 * method wins over the one on its class, so a controller can set a default
 * permission and one route can tighten it.
 */
function metadataOf<T>(context: ExecutionContext, key: string): T | undefined {
  const onHandler = Reflect.getMetadata(key, context.getHandler()) as T | undefined;
  if (onHandler !== undefined) return onHandler;
  return Reflect.getMetadata(key, context.getClass()) as T | undefined;
}

function ipOf(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded !== '') return forwarded.split(',')[0]?.trim() ?? '';
  return request.ip ?? '';
}
