import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where a signing key lives, and where it must never live.
 *
 * **Outside the repository, always.** The default is under the vendor's home
 * directory, not the working tree: a private key inside a git repository is one
 * `git add -A` away from being published forever, and no `.gitignore` is worth
 * relying on for a secret that cannot be rotated quietly. Nothing in SherERP —
 * not the database, not a `.sherdb` archive, not a diagnostic bundle, not a
 * log, not an API response — ever reads these files. Only this tool does.
 *
 * **Two keys, and they are never the same one.** `prod` signs what customers
 * pay for; `dev` signs what a developer's machine trusts, and a build only
 * trusts a dev key if it has been told to by configuration. Keeping them apart
 * is what makes it safe to hand a development licence around.
 */

export type KeyKind = 'prod' | 'dev';

export interface SigningKeyFile {
  readonly keyId: string;
  readonly kind: KeyKind;
  /** PKCS#8 DER, base64. The half that must never leave this machine. */
  readonly privateKeyBase64: string;
  /** SPKI DER, base64. The half that ships inside SherERP. */
  readonly publicKeyBase64: string;
  readonly createdAt: string;
}

/** `~/.sher/licence-keys/<kind>.json`, unless SHER_LICENCE_KEY_DIR says otherwise. */
export function keyPathFor(kind: KeyKind): string {
  const directory = process.env['SHER_LICENCE_KEY_DIR'] ?? join(homedir(), '.sher', 'licence-keys');
  return join(directory, `${kind}.json`);
}

export function writeSigningKey(path: string, key: SigningKeyFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  // Belt and braces: an existing file keeps its old mode through writeFileSync.
  chmodSync(path, 0o600);
}

export function readSigningKey(path: string): SigningKeyFile {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as SigningKeyFile;
}
