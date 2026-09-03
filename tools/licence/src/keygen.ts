import { existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';

import { SystemClock } from '@sher/shared-utils';

import { keyPathFor, writeSigningKey } from './keyfile';
import type { KeyKind } from './keyfile';

/**
 * `pnpm licence:keygen` — make a signing key, once.
 *
 * ```
 * pnpm licence:keygen                 # the development key
 * pnpm licence:keygen --kind prod     # the production key, made once and kept
 * pnpm licence:keygen --kind prod --id sher-2   # a rotation
 * ```
 *
 * Ed25519 rather than RSA: a short key to embed in a build, and no padding-mode
 * choice to get wrong.
 *
 * **It refuses to overwrite.** Replacing a production key would invalidate
 * every licence signed with it — every customer, at once — so a second run has
 * to say `--id` and make a *new* key alongside the old one. That is also how
 * rotation works: both public keys are trusted until the last licence signed by
 * the old one has expired.
 *
 * The private half is written under the vendor's home directory with mode 0600
 * and never enters this repository, the database, an archive or a customer
 * machine. **Back it up offline and encrypted**: it cannot be regenerated, and
 * losing it means no renewal can ever be issued for any existing customer.
 */
function main(): void {
  const kind = flag('--kind') === 'prod' ? 'prod' : 'dev';
  const keyId = flag('--id') ?? defaultKeyId(kind);
  const path = keyPathFor(kind);

  if (existsSync(path) && flag('--id') === null) {
    note(
      `A ${kind} signing key already exists at ${path}.\n` +
        'Refusing to overwrite it: every licence ever signed with it would stop verifying.\n' +
        'To add a second key for rotation, pass a new id, e.g. --id sher-2 (and set\n' +
        'SHER_LICENCE_KEY_DIR to keep it beside the first).',
    );
    process.exitCode = 1;
    return;
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  writeSigningKey(path, {
    keyId,
    kind,
    privateKeyBase64,
    publicKeyBase64,
    createdAt: new SystemClock().now().toISOString(),
  });

  out(`Signing key written to ${path} (mode 0600).`);
  out(`  key id: ${keyId}`);
  out('');
  out('The public half — this is what SherERP verifies against:');
  out(publicKeyBase64);
  out('');

  if (kind === 'dev') {
    out('For a development machine, put this in apps/api/.env:');
    out(`LICENSE_TRUSTED_KEYS=${keyId}|${publicKeyBase64}|dev`);
  } else {
    out('For a customer build, embed it in EMBEDDED_KEYS in');
    out('apps/api/src/deployment/license-keys.ts:');
    out(`  { id: '${keyId}', publicKeyBase64: '${publicKeyBase64}', dev: false },`);
    out('');
    out('Then back up the private key offline and encrypted. It cannot be regenerated,');
    out('and without it no existing customer can ever be issued a renewal.');
  }
}

function defaultKeyId(kind: KeyKind): string {
  return kind === 'prod' ? 'sher-1' : 'dev-1';
}

/** `--name value`, or null. */
function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

main();

/** Straight to stdout, so `> key.txt` captures the licence and nothing else. */
function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** Everything a person reads rather than pipes: stderr, by the house rule. */
function note(line = ''): void {
  process.stderr.write(`${line}\n`);
}
