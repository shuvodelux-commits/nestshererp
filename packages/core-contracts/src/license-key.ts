import { z } from 'zod';

/**
 * The licence key itself — the one string a shop pastes in (§5.4, D-35).
 *
 * ```
 * SHERLIC1.<base64url(canonical payload)>.<base64url(ed25519 signature)>
 * ```
 *
 * **This file describes the format and nothing else.** No signing, no
 * verification, no base64: those need real crypto and they live where the
 * platform provides it — the issuing CLI in `tools/licence`, and the verifier in
 * `apps/api/src/deployment`. What both sides must agree on, exactly, is the
 * shape of the payload and the bytes that get signed, and that agreement is
 * here so it cannot drift between the two.
 *
 * **The signature covers `SHERLIC1.<payload>`, prefix included.** Signing the
 * payload alone would let a future format reuse an old signature under new
 * rules; binding the prefix means a `SHERLIC2` licence can never be mistaken
 * for this one, whatever it contains.
 *
 * The canonical form is what makes that reliable: one fixed key order, no
 * whitespace, so the bytes that were signed are reproducible from the parsed
 * payload without keeping the original text around.
 */

/** The format marker, and the first segment of every key. */
export const LICENSE_PREFIX = 'SHERLIC1';

/** The payload shape this build understands. Bumped only for a breaking change. */
export const LICENSE_SCHEMA_VERSION = 1;

/**
 * The five parts of SherERP a licence can include or leave out.
 *
 * Kept next to the format because they are what the CLI ticks and what the
 * payload carries; `LICENSED_MODULES` in `modules.ts` is the same list with the
 * permissions and tables each one owns.
 */
export const LICENSABLE_MODULE_CODES = [
  'BANK_RECONCILIATION',
  'ADVANCED_REPORTS',
  'PURCHASE_PLANNING',
  'WARRANTY_SERIAL',
  'VENDOR_STOCK',
] as const;

/** One of the five, as a type — what `LICENSED_MODULES` must be keyed by. */
export type LicensableModuleCode = (typeof LICENSABLE_MODULE_CODES)[number];

/**
 * The business id a **development** licence may carry instead of a real one.
 *
 * Accepted only for a signing key the build marks as a development key, and
 * refused outright for the production key — a wildcard licence signed by the
 * vendor's real key would be a licence for every shop at once. It exists so a
 * developer's database, which holds many businesses rather than the one a
 * customer install holds, does not need a separate key per business.
 */
export const ANY_BUSINESS = '*';

export const licensePayloadSchema = z
  .object({
    schema_version: z.number().int().positive(),
    /** ULID. Identifies this licence for the audit trail and for `replacement_of`. */
    licence_id: z.string().min(1).max(64),
    /** Which trusted public key verifies it, so keys can be rotated later. */
    signing_key_id: z.string().min(1).max(64),
    /** The business this licence is for — `*` only on a development key. */
    business_id: z.string().min(1).max(64),
    issued_at: z.string().datetime({ offset: true }),
    valid_until: z.string().datetime({ offset: true }),
    /** Empty means every module: an unrestricted licence, and the CLI's default. */
    modules: z.array(z.enum(LICENSABLE_MODULE_CODES)),
    /**
     * The licence this one deliberately replaces.
     *
     * Present only when the vendor means to issue something *smaller* — a
     * shorter term, or fewer modules. Without it the install refuses to go
     * backwards, which is what stops an old key pasted out of last year's
     * message from shortening a shop's term.
     */
    replacement_of: z.string().min(1).max(64).optional(),
  })
  .strict();

export type LicensePayload = z.infer<typeof licensePayloadSchema>;

/**
 * The exact bytes that are signed and verified, as text.
 *
 * Fixed key order, no whitespace, `replacement_of` written only when it is
 * there. Both sides build this from the parsed payload, so neither has to trust
 * the other's formatting.
 */
export function canonicalLicensePayload(payload: LicensePayload): string {
  const ordered: Record<string, unknown> = {
    schema_version: payload.schema_version,
    licence_id: payload.licence_id,
    signing_key_id: payload.signing_key_id,
    business_id: payload.business_id,
    issued_at: payload.issued_at,
    valid_until: payload.valid_until,
    modules: [...payload.modules],
  };
  if (payload.replacement_of !== undefined) ordered['replacement_of'] = payload.replacement_of;
  return JSON.stringify(ordered);
}

/** Why an install was refused. The screen turns each of these into a sentence. */
export const licenseRejectionSchema = z.union([
  /** Not a SherERP licence at all — wrong prefix, wrong shape, not three parts. */
  z.literal('MALFORMED'),
  /** A newer licence format than this build understands. */
  z.literal('SCHEMA_UNSUPPORTED'),
  /** Signed by a key this build does not trust, or names no known key id. */
  z.literal('UNTRUSTED_KEY'),
  /** The signature does not match the payload. Forged, edited or truncated. */
  z.literal('SIGNATURE_INVALID'),
  /** A real licence, for somebody else's business. */
  z.literal('FOREIGN_BUSINESS'),
  /** Dates that cannot be true — ends before it starts, or already run out. */
  z.literal('DATES_INVALID'),
  /** Ends earlier than the licence already installed. */
  z.literal('EARLIER_EXPIRY'),
  /** Includes less than the licence already installed. */
  z.literal('FEWER_MODULES'),
  /** The verified licence could not be written to this machine. */
  z.literal('NOT_WRITABLE'),
]);
export type LicenseRejection = z.infer<typeof licenseRejectionSchema>;

export const licenseInstallRequestSchema = z
  .object({
    /** The pasted key, whitespace and line breaks and all. */
    key: z.string().min(1).max(8192),
  })
  .strict();
export type LicenseInstallRequest = z.infer<typeof licenseInstallRequestSchema>;

export const licenseInstallResponseSchema = z.object({
  licenceId: z.string(),
  validUntil: z.string(),
  modules: z.array(z.string()),
  /** The licence this one replaced, for the sentence the screen shows afterwards. */
  previousLicenceId: z.string().nullable(),
});
export type LicenseInstallResponse = z.infer<typeof licenseInstallResponseSchema>;
