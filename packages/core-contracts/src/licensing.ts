import { z } from 'zod';

/**
 * What the shop is told about its licence (Phase 10, §5.4, D-35, D-36, owner
 * decision 2026-08-30).
 *
 * The four states already exist and are already computed — `licenseStateAt` has
 * been right since Phase 1.7. What was missing is anybody being told. Until
 * this endpoint, a shop's first sign that a term had ended was a save that
 * failed.
 *
 * **Nothing here can change a licence.** There is no renew endpoint, no upgrade
 * request and no state field a client may post: entitlement comes from the
 * signed key file on this machine and from nowhere else, which is also why a
 * restore cannot restore, extend or bypass one.
 */

/** D-36's ladder, RESTORED included — a renewal returns to it with no data loss. */
export const licenseStateSchema = z.union([
  z.literal('ACTIVE'),
  z.literal('EXPIRING'),
  z.literal('GRACE'),
  z.literal('READ_ONLY'),
  z.literal('RESTORED'),
]);
export type LicenseStateValue = z.infer<typeof licenseStateSchema>;

export const licensedModuleStatusSchema = z.object({
  code: z.string(),
  label: z.string(),
  labelBn: z.string(),
  included: z.boolean(),
  /**
   * True when the licence excludes the module but the business has records in
   * it. Those screens stay open and read-only; the ones where this is false and
   * `included` is false are hidden altogether.
   */
  readOnlyHistorical: z.boolean(),
});
export type LicensedModuleStatus = z.infer<typeof licensedModuleStatusSchema>;

export const licenseStatusResponseSchema = z.object({
  state: licenseStateSchema,
  businessName: z.string(),
  /**
   * The id this installation's licence must name — what the shop reads out, or
   * copies, when asking for a licence or a renewal. It is the business's own
   * identifier and nothing else: it grants nothing and unlocks nothing.
   */
  businessId: z.string(),
  /** The installed licence's own id, for the support call. Null when none is readable. */
  licenceId: z.string().nullable(),
  /**
   * True when a licence *was* read but was issued for a different business.
   *
   * Kept apart from "unreadable" because it sends the shop somewhere else
   * entirely: the key file on this machine belongs to somebody else's shop, and
   * no amount of renewing will help until the right one is pasted in.
   */
  foreignBusiness: z.boolean(),
  /**
   * Set when this machine's clock reads earlier than a time SherERP has already
   * seen. A quiet diagnostic, never an enforcement: the licence is judged at the
   * later of the two, and nothing about business dates, periods or accounting
   * is touched by it.
   */
  clockWarning: z.string().nullable(),
  /** Null when no licence could be read at all — the READ_ONLY floor. */
  validUntil: z.string().nullable(),
  /** Negative once the term has ended; the GRACE countdown reads it. */
  daysRemaining: z.number().nullable(),
  /** Days of grace left before writes stop, null outside GRACE. */
  graceDaysRemaining: z.number().nullable(),
  /** False when the key file is missing, unreadable, forged or expired past grace. */
  licenceReadable: z.boolean(),
  modules: z.array(licensedModuleStatusSchema),
});
export type LicenseStatusResponse = z.infer<typeof licenseStatusResponseSchema>;

/**
 * The half of the licence every signed-in user gets, whatever their role.
 *
 * `license.term.view` gates the Settings page, not the banner: a cashier whose
 * sale will not save has to be told why on the screen they are standing at
 * (owner decision 2026-08-30), and hiding the reason behind a permission they
 * do not hold would leave them staring at a failure with no explanation.
 */
export const licenseNoticeSchema = z.object({
  state: licenseStateSchema,
  validUntil: z.string().nullable(),
  daysRemaining: z.number().nullable(),
  graceDaysRemaining: z.number().nullable(),
  /** Modules hidden from this session because the licence excludes them. */
  hiddenModules: z.array(z.string()),
  /** Modules readable but frozen because the licence excludes them. */
  readOnlyModules: z.array(z.string()),
});
export type LicenseNotice = z.infer<typeof licenseNoticeSchema>;
