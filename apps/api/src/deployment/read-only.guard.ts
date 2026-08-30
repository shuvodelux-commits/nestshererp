import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { EntitlementProvider } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import type { Request } from 'express';

import { CLOCK, ENTITLEMENT_PROVIDER } from '../infrastructure/tokens';

/**
 * D-36: a deployment whose licence term and grace period have both run out
 * accepts no new business writes.
 *
 * **What it must never do is take anything away.** D-36 is explicit: "There is
 * no state in which customer data is destroyed, hidden, or made un-exportable —
 * backup export works in every state including READ_ONLY." So this guard
 * refuses writes and nothing else:
 *
 *   Reads pass. The shop can open every ledger, report and invoice it has.
 *   Signing in passes. Being locked out of the screen that explains why you are
 *     locked out is not a licence enforcement, it is a support call.
 *   Backup export passes (Phase 10). D-36 is explicit that backup export works
 *     in every state including READ_ONLY, and gating it would hold a business's
 *     own records hostage over an unpaid renewal.
 *   Restore passes too. A shop recovering from a dead machine onto a fresh one,
 *     with a licence that lapsed while the computer was in a repair shop, must
 *     be able to get its books back — and the licence still governs everything
 *     it can do afterwards, so nothing is bypassed by letting it in.
 *
 * `GRACE` still writes. The 30 days after expiry exist precisely so that a late
 * renewal does not stop a shop trading, and treating grace as read-only would
 * throw away the whole point of the ladder.
 *
 * A guard, not a use-case check, unusually — and deliberately. This is not a
 * business rule about a document; it is a property of the whole deployment,
 * identical for every endpoint, and R-D2's reason for putting permissions in
 * the use case (MCP and offline bypass HTTP) is answered differently here: the
 * same `EntitlementProvider` is what those paths will consult, through the same
 * port.
 */
@Injectable()
export class ReadOnlyLicenseGuard implements CanActivate {
  constructor(
    @Inject(ENTITLEMENT_PROVIDER) private readonly entitlements: EntitlementProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (READ_METHODS.has(request.method)) return true;
    if (isAlwaysAllowed(request.path)) return true;

    const entitlement = this.entitlements.current(this.clock.now());
    if (entitlement.state !== 'READ_ONLY') return true;

    throw new AppError(
      ErrorCode.LICENSE_READ_ONLY,
      'This SherERP licence has expired, so new entries cannot be saved. ' +
        'Everything already recorded is still here and can still be read and exported. ' +
        'Renew the licence to start entering again.',
    );
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths that write but are not business writes. Signing in, refreshing a token
 * and signing out must keep working — otherwise nobody can reach the screen
 * that says the licence lapsed, or take the backup D-36 promises them.
 */
function isAlwaysAllowed(path: string): boolean {
  return path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/backup/');
}
