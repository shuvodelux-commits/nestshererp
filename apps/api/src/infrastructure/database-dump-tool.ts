import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DatabaseDumpTool, DumpResult } from '@sher/core-application';

/**
 * The operational recovery artifact (Phase 10, owner decision 2026-08-30).
 *
 * A `pg_dump` in PostgreSQL's own custom format, taken immediately before every
 * database migration and before a Reset Business Data, and used for exact
 * rollback if the operation fails. **It is not the owner's backup** — it only
 * restores into the same schema version, and the shop never sees it. The
 * `.sherdb` archive is the portable, version-crossing copy; neither replaces
 * the other.
 *
 * **`dumpAndVerify` returns only after the file has been read back.** A zero
 * exit code says `pg_dump` believed it succeeded; `pg_restore --list` says the
 * archive on disk can actually be opened and enumerated. The reset that depends
 * on this must not clear a shop's data on the strength of the first of those.
 */
export class PgDumpTool implements DatabaseDumpTool {
  constructor(
    private readonly databaseUrl: string,
    private readonly directory: string,
  ) {}

  async dumpAndVerify(label: string): Promise<DumpResult> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${safeLabel(label)}.dump`);

    try {
      await run('pg_dump', ['--format=custom', '--file', path, this.databaseUrl]);
      await run('pg_restore', ['--list', path]);
    } catch (error) {
      // A dump that cannot be verified is worse than no dump: it is a safety
      // net somebody would rely on. Remove it so nothing can mistake it for one.
      await rm(path, { force: true });
      throw new Error(
        `Could not create a verified recovery copy of the database (${describe(error)}). ` +
          'Nothing has been changed.',
      );
    }

    const info = await stat(path);
    return { path, byteSize: info.size };
  }
}

function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: a failing pg_dump can produce a great deal of output, and the
      // first few lines are the ones that name the cause.
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      reject(new Error(`${command} is not installed on this computer`));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim()}`));
    });
  });
}
