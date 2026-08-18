import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Entitlement, EntitlementProvider, LicenseTerm } from '@sher/core-application';
import { licenseStateAt } from '@sher/core-application';
import { parseInstant } from '@sher/shared-utils';

/**
 * D-35's on-premise entitlement source: a signed licence key, validated
 * **offline** against an embedded public key. No phone-home, ever — an
 * on-premise shop may have no internet at all, and a licence check that needed
 * one would stop a business trading over a broken ADSL line.
 *
 * **Licence format.** `base64url(payloadJson).base64url(ed25519Signature)`. The
 * signature covers the payload bytes exactly as they appear before the dot, so
 * there is no canonicalisation question and no way to re-order JSON keys into a
 * different meaning. Ed25519 rather than RSA: a shorter key to embed, and no
 * padding-mode choice to get wrong.
 *
 * **Nothing here throws.** D-35: "Missing/invalid license → READ_ONLY, never a
 * crash, never data loss." A deleted, truncated, forged or expired licence all
 * resolve to the same safe answer, and the shop can still read its ledgers and
 * export a backup (D-36). The file is read on every call rather than cached at
 * boot, so dropping a renewed licence in place takes effect without a restart —
 * which matters when the alternative is telling a shopkeeper to restart their
 * server.
 */
interface LicensePayload {
  readonly tenant?: string;
  readonly issuedAt?: string;
  readonly validUntil?: string;
  readonly renewedFrom?: string;
  readonly modules?: readonly string[];
}

/** What a deployment with no usable licence is entitled to. */
const NO_LICENCE: Entitlement = { state: 'READ_ONLY', modules: [], validUntil: null };

export class LicenseKeyEntitlementProvider implements EntitlementProvider {
  constructor(
    private readonly licensePath: string,
    private readonly publicKeyBase64: string,
  ) {}

  current(now: Date): Entitlement {
    const payload = this.readVerifiedPayload();
    if (payload === null) return NO_LICENCE;

    const term = toTerm(payload);
    if (term === null) return NO_LICENCE;

    return {
      state: licenseStateAt(term, now),
      modules: payload.modules ?? [],
      validUntil: term.validUntil,
    };
  }

  /** The payload, or null for anything that is not a licence this build trusts. */
  private readVerifiedPayload(): LicensePayload | null {
    if (this.publicKeyBase64 === '') return null;

    let raw: string;
    try {
      raw = readFileSync(this.licensePath, 'utf8').trim();
    } catch {
      return null;
    }

    const separator = raw.indexOf('.');
    if (separator <= 0) return null;

    const encodedPayload = raw.slice(0, separator);
    const encodedSignature = raw.slice(separator + 1);

    try {
      const key = createPublicKey({
        key: Buffer.from(this.publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });

      // Ed25519 verification takes a null algorithm — the curve fixes the hash.
      const signed = verifySignature(
        null,
        Buffer.from(encodedPayload, 'utf8'),
        key,
        Buffer.from(encodedSignature, 'base64url'),
      );
      if (!signed) return null;

      return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as LicensePayload;
    } catch {
      // A malformed key, a truncated signature, payload that is not JSON — all
      // of them mean the same thing to a shopkeeper, and none of them may take
      // the server down.
      return null;
    }
  }
}

function toTerm(payload: LicensePayload): LicenseTerm | null {
  const validUntil = parseInstant(payload.validUntil);
  const issuedAt = parseInstant(payload.issuedAt);
  if (validUntil === null || issuedAt === null) return null;

  const renewedFrom = parseInstant(payload.renewedFrom);
  return renewedFrom === null ? { validUntil, issuedAt } : { validUntil, issuedAt, renewedFrom };
}
