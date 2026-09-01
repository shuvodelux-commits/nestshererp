import type {
  DeviceRepository,
  DeviceRow,
  DeviceStatusChange,
  NewDevice,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { DeviceStatus, SnapshotCounts } from '@sher/core-domain';
import { parseInstant } from '@sher/shared-utils';
import { sql } from 'drizzle-orm';

import { txOf } from './unit-of-work';

/**
 * Registered browser profiles and the shop's single offline writer (§5.23,
 * D-01).
 *
 * The one-writer rule is not enforced here — it is enforced by the partial
 * unique index in migration 0041, which is the only place two managers pressing
 * Approve on two machines in the same second can be stopped. This file's job is
 * to read and write the rows honestly and let that index be the referee.
 */
interface DeviceRecord extends Record<string, unknown> {
  id: string;
  name: string;
  public_key: string;
  platform: string;
  status: string;
  registered_by_name: string | null;
  created_at: Date | string | null;
  requested_at: Date | string | null;
  approved_at: Date | string | null;
  approved_by_name: string | null;
  revoked_at: Date | string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
  last_seen_at: Date | string | null;
  gate_installed: boolean | null;
  gate_persisted: boolean | null;
  gate_available_bytes: string | number | null;
  gate_reported_at: Date | string | null;
  snapshot_bytes: string | number | null;
  snapshot_usage_bytes: string | number | null;
  snapshot_quota_bytes: string | number | null;
  snapshot_elapsed_ms: number | null;
  snapshot_reported_at: Date | string | null;
}

/**
 * A `bigint` column, which the driver hands back as a string to keep precision.
 *
 * Every one of these is a byte count well inside a JavaScript integer, so the
 * conversion is safe — but it has to be explicit, because `Number(null)` is 0
 * and a machine that never reported would otherwise read as one that reported
 * an empty database.
 */
function bigish(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** Instants come back as `Date` or as a string depending on the statement. */
function instant(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  return parseInstant(value);
}

/**
 * The stand-in for a `NOT NULL` timestamp that somehow did not parse.
 *
 * Built through `parseInstant` rather than `new Date(0)` because the clock is a
 * port: `new Date()` anywhere outside `shared-utils` is a boundary violation,
 * and the rule is worth more than the two characters it costs here.
 */
const EPOCH = parseInstant('1970-01-01T00:00:00.000Z') as Date;

function toRow(record: DeviceRecord): DeviceRow {
  return {
    id: record.id,
    name: record.name,
    publicKey: record.public_key,
    platform: record.platform,
    status: record.status as DeviceStatus,
    registeredByName: record.registered_by_name ?? '—',
    registeredAt: instant(record.created_at) ?? EPOCH,
    requestedAt: instant(record.requested_at),
    approvedAt: instant(record.approved_at),
    approvedByName: record.approved_by_name,
    revokedAt: instant(record.revoked_at),
    revokedByName: record.revoked_by_name,
    revokeReason: record.revoke_reason,
    lastSeenAt: instant(record.last_seen_at),
    gateInstalled: record.gate_installed,
    gatePersisted: record.gate_persisted,
    gateAvailableBytes:
      record.gate_available_bytes === null ? null : Number(record.gate_available_bytes),
    gateReportedAt: instant(record.gate_reported_at),
    snapshotBytes: bigish(record.snapshot_bytes),
    snapshotUsageBytes: bigish(record.snapshot_usage_bytes),
    snapshotQuotaBytes: bigish(record.snapshot_quota_bytes),
    snapshotElapsedMs: record.snapshot_elapsed_ms,
    snapshotReportedAt: instant(record.snapshot_reported_at),
  };
}

/** The select every read shares, so a new column cannot appear in only one. */
const SELECT = sql`
  SELECT d.id, d.name, d.public_key, d.platform, d.status,
         d.created_at, d.requested_at, d.approved_at, d.revoked_at,
         d.revoke_reason, d.last_seen_at,
         d.gate_installed, d.gate_persisted, d.gate_available_bytes, d.gate_reported_at,
         d.snapshot_bytes, d.snapshot_usage_bytes, d.snapshot_quota_bytes,
         d.snapshot_elapsed_ms, d.snapshot_reported_at,
         reg.display_name AS registered_by_name,
         app.display_name AS approved_by_name,
         rev.display_name AS revoked_by_name
    FROM device_authorizations d
    LEFT JOIN users reg ON reg.id = d.created_by
    LEFT JOIN users app ON app.id = d.approved_by
    LEFT JOIN users rev ON rev.id = d.revoked_by
`;

export class PostgresDeviceRepository implements DeviceRepository {
  async insert(tx: Tx, ctx: TenantContext, device: NewDevice): Promise<void> {
    await txOf(tx).execute(sql`
      INSERT INTO device_authorizations
        (id, tenant_id, public_key, name, platform, capability, status,
         created_at, updated_at, created_by, updated_by, version)
      VALUES (${device.id}, ${ctx.tenantId}, ${device.publicKey}, ${device.name},
              ${device.platform}, 'OFFLINE_RW', 'REGISTERED',
              now(), now(), ${ctx.userId}, ${ctx.userId}, 1)
    `);
  }

  async findByPublicKey(
    tx: Tx,
    ctx: TenantContext,
    publicKey: string,
  ): Promise<DeviceRow | null> {
    const result = await txOf(tx).execute<DeviceRecord>(sql`
      ${SELECT}
       WHERE d.tenant_id = ${ctx.tenantId} AND d.public_key = ${publicKey}
       LIMIT 1
    `);
    const record = result.rows[0];
    return record === undefined ? null : toRow(record);
  }

  async findById(tx: Tx, ctx: TenantContext, deviceId: string): Promise<DeviceRow | null> {
    const result = await txOf(tx).execute<DeviceRecord>(sql`
      ${SELECT}
       WHERE d.tenant_id = ${ctx.tenantId} AND d.id = ${deviceId}
       LIMIT 1
    `);
    const record = result.rows[0];
    return record === undefined ? null : toRow(record);
  }

  async list(tx: Tx, ctx: TenantContext): Promise<readonly DeviceRow[]> {
    const result = await txOf(tx).execute<DeviceRecord>(sql`
      ${SELECT}
       WHERE d.tenant_id = ${ctx.tenantId}
       ORDER BY d.created_at DESC
    `);
    return result.rows.map(toRow);
  }

  async findWriter(tx: Tx, ctx: TenantContext): Promise<DeviceRow | null> {
    const result = await txOf(tx).execute<DeviceRecord>(sql`
      ${SELECT}
       WHERE d.tenant_id = ${ctx.tenantId}
         AND d.capability = 'OFFLINE_RW'
         AND d.status IN ('ACTIVE', 'DRAINING')
       LIMIT 1
    `);
    const record = result.rows[0];
    return record === undefined ? null : toRow(record);
  }

  async rename(tx: Tx, ctx: TenantContext, deviceId: string, name: string): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE device_authorizations
         SET name = ${name}, updated_at = now(), updated_by = ${ctx.userId},
             version = version + 1
       WHERE tenant_id = ${ctx.tenantId} AND id = ${deviceId}
    `);
  }

  /**
   * One state change.
   *
   * The timestamps are written from the change, not from `now()`: the service
   * holds the clock (R-C8), and a row whose `approved_at` disagreed with its own
   * audit event would be the first thing to argue with in a dispute.
   */
  async changeStatus(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    change: DeviceStatusChange,
  ): Promise<void> {
    const at = change.at.toISOString();
    await txOf(tx).execute(sql`
      UPDATE device_authorizations
         SET status = ${change.status},
             requested_at = CASE WHEN ${change.status} = 'PENDING' THEN ${at}::timestamptz
                                 ELSE requested_at END,
             approved_at = CASE WHEN ${change.approved ?? false} THEN ${at}::timestamptz
                                ELSE approved_at END,
             approved_by = CASE WHEN ${change.approved ?? false} THEN ${ctx.userId}
                                ELSE approved_by END,
             revoked_at = CASE WHEN ${change.revoked ?? false} THEN ${at}::timestamptz
                               ELSE revoked_at END,
             revoked_by = CASE WHEN ${change.revoked ?? false} THEN ${ctx.userId}
                               ELSE revoked_by END,
             revoke_reason = CASE WHEN ${change.reason ?? null}::text IS NOT NULL
                                  THEN ${change.reason ?? null}::text
                                  ELSE revoke_reason END,
             updated_at = now(), updated_by = ${ctx.userId}, version = version + 1
       WHERE tenant_id = ${ctx.tenantId} AND id = ${deviceId}
    `);
  }

  async recordSeen(tx: Tx, ctx: TenantContext, deviceId: string, at: Date): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE device_authorizations
         SET last_seen_at = ${at.toISOString()}::timestamptz
       WHERE tenant_id = ${ctx.tenantId} AND id = ${deviceId}
    `);
  }

  async recordGate(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    report: {
      readonly installed: boolean;
      readonly persisted: boolean;
      readonly availableBytes: number | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE device_authorizations
         SET gate_installed = ${report.installed},
             gate_persisted = ${report.persisted},
             gate_available_bytes = ${report.availableBytes},
             gate_reported_at = ${report.at.toISOString()}::timestamptz,
             last_seen_at = ${report.at.toISOString()}::timestamptz
       WHERE tenant_id = ${ctx.tenantId} AND id = ${deviceId}
    `);
  }

  /**
   * What the device measured after storing a snapshot (Phase 12.3, O-6).
   *
   * Beside `recordGate` and for the same reason: it is a report, and like the
   * gate report it never touches `status`. Nothing a machine says about itself
   * can grant it authority or take authority away.
   */
  async recordSnapshot(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    report: {
      readonly storedBytes: number;
      readonly usageBytes: number | null;
      readonly quotaBytes: number | null;
      readonly elapsedMs: number;
      readonly at: Date;
    },
  ): Promise<void> {
    await txOf(tx).execute(sql`
      UPDATE device_authorizations
         SET snapshot_bytes = ${report.storedBytes},
             snapshot_usage_bytes = ${report.usageBytes},
             snapshot_quota_bytes = ${report.quotaBytes},
             snapshot_elapsed_ms = ${report.elapsedMs},
             snapshot_reported_at = ${report.at.toISOString()}::timestamptz,
             last_seen_at = ${report.at.toISOString()}::timestamptz
       WHERE tenant_id = ${ctx.tenantId} AND id = ${deviceId}
    `);
  }

  /**
   * What an offline snapshot would have to carry for this shop.
   *
   * Counted, never estimated from a guess about shop size: the gate's space
   * check is only worth running if the number it checks against is this
   * tenant's own (owner decision 2026-08-31). Documents and their lines are
   * bounded by the snapshot window, because §5.23's bootstrap carries the last
   * N months plus an opening position — not the whole history.
   */
  async snapshotCounts(tx: Tx, ctx: TenantContext, months: number): Promise<SnapshotCounts> {
    const since = sql`(now() - (${months} || ' months')::interval)`;
    const result = await txOf(tx).execute<Record<string, string | number>>(sql`
      SELECT
        (SELECT COUNT(*) FROM products WHERE tenant_id = ${ctx.tenantId}) AS products,
        (SELECT COUNT(*) FROM parties WHERE tenant_id = ${ctx.tenantId}) AS parties,
        (SELECT COUNT(*) FROM sales WHERE tenant_id = ${ctx.tenantId} AND created_at >= ${since})
        + (SELECT COUNT(*) FROM purchases WHERE tenant_id = ${ctx.tenantId} AND created_at >= ${since})
          AS documents,
        (SELECT COUNT(*) FROM sale_lines WHERE tenant_id = ${ctx.tenantId})
        + (SELECT COUNT(*) FROM purchase_lines WHERE tenant_id = ${ctx.tenantId})
          AS document_lines,
        (SELECT COUNT(*) FROM journal_lines WHERE tenant_id = ${ctx.tenantId}) AS journal_lines,
        (SELECT COUNT(*) FROM inventory_lots WHERE tenant_id = ${ctx.tenantId}) AS lots
    `);
    const row = result.rows[0] ?? {};
    const count = (key: string): number => Number(row[key] ?? 0);
    return {
      products: count('products'),
      parties: count('parties'),
      documents: count('documents'),
      documentLines: count('document_lines'),
      journalLines: count('journal_lines'),
      lots: count('lots'),
    };
  }
}
