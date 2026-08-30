import type { ArchiveTable } from './backup-ports';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * The database side of backup, restore and reset (Phase 10).
 *
 * **The table list is discovered, never compiled in.** `exportBusiness` asks the
 * database which tables carry a `tenant_id` and exports every one of them
 * except an explicit, named exclusion list. A hand-kept list of tables to back
 * up is the list that silently omits the module somebody adds next month, and
 * the omission would only be discovered by a shop trying to recover. The
 * exclusions are therefore the thing that must be justified, not the inclusions.
 */

export interface BackupRunRecord {
  readonly id: string;
  readonly kind: 'AUTO' | 'MANUAL';
  readonly status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly fileName: string | null;
  readonly byteSize: number | null;
  readonly error: string | null;
}

export interface StartRunInput {
  readonly id: string;
  readonly kind: 'AUTO' | 'MANUAL';
  readonly startedAt: Date;
  /** Null for the nightly run: no user performed it. */
  readonly userId: string | null;
}

export interface FinishRunInput {
  readonly id: string;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly finishedAt: Date;
  readonly verifiedAt: Date | null;
  readonly fileName: string | null;
  readonly byteSize: number | null;
  readonly checksum: string | null;
  readonly archiveVersion: number | null;
  readonly schemaVersion: string | null;
  readonly error: string | null;
}

export interface RestoreEventInput {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceFileName: string;
  readonly archiveVersion: number;
  readonly archiveSchemaVersion: string;
  readonly archiveTakenAt: Date;
  readonly businessName: string;
  readonly rowCount: number;
  readonly restoredAt: Date;
  readonly userId: string;
}

/**
 * Why this installation cannot accept a restore, in the shop's own terms.
 *
 * `null` means it can. Anything else is shown verbatim on the preview screen
 * beside the Reset action, because the person reading it is one step from the
 * only thing that clears the obstacle.
 */
export type RestoreBlock = string | null;

export interface BackupRepository {
  /* ------------------------------------------------------------- runs */
  startRun(tx: Tx, ctx: TenantContext, input: StartRunInput): Promise<void>;
  finishRun(tx: Tx, ctx: TenantContext, input: FinishRunInput): Promise<void>;
  recentRuns(tx: Tx, ctx: TenantContext, limit: number): Promise<readonly BackupRunRecord[]>;
  lastRunOfKind(
    tx: Tx,
    ctx: TenantContext,
    kind: 'AUTO' | 'MANUAL',
  ): Promise<BackupRunRecord | null>;
  lastSuccessfulManualExportAt(tx: Tx, ctx: TenantContext): Promise<Date | null>;
  recordRestore(tx: Tx, ctx: TenantContext, input: RestoreEventInput): Promise<void>;

  /* ---------------------------------------------------------- the data */
  /** Every tenant-scoped table, in dependency order, for this business. */
  exportBusiness(tx: Tx, ctx: TenantContext): Promise<readonly ArchiveTable[]>;
  /**
   * Writes the archive's rows. Insert order follows the same dependency order;
   * a foreign key that points back up the graph is written null first and
   * filled in by a second pass, because a shop's own data may legitimately
   * contain a cycle (a bill naming its order, an order naming its bill).
   */
  importBusiness(tx: Tx, ctx: TenantContext, tables: readonly ArchiveTable[]): Promise<number>;
  /**
   * Deletes **every** row for this tenant, identity included, children first.
   * Only restore uses this: the archive brings its own identity, and a leftover
   * seeded tenant row would be a second business in a single-business install.
   */
  clearBusiness(tx: Tx, ctx: TenantContext): Promise<number>;
  /**
   * Empties the books but keeps the shop's account — identity, users, roles,
   * permissions and the audit trail. Reset uses this: somebody has to be able
   * to sign back in and perform the restore, and the audit trail is
   * append-only, so the record that a reset happened survives the reset.
   */
  clearBusinessKeepingIdentity(tx: Tx, ctx: TenantContext): Promise<number>;
  /**
   * Puts back the handful of rows provisioning creates and a working shop
   * cannot open without — units (a product needs a base unit), the walk-in
   * customer (D-02) and the starting expense categories.
   */
  reseedBaseline(tx: Tx, ctx: TenantContext): Promise<void>;
  /**
   * Whether this installation still looks like a fresh one: nothing but what
   * provisioning created. Returns the refusal sentence, or null.
   */
  restoreBlock(tx: Tx, ctx: TenantContext): Promise<RestoreBlock>;
  /** True when any of these tables holds a row for this business. */
  hasRowsIn(tx: Tx, ctx: TenantContext, tables: readonly string[]): Promise<boolean>;
  /** The migrations this database has actually applied, in order. */
  appliedMigrations(tx: Tx): Promise<readonly string[]>;
  /**
   * A user id that exists in the **restored** business, for the rows a restore
   * must write about itself. The seeded admin who performed the restore is gone
   * by then, and `created_by` may not name a user this business never had.
   */
  firstOwnerUserId(tx: Tx, ctx: TenantContext): Promise<string>;
  /** The business's own name, for the manifest and the file name. */
  businessName(tx: Tx, ctx: TenantContext): Promise<string>;
  /** Bytes of statement evidence carried, for the manifest. */
  evidenceBytes(tx: Tx, ctx: TenantContext): Promise<number>;
}
