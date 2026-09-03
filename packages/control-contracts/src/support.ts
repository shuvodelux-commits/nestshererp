import { z } from 'zod';

/**
 * The signed grant that opens a support session (§12).
 *
 * **This is the whole of the vendor's authority inside a customer's ERP.** It
 * is not a password, it is not a user, and it cannot be stored and reused: it
 * names one session, one operator, one tenant, one installation, and it stops
 * being true at `expires_at` whatever anybody believes.
 *
 * Access is pre-authorized by the support arrangement, so the shop is not asked
 * to approve each visit (owner decision 2026-09-03). That places the entire
 * weight of containment on three things — the signature, the expiry, and
 * revocation — which is why all three are short, checked on every request, and
 * checked by the installation itself rather than by the control plane that
 * issued the grant.
 *
 * `reason` is mandatory and travels inside the signed bytes. An operator cannot
 * open a session without saying why, and cannot change why afterwards.
 */
export const supportGrantSchema = z
  .object({
    session_id: z.string().min(1).max(64),
    operator_id: z.string().min(1).max(64),
    /** Shown in the audit trail and in the customer's active-session indicator. */
    operator_name: z.string().min(1).max(120),
    /**
     * The **vendor's** customer record. Meaningful in the control plane only.
     *
     * Kept in the signed bytes so an audit can tie a grant back to the customer
     * it was issued for without consulting the database that issued it.
     */
    tenant_id: z.string().min(1).max(64),
    /**
     * The **shop's own** tenant id, from its own database.
     *
     * This is the one the installation acts on, and the two are deliberately
     * separate fields rather than one overloaded name. A vendor's customer
     * record and a shop's data-isolation boundary are different things; naming
     * them the same would eventually put one where the other belonged, and the
     * failure would be a support session pointed at the wrong business.
     *
     * R-C4 holds either way: the ERP takes its tenant from these signed bytes,
     * never from a header, a body or a domain name.
     */
    erp_tenant_id: z.string().min(1).max(64),
    installation_id: z.string().min(1).max(64),
    issued_at: z.string().datetime({ offset: true }),
    /** Short. Renewed by activity, never beyond `absolute_expires_at`. */
    expires_at: z.string().datetime({ offset: true }),
    /**
     * The ceiling, fixed at session creation and never extended.
     *
     * Sliding renewal is convenient; an unbounded slide is not containment. Four
     * hours from creation, and the grant is dead no matter how busy the
     * operator was (owner decision 2026-09-03).
     */
    absolute_expires_at: z.string().datetime({ offset: true }),
    reason: z.string().min(3).max(500),
    scope: z.literal('SUPER_SUPPORT'),
    signing_key_id: z.string().min(1).max(64),
  })
  .strict();
export type SupportGrant = z.infer<typeof supportGrantSchema>;

export const signedSupportGrantSchema = z
  .object({
    grant: supportGrantSchema,
    /** Ed25519 over `SHERSUP1.` + canonical grant, base64url. */
    signature: z.string().min(1).max(256),
  })
  .strict();
export type SignedSupportGrant = z.infer<typeof signedSupportGrantSchema>;

/**
 * What a support principal may never do, whatever its scope says (§13 ceiling).
 *
 * The owner chose full operational and accounting reach, so this list is
 * deliberately short — but it is not empty, and the two things it protects are
 * the two an audit trail cannot repair afterwards:
 *
 * - **Identity.** Changing a password or PIN, or creating a user, would leave
 *   the vendor able to return as the shop after the session is over. That is
 *   the permanent backdoor §12 forbids, arrived at by a different door.
 * - **Erasure.** Reset Business Data, a restore over live data, and replacing
 *   the backup secret each destroy the evidence of what the session did. A
 *   capability that can erase its own audit trail is not audited.
 *
 * Everything a real support visit needs — corrections, reversals, adjustments,
 * settings, every document — is on the other side of this line.
 */
export const SUPPORT_FORBIDDEN_PERMISSIONS: readonly string[] = [
  'users.create',
  'users.delete',
  'users.credentials.change',
  'roles.create',
  'roles.delete',
  'settings.reset_business_data',
  'backup.restore',
  'backup.secret.replace',
];

/**
 * Route prefixes closed to a support principal, matching the list above.
 *
 * Permissions are checked by the ERP's own `AccessControl`; this is the second
 * fence, applied at the edge by the support guard, because a route that forgot
 * to declare a permission would otherwise inherit the ceiling by omission.
 */
export const SUPPORT_FORBIDDEN_ROUTES: readonly string[] = [
  '/api/v1/auth/change-credentials',
  '/api/v1/auth/reset-password',
  '/api/v1/users',
  '/api/v1/roles',
  '/api/v1/backup/restore',
  '/api/v1/backup/secret',
  '/api/v1/settings/reset-business-data',
];

/** Sliding inactivity window and the absolute ceiling, in seconds. */
export const SUPPORT_IDLE_SECONDS = 30 * 60;
export const SUPPORT_ABSOLUTE_SECONDS = 4 * 60 * 60;

/** Header carrying the signed grant on a proxied support request. */
export const SUPPORT_HEADER_GRANT = 'x-sher-support-grant';
