import {
  canonicalLicensePayload,
  LICENSABLE_MODULE_CODES,
  LICENSE_PREFIX,
  LICENSE_SCHEMA_VERSION,
  licensePayloadSchema,
} from '@sher/core-contracts';
import type { LicensePayload } from '@sher/core-contracts';

/**
 * The licence format, taken from the ERP's own contract rather than restated.
 *
 * This is the one place the control plane reaches into `@sher/core-contracts`,
 * and it is deliberate. The boundary rule bans the ERP's *domain*, its
 * *application services* and its *database adapters* — the data plane — for the
 * reasons in §22 and §27. It does not ban the format definition, and banning it
 * would be actively harmful here: a second hand-written copy of
 * `canonicalLicensePayload` is precisely how the vendor ends up signing bytes
 * that customer installations do not verify, discovered one renewal at a time.
 *
 * `packages/core-contracts/src/license-key.ts` says it plainly — the agreement
 * about what gets signed lives in one file "so it cannot drift between the two".
 * There are now three consumers of that agreement (the offline CLI, the signer,
 * and this), and the argument only gets stronger with each one.
 */
export const LICENCE_PREFIX = LICENSE_PREFIX;
export const LICENCE_SCHEMA_VERSION = LICENSE_SCHEMA_VERSION;
export const LICENSABLE_MODULES: readonly string[] = LICENSABLE_MODULE_CODES;

/** Validates the payload, then canonicalises from the parsed value — never the input. */
export function canonicalLicencePayload(payload: unknown): string {
  const parsed = licensePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Refusing to sign a licence payload that does not match the published schema');
  }
  return canonicalLicensePayload(parsed.data as LicensePayload);
}
