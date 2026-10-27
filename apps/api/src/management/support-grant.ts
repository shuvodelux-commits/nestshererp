import { createPublicKey, verify as verifyBytes } from 'node:crypto';

import type { TenantContext } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';

import { managementState } from './management-state';

/**
 * The support grant, as this installation understands it.
 *
 * A deliberate local copy of the shape rather than an import from
 * `@sher/control-contracts`. The ERP is the thing being *protected* here, and
 * it should not gain a dependency on the vendor's control-plane package to
 * defend itself — an installation must be able to verify a grant with nothing
 * but its own build and a pinned public key, exactly as it verifies a licence
 * with nothing but its own build and an embedded key.
 *
 * The canonical form below must agree byte-for-byte with the control plane's
 * `canonicalJson`. It is sorted-key, no-whitespace JSON, and the field list is
 * fixed: an unknown field arriving from a future control plane would change the
 * bytes and fail verification, which is the correct outcome — this build cannot
 * reason about a grant it does not fully understand.
 */
export interface SupportGrant {
  readonly session_id: string;
  readonly operator_id: string;
  readonly operator_name: string;
  /** The vendor's own customer record. This installation does not act on it. */
  readonly tenant_id: string;
  /** This shop's own tenant id — the one every query is scoped by. */
  readonly erp_tenant_id: string;
  readonly installation_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly absolute_expires_at: string;
  readonly reason: string;
  readonly scope: string;
  readonly signing_key_id: string;
}

export const SUPPORT_GRANT_PREFIX = 'SHERSUP1';
export const SUPPORT_GRANT_HEADER = 'x-sher-support-grant';

/**
 * Routes closed to a support principal, whatever its scope says.
 *
 * Identity and erasure — the two things §15's audit trail cannot repair. A
 * vendor who can change the owner's password can return as the shop after the
 * session is over; one who can reset the business data or restore over it can
 * destroy the evidence of what they did.
 */
export const SUPPORT_FORBIDDEN_ROUTE_PREFIXES: readonly string[] = [
  // Identity. Credential changes are self-service and have no permission code,
  // so this is the only place they can be refused.
  '/api/v1/settings/security',
  '/api/v1/auth/password',
  '/api/v1/users',
  '/api/v1/roles',
  // Erasure. `/backup/reset` is Reset Business Data — the route really is under
  // `/backup`, not under `/settings`, and it must be named in full: it does
  // not start with `/api/v1/backup/restore`, so the restore prefix does not
  // cover it and for a while nothing did.
  '/api/v1/backup/restore',
  '/api/v1/backup/secret',
  '/api/v1/backup/reset',
];

/** Sorted keys, no whitespace — the same bytes the control plane signed. */
export function canonicalSupportGrant(grant: SupportGrant): string {
  const ordered: Record<string, string> = {
    absolute_expires_at: grant.absolute_expires_at,
    erp_tenant_id: grant.erp_tenant_id,
    expires_at: grant.expires_at,
    installation_id: grant.installation_id,
    issued_at: grant.issued_at,
    operator_id: grant.operator_id,
    operator_name: grant.operator_name,
    reason: grant.reason,
    scope: grant.scope,
    session_id: grant.session_id,
    signing_key_id: grant.signing_key_id,
    tenant_id: grant.tenant_id,
  };
  return JSON.stringify(ordered);
}

/**
 * Turns a signed grant into a tenant context, or refuses (§12, §13).
 *
 * A function rather than a guard, so that `TenantContextGuard` — the one guard
 * every route in the ERP already uses — can call it. Adding a second guard to
 * a few hundred controllers would have meant a few hundred chances to forget
 * one, and the forgotten one would be a route the vendor could not reach or,
 * far worse, one they could reach unchecked.
 *
 * Every check happens **here, on the shop's own machine**, against a key it
 * holds. A control plane that has been compromised cannot extend an expired
 * session, because expiry is inside bytes it cannot re-sign without the support
 * key — and that key lives in the signer, not the control plane (§5).
 */
export function verifySupportGrant(
  header: string,
  options: { supportPublicKey: string; path: string; now: Date },
): TenantContext {
  if (options.supportPublicKey === '') {
    /*
     * This installation was never configured to accept vendor support. Refusing
     * outright is the right default for a product sold as an independent
     * install: unconfigured means unsupportable, which is safer than a build
     * that trusts whatever key happens to arrive.
     */
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'This installation does not accept remote support');
  }

  let envelope: { grant?: SupportGrant; signature?: string };
  try {
    envelope = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as typeof envelope;
  } catch {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'That support grant could not be read');
  }
  const grant = envelope.grant;
  const signature = envelope.signature;
  if (grant === undefined || typeof signature !== 'string') {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'That support grant is incomplete');
  }

  // Canonicalised from the parsed grant, never from the received text — the
  // same discipline the licence verifier follows, and for the same reason: a
  // verifier that hashes what arrived can be fed a differently-shaped document
  // that means something else.
  let verified = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(options.supportPublicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    verified = verifyBytes(
      null,
      Buffer.from(`${SUPPORT_GRANT_PREFIX}.${canonicalSupportGrant(grant)}`, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'That support grant is not signed by this vendor');
  }

  const now = options.now.getTime();
  if (Date.parse(grant.expires_at) <= now) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'That support session has expired');
  }
  /*
   * The ceiling, checked separately from the sliding window.
   *
   * The control plane re-signs with a later `expires_at` on each request; this
   * is what stops it sliding past the four hours fixed when the session opened
   * (owner decision 2026-09-03). Two checks because they can only both be
   * enforced here — the control plane is the party being bounded.
   */
  if (Date.parse(grant.absolute_expires_at) <= now) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'That support session has reached its time limit');
  }
  if (grant.scope !== 'SUPER_SUPPORT') {
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'That support grant carries no usable scope');
  }

  if (SUPPORT_FORBIDDEN_ROUTE_PREFIXES.some((prefix) => options.path.startsWith(prefix))) {
    throw new AppError(
      ErrorCode.PERMISSION_DENIED,
      'A support session may not change credentials or users, or erase or restore data',
    );
  }

  /*
   * The timezone is this installation's, not the grant's.
   *
   * Business dates are computed in it (§3.5), so a correction made in a support
   * session must land on the same day it would have landed on had the owner
   * made it. Taking it from the grant would let the control plane decide what
   * day a customer's transaction belongs to, which is not the vendor's to
   * decide. It is cached by the management status endpoint the sidecar calls
   * every few minutes; if this process has restarted and not been asked yet,
   * the session is refused and the operator retries in a moment. Refusing is
   * the honest answer — guessing a timezone would silently misdate a posting.
   */
  const timezone = managementState.installationTimezone();
  if (timezone === null) {
    throw new AppError(
      ErrorCode.UNAUTHENTICATED,
      'This installation is not ready for a support session yet; try again in a moment',
    );
  }

  return {
    /*
     * The shop's own id, not the vendor's customer record.
     *
     * Getting this wrong is not a subtle failure — every query in the ERP is
     * scoped by `tenantId`, so the vendor's identifier here would either find
     * nothing or, on a multi-tenant developer database, find somebody else's
     * business. Two named fields instead of one overloaded one is what makes
     * the mistake impossible to make silently.
     */
    tenantId: grant.erp_tenant_id,
    // The vendor operator, never a shop user. Every audit row this session
    // writes carries it, so a vendor action is distinguishable from the owner's
    // own in the shop's own history (§15).
    userId: `support:${grant.operator_id}`,
    timezone,
  };
}
