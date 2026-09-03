import { createPrivateKey, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_REQUEST_PREFIX, canonicalJson } from '@sher/control-contracts';

/**
 * This installation's cryptographic identity (§3).
 *
 * **The private key is generated here and never leaves.** Not at the vendor,
 * not in the installer, not in a backup, not in the ERP's database, not in a
 * `.sherdb` archive — in one file, mode 0600, in the sidecar's own directory on
 * the shop's own machine. That is what makes "installation X said this" a
 * statement the vendor can rely on, and it is why a leaked vendor-side backup
 * cannot be used to impersonate a single customer.
 *
 * The same reasoning as the licence signing key, applied from the other end:
 * the licence key exists only where licences are made, and this key exists only
 * where this installation is.
 *
 * The pinned `commandPublicKey` is the other half of the arrangement. Learned
 * once at enrolment and checked on every command afterwards, it means a control
 * plane that has been replaced — hijacked DNS, a proxy in the middle — can
 * deliver bytes but cannot be believed.
 */
export interface AgentIdentity {
  readonly tenantId: string;
  readonly installationId: string;
  readonly privateKeyBase64: string;
  readonly publicKeyBase64: string;
  readonly commandPublicKey: string;
  readonly commandSigningKeyId: string;
  readonly enrolledAt: string;
}

function identityPath(stateDir: string): string {
  return join(stateDir, 'identity.json');
}

export function hasIdentity(stateDir: string): boolean {
  return existsSync(identityPath(stateDir));
}

export function readIdentity(stateDir: string): AgentIdentity {
  const path = identityPath(stateDir);
  if (!existsSync(path)) {
    throw new Error(`This installation has not enrolled yet. Run: pnpm --filter @sher/agent enrol`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as AgentIdentity;
}

export function writeIdentity(stateDir: string, identity: AgentIdentity): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = identityPath(stateDir);
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** A fresh keypair, made on this machine, for this machine. */
export function generateIdentityKeypair(): { privateKeyBase64: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

/**
 * The headers that authenticate one outbound request.
 *
 * The signed document covers the method, the path and a hash of the body, so a
 * signature cannot be lifted onto a different request; the nonce and timestamp
 * bound how long a captured one is worth anything. Built here rather than in
 * each caller so no call site can accidentally sign less than the others.
 */
export function signRequest(
  identity: AgentIdentity,
  input: { method: string; path: string; bodySha256: string; issuedAt: string; nonce: string },
): string {
  const document = {
    installation_id: identity.installationId,
    method: input.method,
    path: input.path,
    body_sha256: input.bodySha256,
    issued_at: input.issuedAt,
    nonce: input.nonce,
  };
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return signBytes(
    null,
    Buffer.from(`${AGENT_REQUEST_PREFIX}.${canonicalJson(document)}`, 'utf8'),
    key,
  ).toString('base64url');
}
