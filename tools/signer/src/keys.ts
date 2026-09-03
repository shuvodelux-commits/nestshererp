import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the signing keys live — and everywhere they do not.
 *
 * This file is the whole of §5. The private halves sit under the vendor's home
 * directory, mode 0600 in a 0700 directory, and are read by exactly one process:
 * the signer. They are **not** in the repository (one `git add -A` from being
 * public forever), **not** in the control-plane database (a backup of which the
 * vendor will one day copy to a laptop), **not** in an environment variable
 * (which lands in a process listing, a crash dump and a deployment config), and
 * **not** returned by any endpoint the signer serves.
 *
 * There are four keys, and they are separate on purpose. The licence key is the
 * one that matters most — losing it means no existing customer can ever be
 * renewed — so it is the same file `tools/licence` already writes, unchanged, so
 * that offline issuance by hand keeps working exactly as it does today. The
 * other three sign commands, support grants and release manifests, and are
 * separate so that a compromise of the fast-moving management channel does not
 * hand over the authority to mint licences.
 */

export type KeyPurpose = 'licence' | 'command' | 'support' | 'release';

export interface SigningKeyFile {
  readonly keyId: string;
  readonly kind: string;
  readonly privateKeyBase64: string;
  readonly publicKeyBase64: string;
  readonly createdAt: string;
}

/** `~/.sher/licence-keys/prod.json` — the file `tools/licence` already writes. */
function licenceKeyPath(): string {
  const kind = process.env['SIGNER_LICENCE_KIND'] ?? 'prod';
  const dir = process.env['SHER_LICENCE_KEY_DIR'] ?? join(homedir(), '.sher', 'licence-keys');
  return join(dir, `${kind}.json`);
}

/** `~/.sher/control-keys/<purpose>.json` — the management channel's own keys. */
function controlKeyPath(purpose: KeyPurpose): string {
  const dir = process.env['SHER_CONTROL_KEY_DIR'] ?? join(homedir(), '.sher', 'control-keys');
  return join(dir, `${purpose}.json`);
}

export function pathFor(purpose: KeyPurpose): string {
  return purpose === 'licence' ? licenceKeyPath() : controlKeyPath(purpose);
}

export function readKey(purpose: KeyPurpose): SigningKeyFile {
  const path = pathFor(purpose);
  if (!existsSync(path)) {
    throw new Error(`No ${purpose} signing key at ${path}. Run: pnpm signer:keygen`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SigningKeyFile;
}

export function writeKey(purpose: KeyPurpose, key: SigningKeyFile): void {
  const path = pathFor(purpose);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  // An existing file keeps its old mode through writeFileSync.
  chmodSync(path, 0o600);
}

/**
 * Every signature, written down where the database cannot reach it.
 *
 * The control plane's own audit trail records that an operator *asked* for a
 * licence; this records that a key actually *produced* one. Keeping the second
 * record beside the key rather than in the database is what makes it useful
 * after a compromise of the database — the two can be compared, and a signature
 * that appears here with no corresponding request there is the alarm.
 *
 * It records what was signed, never the key and never anything that would let a
 * reader reconstruct one.
 */
export function auditSignature(purpose: KeyPurpose, keyId: string, subject: string, at: string): void {
  const dir = process.env['SHER_CONTROL_KEY_DIR'] ?? join(homedir(), '.sher', 'control-keys');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'signer-audit.log');
  appendFileSync(path, `${JSON.stringify({ at, purpose, keyId, subject })}\n`, { mode: 0o600 });
}
