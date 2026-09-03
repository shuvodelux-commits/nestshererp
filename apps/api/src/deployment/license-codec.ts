import { createPublicKey, verify as verifySignature } from 'node:crypto';

import type { LicenseVerification, LicenseVerifier } from '@sher/core-application';
import {
  ANY_BUSINESS,
  canonicalLicensePayload,
  LICENSE_PREFIX,
  LICENSE_SCHEMA_VERSION,
  licensePayloadSchema,
} from '@sher/core-contracts';
import { parseInstant } from '@sher/shared-utils';

import type { TrustedLicenseKey } from './license-keys';

/**
 * Checking a pasted licence key (D-35).
 *
 * Ed25519, verified **offline** against a key that ships with the build. No
 * phone-home, ever: an on-premise shop may have no internet at all, and a
 * licence check that needed one would stop a business trading over a broken
 * ADSL line.
 *
 * **Nothing here throws.** Every way a key can be wrong — truncated, edited,
 * signed by somebody else, from a newer version of SherERP — comes back as a
 * reason with a sentence a shopkeeper can act on. D-35 says it for the missing
 * case ("never a crash, never data loss") and a pasted key is the same
 * argument with a person standing at the screen.
 *
 * **What is signed.** `SHERLIC1.<payload>`, prefix included, so a signature
 * made for this format can never be replayed under another one. The payload is
 * re-canonicalised from what was parsed rather than trusted as text, which
 * means the bytes checked here are the bytes the issuer signed regardless of
 * how the key was copied, pasted or line-wrapped on the way.
 */
export class Ed25519LicenseVerifier implements LicenseVerifier {
  constructor(private readonly keys: readonly TrustedLicenseKey[]) {}

  verify(raw: string): LicenseVerification {
    // Pasted from a message: line breaks and stray spaces are the normal case,
    // not an error, so they are removed rather than refused.
    const text = raw.replace(/\s+/g, '');
    const parts = text.split('.');
    if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
      return {
        ok: false,
        reason: 'MALFORMED',
        message:
          'That does not look like a SherERP licence key. It should be one line beginning with ' +
          `${LICENSE_PREFIX}. Copy the whole line from the message and paste it again.`,
      };
    }

    const [, encodedPayload, encodedSignature] = parts as [string, string, string];

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      return {
        ok: false,
        reason: 'MALFORMED',
        message: 'This licence key is damaged or incomplete. Ask the supplier to send it again.',
      };
    }

    const payload = licensePayloadSchema.safeParse(parsedJson);
    if (!payload.success) {
      const version = versionOf(parsedJson);
      if (version !== null && version > LICENSE_SCHEMA_VERSION) {
        return {
          ok: false,
          reason: 'SCHEMA_UNSUPPORTED',
          message:
            'This licence was made for a newer version of SherERP than the one on this computer. ' +
            'Update SherERP first, then install it.',
        };
      }
      return {
        ok: false,
        reason: 'MALFORMED',
        message: 'This licence key is damaged or incomplete. Ask the supplier to send it again.',
      };
    }

    if (payload.data.schema_version > LICENSE_SCHEMA_VERSION) {
      return {
        ok: false,
        reason: 'SCHEMA_UNSUPPORTED',
        message:
          'This licence was made for a newer version of SherERP than the one on this computer. ' +
          'Update SherERP first, then install it.',
      };
    }

    const key = this.keys.find((candidate) => candidate.id === payload.data.signing_key_id);
    if (key === undefined) {
      return {
        ok: false,
        reason: 'UNTRUSTED_KEY',
        message:
          'This licence was not signed by SherERP, or it was signed with a key this installation ' +
          'does not know. Check that the key came from your supplier.',
      };
    }

    /*
     * The wildcard business exists for a developer's database, which holds many
     * businesses where a customer install holds one. A production key must
     * never be able to sign it: that single licence would be a licence for
     * every shop at once.
     */
    if (payload.data.business_id === ANY_BUSINESS && !key.dev) {
      return {
        ok: false,
        reason: 'UNTRUSTED_KEY',
        message: 'This licence does not name a business, so it cannot be installed.',
      };
    }

    if (!this.signatureMatches(key, payload.data, encodedSignature)) {
      return {
        ok: false,
        reason: 'SIGNATURE_INVALID',
        message:
          'This licence key did not pass its security check. It may have been altered or only ' +
          'partly copied. Copy the whole line again, and if it still fails ask the supplier for a new key.',
      };
    }

    const issuedAt = parseInstant(payload.data.issued_at);
    const validUntil = parseInstant(payload.data.valid_until);
    if (issuedAt === null || validUntil === null) {
      return {
        ok: false,
        reason: 'DATES_INVALID',
        message: 'This licence does not carry usable dates. Ask the supplier to send it again.',
      };
    }

    return {
      ok: true,
      licence: {
        schemaVersion: payload.data.schema_version,
        licenceId: payload.data.licence_id,
        signingKeyId: payload.data.signing_key_id,
        businessId: payload.data.business_id,
        issuedAt,
        validUntil,
        modules: payload.data.modules,
        replacementOf: payload.data.replacement_of ?? null,
      },
    };
  }

  private signatureMatches(
    key: TrustedLicenseKey,
    payload: ReturnType<typeof licensePayloadSchema.parse>,
    encodedSignature: string,
  ): boolean {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key.publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });

      const canonical = Buffer.from(canonicalLicensePayload(payload), 'utf8').toString('base64url');
      const signed = Buffer.from(`${LICENSE_PREFIX}.${canonical}`, 'utf8');

      // Ed25519 verification takes a null algorithm — the curve fixes the hash.
      return verifySignature(null, signed, publicKey, Buffer.from(encodedSignature, 'base64url'));
    } catch {
      // A malformed key, a truncated signature, a base64 segment that is not
      // base64 — all of them mean the same thing to the person pasting it.
      return false;
    }
  }
}

/** The schema version of something that failed to parse, if it declares one. */
function versionOf(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const version = (value as Record<string, unknown>)['schema_version'];
  return typeof version === 'number' ? version : null;
}
