import { createPublicKey, verify as verifyBytes } from 'node:crypto';

/**
 * Ed25519 verification, as the control plane needs it.
 *
 * Only the **verify** half lives here. The control plane holds no private key
 * of any kind: licences, commands, support grants and release manifests are all
 * signed by the isolated signer (§5), and installation requests are signed on
 * the shop's own machine. A `sign` function in this file would be a private key
 * in this process waiting to be added.
 *
 * The curve fixes the hash, so the algorithm argument is null — the same shape
 * `apps/api/src/deployment/license-codec.ts` uses, deliberately, so the two
 * verifiers read alike.
 */
export function verifyEd25519(
  signedBytes: string,
  signatureBase64Url: string,
  publicKeyBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verifyBytes(
      null,
      Buffer.from(signedBytes, 'utf8'),
      key,
      Buffer.from(signatureBase64Url, 'base64url'),
    );
  } catch {
    // A malformed key or signature is a failed verification, not a crash. The
    // caller's next line must be a refusal either way.
    return false;
  }
}
