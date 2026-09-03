import { createPrivateKey, sign as signBytes } from 'node:crypto';

import {
  ANY_BUSINESS,
  canonicalLicensePayload,
  LICENSABLE_MODULE_CODES,
  LICENSE_PREFIX,
  LICENSE_SCHEMA_VERSION,
  licensePayloadSchema,
} from '@sher/core-contracts';
import type { LicensePayload } from '@sher/core-contracts';
import { addSeconds, parseInstant, SystemClock, Ulid } from '@sher/shared-utils';

import { keyPathFor, readSigningKey } from './keyfile';

/**
 * `pnpm licence:issue` — sign one licence, offline, on the vendor's machine.
 *
 * ```
 * pnpm licence:issue --business 01J8Z... --days 365
 * pnpm licence:issue --business 01J8Z... --until 2027-03-31 --modules VENDOR_STOCK,WARRANTY_SERIAL
 * pnpm licence:issue --business 01J8Z... --days 14                     # a trial
 * pnpm licence:issue --kind dev --business '*' --days 3650             # this machine
 * pnpm licence:issue --business 01J8Z... --days 180 --replaces 01J9... # a signed downgrade
 * ```
 *
 * **A trial is a licence with a short end date.** There is no self-issued trial
 * anywhere in SherERP: everything a shop can do comes from a key the vendor
 * signed, checked by the same signature, the same business binding and the same
 * expiry (owner decision 2026-09-02).
 *
 * **Modules default to everything.** An empty `modules[]` means unrestricted,
 * which is also what keeps a module built next year from being silently
 * withheld from a licence issued today. Tick modules only to sell less than all
 * of it.
 *
 * **`--replaces` is the only way down.** An install refuses a key that ends
 * earlier or includes less than the one already there; naming the licence being
 * replaced is the vendor deliberately saying "yes, smaller", with their signing
 * key rather than a shopkeeper's confirmation click.
 *
 * The output is one line. Send it however you like — it is not a secret: it
 * grants nothing on any machine but the business it names, and it cannot be
 * altered without breaking its own signature.
 */
function main(): void {
  const kind = flag('--kind') === 'prod' ? 'prod' : flag('--kind') === 'dev' ? 'dev' : 'prod';
  const keyPath = flag('--key') ?? keyPathFor(kind);

  const business = flag('--business');
  if (business === null) {
    fail('--business is required: the Business ID from the shop\'s Settings → Licence page.');
    return;
  }
  if (business === ANY_BUSINESS && kind !== 'dev') {
    fail('Only a development key may issue a licence for every business (--business "*").');
    return;
  }

  const validUntil = resolveValidUntil();
  if (validUntil === null) {
    fail('Pass either --days <n> or --until <YYYY-MM-DD>.');
    return;
  }

  const modules = resolveModules();
  if (modules === null) {
    fail(`--modules must be a comma-separated subset of: ${LICENSABLE_MODULE_CODES.join(', ')}`);
    return;
  }

  const key = readSigningKey(keyPath);
  const clock = new SystemClock();
  const replaces = flag('--replaces');

  const payload: LicensePayload = licensePayloadSchema.parse({
    schema_version: LICENSE_SCHEMA_VERSION,
    licence_id: Ulid.generate(clock),
    signing_key_id: key.keyId,
    business_id: business,
    issued_at: clock.now().toISOString(),
    valid_until: validUntil.toISOString(),
    modules,
    ...(replaces === null ? {} : { replacement_of: replaces }),
  });

  const encodedPayload = Buffer.from(canonicalLicensePayload(payload), 'utf8').toString('base64url');
  const signed = Buffer.from(`${LICENSE_PREFIX}.${encodedPayload}`, 'utf8');
  const privateKey = createPrivateKey({
    key: Buffer.from(key.privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  // Ed25519 signing takes a null algorithm — the curve fixes the hash.
  const signature = signBytes(null, signed, privateKey).toString('base64url');

  note(`Business:   ${business}`);
  note(`Valid until: ${validUntil.toISOString().slice(0, 10)}`);
  note(`Modules:     ${modules.length === 0 ? 'all' : modules.join(', ')}`);
  note(`Licence id:  ${payload.licence_id}   (signed with ${key.keyId})`);
  note('');
  // The key itself goes to stdout alone, so `pnpm licence:issue ... > key.txt`
  // produces a file with nothing in it but the licence.
  out(`${LICENSE_PREFIX}.${encodedPayload}.${signature}`);
}

/** `--days n` counted from now, or `--until YYYY-MM-DD` ending that day. */
function resolveValidUntil(): Date | null {
  const days = flag('--days');
  if (days !== null) {
    const count = Number(days);
    if (!Number.isFinite(count) || count <= 0) return null;
    return addSeconds(new SystemClock().now(), count * 24 * 60 * 60);
  }

  const until = flag('--until');
  if (until === null) return null;
  // End of that day, so "until the 31st" includes the 31st.
  return parseInstant(`${until}T23:59:59.000Z`);
}

function resolveModules(): string[] | null {
  const modules = flag('--modules');
  if (modules === null) return [];
  const codes = modules
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== '');
  const known: readonly string[] = LICENSABLE_MODULE_CODES;
  return codes.every((code) => known.includes(code)) ? codes : null;
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function fail(message: string): void {
  note(message);
  process.exitCode = 1;
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
