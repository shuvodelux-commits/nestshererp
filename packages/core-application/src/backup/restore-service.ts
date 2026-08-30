import { archiveCompatibility } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { ArchivePreviewResponse, RestoreResultResponse } from '@sher/core-contracts';
import { parseInstant, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { UserRepository } from '../auth/registration-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { ArchiveBody, ArchiveCodec, BackupSecretStore } from './backup-ports';
import { ArchiveOpenError } from './backup-ports';
import type { BackupRepository } from './backup-repository';
import { assertStepUp } from './step-up';

/**
 * Putting a business back (Phase 10, §5.25, owner decisions 2026-08-30).
 *
 * **Restore never deletes anything.** It writes into an empty installation and
 * refuses anywhere else, naming Reset Business Data as the separate, deliberate
 * step that clears one. That separation is the whole safety property: a
 * mis-clicked restore cannot erase a working shop, because a working shop is
 * exactly the state restore will not run in.
 *
 * **Identity comes from the archive; entitlement comes from the machine.** The
 * business name, users, credential hashes, roles and every historical
 * authorization relationship are restored as they were, so the owner signs in
 * the way they always did and every audit row still names a real person. What
 * the archive cannot bring with it is a licence: a restore can neither restore,
 * extend nor bypass one (owner decision 2026-08-30, and D-08 before it).
 *
 * The recovery session dies with the identity it belonged to. The temporary
 * seeded admin existed only to reach an empty installation; once the archive's
 * users are in place, that account is gone and the operator signs in as
 * themselves.
 */

export interface InspectArchiveCommand {
  readonly ctx: TenantContext;
  readonly fileName: string;
  readonly content: Uint8Array;
}

export interface RestoreCommand extends InspectArchiveCommand {
  readonly confirmPassword: string;
}

export class RestoreService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly backups: BackupRepository,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly codec: ArchiveCodec,
    private readonly secrets: BackupSecretStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /** Read the file and say what is in it. Writes nothing, ever. */
  async inspect(command: InspectArchiveCommand): Promise<ArchivePreviewResponse> {
    const { ctx } = command;
    const archive = await this.open(command.content);

    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.BACKUP_RESTORE);

      const applied = await this.backups.appliedMigrations(tx);
      const block = await this.backups.restoreBlock(tx, ctx);
      const compatibility = archiveCompatibility(archive.manifest, applied);

      const readable = compatibility.kind === 'SAME' || compatibility.kind === 'FORWARD_MIGRATE';
      const blockedReason = readable ? block : refusalFor(compatibility, applied);

      return {
        fileName: command.fileName,
        businessName: archive.manifest.businessName,
        takenAt: archive.manifest.takenAt,
        appVersion: archive.manifest.appVersion,
        archiveSchemaVersion: archive.manifest.schemaVersion,
        buildSchemaVersion: applied.at(-1) ?? '',
        compatibility: compatibility.kind,
        contents: summarize(archive),
        totalRows: totalRows(archive),
        evidenceBytes: archive.manifest.evidenceBytes,
        canRestore: readable && block === null,
        blockedReason,
      };
    });
  }

  async restore(command: RestoreCommand): Promise<RestoreResultResponse> {
    const { ctx } = command;
    const archive = await this.open(command.content);

    await this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.BACKUP_RESTORE);
      await assertStepUp(tx, ctx, this.users, this.hasher, command.confirmPassword);
    });

    /*
     * One transaction, and it spans two tenant identities.
     *
     * `runWithoutTenant` is the only sanctioned way to move `app.tenant_id`
     * inside a transaction, and this is precisely the case it exists for: the
     * seeded identity is cleared under its own id, then the archive's id is
     * adopted so every inserted row satisfies the same RLS policy that guards
     * everything else. Nothing here escapes row-level security — it changes
     * which tenant the policy is evaluating, having proved which one the file
     * belongs to.
     *
     * A failure anywhere rolls the whole thing back, which leaves the seeded
     * installation exactly as it was. There is no half-restored state.
     */
    const result = await this.uow.runWithoutTenant(async (tx, adoptTenant) => {
      await adoptTenant(ctx.tenantId);

      const applied = await this.backups.appliedMigrations(tx);
      const compatibility = archiveCompatibility(archive.manifest, applied);
      if (compatibility.kind !== 'SAME' && compatibility.kind !== 'FORWARD_MIGRATE') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, refusalFor(compatibility, applied));
      }

      const block = await this.backups.restoreBlock(tx, ctx);
      if (block !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, block);

      await this.backups.clearBusiness(tx, ctx);

      const restoredCtx: TenantContext = { ...ctx, tenantId: archive.manifest.tenantId };
      await adoptTenant(restoredCtx.tenantId);
      const rows = await this.backups.importBusiness(tx, restoredCtx, archive.tables);

      /*
       * The restore event belongs to the business that now exists, written
       * under its own tenant id — a row written before the clear would have
       * belonged to the temporary identity and been deleted by the very
       * operation it documents.
       *
       * The actor is the restored owner of the archive, not the seeded admin,
       * who no longer exists to be named: `created_by` must point at a user
       * this business actually has.
       */
      const actorId = await this.backups.firstOwnerUserId(tx, restoredCtx);
      const eventCtx: TenantContext = { ...restoredCtx, userId: actorId };
      const restoredAt = this.clock.now();

      await this.backups.recordRestore(tx, eventCtx, {
        id: Ulid.generate(this.clock),
        tenantId: restoredCtx.tenantId,
        sourceFileName: command.fileName,
        archiveVersion: archive.manifest.archiveVersion,
        archiveSchemaVersion: archive.manifest.schemaVersion,
        archiveTakenAt: parseInstant(archive.manifest.takenAt) ?? restoredAt,
        businessName: archive.manifest.businessName,
        rowCount: rows,
        restoredAt,
        userId: actorId,
      });

      await this.audit.append(tx, eventCtx, {
        entityType: 'BUSINESS',
        entityId: restoredCtx.tenantId,
        action: 'BUSINESS_RESTORED',
        before: null,
        after: {
          fileName: command.fileName,
          takenAt: archive.manifest.takenAt,
          rows,
        },
        source: 'API',
      });

      return { businessName: archive.manifest.businessName, rowsRestored: rows };
    });

    return { ...result, signedOut: true };
  }

  /**
   * Decrypt, and say honestly which of the two things went wrong.
   *
   * "Wrong password" and "damaged file" send a shopkeeper to two different
   * places — the other secret they wrote down, or a different copy of the file
   * — so they must never collapse into one message (owner decision
   * 2026-08-30).
   */
  private async open(content: Uint8Array): Promise<ArchiveBody> {
    if (!(await this.secrets.isConfigured())) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'No backup password is set for this installation, so no backup file can be opened. ' +
          'Set the same password this file was made with on the Backup screen first.',
      );
    }

    try {
      return await this.codec.decode(content, await this.secrets.read());
    } catch (error) {
      if (!(error instanceof ArchiveOpenError)) throw error;
      throw new AppError(ErrorCode.VALIDATION_FAILED, openFailureMessage(error.failure));
    }
  }
}

function openFailureMessage(failure: 'WRONG_SECRET' | 'DAMAGED' | 'NOT_AN_ARCHIVE'): string {
  if (failure === 'WRONG_SECRET') {
    return (
      'This installation’s backup password does not open this file. ' +
      'The file is fine — it was made with a different password.'
    );
  }
  if (failure === 'DAMAGED') {
    return 'This backup file is damaged and cannot be read. Try another copy of it.';
  }
  return 'This is not a SherERP backup file.';
}

function refusalFor(
  compatibility: ReturnType<typeof archiveCompatibility>,
  applied: readonly string[],
): string {
  if (compatibility.kind === 'TOO_NEW') {
    return (
      `This backup was made by a newer version of SherERP (${compatibility.archiveSchema}) ` +
      `than the one installed here (${applied.at(-1) ?? 'unknown'}). ` +
      'Update SherERP on this computer first, then restore.'
    );
  }
  if (compatibility.kind === 'UNSUPPORTED_FORMAT') {
    return (
      `This backup file is in format version ${String(compatibility.archiveVersion)}, ` +
      'which this version of SherERP cannot read.'
    );
  }
  return '';
}

function totalRows(archive: ArchiveBody): number {
  return archive.tables.reduce((sum, table) => sum + table.rows.length, 0);
}

/**
 * The confirmation screen's list: what the file holds, in the shop's words.
 *
 * Only the tables a shopkeeper would recognise, and only the ones that actually
 * have rows. A preview listing eighty table names would be a wall of text that
 * nobody reads before pressing the button that matters.
 */
function summarize(archive: ArchiveBody): { label: string; rows: number }[] {
  const counts = new Map(archive.tables.map((table) => [table.name, table.rows.length]));
  return NOTABLE_TABLES.map(([name, label]) => ({ label, rows: counts.get(name) ?? 0 })).filter(
    (entry) => entry.rows > 0,
  );
}

const NOTABLE_TABLES: readonly (readonly [string, string])[] = [
  ['products', 'Products'],
  ['parties', 'Customers & suppliers'],
  ['purchases', 'Purchase bills'],
  ['sales', 'Sales invoices'],
  ['sale_payments', 'Sale payments'],
  ['customer_receipts', 'Customer receipts'],
  ['supplier_payments', 'Supplier payments'],
  ['expenses', 'Expenses'],
  ['journal_entries', 'Ledger entries'],
  ['stock_movements', 'Stock movements'],
  ['inventory_lots', 'Stock lots'],
  ['account_reconciliations', 'Reconciliations'],
  ['bank_statement_files', 'Bank statement files'],
  ['users', 'Users'],
  ['audit_events', 'Audit history'],
];
