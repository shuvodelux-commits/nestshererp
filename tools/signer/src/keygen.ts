import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';

import { SystemClock } from '@sher/shared-utils';

import { pathFor, writeKey } from './keys';
import type { KeyPurpose } from './keys';

/**
 * `pnpm signer:keygen` — make the three management-channel keys, once.
 *
 * The **licence** key is deliberately not made here. It already has an owner:
 * `pnpm licence:keygen`, which refuses to overwrite, prints the public half for
 * embedding, and warns about the backup. Two commands that can create the same
 * irreplaceable key is one too many.
 *
 * Like that command, this one refuses to overwrite. A regenerated command key
 * would be rejected by every agent in the fleet — they pinned the old public
 * half at enrolment — and recovering from that means re-enrolling every shop by
 * hand.
 */
function main(): void {
  const purposes: Exclude<KeyPurpose, 'licence'>[] = ['command', 'support', 'release'];
  const force = process.argv.includes('--force');

  for (const purpose of purposes) {
    const path = pathFor(purpose);
    if (existsSync(path) && !force) {
      out(`${purpose}: already exists at ${path} — left alone.`);
      continue;
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeKey(purpose, {
      keyId: `${purpose}-1`,
      kind: purpose,
      privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      createdAt: new SystemClock().now().toISOString(),
    });
    out(`${purpose}: written to ${path} (mode 0600).`);
  }

  out('');
  out('Back these up offline and encrypted, with the licence key.');
  out('A lost command key means re-enrolling every installation by hand.');
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

main();
