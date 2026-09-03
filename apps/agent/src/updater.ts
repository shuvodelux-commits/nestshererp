import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify as verifyBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { canonicalJson, RELEASE_MANIFEST_PREFIX, releaseManifestSchema } from '@sher/control-contracts';
import type { DeploymentState, ReleaseManifest } from '@sher/control-contracts';

import type { AgentConfig } from './config';
import type { ErpClient } from './erp-client';

const run = promisify(execFile);

export type StageReporter = (state: DeploymentState, detail: string, failureCode?: string) => Promise<void>;

export interface UpdateOutcome {
  readonly ok: boolean;
  readonly state: DeploymentState;
  readonly failureCode: string | null;
  readonly detail: string;
}

/**
 * Applying a release, on the shop's machine (§10, §11).
 *
 * **The order is the safety.** Verify before unpacking, back up before
 * migrating, migrate before switching the symlink, health-check before calling
 * it done. Each step is refusable and each refusal leaves the shop exactly as
 * it was — which is why a failed update here is an afternoon of the vendor's
 * time rather than a shop that cannot trade in the morning.
 *
 * **Why a symlink.** The build is unpacked into a directory named for its
 * version and the `current` link is moved at the end, atomically. That means
 * the old build is still on disk and still complete: rollback is one symlink
 * move, not a re-download over a domestic line at nine at night. It is also why
 * this is a separate process from the ERP — a process cannot cleanly overwrite
 * the files it is running from (owner decision 2026-09-03).
 *
 * **A failed migration does not roll back by default.** §11, and the owner's
 * decision: migrations run in a transaction where the DDL allows, so most
 * failures undo themselves and the old build is still pointing at the old
 * schema. Restoring the pre-update backup would discard every sale the shop has
 * made since it was taken, so that is reserved for a schema that is verifiably
 * inconsistent — a much rarer thing than a migration that simply refused.
 */
export class Updater {
  constructor(
    private readonly config: AgentConfig,
    private readonly erp: ErpClient,
  ) {}

  async apply(input: {
    manifest: unknown;
    manifestSignature: string;
    artifactUrl: string;
    commandPublicKeyForReleases: string;
    authHeaders: Record<string, string>;
    report: StageReporter;
  }): Promise<UpdateOutcome> {
    const parsed = releaseManifestSchema.safeParse(input.manifest);
    if (!parsed.success) {
      return this.fail(input.report, 'MANIFEST_INVALID', 'The release manifest did not parse');
    }
    const manifest = parsed.data;

    /*
     * The signature is checked before anything is downloaded, let alone run.
     * §9: only signed, verified artifacts may be deployed — and checking first
     * means an unsigned release costs the shop a refusal, not a download.
     */
    await input.report('VERIFYING', `Checking the signature on ${manifest.version}`);
    if (!verifyManifest(manifest, input.manifestSignature, input.commandPublicKeyForReleases)) {
      return this.fail(input.report, 'SIGNATURE_INVALID', 'That release is not signed by this vendor');
    }

    await input.report('DOWNLOADING', `Fetching ${manifest.version}`);
    const archivePath = join(this.config.releasesDir, `${manifest.version}.tar.gz`);
    mkdirSync(this.config.releasesDir, { recursive: true });
    try {
      await this.download(input.artifactUrl, archivePath, input.authHeaders);
    } catch {
      return this.fail(input.report, 'DOWNLOAD_FAILED', 'The release could not be downloaded');
    }

    await input.report('VERIFYING', 'Checking the downloaded file');
    const digest = await hashFile(archivePath);
    if (digest !== manifest.sha256) {
      // Almost always a truncated download on a bad line rather than an
      // attack — but the two are indistinguishable from here, so both are
      // refused and the file is removed rather than left to be retried into.
      rmSync(archivePath, { force: true });
      return this.fail(input.report, 'HASH_MISMATCH', 'The downloaded release did not match its hash');
    }

    /*
     * §10 step 6: a valid pre-update backup, confirmed, not assumed. Taken
     * through the ERP's own backup service so it is the same archive a restore
     * would use — a bespoke dump taken by the sidecar would be a recovery path
     * nobody has ever tested.
     */
    await input.report('BACKING_UP', 'Taking a backup before anything changes');
    const backup = await this.erp.createBackup();
    if (!backup.ok) {
      return this.fail(
        input.report,
        backup.failureCode ?? 'BACKUP_FAILED',
        'No usable backup could be taken, so the update was not started',
      );
    }

    const targetDir = join(this.config.releasesDir, manifest.version);
    try {
      mkdirSync(targetDir, { recursive: true });
      await run('tar', ['-xzf', archivePath, '-C', targetDir]);
    } catch {
      rmSync(targetDir, { recursive: true, force: true });
      return this.fail(input.report, 'UNPACK_FAILED', 'The release could not be unpacked');
    }

    await input.report('MIGRATING', `Running ${String(manifest.migrations.length)} migration(s)`);
    const migrated = await this.migrate(targetDir);
    if (!migrated.ok) {
      /*
       * The old build is still running against the old schema. Nothing is
       * switched, nothing is restored, and the rollout halts (§11). The vendor
       * is told which migration failed, which is the one fact that makes the
       * next step obvious.
       */
      return this.fail(
        input.report,
        migrated.failureCode,
        `Migration failed; the previous version is still running. ${migrated.detail}`,
      );
    }

    await input.report('DEPLOYING', 'Switching to the new version');
    const previous = this.currentTarget();
    try {
      this.pointCurrentAt(targetDir);
      await this.restart();
    } catch {
      if (previous !== null) this.pointCurrentAt(previous);
      await this.restart().catch(() => undefined);
      return this.fail(input.report, 'DEPLOY_FAILED', 'The new version would not start; the old one was restored');
    }

    await input.report('HEALTH_CHECK', 'Checking the shop can serve');
    if (!(await this.waitForHealth())) {
      /*
       * Rollback is offered only when it is genuinely available. If the release
       * carried an irreversible migration, going back to the old build would
       * point it at a schema it does not understand — worse than the failure
       * being reported. §11: say so rather than pretend.
       */
      if (!manifest.rollback_supported || manifest.migrations.length > 0) {
        return this.fail(
          input.report,
          'HEALTH_CHECK_FAILED',
          'The new version is not answering, and this release cannot be rolled back automatically because it changed the database',
        );
      }
      if (previous !== null) {
        this.pointCurrentAt(previous);
        await this.restart().catch(() => undefined);
        await input.report('ROLLED_BACK', 'Health check failed; the previous version was restored');
        return { ok: false, state: 'ROLLED_BACK', failureCode: 'HEALTH_CHECK_FAILED', detail: 'rolled back' };
      }
      return this.fail(input.report, 'HEALTH_CHECK_FAILED', 'The new version is not answering');
    }

    rmSync(archivePath, { force: true });
    await input.report('SUCCEEDED', `Now running ${manifest.version}`);
    return { ok: true, state: 'SUCCEEDED', failureCode: null, detail: manifest.version };
  }

  private async migrate(targetDir: string): Promise<{ ok: true } | { ok: false; failureCode: string; detail: string }> {
    const migrateScript = join(targetDir, 'api', 'migrate.js');
    if (!existsSync(migrateScript)) return { ok: true };
    try {
      await run('node', [migrateScript], { env: process.env, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The migration name, if the runner named it — and nothing else. A
      // migration failure is the one diagnostic where the vendor genuinely
      // needs the identifier, and it names a file in the vendor's own repo, not
      // anything belonging to the customer.
      const named = /(\d{4}_[a-z0-9_]+\.sql)/u.exec(message);
      return {
        ok: false,
        failureCode: 'MIGRATION_FAILED',
        detail: named === null ? 'see the installation log' : `failed at ${named[1] ?? ''}`,
      };
    }
  }

  private currentTarget(): string | null {
    const link = join(this.config.releasesDir, 'current');
    try {
      return existsSync(link) ? readlinkSync(link) : null;
    } catch {
      return null;
    }
  }

  /** Atomic: write a new link beside the old one and rename over it. */
  private pointCurrentAt(targetDir: string): void {
    const link = join(this.config.releasesDir, 'current');
    const temporary = `${link}.next`;
    rmSync(temporary, { force: true });
    symlinkSync(targetDir, temporary);
    renameSync(temporary, link);
  }

  private async restart(): Promise<void> {
    if (this.config.restartCommand === '') return;
    const [command, ...args] = this.config.restartCommand.split(' ');
    await run(command ?? '', args);
  }

  /** Up to a minute, because a Node process on a shop PC is not instant. */
  private async waitForHealth(): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await this.erp.health()) return true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
    }
    return false;
  }

  private async download(url: string, to: string, headers: Record<string, string>): Promise<void> {
    const response = await fetch(url, { headers });
    if (!response.ok || response.body === null) throw new Error('download failed');
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(to));
  }

  private async fail(report: StageReporter, failureCode: string, detail: string): Promise<UpdateOutcome> {
    await report('FAILED', detail, failureCode);
    return { ok: false, state: 'FAILED', failureCode, detail };
  }
}

function verifyManifest(manifest: ReleaseManifest, signature: string, publicKeyBase64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verifyBytes(
      null,
      Buffer.from(`${RELEASE_MANIFEST_PREFIX}.${canonicalJson(manifest as unknown as Record<string, never>)}`, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}
