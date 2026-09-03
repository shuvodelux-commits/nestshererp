import { createPrivateKey, sign as signBytes } from 'node:crypto';

import { canonicalJson } from '@sher/control-contracts';
import type { CanonicalValue } from '@sher/control-contracts';

import { auditSignature, readKey } from './keys';
import type { KeyPurpose } from './keys';

/**
 * The one thing this service does.
 *
 * Note what it returns: a signature, and the id of the key that made it. It
 * never returns key material, never logs it, and there is no code path here or
 * anywhere else that reads a private key out to a caller — §5, and the reason
 * the signer is a separate process rather than a module the control plane
 * imports. A module can be called from anywhere in the process that imports it;
 * a process can only be called the way its API allows.
 */
export function signDocument(
  purpose: KeyPurpose,
  prefix: string,
  document: CanonicalValue,
  subject: string,
  at: string,
): { signature: string; signingKeyId: string } {
  const key = readKey(purpose);
  const canonical = canonicalJson(document);
  const privateKey = createPrivateKey({
    key: Buffer.from(key.privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  // Ed25519 takes a null algorithm — the curve fixes the hash.
  const signature = signBytes(null, Buffer.from(`${prefix}.${canonical}`, 'utf8'), privateKey);
  auditSignature(purpose, key.keyId, subject, at);
  return { signature: signature.toString('base64url'), signingKeyId: key.keyId };
}

/**
 * A licence, signed exactly the way `tools/licence/src/issue.ts` signs one.
 *
 * Kept byte-compatible on purpose: the offline path must keep working. A shop
 * with no internet at all is renewed by the vendor running `pnpm licence:issue`
 * by hand and sending the line in a message, and an installation cannot tell —
 * must not be able to tell — whether the licence it verifies came from that
 * command or from this service. One format, one verifier, two ways of reaching
 * it (owner decision 2026-09-03).
 */
export function signLicence(
  canonicalPayload: string,
  prefix: string,
  subject: string,
  at: string,
): { key: string; signingKeyId: string } {
  const licenceKey = readKey('licence');
  const encodedPayload = Buffer.from(canonicalPayload, 'utf8').toString('base64url');
  const privateKey = createPrivateKey({
    key: Buffer.from(licenceKey.privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = signBytes(
    null,
    Buffer.from(`${prefix}.${encodedPayload}`, 'utf8'),
    privateKey,
  ).toString('base64url');
  auditSignature('licence', licenceKey.keyId, subject, at);
  return { key: `${prefix}.${encodedPayload}.${signature}`, signingKeyId: licenceKey.keyId };
}
