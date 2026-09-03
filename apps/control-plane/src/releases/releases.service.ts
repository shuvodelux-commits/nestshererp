import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import type { ReleaseChannel, ReleaseManifest } from '@sher/control-contracts';
import { compareVersions, releaseManifestSchema } from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import type { ControlPlaneConfig } from '../config';
import { CONTROL_CLOCK, CONTROL_CONFIG, CONTROL_POOL } from '../db/tokens';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { SignerClient } from '../signer/signer-client';
import { AUDIT_SERVICE, SIGNER_CLIENT } from '../tokens';

export interface ReleaseRow {
  readonly id: string;
  readonly version: string;
  readonly buildId: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly requiredSchemaVersion: string;
  readonly minCompatibleVersion: string;
  readonly migrations: string[];
  readonly rollbackSupported: boolean;
  readonly channel: ReleaseChannel;
  readonly notes: string;
  readonly artifactPath: string;
  readonly manifest: ReleaseManifest;
  readonly signature: string;
  readonly publishedAt: Date;
  readonly withdrawnAt: Date | null;
}

/**
 * Release inventory (§9).
 *
 * **Publishing is where the signature happens, and nothing else may deploy.**
 * The tarball is hashed here, from disk, by this process — not taken on the
 * operator's word — and that hash goes inside the signed manifest. An agent
 * checks both: the hash catches the truncated download, which is the common
 * failure on a shop's line; the signature catches a substituted artifact, which
 * is the dangerous one. An attacker able to replace the file can replace a hash
 * served next to it, but cannot forge a signature without the vendor's key, and
 * that key is not in this process (§5).
 *
 * `withdrawn_at` rather than a delete. A release that shipped to shops is part
 * of the history of what they are running, and deleting the row would leave
 * installations reporting a version the control plane cannot name.
 */
@Injectable()
export class ReleasesService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(CONTROL_CONFIG) private readonly config: ControlPlaneConfig,
    @Inject(SIGNER_CLIENT) private readonly signer: SignerClient,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async list(): Promise<ReleaseRow[]> {
    const result = await this.pool.query<ReleaseRow>(`${SELECT_RELEASE} ORDER BY published_at DESC`);
    return result.rows;
  }

  async get(id: string): Promise<ReleaseRow> {
    const result = await this.pool.query<ReleaseRow>(`${SELECT_RELEASE} WHERE id=$1`, [id]);
    const row = result.rows[0];
    if (row === undefined) throw new ControlError(ControlErrorCode.NOT_FOUND, 'No such release');
    return row;
  }

  async publish(
    input: {
      version: string;
      buildId: string;
      artifactFile: string;
      requiredSchemaVersion: string;
      minCompatibleVersion: string;
      migrations: readonly string[];
      rollbackSupported: boolean;
      channel: ReleaseChannel;
      notes: string;
      reason: string;
    },
    operator: OperatorPrincipal,
  ): Promise<ReleaseRow> {
    /*
     * The artifact must already be in the release directory, named without a
     * path. Accepting an arbitrary path from an API request would let an
     * operator — or anyone who reached this endpoint — have the process read
     * and publish any file on the box.
     */
    const safeName = basename(input.artifactFile);
    const artifactPath = resolve(join(this.config.releaseDir, safeName));
    if (!artifactPath.startsWith(resolve(this.config.releaseDir))) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'That artifact path is not allowed');
    }
    if (!existsSync(artifactPath)) {
      throw new ControlError(
        ControlErrorCode.NOT_FOUND,
        `No artifact named ${safeName} in the release directory`,
      );
    }

    const sha256 = await hashFile(artifactPath);
    const sizeBytes = statSync(artifactPath).size;
    const releaseId = Ulid.generate(this.clock);

    const keys = await this.signer.publicKeys();
    const releaseKey = keys['release'];
    if (releaseKey === null || releaseKey === undefined) {
      throw new ControlError(ControlErrorCode.SIGNER_UNAVAILABLE, 'No release signing key is available');
    }

    const manifest: ReleaseManifest = releaseManifestSchema.parse({
      release_id: releaseId,
      version: input.version,
      build_id: input.buildId,
      sha256,
      size_bytes: sizeBytes,
      required_schema_version: input.requiredSchemaVersion,
      min_compatible_version: input.minCompatibleVersion,
      migrations: [...input.migrations],
      rollback_supported: input.rollbackSupported,
      channel: input.channel,
      notes: input.notes,
      published_at: this.clock.now().toISOString(),
      signing_key_id: releaseKey.keyId,
    });
    const { signature } = await this.signer.signRelease(
      manifest as unknown as Record<string, never>,
      `release ${input.version}`,
    );

    try {
      await this.pool.query(
        `INSERT INTO releases
           (id, version, build_id, sha256, size_bytes, required_schema_version, min_compatible_version,
            migrations, rollback_supported, channel, notes, artifact_path, manifest, signature, published_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          releaseId,
          input.version,
          input.buildId,
          sha256,
          sizeBytes,
          input.requiredSchemaVersion,
          input.minCompatibleVersion,
          JSON.stringify(input.migrations),
          input.rollbackSupported,
          input.channel,
          input.notes,
          artifactPath,
          JSON.stringify(manifest),
          signature,
          operator.id,
        ],
      );
    } catch {
      throw new ControlError(ControlErrorCode.CONFLICT, 'A release with that version already exists');
    }

    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'release.publish',
      reason: input.reason,
      subject: input.version,
      after: { sha256, sizeBytes, channel: input.channel, rollbackSupported: input.rollbackSupported },
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
    return this.get(releaseId);
  }

  /**
   * Whether this release may be sent to an installation on `currentVersion`.
   *
   * §10: "never deploy blindly to every installation without compatibility
   * checks". Refusing a jump the release itself says it cannot make — rather
   * than attempting it and hoping — is the difference between a rollout that
   * stops and a shop that cannot trade in the morning.
   */
  eligibility(release: ReleaseRow, currentVersion: string): { ok: boolean; reason: string } {
    if (release.withdrawnAt !== null) return { ok: false, reason: 'That release has been withdrawn' };
    if (currentVersion === '') return { ok: false, reason: 'That installation has not reported a version yet' };
    if (compareVersions(currentVersion, release.version) >= 0) {
      return { ok: false, reason: 'Already on this version or newer' };
    }
    if (compareVersions(currentVersion, release.minCompatibleVersion) < 0) {
      return {
        ok: false,
        reason: `Too far behind: this release needs at least ${release.minCompatibleVersion}`,
      };
    }
    return { ok: true, reason: '' };
  }

  /** The signed manifest an agent verifies before it replaces anything. */
  async manifestFor(releaseId: string): Promise<{ manifest: ReleaseManifest; signature: string; url: string }> {
    const release = await this.get(releaseId);
    return {
      manifest: release.manifest,
      signature: release.signature,
      url: `${this.config.publicBaseUrl}/api/agent/releases/${releaseId}/artifact`,
    };
  }

  async artifactPathFor(releaseId: string): Promise<string> {
    return (await this.get(releaseId)).artifactPath;
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

const SELECT_RELEASE = `
  SELECT id, version, build_id AS "buildId", sha256, size_bytes AS "sizeBytes",
         required_schema_version AS "requiredSchemaVersion",
         min_compatible_version AS "minCompatibleVersion", migrations,
         rollback_supported AS "rollbackSupported", channel, notes,
         artifact_path AS "artifactPath", manifest, signature,
         published_at AS "publishedAt", withdrawn_at AS "withdrawnAt"
    FROM releases
`;
