import { SystemClock } from '@sher/shared-utils';

import { AuditService } from './audit/audit.service';
import { loadConfig } from './config';
import { createControlPool } from './db/pool';
import { OperatorsService } from './operators/operators.service';

/**
 * `pnpm --filter @sher/control-plane operator:create -- --email … --name … --role PLATFORM_OWNER`
 *
 * The bootstrap door, and the only one. A console that can enter every
 * customer's ERP must not have a self-service signup, so the first operator is
 * made here, on the vendor's own server, by somebody with shell access — and
 * every operator after that is made from inside the console by an account that
 * holds `operator.manage`.
 *
 * It prints the TOTP secret once. There is no route that reads it back, and
 * losing it before scanning means deleting the row and running this again.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createControlPool(config.databaseUrl);
  try {
    const clock = new SystemClock();
    const audit = new AuditService(pool);
    const operators = new OperatorsService(pool, config, clock, audit);

    const email = flag('--email');
    const name = flag('--name');
    const role = flag('--role') ?? 'PLATFORM_OWNER';
    const password = flag('--password');
    if (email === null || name === null || password === null) {
      note('Usage: operator:create -- --email <e> --name <n> --password <p> [--role PLATFORM_OWNER]');
      process.exitCode = 1;
      return;
    }
    if (password.length < 12) {
      note('The password must be at least 12 characters.');
      process.exitCode = 1;
      return;
    }

    const created = await operators.create({ email, name, password, role, actor: null });
    note(`Operator created: ${email} (${role})`);
    note('');
    note('Scan this in an authenticator app now — it is shown once and never again:');
    out(created.totpUri);
    note('');
    note(`Or type the secret by hand: ${created.totpSecret}`);
  } finally {
    await pool.end();
  }
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

/** The URI alone on stdout, so it can be piped to a QR generator. */
function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function note(line = ''): void {
  process.stderr.write(`${line}\n`);
}

void main();
