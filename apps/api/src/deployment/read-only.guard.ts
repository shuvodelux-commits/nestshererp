import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { EntitlementProvider, TenantContext } from '@sher/core-application';
import { entitlementFor } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import type { Request } from 'express';

import { verifyToken } from '../auth/jwt';
import type { ApiConfig } from '../config';
import { API_CONFIG, CLOCK, ENTITLEMENT_PROVIDER } from '../infrastructure/tokens';

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
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (READ_METHODS.has(request.method)) return true;
    if (isAlwaysAllowed(request.path)) return true;

    /*
     * Judged against the business making the request, so a licence file
     * belonging to another shop entitles this one to nothing (owner decision
     * 2026-09-02). The tenant is read from the bearer token here rather than
     * from `request.tenantContext`, which the controller-level guard has not
     * set yet: a global guard runs first. An unreadable token leaves it null,
     * the binding unjudged, and authentication to refuse the request a moment
     * later as it always would.
     */
    const entitlement = entitlementFor(
      this.entitlements.current(this.clock.now()),
      tenantIdOf(request, this.config, this.clock),
    );
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
 * Paths that write but are not business writes.
 *
 * Every one of them is a way out of READ_ONLY or a way to rescue what is
 * already here, and closing any of them would trap a shop inside the state
 * meant to make it renew (owner decisions 2026-09-02):
 *
 *   `auth`     signing in, refreshing, signing out. Being locked out of the
 *              screen that explains the lock is a support call, not enforcement.
 *   `backup`   export and restore, which D-36 promises in every state.
 *   `license`  reading the licence, and **installing one** — the single action
 *              that ends READ_ONLY. A licence screen that could not accept a
 *              renewal while the licence had lapsed would be useless exactly
 *              when it is needed.
 *   `health`   diagnostics, for whoever is trying to work out what is wrong.
 *
 * **`/api/v1/sync/` used to be on this list and is deliberately not any more.**
 * The reason given for it was that "whether each operation may post is decided
 * per operation at replay" — and nothing in the replay path ever consulted the
 * entitlement provider, so the exemption did not narrow the hole, it *was* the
 * hole: a lapsed shop could go on selling on an offline machine for ever and
 * push the sales up, which is D-36's READ_ONLY defeated entirely. Nothing had
 * to be added in its place. `pull`, `status` and `conflicts` are all `GET` and
 * pass on `READ_METHODS` above — a lapsed shop must always be able to read and
 * export its own data — while `POST push` and `POST conflicts/:id/resolve`,
 * the two endpoints that put new business documents into the books, now meet
 * the same refusal a sale typed at the counter would.
 */
function isAlwaysAllowed(path: string): boolean {
  return (
    path.startsWith('/api/v1/auth/') ||
    path.startsWith('/api/v1/backup/') ||
    path === '/api/v1/license' ||
    path.startsWith('/api/v1/license/') ||
    path.startsWith('/health')
  );
}

/** The business making this request, or null when the token cannot be read. */
function tenantIdOf(request: Request, config: ApiConfig, clock: Clock): string | null {
  const existing = (request as Request & { tenantContext?: TenantContext }).tenantContext;
  if (existing !== undefined) return existing.tenantId;

  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  try {
    return verifyToken(header.slice('Bearer '.length), config.jwtSecret, clock).tenantId;
  } catch {
    return null;
  }
}
