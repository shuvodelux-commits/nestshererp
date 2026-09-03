import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { SystemClock } from '@sher/shared-utils';

import { assertE2eDatabase, E2E_DATABASE_URL, resetE2eDatabase } from './database';
import { E2E_API_URL } from './api';

/**
 * The real stack, on its own database and its own ports (Phase 18.5).
 *
 * The owner's decision was that the E2E suite drives the real thing: the same
 * NestJS API, the same migrations, the same role backfill, the same Vite build
 * step a shopkeeper's browser loads. Nothing here is a stub or an in-memory
 * substitute, because a suite that passes against a substitute proves only that
 * the substitute works.
 *
 * The API is started here rather than through Playwright's `webServer` because
 * the database has to be dropped, migrated and back-filled *before* the process
 * that connects to it exists — and `webServer` gives no ordering guarantee
 * against `globalSetup` that survives a Playwright upgrade.
 */

// ESM: this package is `"type": "module"`, so there is no `__dirname`.
const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, '../../../api');
/** Never 3000: the owner's development API lives there and must keep running. */
const API_PORT = new URL(E2E_API_URL).port;

const clock = new SystemClock();

let api: ChildProcess | null = null;

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((settle, fail) => {
    const child = spawn(command, [...args], { cwd: API_DIR, env, stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code) => {
      if (code === 0) settle();
      else fail(new Error(`${command} ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

/** The environment the E2E API runs under. */
function apiEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    PORT: API_PORT,
    NODE_ENV: 'development',
    JWT_SECRET: 'e2e-secret-not-used-in-production',
    /*
     * Said explicitly, for the same reason `apps/api/vitest.config.ts` says it.
     * Licence mode is the right default for a shipped installation — no licence
     * means READ_ONLY (D-36) — and under it every write in this suite would come
     * back 423 from a deployment that simply has no key, which says nothing
     * about the workflow being tested. The upgrade spec is about schema and
     * roles; the licence's own behaviour is proven against a real signed key
     * elsewhere.
     */
    ENTITLEMENT_SOURCE: 'subscription',
  };
}

/**
 * An empty `sher_e2e` with the real schema and the real seed roles on it.
 *
 * The backfill is not optional garnish: a permission code added by a later
 * module is invisible until it has run, which hides the whole feature from the
 * sidebar. Running it here is what makes the upgrade spec's "the role backfill
 * is one of the two things that silently break an upgrade" testable at all.
 */
export async function prepareDatabase(): Promise<void> {
  assertE2eDatabase(E2E_DATABASE_URL);
  await resetE2eDatabase();
  await runUpgradeSteps();
}

/**
 * The migrations and the role backfill, over whatever is already there.
 *
 * Separate from `prepareDatabase` because the upgrade spec needs exactly these
 * two steps run **against a database that has been traded on** — the drop that
 * starts a suite would destroy the evidence that spec exists to check.
 */
export async function runUpgradeSteps(): Promise<void> {
  assertE2eDatabase(E2E_DATABASE_URL);
  const env = apiEnvironment();
  await run('node', ['dist/migrate.js'], env);
  await run('node', ['dist/backfill-seed-roles.js'], env);
}

/**
 * Waits until the API answers, or gives up with something a person can act on.
 *
 * The deadline comes through the `Clock` port: `Date.now()` is legal in exactly
 * one file in this repository and `pnpm test:boundaries` fails the build on any
 * other use, a test harness included.
 */
async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = clock.now().getTime() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${E2E_API_URL}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet. The only interesting failure is the timeout below.
    }
    if (clock.now().getTime() > deadline) {
      throw new Error(
        `The E2E API did not come up on ${E2E_API_URL} within ${String(timeoutMs / 1000)}s. ` +
          'Run `pnpm --filter "@sher/api..." build` first — this runs from dist, not from source.',
      );
    }
    await new Promise((settle) => setTimeout(settle, 250));
  }
}

export async function startApi(): Promise<void> {
  api = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: apiEnvironment(),
    stdio: 'inherit',
  });
  await waitForHealth();
}

export async function stopApi(): Promise<void> {
  if (api === null) return;
  const child = api;
  api = null;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((settle) => setTimeout(settle, 5000))]);
}
