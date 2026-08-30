import {
  archiveFileName,
  archivesToDelete,
  ARCHIVE_VERSION,
  AUTOMATIC_BACKUP_RETENTION,
  MANUAL_EXPORT_REMINDER_DAYS,
} from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { BackupRun, BackupStatusResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { UserRepository } from '../auth/registration-repository';
import type { AccessControl } from '../ports/access-control';
import { SYSTEM_ACTOR_ID } from '../ports/audit-writer';
import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type {
  ArchiveCodec,
  BackupFileStore,
  BackupSecretStore,
  BuildInfo,
} from './backup-ports';
import type { BackupRepository, BackupRunRecord } from './backup-repository';
import { assertStepUp } from './step-up';

/**
 * Taking the business out as one encrypted file (Phase 10, §5.25, D-15, owner
 * decisions 2026-08-30).
 *
 * **WRITE CLASS: M.** It posts nothing, numbers nothing and never touches a
 * period: an export reads the business and writes one row saying it happened.
 * No idempotency key — running it twice produces two archives, which is two
 * backups, not a duplicated document.
 *
 * **A run is SUCCESS only after the archive has been read back.** Write,
 * reopen, decrypt, and compare the checksum and row counts against the manifest
 * the writer produced. That is what the owner meant by "creates and verifies",
 * and it is not ceremony: an archive that cannot be decrypted is discovered on
 * the night it was written, not on the morning a shop needs it.
 *
 * **Export works in every licence state, `READ_ONLY` included** (D-36: no state
 * makes a shop's data un-exportable). The read-only guard lets it through by
 * name for exactly this reason.
 */

export interface BackupStatusCommand {
  readonly ctx: TenantContext;
}

export interface ExportBackupCommand {
  readonly ctx: TenantContext;
  readonly confirmPassword: string;
}

export interface ExportedArchive {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface ReplaceSecretCommand {
  readonly ctx: TenantContext;
  readonly confirmPassword: string;
  readonly newSecret: string;
}

export class BackupService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly backups: BackupRepository,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly codec: ArchiveCodec,
    private readonly files: BackupFileStore,
    private readonly secrets: BackupSecretStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
    private readonly build: BuildInfo,
  ) {}

  /** What the Backup page and the two dashboard warnings read. */
  async status(command: BackupStatusCommand): Promise<BackupStatusResponse> {
    const { ctx } = command;
    const secretConfigured = await this.secrets.isConfigured();
    const stored = await this.files.list();

    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.BACKUP_EXPORT);

      const history = await this.backups.recentRuns(tx, ctx, 20);
      const lastAutomatic = await this.backups.lastRunOfKind(tx, ctx, 'AUTO');
      const lastManualAt = await this.backups.lastSuccessfulManualExportAt(tx, ctx);
      const block = await this.backups.restoreBlock(tx, ctx);

      const days =
        lastManualAt === null ? null : daysBetween(lastManualAt, this.clock.now());

      return {
        secretConfigured,
        automaticEnabled: secretConfigured,
        lastAutomatic: lastAutomatic === null ? null : toResponse(lastAutomatic),
        lastManualExportAt: lastManualAt?.toISOString() ?? null,
        daysSinceManualExport: days,
        /*
         * Never having exported is overdue from the start. A shop three weeks
         * into using SherERP with every copy still on the shop PC is exactly
         * the case this warning exists for, and "no export yet" is not a
         * gentler situation than "an old export".
         */
        manualExportOverdue: days === null || days >= MANUAL_EXPORT_REMINDER_DAYS,
        automaticFailing:
          lastAutomatic !== null &&
          (lastAutomatic.status === 'FAILED' || lastAutomatic.verifiedAt === null),
        retainedCount: stored.length,
        retentionLimit: AUTOMATIC_BACKUP_RETENTION,
        history: history.map(toResponse),
        businessEmpty: block === null,
      };
    });
  }

  /** The owner pressing Download backup. */
  async exportNow(command: ExportBackupCommand): Promise<ExportedArchive> {
    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.BACKUP_EXPORT);
      await assertStepUp(tx, ctx, this.users, this.hasher, command.confirmPassword);
    });

    return this.run(ctx, 'MANUAL', ctx.userId);
  }

  /**
   * Replacing the installation's backup secret (D-15).
   *
   * Every archive already written stays encrypted under the **previous** secret
   * and can no longer be opened by this installation. That is not a bug to
   * engineer around — re-encrypting fourteen archives would mean holding both
   * secrets and rewriting evidence — so it is stated on the screen before the
   * button and recorded in the audit trail afterwards.
   *
   * The audit event records that the secret changed and **never either value**.
   */
  async replaceSecret(command: ReplaceSecretCommand): Promise<void> {
    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.BACKUP_EXPORT);
      await assertStepUp(tx, ctx, this.users, this.hasher, command.confirmPassword);
    });

    const hadOne = await this.secrets.isConfigured();
    await this.secrets.replace(command.newSecret);

    await this.uow.run(ctx, async (tx) => {
      await this.audit.append(tx, ctx, {
        entityType: 'BACKUP_SECRET',
        entityId: ctx.tenantId,
        action: hadOne ? 'BACKUP_SECRET_REPLACED' : 'BACKUP_SECRET_SET',
        before: null,
        after: null,
        reason: hadOne ? 'Earlier backups stay under the previous password' : 'First backup password',
        source: 'API',
      });
    });
  }

  /**
   * The nightly run. No permission check and no step-up: nobody is present.
   * The scheduler that calls this is the actor, and the audit event says so.
   */
  async runAutomatic(ctx: TenantContext): Promise<ExportedArchive> {
    const archive = await this.run(ctx, 'AUTO', null);
    await this.pruneOldArchives();
    return archive;
  }

  /**
   * Write, verify, record. One method for both kinds, because a manual export
   * that skipped verification would be the copy a shop actually relies on.
   */
  private async run(
    ctx: TenantContext,
    kind: 'AUTO' | 'MANUAL',
    userId: string | null,
  ): Promise<ExportedArchive> {
    if (!(await this.secrets.isConfigured())) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'No backup password is set for this installation yet, so nothing can be encrypted. ' +
          'Set one on the Backup screen first.',
      );
    }
    const secret = await this.secrets.read();

    const runId = Ulid.generate(this.clock);
    const startedAt = this.clock.now();
    await this.uow.run(ctx, async (tx) => {
      await this.backups.startRun(tx, ctx, { id: runId, kind, startedAt, userId });
    });

    try {
      const { fileName, bytes, checksum, rows } = await this.buildArchive(ctx, secret, startedAt);

      await this.files.write(fileName, bytes);

      // Verification proper: read the file back off the disk it was written to,
      // decrypt it with the same secret, and check what came back. Verifying
      // the in-memory buffer would prove only that the encoder is consistent
      // with itself, and a full disk fails exactly here.
      const readBack = await this.codec.decode(await this.files.read(fileName), secret);
      if (readBack.checksum !== checksum) {
        throw new Error('the archive read back different from what was written');
      }
      const rowsBack = readBack.tables.reduce((sum, table) => sum + table.rows.length, 0);
      if (rowsBack !== rows) {
        throw new Error(`the archive read back ${String(rowsBack)} rows, not ${String(rows)}`);
      }

      const verifiedAt = this.clock.now();
      await this.uow.run(ctx, async (tx) => {
        await this.backups.finishRun(tx, ctx, {
          id: runId,
          status: 'SUCCESS',
          finishedAt: verifiedAt,
          verifiedAt,
          fileName,
          byteSize: bytes.byteLength,
          checksum,
          archiveVersion: ARCHIVE_VERSION,
          schemaVersion: this.build.schemaVersion,
          error: null,
        });
        await this.audit.append(tx, { ...ctx, userId: userId ?? SYSTEM_ACTOR_ID }, {
          entityType: 'BACKUP',
          entityId: runId,
          action: kind === 'AUTO' ? 'BACKUP_AUTOMATIC' : 'BACKUP_EXPORTED',
          before: null,
          after: { fileName, byteSize: bytes.byteLength, rows },
          source: 'API',
        });
      });

      return { fileName, bytes };
    } catch (error) {
      // A failed run must leave no half-written archive behind: a truncated
      // file in the folder is one a future restore could pick up believing it
      // whole, and it would also count against the fourteen.
      const message = error instanceof Error ? error.message : String(error);
      await this.uow.run(ctx, async (tx) => {
        await this.backups.finishRun(tx, ctx, {
          id: runId,
          status: 'FAILED',
          finishedAt: this.clock.now(),
          verifiedAt: null,
          fileName: null,
          byteSize: null,
          checksum: null,
          archiveVersion: null,
          schemaVersion: null,
          error: message,
        });
      });
      throw error;
    }
  }

  private async buildArchive(
    ctx: TenantContext,
    secret: string,
    takenAt: Date,
  ): Promise<{ fileName: string; bytes: Uint8Array; checksum: string; rows: number }> {
    const { tables, businessName, evidenceBytes } = await this.uow.run(ctx, async (tx) => ({
      tables: await this.backups.exportBusiness(tx, ctx),
      businessName: await this.backups.businessName(tx, ctx),
      evidenceBytes: await this.backups.evidenceBytes(tx, ctx),
    }));

    const rowCounts: Record<string, number> = {};
    let rows = 0;
    for (const table of tables) {
      rowCounts[table.name] = table.rows.length;
      rows += table.rows.length;
    }

    const encoded = await this.codec.encode(
      {
        manifest: {
          archiveVersion: ARCHIVE_VERSION,
          schemaVersion: this.build.schemaVersion,
          appVersion: this.build.appVersion,
          tenantId: ctx.tenantId,
          businessName,
          takenAt: takenAt.toISOString(),
          rowCounts,
          evidenceBytes,
        },
        tables,
      },
      secret,
    );

    return {
      fileName: archiveFileName(businessName, takenAt),
      bytes: encoded.bytes,
      checksum: encoded.checksum,
      rows,
    };
  }

  /** Fourteen successful archives, newest kept (owner decision 2026-08-30). */
  private async pruneOldArchives(): Promise<void> {
    const stored = await this.files.list();
    for (const archive of archivesToDelete(stored)) {
      await this.files.delete(archive.fileName);
    }
  }
}

function toResponse(run: BackupRunRecord): BackupRun {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    verifiedAt: run.verifiedAt?.toISOString() ?? null,
    fileName: run.fileName,
    byteSize: run.byteSize,
    error: run.error,
  };
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MILLISECONDS_PER_DAY);
}
