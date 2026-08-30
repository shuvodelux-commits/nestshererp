import type {
  ArchiveTable,
  BackupRepository,
  BackupRunRecord,
  FinishRunInput,
  RestoreBlock,
  RestoreEventInput,
  StartRunInput,
  TenantContext,
  Tx,
} from '@sher/core-application';
import {
  SEED_EXPENSE_CATEGORIES,
  SEED_UNITS,
  WALK_IN_PARTY_NAME,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';
import { sql } from 'drizzle-orm';

import { txOf } from './unit-of-work';

/**
 * The database half of backup, restore and reset (Phase 10).
 *
 * **The table list is discovered from the database, never compiled in.** Every
 * table carrying a `tenant_id`, plus `tenants` itself, is exported — except an
 * explicit exclusion list that has to justify itself. A hand-kept list of
 * tables *to include* is the list that silently omits the module somebody adds
 * next month, and the omission would surface as a shop discovering, mid
 * recovery, that a year of warranty claims was never in any backup.
 *
 * **Order comes from the foreign keys, not from a constant.** Parents are
 * written before children, computed from `pg_constraint` at run time. Where the
 * shop's own data legitimately contains a cycle — a purchase naming the
 * supplier order it came from, that order naming the purchase it became — the
 * cycle is broken on a nullable column: the row goes in without it, and a
 * second pass fills it. Deleting walks the same order backwards.
 */

/* ------------------------------------------------------------ exclusions */

/**
 * Ephemeral runtime state (owner decision 2026-08-30). Recreated clean after a
 * restore, never carried in an archive.
 *
 * Each of these would be actively wrong to restore. A refresh token minted in a
 * database that no longer exists is a live credential from another moment; a
 * spent idempotency key would make a legitimate retry a silent no-op; and the
 * outbox is a queue of operations the future sync engine would replay against a
 * server that never saw the database they came from.
 */
const EPHEMERAL_TABLES: readonly string[] = [
  'otp_codes',
  'refresh_tokens',
  'idempotency_keys',
  'outbox',
];

/**
 * This module's own bookkeeping. Excluded because it describes files on **one
 * machine**: an archive that restored a claim of fourteen nightly backups onto
 * a new computer would be lying about the only thing an owner opens this screen
 * to find out.
 */
const MACHINE_LOCAL_TABLES: readonly string[] = ['backup_runs', 'restore_events'];

/**
 * What provisioning creates, and therefore what a genuinely empty installation
 * is allowed to contain. Rows anywhere else mean this shop has started
 * trading, and restore refuses (owner decision 2026-08-30).
 *
 * `audit_events` is here because the trail is append-only and survives a reset:
 * the record that somebody emptied this installation must not be erased by the
 * act of emptying it.
 */
const BASELINE_TABLES: readonly string[] = [
  'tenants',
  'users',
  'roles',
  'role_permissions',
  'user_identifiers',
  'units',
  'expense_categories',
  'parties',
  'party_roles',
  'audit_events',
  'numbering_counters',
];

/** Identity: what a reset keeps and only a restore replaces. */
const IDENTITY_TABLES: readonly string[] = [
  'tenants',
  'users',
  'roles',
  'role_permissions',
  'user_identifiers',
  'audit_events',
];

/** Table names in refusal sentences, in the shop's words. */
const FRIENDLY_NAMES: Readonly<Record<string, string>> = {
  products: 'products',
  sales: 'sales',
  purchases: 'purchase bills',
  journal_entries: 'ledger entries',
  expenses: 'expenses',
  stock_movements: 'stock movements',
  accounts: 'money accounts',
  settings: 'changed settings',
};

/* ------------------------------------------------------------- structure */

interface ColumnInfo {
  readonly name: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
}

interface TableInfo {
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
  /** How this table's rows are filtered to one business. */
  readonly tenantColumn: 'tenant_id' | 'id';
}

interface Structure {
  /** Parents before children. */
  readonly ordered: readonly TableInfo[];
  /** table → columns that must be written null first and filled in afterwards. */
  readonly deferred: ReadonlyMap<string, readonly string[]>;
}

/** A byte column in an archive: base64 under a marker no real value can be. */
interface EncodedBytes {
  readonly $bytes: string;
}

export class PostgresBackupRepository implements BackupRepository {
  constructor(private readonly clock: Clock) {}

  /* ------------------------------------------------------------ runs */

  async startRun(tx: Tx, ctx: TenantContext, input: StartRunInput): Promise<void> {
    const actor = input.userId ?? SYSTEM_ACTOR;
    await txOf(tx).execute(sql`
      INSERT INTO backup_runs
        (id, tenant_id, kind, status, started_at, created_at, updated_at, created_by, updated_by)
      VALUES (${input.id}, ${ctx.tenantId}, ${input.kind}, 'RUNNING', ${input.startedAt},
              ${input.startedAt}, ${input.startedAt}, ${actor}, ${actor})
    `);
  }

  async finishRun(tx: Tx, ctx: TenantContext, input: FinishRunInput): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE backup_runs SET
        status = ${input.status},
        finished_at = ${input.finishedAt},
        verified_at = ${input.verifiedAt},
        file_name = ${input.fileName},
        byte_size = ${input.byteSize},
        checksum = ${input.checksum},
        archive_version = ${input.archiveVersion},
        schema_version = ${input.schemaVersion},
        error = ${input.error},
        updated_at = ${input.finishedAt},
        version = version + 1
      WHERE id = ${input.id} AND tenant_id = ${ctx.tenantId}
    `);
  }

  async recentRuns(
    tx: Tx,
    ctx: TenantContext,
    limit: number,
  ): Promise<readonly BackupRunRecord[]> {
    const result = await txOf(tx).execute(sql`
      SELECT id, kind, status, started_at, finished_at, verified_at, file_name, byte_size, error
      FROM backup_runs WHERE tenant_id = ${ctx.tenantId}
      ORDER BY started_at DESC LIMIT ${limit}
    `);
    return result.rows.map(toRun);
  }

  async lastRunOfKind(
    tx: Tx,
    ctx: TenantContext,
    kind: 'AUTO' | 'MANUAL',
  ): Promise<BackupRunRecord | null> {
    const result = await txOf(tx).execute(sql`
      SELECT id, kind, status, started_at, finished_at, verified_at, file_name, byte_size, error
      FROM backup_runs WHERE tenant_id = ${ctx.tenantId} AND kind = ${kind}
      ORDER BY started_at DESC LIMIT 1
    `);
    return result.rows.length === 0 ? null : toRun(result.rows[0]);
  }

  async lastSuccessfulManualExportAt(tx: Tx, ctx: TenantContext): Promise<Date | null> {
    const result = await txOf(tx).execute(sql`
      SELECT finished_at FROM backup_runs
      WHERE tenant_id = ${ctx.tenantId} AND kind = 'MANUAL' AND status = 'SUCCESS'
      ORDER BY finished_at DESC LIMIT 1
    `);
    // `timestamptz` arrives from the driver as a `Date` already; re-wrapping it
    // would be an ambient clock read for no gain (R-C2, the boundary checker).
    return (result.rows[0] as { finished_at: Date | null } | undefined)?.finished_at ?? null;
  }

  async recordRestore(tx: Tx, ctx: TenantContext, input: RestoreEventInput): Promise<void> {
    await txOf(tx).execute(sql`
      INSERT INTO restore_events
        (id, tenant_id, source_file_name, archive_version, archive_schema_version,
         archive_taken_at, business_name, row_count, restored_at,
         created_at, updated_at, created_by, updated_by)
      VALUES (${input.id}, ${input.tenantId}, ${input.sourceFileName}, ${input.archiveVersion},
              ${input.archiveSchemaVersion}, ${input.archiveTakenAt}, ${input.businessName},
              ${input.rowCount}, ${input.restoredAt}, ${input.restoredAt}, ${input.restoredAt},
              ${input.userId}, ${input.userId})
    `);
    void ctx;
  }

  /* ------------------------------------------------------------ data */

  async exportBusiness(tx: Tx, ctx: TenantContext): Promise<readonly ArchiveTable[]> {
    const structure = await this.structure(tx);
    const tables: ArchiveTable[] = [];

    for (const table of structure.ordered) {
      const columns = table.columns.map((column) => column.name);
      const result = await txOf(tx).execute(
        sql`SELECT * FROM ${sql.raw(quote(table.name))} WHERE ${sql.raw(
          quote(table.tenantColumn),
        )} = ${ctx.tenantId}`,
      );

      tables.push({
        name: table.name,
        columns,
        rows: result.rows.map((row) =>
          columns.map((column) => encodeValue((row as Record<string, unknown>)[column])),
        ),
      });
    }

    return tables;
  }

  async importBusiness(
    tx: Tx,
    ctx: TenantContext,
    tables: readonly ArchiveTable[],
  ): Promise<number> {
    const structure = await this.structure(tx);
    const byName = new Map(tables.map((table) => [table.name, table]));
    let written = 0;

    for (const target of structure.ordered) {
      const source = byName.get(target.name);
      if (source === undefined || source.rows.length === 0) continue;

      /*
       * Forward migration, and it is this loop rather than a registry of
       * hand-written steps.
       *
       * A column the archive has and this build has dropped is skipped; a
       * column this build added takes its default. A column this build requires
       * that the archive cannot supply is the only case that cannot be carried
       * forward, and it stops the restore by name rather than by a constraint
       * violation nobody can read.
       */
      const usable = source.columns.filter((column) =>
        target.columns.some((existing) => existing.name === column),
      );
      const unsatisfiable = target.columns.filter(
        (column) =>
          !column.nullable && !column.hasDefault && !source.columns.includes(column.name),
      );
      const firstMissing = unsatisfiable[0];
      if (firstMissing !== undefined) {
        throw new Error(
          `this backup is missing ${target.name}.${firstMissing.name}, which this version of ` +
            'SherERP requires. The backup is too old for this build to carry forward.',
        );
      }

      const deferred = structure.deferred.get(target.name) ?? [];
      const insertColumns = usable.filter((column) => !deferred.includes(column));
      const columnIndex = new Map(source.columns.map((column, index) => [column, index]));

      for (const row of source.rows) {
        const values = insertColumns.map((column) =>
          decodeValue(row[columnIndex.get(column) ?? -1]),
        );
        await txOf(tx).execute(
          sql`INSERT INTO ${sql.raw(quote(target.name))} (${sql.raw(
            insertColumns.map(quote).join(', '),
          )}) VALUES (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`,
        );
        written += 1;
      }

      // The second pass: the columns held back to break a cycle, now that every
      // row they point at exists.
      const fillable = deferred.filter((column) => usable.includes(column));
      if (fillable.length > 0 && source.columns.includes('id')) {
        const idIndex = columnIndex.get('id') ?? -1;
        for (const row of source.rows) {
          const assignments = fillable
            .map((column) => ({ column, value: decodeValue(row[columnIndex.get(column) ?? -1]) }))
            .filter((entry) => entry.value !== null);
          if (assignments.length === 0) continue;

          await txOf(tx).execute(
            sql`UPDATE ${sql.raw(quote(target.name))} SET ${sql.join(
              assignments.map(
                (entry) => sql`${sql.raw(quote(entry.column))} = ${entry.value}`,
              ),
              sql`, `,
            )} WHERE id = ${decodeValue(row[idIndex])}`,
          );
        }
      }
    }

    void ctx;
    return written;
  }

  async clearBusiness(tx: Tx, ctx: TenantContext): Promise<number> {
    return this.clear(tx, ctx, []);
  }

  async clearBusinessKeepingIdentity(tx: Tx, ctx: TenantContext): Promise<number> {
    return this.clear(tx, ctx, IDENTITY_TABLES);
  }

  private async clear(
    tx: Tx,
    ctx: TenantContext,
    keep: readonly string[],
  ): Promise<number> {
    const structure = await this.structure(tx);
    let deleted = 0;

    // Children first: the reverse of the write order, so no delete ever trips a
    // foreign key that a later delete was about to remove anyway.
    for (const table of [...structure.ordered].reverse()) {
      if (keep.includes(table.name)) continue;
      const result = await txOf(tx).execute(
        sql`DELETE FROM ${sql.raw(quote(table.name))} WHERE ${sql.raw(
          quote(table.tenantColumn),
        )} = ${ctx.tenantId}`,
      );
      deleted += result.rowCount ?? 0;
    }

    // Ephemeral tables are not in an archive, but they are certainly in the
    // database, and a session that outlived the business it belonged to is the
    // one thing a clear must not leave behind.
    for (const table of EPHEMERAL_TABLES) {
      const exists = await this.tableExists(tx, table);
      if (!exists) continue;
      const hasTenant = await this.hasTenantColumn(tx, table);
      if (!hasTenant) continue;
      const result = await txOf(tx).execute(
        sql`DELETE FROM ${sql.raw(quote(table))} WHERE tenant_id = ${ctx.tenantId}`,
      );
      deleted += result.rowCount ?? 0;
    }

    return deleted;
  }

  async reseedBaseline(tx: Tx, ctx: TenantContext): Promise<void> {
    const now = this.clock.now();
    const actor = ctx.userId;

    for (const name of SEED_UNITS) {
      await txOf(tx).execute(sql`
        INSERT INTO units (id, tenant_id, name, created_at, updated_at, created_by, updated_by)
        VALUES (${Ulid.generate(this.clock)}, ${ctx.tenantId}, ${name}, ${now}, ${now},
                ${actor}, ${actor})
      `);
    }

    for (const category of SEED_EXPENSE_CATEGORIES) {
      await txOf(tx).execute(sql`
        INSERT INTO expense_categories
          (id, tenant_id, code, name, created_at, updated_at, created_by, updated_by)
        VALUES (${Ulid.generate(this.clock)}, ${ctx.tenantId}, ${category.code}, ${category.name},
                ${now}, ${now}, ${actor}, ${actor})
      `);
    }

    // D-02's walk-in customer. A shop cannot ring up a guest sale without it,
    // so an installation left without one is an installation that cannot trade.
    const partyId = Ulid.generate(this.clock);
    await txOf(tx).execute(sql`
      INSERT INTO parties
        (id, tenant_id, name, is_system_reserved, created_at, updated_at, created_by, updated_by)
      VALUES (${partyId}, ${ctx.tenantId}, ${WALK_IN_PARTY_NAME}, TRUE, ${now}, ${now},
              ${actor}, ${actor})
    `);
    await txOf(tx).execute(sql`
      INSERT INTO party_roles
        (id, tenant_id, party_id, role, created_at, updated_at, created_by, updated_by)
      VALUES (${Ulid.generate(this.clock)}, ${ctx.tenantId}, ${partyId}, 'CUSTOMER', ${now},
              ${now}, ${actor}, ${actor})
    `);
  }

  async restoreBlock(tx: Tx, ctx: TenantContext): Promise<RestoreBlock> {
    const structure = await this.structure(tx);
    const populated: string[] = [];

    for (const table of structure.ordered) {
      if (BASELINE_TABLES.includes(table.name)) continue;
      const result = await txOf(tx).execute(
        sql`SELECT 1 FROM ${sql.raw(quote(table.name))} WHERE ${sql.raw(
          quote(table.tenantColumn),
        )} = ${ctx.tenantId} LIMIT 1`,
      );
      if (result.rows.length > 0) populated.push(FRIENDLY_NAMES[table.name] ?? table.name);
      if (populated.length === 3) break;
    }

    // A real customer or supplier is business data even though `parties` is a
    // table provisioning touches — it seeds exactly one row, the walk-in
    // customer, and anything beyond it is a shop that has started trading.
    const realParties = await txOf(tx).execute(sql`
      SELECT 1 FROM parties
      WHERE tenant_id = ${ctx.tenantId} AND is_system_reserved = FALSE LIMIT 1
    `);
    if (realParties.rows.length > 0) populated.unshift('customers or suppliers');

    if (populated.length === 0) return null;

    return (
      `This installation already has business data in it (${populated.join(', ')}). ` +
      'A backup can only be restored into an empty installation. ' +
      'Use Reset Business Data below first — it takes a recovery copy before it clears anything.'
    );
  }

  async hasRowsIn(tx: Tx, ctx: TenantContext, tables: readonly string[]): Promise<boolean> {
    for (const table of tables) {
      if (!(await this.tableExists(tx, table))) continue;
      const result = await txOf(tx).execute(
        sql`SELECT 1 FROM ${sql.raw(quote(table))} WHERE tenant_id = ${ctx.tenantId} LIMIT 1`,
      );
      if (result.rows.length > 0) return true;
    }
    return false;
  }

  async appliedMigrations(tx: Tx): Promise<readonly string[]> {
    const result = await txOf(tx).execute(
      sql`SELECT name FROM schema_migrations ORDER BY name ASC`,
    );
    return result.rows.map((row) => (row as { name: string }).name);
  }

  async businessName(tx: Tx, ctx: TenantContext): Promise<string> {
    const result = await txOf(tx).execute(
      sql`SELECT name FROM tenants WHERE id = ${ctx.tenantId}`,
    );
    return result.rows.length === 0 ? 'SherERP' : (result.rows[0] as { name: string }).name;
  }

  async firstOwnerUserId(tx: Tx, ctx: TenantContext): Promise<string> {
    const result = await txOf(tx).execute(sql`
      SELECT u.id FROM users u
      JOIN roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id
      WHERE u.tenant_id = ${ctx.tenantId} AND u.deleted_at IS NULL AND r.code = 'OWNER'
      ORDER BY u.id ASC LIMIT 1
    `);
    if (result.rows.length > 0) return (result.rows[0] as { id: string }).id;

    const anyUser = await txOf(tx).execute(
      sql`SELECT id FROM users WHERE tenant_id = ${ctx.tenantId} ORDER BY id ASC LIMIT 1`,
    );
    if (anyUser.rows.length === 0) {
      throw new Error('the archive contains no users, so it cannot be a SherERP business');
    }
    return (anyUser.rows[0] as { id: string }).id;
  }

  async evidenceBytes(tx: Tx, ctx: TenantContext): Promise<number> {
    const result = await txOf(tx).execute(sql`
      SELECT COALESCE(SUM(byte_size), 0) AS total
      FROM bank_statement_files WHERE tenant_id = ${ctx.tenantId}
    `);
    return Number((result.rows[0] as { total: number | string }).total);
  }

  /* -------------------------------------------------------- structure */

  private async tableExists(tx: Tx, name: string): Promise<boolean> {
    const result = await txOf(tx).execute(sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    `);
    return result.rows.length > 0;
  }

  private async hasTenantColumn(tx: Tx, name: string): Promise<boolean> {
    const result = await txOf(tx).execute(sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${name} AND column_name = 'tenant_id'
    `);
    return result.rows.length > 0;
  }

  /**
   * Which tables belong to a business, in an order that respects their keys.
   *
   * Recomputed per call rather than cached: a restore runs immediately after a
   * migration in the one workflow that matters, and a cached shape from before
   * the upgrade is exactly the wrong thing to write rows with.
   */
  private async structure(tx: Tx): Promise<Structure> {
    const columnRows = await txOf(tx).execute(sql`
      SELECT c.table_name, c.column_name, c.is_nullable, c.column_default
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position
    `);

    const columns = new Map<string, ColumnInfo[]>();
    for (const raw of columnRows.rows) {
      const row = raw as {
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      };
      const list = columns.get(row.table_name) ?? [];
      list.push({
        name: row.column_name,
        nullable: row.is_nullable === 'YES',
        hasDefault: row.column_default !== null,
      });
      columns.set(row.table_name, list);
    }

    const excluded = new Set([...EPHEMERAL_TABLES, ...MACHINE_LOCAL_TABLES, 'schema_migrations']);
    const tables: TableInfo[] = [];
    for (const [name, list] of columns) {
      if (excluded.has(name)) continue;
      const hasTenant = list.some((column) => column.name === 'tenant_id');
      if (name === 'tenants') {
        tables.push({ name, columns: list, tenantColumn: 'id' });
      } else if (hasTenant) {
        tables.push({ name, columns: list, tenantColumn: 'tenant_id' });
      }
    }

    const edgeRows = await txOf(tx).execute(sql`
      SELECT src.relname AS child, tgt.relname AS parent,
             -- Cast to text[]: the name[] type has no parser in the driver and
             -- would arrive as a raw literal string rather than an array.
             (SELECT array_agg(a.attname::text ORDER BY x.ord)
              FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum)::text[] AS cols
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'
    `);

    const known = new Set(tables.map((table) => table.name));
    const edges = edgeRows.rows
      .map((raw) => raw as { child: string; parent: string; cols: string[] | null })
      .filter((edge) => known.has(edge.child) && known.has(edge.parent))
      .map((edge) => ({ ...edge, cols: edge.cols ?? [] }));

    return orderTables(tables, edges);
  }
}

/**
 * Parents before children, with cycles broken on a nullable column.
 *
 * A depth-first walk. A back edge means the two tables point at each other —
 * which happens for real, legitimate reasons in this schema — and the edge is
 * dropped from the ordering, its columns recorded so the writer knows to fill
 * them in a second pass. A cycle that cannot be broken because every column in
 * it is `NOT NULL` would be a schema no restore could ever write, and it fails
 * loudly here rather than as a constraint violation halfway through a recovery.
 */
function orderTables(
  tables: readonly TableInfo[],
  edges: readonly { child: string; parent: string; cols: string[] }[],
): Structure {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const parentsOf = new Map<string, { parent: string; cols: string[] }[]>();
  for (const edge of edges) {
    if (edge.child === edge.parent) continue;
    const list = parentsOf.get(edge.child) ?? [];
    list.push({ parent: edge.parent, cols: edge.cols ?? [] });
    parentsOf.set(edge.child, list);
  }

  const ordered: TableInfo[] = [];
  const deferred = new Map<string, string[]>();
  const state = new Map<string, 'VISITING' | 'DONE'>();

  const visit = (name: string): void => {
    const status = state.get(name);
    if (status === 'DONE') return;
    if (status === 'VISITING') return;

    state.set(name, 'VISITING');
    for (const edge of parentsOf.get(name) ?? []) {
      if (state.get(edge.parent) === 'VISITING') {
        // The back edge. Break it here, on this child's own columns.
        const table = byName.get(name);
        const breakable = edge.cols.filter((column) =>
          table?.columns.some((existing) => existing.name === column && existing.nullable),
        );
        if (breakable.length !== edge.cols.length) {
          throw new Error(
            `${name} → ${edge.parent} is a required cycle and cannot be restored in any order`,
          );
        }
        deferred.set(name, [...(deferred.get(name) ?? []), ...breakable]);
        continue;
      }
      visit(edge.parent);
    }
    state.set(name, 'DONE');
    const table = byName.get(name);
    if (table !== undefined) ordered.push(table);
  };

  // `tenants` first whatever the keys say: everything references it, and a
  // business's own row is the one thing that cannot arrive second.
  visit('tenants');
  for (const table of tables) visit(table.name);

  return { ordered, deferred };
}

/* --------------------------------------------------------------- values */

/** Bytes travel base64 under a marker; instants travel ISO. Everything else is itself. */
function encodeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') } satisfies EncodedBytes;
  return value;
}

function decodeValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '$bytes' in value) {
    return Buffer.from((value as EncodedBytes).$bytes, 'base64');
  }
  return value ?? null;
}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`refusing to build SQL with the identifier ${identifier}`);
  }
  return `"${identifier}"`;
}

function toRun(raw: unknown): BackupRunRecord {
  const row = raw as {
    id: string;
    kind: 'AUTO' | 'MANUAL';
    status: 'RUNNING' | 'SUCCESS' | 'FAILED';
    started_at: Date;
    finished_at: Date | null;
    verified_at: Date | null;
    file_name: string | null;
    byte_size: number | null;
    error: string | null;
  };
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    verifiedAt: row.verified_at,
    fileName: row.file_name,
    byteSize: row.byte_size,
    error: row.error,
  };
}

/** Phase 0's reserved actor, for the nightly run nobody performed. */
const SYSTEM_ACTOR = '00000000000000000000000000';
