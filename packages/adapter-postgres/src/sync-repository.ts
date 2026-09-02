import type {
  NewSyncConflict,
  NewSyncOperation,
  SyncChangeRow,
  SyncConflictRow,
  SyncCounts,
  SyncOperationOutcome,
  SyncOperationRow,
  SyncOperationStatus,
  SyncRepository,
  TenantContext,
  Tx,
} from '@sher/core-application';
import { OP_DOCUMENT_TABLE } from '@sher/core-application';
import type { SyncOpType, SyncReasonCode, SyncResolution } from '@sher/core-contracts';
import { parseInstant } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';
import { sql } from 'drizzle-orm';

import { txOf } from './unit-of-work';

/**
 * Synchronisation over PostgreSQL (Phase 12.4, §5.23).
 *
 * No business rule lives here (R-B6). The replay service decides what may be
 * tried and the posting services decide what may be posted; this writes down
 * what was sent, what came back, and what a person decided — and nothing it
 * stores is ever read back to compute a figure.
 *
 * Raw SQL rather than Drizzle's builder for the parts that name a table
 * dynamically (`markOffline`) and for the union that reads the change feed.
 * Every column named here was checked against `information_schema` before it
 * was written, which is Phase 8.2's lesson applied rather than relearned.
 */
export class PostgresSyncRepository implements SyncRepository {
  constructor(private readonly clock: Clock) {}

  async findOperationByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<SyncOperationRow | null> {
    const rows = await txOf(tx).execute<OperationRecord>(sql`
      ${OPERATION_SELECT}
       WHERE o.tenant_id = ${ctx.tenantId} AND o.operation_id = ${operationId}
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toOperation(row);
  }

  async findOperationById(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<SyncOperationRow | null> {
    const rows = await txOf(tx).execute<OperationRecord>(sql`
      ${OPERATION_SELECT}
       WHERE o.tenant_id = ${ctx.tenantId} AND o.id = ${id}
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toOperation(row);
  }

  async findOperationByDeviceSeq(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    localSeq: number,
  ): Promise<SyncOperationRow | null> {
    const rows = await txOf(tx).execute<OperationRecord>(sql`
      ${OPERATION_SELECT}
       WHERE o.tenant_id = ${ctx.tenantId} AND o.device_id = ${deviceId}
         AND o.local_seq = ${localSeq}
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toOperation(row);
  }

  async insertOperation(tx: Tx, ctx: TenantContext, op: NewSyncOperation): Promise<void> {
    const now = this.clock.now();
    await txOf(tx).execute(sql`
      INSERT INTO sync_operations
        (id, tenant_id, device_id, operation_id, local_seq, op_type, payload, context,
         depends_on, client_result_digest, device_created_at, business_date, status,
         received_at, created_at, updated_at, created_by, updated_by)
      VALUES
        (${op.id}, ${ctx.tenantId}, ${op.deviceId}, ${op.operationId}, ${op.localSeq},
         ${op.opType}, ${JSON.stringify(op.payload)}::jsonb, ${JSON.stringify(op.context)}::jsonb,
         ${JSON.stringify(op.dependsOn)}::jsonb,
         ${op.clientResultDigest === null ? null : JSON.stringify(op.clientResultDigest)},
         ${op.deviceCreatedAt}, ${op.businessDate}, 'IN_FLIGHT',
         ${op.receivedAt}, ${now}, ${now}, ${ctx.userId}, ${ctx.userId})
      ON CONFLICT ON CONSTRAINT sync_operations_operation_unique DO NOTHING
    `);
  }

  /**
   * Writes what became of an operation, and hands back the shop-wide sequence
   * number when it was accepted.
   *
   * The sequence is drawn only on acceptance, so it counts documents that
   * actually entered the books rather than attempts to enter them.
   */
  async recordOutcome(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    outcome: SyncOperationOutcome,
  ): Promise<number | null> {
    const now = this.clock.now();
    const digest =
      outcome.serverResultDigest === undefined || outcome.serverResultDigest === null
        ? null
        : JSON.stringify(outcome.serverResultDigest);
    const divergence =
      outcome.divergence === undefined || outcome.divergence === null
        ? null
        : JSON.stringify(outcome.divergence);
    /*
     * The two json columns are left out of the SET list entirely when there is
     * nothing to write, rather than guarded inside the statement. A null
     * parameter beside a jsonb column has no type of its own, and every shape
     * that tries to give it one inside the query — COALESCE, CASE — leaves the
     * planner unifying text with jsonb and refusing the whole statement. A
     * column that is not being written simply does not appear.
     */
    const digestSet =
      digest === null ? sql`` : sql`server_result_digest = ${digest}::jsonb,`;
    const divergenceSet =
      divergence === null ? sql`` : sql`divergence = ${divergence}::jsonb,`;

    const rows = await txOf(tx).execute<{ server_seq: string | null }>(sql`
      UPDATE sync_operations
         SET status = ${outcome.status},
             result_document_id = COALESCE(${outcome.resultDocumentId ?? null}, result_document_id),
             result_document_number = COALESCE(${outcome.resultDocumentNumber ?? null}, result_document_number),
             ${digestSet}
             ${divergenceSet}
             server_seq = CASE
               WHEN ${outcome.assignServerSeq ?? false} AND server_seq IS NULL
                 THEN nextval('sync_operations_server_seq')
               ELSE server_seq
             END,
             applied_at = CASE WHEN ${outcome.status} = 'APPLIED' THEN ${outcome.at} ELSE applied_at END,
             last_error_code = ${outcome.errorCode ?? null},
             last_error_message = ${outcome.errorMessage ?? null},
             updated_at = ${now}, updated_by = ${ctx.userId}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
      RETURNING server_seq
    `);
    const seq = rows.rows[0]?.server_seq ?? null;
    return seq === null ? null : Number(seq);
  }

  async countAttempt(tx: Tx, ctx: TenantContext, id: string, at: Date): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE sync_operations
         SET attempts = attempts + 1, updated_at = ${at}, updated_by = ${ctx.userId}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
    `);
  }

  async openConflictFor(
    tx: Tx,
    ctx: TenantContext,
    syncOperationId: string,
  ): Promise<SyncConflictRow | null> {
    const rows = await txOf(tx).execute<ConflictRecord>(sql`
      ${CONFLICT_SELECT}
       WHERE c.tenant_id = ${ctx.tenantId}
         AND c.sync_operation_id = ${syncOperationId}
         AND c.status = 'OPEN'
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toConflict(row);
  }

  /**
   * One open conflict per operation, updated rather than repeated.
   *
   * A retry that fails again must not give the manager the same document to
   * read twice — the count in the top bar has to keep meaning "things to deal
   * with", not "times something was tried".
   */
  async upsertConflict(tx: Tx, ctx: TenantContext, conflict: NewSyncConflict): Promise<string> {
    const now = this.clock.now();
    const serverState =
      conflict.serverState === null || conflict.serverState === undefined
        ? null
        : JSON.stringify(conflict.serverState);
    const localState =
      conflict.localState === null || conflict.localState === undefined
        ? null
        : JSON.stringify(conflict.localState);
    const rows = await txOf(tx).execute<{ id: string }>(sql`
      INSERT INTO sync_conflicts
        (id, tenant_id, sync_operation_id, reason_code, reason_message, server_state,
         local_state, suggested_actions, status, created_at, updated_at, created_by, updated_by)
      VALUES
        (${conflict.id}, ${ctx.tenantId}, ${conflict.syncOperationId}, ${conflict.reasonCode},
         ${conflict.reasonMessage},
         ${serverState}::jsonb, ${localState}::jsonb,
         ${JSON.stringify(conflict.suggestedActions)}::jsonb, 'OPEN',
         ${now}, ${now}, ${ctx.userId}, ${ctx.userId})
      ON CONFLICT ON CONSTRAINT sync_conflicts_one_per_operation DO UPDATE
        SET reason_code = EXCLUDED.reason_code,
            reason_message = EXCLUDED.reason_message,
            server_state = EXCLUDED.server_state,
            suggested_actions = EXCLUDED.suggested_actions,
            -- A conflict that was resolved and then failed again is open again.
            status = 'OPEN',
            resolution = NULL,
            resolution_reason = NULL,
            resolved_at = NULL,
            resolved_by = NULL,
            updated_at = ${now},
            updated_by = ${ctx.userId},
            version = sync_conflicts.version + 1
      RETURNING id
    `);
    return String(rows.rows[0]?.id ?? conflict.id);
  }

  async findConflictById(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<SyncConflictRow | null> {
    const rows = await txOf(tx).execute<ConflictRecord>(sql`
      ${CONFLICT_SELECT}
       WHERE c.tenant_id = ${ctx.tenantId} AND c.id = ${id}
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toConflict(row);
  }

  async listConflicts(
    tx: Tx,
    ctx: TenantContext,
    query: {
      readonly status: 'OPEN' | 'RESOLVED' | 'DISCARDED' | 'ALL';
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<readonly SyncConflictRow[]> {
    const statusFilter =
      query.status === 'ALL' ? sql`TRUE` : sql`c.status = ${query.status}`;
    // Keyset paging on the id, which is a ULID and therefore already in time
    // order — §3.9 bans OFFSET, and a cursor on a monotonic id cannot skip or
    // repeat a row when two conflicts share a millisecond.
    const cursorFilter =
      query.cursor === undefined ? sql`TRUE` : sql`c.id < ${query.cursor}`;

    const rows = await txOf(tx).execute<ConflictRecord>(sql`
      ${CONFLICT_SELECT}
       WHERE c.tenant_id = ${ctx.tenantId} AND ${statusFilter} AND ${cursorFilter}
       ORDER BY c.id DESC
       LIMIT ${query.limit}
    `);
    return rows.rows.map(toConflict);
  }

  async closeConflict(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    decision: {
      readonly status: 'RESOLVED' | 'DISCARDED';
      readonly resolution: SyncResolution;
      readonly reason: string | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE sync_conflicts
         SET status = ${decision.status},
             resolution = ${decision.resolution},
             resolution_reason = ${decision.reason},
             resolved_at = ${decision.at},
             resolved_by = ${ctx.userId},
             updated_at = ${decision.at},
             updated_by = ${ctx.userId},
             version = version + 1
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
    `);
  }

  async counts(tx: Tx, ctx: TenantContext): Promise<SyncCounts> {
    const rows = await txOf(tx).execute<{
      applied: string;
      open_conflicts: string;
      resolved_conflicts: string;
      discarded: string;
    }>(sql`
      SELECT
        (SELECT count(*) FROM sync_operations
          WHERE tenant_id = ${ctx.tenantId} AND status = 'APPLIED')            AS applied,
        (SELECT count(*) FROM sync_conflicts
          WHERE tenant_id = ${ctx.tenantId} AND status = 'OPEN')               AS open_conflicts,
        (SELECT count(*) FROM sync_conflicts
          WHERE tenant_id = ${ctx.tenantId} AND status = 'RESOLVED')           AS resolved_conflicts,
        (SELECT count(*) FROM sync_operations
          WHERE tenant_id = ${ctx.tenantId} AND status = 'DISCARDED')          AS discarded
    `);
    const row = rows.rows[0];
    return {
      applied: Number(row?.applied ?? 0),
      openConflicts: Number(row?.open_conflicts ?? 0),
      resolvedConflicts: Number(row?.resolved_conflicts ?? 0),
      discarded: Number(row?.discarded ?? 0),
    };
  }

  async recordPush(tx: Tx, ctx: TenantContext, deviceId: string, at: Date): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE device_authorizations
         SET last_push_at = ${at}, updated_at = ${at}, updated_by = ${ctx.userId}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${deviceId}
    `);
  }

  async recordPull(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    at: Date,
    cursor: Date,
  ): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE device_authorizations
         SET last_pull_at = ${at},
             -- Never moves backwards: a device replaying an old pull must not
             -- be told to forget everything it learned since.
             sync_cursor = GREATEST(COALESCE(sync_cursor, ${cursor}), ${cursor}),
             updated_at = ${at}, updated_by = ${ctx.userId}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${deviceId}
    `);
  }

  async resolveLocalIds(
    tx: Tx,
    ctx: TenantContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await txOf(tx).execute<{ operation_id: string; result_document_id: string }>(sql`
      SELECT operation_id, result_document_id
        FROM sync_operations
       WHERE tenant_id = ${ctx.tenantId}
         AND status = 'APPLIED'
         AND result_document_id IS NOT NULL
         -- An explicit list rather than = ANY(array): this driver renders a
         -- JavaScript array as a record, and Postgres will not cast a record to
         -- an array of char(26). The list is short — it is the ids inside one
         -- operation's payload — so there is nothing to gain from an array.
         AND operation_id IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})
    `);
    return new Map(
      rows.rows.map((row) => [String(row.operation_id), String(row.result_document_id)]),
    );
  }

  /**
   * The origin trail, and only the origin trail.
   *
   * The table name is interpolated, so it is taken from `OP_DOCUMENT_TABLE` —
   * a closed list in the application layer — and checked against that list
   * again here before a statement is built. A name that is not on the list is
   * a programming error, not a request, and it stops here rather than reaching
   * the database.
   */
  async markOffline(
    tx: Tx,
    ctx: TenantContext,
    stamp: {
      readonly table: string;
      readonly documentId: string;
      readonly deviceId: string;
      readonly deviceCreatedAt: Date;
      readonly deviceSeq: number;
      readonly syncedAt: Date;
    },
  ): Promise<void> {
    if (!ORIGIN_TABLES.has(stamp.table)) {
      throw new Error(`refusing to stamp offline origin on unknown table ${stamp.table}`);
    }
    await txOf(tx).execute(sql`
      UPDATE ${sql.raw(`"${stamp.table}"`)}
         SET origin_mode = 'OFFLINE',
             origin_device_id = ${stamp.deviceId},
             device_created_at = ${stamp.deviceCreatedAt},
             device_seq = ${stamp.deviceSeq},
             synced_at = ${stamp.syncedAt}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${stamp.documentId}
    `);
  }

  /**
   * Master data changed since the device last looked.
   *
   * Read from the tables' own `updated_at`, so there is nothing to keep in step
   * with them. A row whose `deleted_at` is set comes back as a tombstone, since
   * a device that merely stops hearing about a product would keep selling it.
   */
  async changesSince(
    tx: Tx,
    ctx: TenantContext,
    cursor: Date | null,
    limit: number,
  ): Promise<readonly SyncChangeRow[]> {
    // The epoch, built through the clock port rather than `new Date(0)`: the
    // rule that time comes from one place is worth more than the characters it
    // costs here, and this is a first-ever pull, not a moment in the shop's day.
    const since = cursor ?? (parseInstant('1970-01-01T00:00:00.000Z') as Date);
    const rows = await txOf(tx).execute<{
      entity: string;
      id: string;
      kind: string;
      entity_version: number;
      role: string | null;
      changed_at: Date | string;
    }>(sql`
      SELECT * FROM (
        SELECT 'PRODUCT' AS entity, p.id, p.version AS entity_version,
               CASE WHEN p.deleted_at IS NULL THEN 'UPSERT' ELSE 'TOMBSTONE' END AS kind,
               NULL::text AS role, p.updated_at AS changed_at
          FROM products p
         WHERE p.tenant_id = ${ctx.tenantId} AND p.updated_at > ${since}
        UNION ALL
        SELECT 'PARTY' AS entity, pa.id, pa.version AS entity_version,
               CASE WHEN pa.deleted_at IS NULL THEN 'UPSERT' ELSE 'TOMBSTONE' END AS kind,
               NULL::text AS role, pa.updated_at AS changed_at
          FROM parties pa
         WHERE pa.tenant_id = ${ctx.tenantId} AND pa.updated_at > ${since}
      ) changes
      ORDER BY changed_at ASC, id ASC
      LIMIT ${limit}
    `);

    return rows.rows.map((row) => ({
      entity: row.entity === 'PRODUCT' ? ('PRODUCT' as const) : ('PARTY' as const),
      id: String(row.id),
      kind: row.kind === 'TOMBSTONE' ? ('TOMBSTONE' as const) : ('UPSERT' as const),
      entityVersion: Number(row.entity_version),
      role: row.role,
      changedAt: asDate(row.changed_at),
    }));
  }
}

const ORIGIN_TABLES: ReadonlySet<string> = new Set(Object.values(OP_DOCUMENT_TABLE));

const OPERATION_SELECT = sql`
  SELECT o.*, d.name AS device_name, d.device_code
    FROM sync_operations o
    JOIN device_authorizations d ON d.id = o.device_id AND d.tenant_id = o.tenant_id
`;

const CONFLICT_SELECT = sql`
  SELECT c.*, o.id AS op_id, o.device_id, o.operation_id, o.local_seq, o.op_type, o.payload,
         o.context, o.depends_on, o.client_result_digest, o.device_created_at,
         o.business_date, o.status AS op_status, o.result_document_id,
         o.result_document_number, o.server_result_digest, o.divergence, o.server_seq,
         o.attempts, o.last_error_code, o.last_error_message, o.received_at, o.applied_at,
         d.name AS device_name, d.device_code,
         COALESCE(actor.display_name, 'Someone') AS recorded_by_name,
         resolver.display_name AS resolved_by_name
    FROM sync_conflicts c
    JOIN sync_operations o ON o.id = c.sync_operation_id AND o.tenant_id = c.tenant_id
    JOIN device_authorizations d ON d.id = o.device_id AND d.tenant_id = o.tenant_id
    LEFT JOIN users actor
      ON actor.id = (o.context ->> 'userId') AND actor.tenant_id = o.tenant_id
    LEFT JOIN users resolver
      ON resolver.id = c.resolved_by AND resolver.tenant_id = c.tenant_id
`;

interface OperationRecord extends Record<string, unknown> {
  id: string;
  device_id: string;
  device_name: string;
  device_code: string | null;
  operation_id: string;
  local_seq: string | number;
  op_type: string;
  payload: unknown;
  context: { userId: string; businessDate: string; deviceCreatedAt: string };
  depends_on: unknown;
  client_result_digest: unknown;
  device_created_at: Date | string;
  business_date: Date | string;
  status: string;
  result_document_id: string | null;
  result_document_number: string | null;
  server_result_digest: unknown;
  divergence: unknown;
  server_seq: string | number | null;
  attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  received_at: Date | string;
  applied_at: Date | string | null;
}

interface ConflictRecord extends OperationRecord {
  op_id: string;
  op_status: string;
  reason_code: string;
  reason_message: string;
  server_state: unknown;
  local_state: unknown;
  suggested_actions: unknown;
  resolution: string | null;
  resolution_reason: string | null;
  resolved_at: Date | string | null;
  resolved_by_name: string | null;
  recorded_by_name: string;
  created_at: Date | string;
}

function toOperation(row: OperationRecord, status?: string): SyncOperationRow {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    deviceName: String(row.device_name),
    deviceCode: row.device_code,
    operationId: String(row.operation_id),
    localSeq: Number(row.local_seq),
    opType: row.op_type as SyncOpType,
    payload: row.payload,
    context: row.context,
    dependsOn: Array.isArray(row.depends_on) ? row.depends_on.map(Number) : [],
    clientResultDigest: asDigest(row.client_result_digest),
    deviceCreatedAt: asDate(row.device_created_at),
    businessDate: asBusinessDate(row.business_date),
    status: (status ?? row.status) as SyncOperationStatus,
    resultDocumentId: row.result_document_id,
    resultDocumentNumber: row.result_document_number,
    serverResultDigest: asDigest(row.server_result_digest),
    divergence: asDigest(row.divergence),
    serverSeq: row.server_seq === null ? null : Number(row.server_seq),
    attempts: Number(row.attempts),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    receivedAt: asDate(row.received_at),
    appliedAt: row.applied_at === null ? null : asDate(row.applied_at),
  };
}

function toConflict(row: ConflictRecord): SyncConflictRow {
  return {
    id: String(row.id),
    syncOperationId: String(row.op_id),
    reasonCode: row.reason_code as SyncReasonCode,
    reasonMessage: String(row.reason_message),
    serverState: row.server_state,
    localState: row.local_state,
    suggestedActions: Array.isArray(row.suggested_actions)
      ? (row.suggested_actions as SyncResolution[])
      : [],
    status: row.status as 'OPEN' | 'RESOLVED' | 'DISCARDED',
    resolution: row.resolution as SyncResolution | null,
    resolutionReason: row.resolution_reason,
    resolvedAt: row.resolved_at === null ? null : asDate(row.resolved_at),
    resolvedByName: row.resolved_by_name,
    createdAt: asDate(row.created_at),
    operation: toOperation({ ...row, id: row.op_id }, row.op_status),
    recordedByName: String(row.recorded_by_name),
  };
}

function asDigest(value: unknown): Record<string, number> | null {
  if (value === null || typeof value !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number') out[key] = item;
  }
  return out;
}

/**
 * A timestamp that may arrive as a string.
 *
 * Raw statements return `timestamptz` as text through this driver, and a `Date`
 * through the query builder. Phase 9.1 and 9.2 both lost time to the same
 * mistake — `row.closedAt.toISOString is not a function` — so every date read
 * by a raw statement goes through here.
 */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : ((parseInstant(value) ?? EPOCH) as Date);
}

/** A timestamp that somehow did not parse. Never expected; never a crash. */
const EPOCH = parseInstant('1970-01-01T00:00:00.000Z') as Date;

/** A `date` column, as the `YYYY-MM-DD` the rest of the application speaks. */
function asBusinessDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
