import type {
  OfflineUserRow,
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
  device_code: string | null;
  sync_cursor: Date | string | null;
  last_push_at: Date | string | null;
  last_pull_at: Date | string | null;
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
    deviceCode: record.device_code,
    syncCursor: instant(record.sync_cursor),
    lastPushAt: instant(record.last_push_at),
    lastPullAt: instant(record.last_pull_at),
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
         d.device_code, d.sync_cursor, d.last_push_at, d.last_pull_at,
         reg.display_name AS registered_by_name,
         app.display_name AS approved_by_name,
         rev.display_name AS revoked_by_name
    FROM device_authorizations d
    LEFT JOIN users reg ON reg.id = d.created_by
    LEFT JOIN users app ON app.id = d.approved_by
    LEFT JOIN users rev ON rev.id = d.revoked_by
`;

/**
 * A, B, … Z, AA, AB — the shop's device codes in the order they were handed out.
 *
 * A number rather than a letter would have been simpler and would have read
 * badly on an invoice beside the year and the sequence, which are both numbers
 * already. Three letters is 18,278 machines; a shop that reaches that has other
 * problems.
 */
function codeFor(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export class PostgresDeviceRepository implements DeviceRepository {
  /**
   * The next free code, chosen by walking upwards from the count of codes
   * already issued and skipping anything taken.
   *
   * Counting rather than reading the maximum, because a code is never released
   * when a device is revoked — the number issued only ever grows, and the walk
   * is what keeps the answer right if a row was ever inserted out of order.
   */
  async nextDeviceCode(tx: Tx, ctx: TenantContext): Promise<string> {
    const rows = await txOf(tx).execute<{ device_code: string }>(sql`
      SELECT device_code FROM device_authorizations
       WHERE tenant_id = ${ctx.tenantId} AND device_code IS NOT NULL
    `);
    const taken = new Set(rows.rows.map((row) => String(row.device_code)));
    for (let index = 0; index < 18_278; index += 1) {
      const code = codeFor(index);
      if (!taken.has(code)) return code;
    }
    throw new Error('this shop has registered more computers than there are codes');
  }

  async insert(tx: Tx, ctx: TenantContext, device: NewDevice): Promise<void> {
    await txOf(tx).execute(sql`
      INSERT INTO device_authorizations
        (id, tenant_id, public_key, name, platform, capability, status, device_code,
         created_at, updated_at, created_by, updated_by, version)
      VALUES (${device.id}, ${ctx.tenantId}, ${device.publicKey}, ${device.name},
              ${device.platform}, 'OFFLINE_RW', 'REGISTERED', ${device.deviceCode},
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

  async listDeviceUsers(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
  ): Promise<readonly { readonly userId: string; readonly displayName: string }[]> {
    const rows = await txOf(tx).execute<{ user_id: string; display_name: string }>(sql`
      SELECT a.user_id, u.display_name
        FROM device_user_access a
        JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
       WHERE a.tenant_id = ${ctx.tenantId} AND a.device_id = ${deviceId}
         AND u.deleted_at IS NULL
       ORDER BY u.display_name
    `);
    return rows.rows.map((row) => ({
      userId: String(row.user_id),
      displayName: String(row.display_name),
    }));
  }

  /**
   * Replaces the list whole.
   *
   * A set of people is edited as a set — ticking two boxes and clearing a third
   * is one decision, and applying it as three separate ones would leave a
   * moment where a machine trusted nobody.
   */
  async setDeviceUsers(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    userIds: readonly string[],
    ids: readonly string[],
    at: Date,
  ): Promise<void> {
    const db = txOf(tx);
    await db.execute(sql`
      DELETE FROM device_user_access
       WHERE tenant_id = ${ctx.tenantId} AND device_id = ${deviceId}
    `);
    for (const [index, userId] of userIds.entries()) {
      await db.execute(sql`
        INSERT INTO device_user_access
          (id, tenant_id, device_id, user_id, created_at, updated_at, created_by, updated_by)
        VALUES (${ids[index]}, ${ctx.tenantId}, ${deviceId}, ${userId},
                ${at}, ${at}, ${ctx.userId}, ${ctx.userId})
        ON CONFLICT ON CONSTRAINT device_user_access_unique DO NOTHING
      `);
    }
  }

  async offlineUsers(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
  ): Promise<readonly OfflineUserRow[]> {
    const rows = await txOf(tx).execute<{
      id: string;
      display_name: string;
      username: string | null;
      pin_hash: string | null;
      role_id: string;
      permissions: string[] | null;
    }>(sql`
      SELECT u.id, u.display_name, u.username, u.pin_hash, u.role_id,
             array_remove(array_agg(rp.permission_code), NULL) AS permissions
        FROM device_user_access a
        JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
        LEFT JOIN role_permissions rp
          ON rp.role_id = u.role_id AND rp.tenant_id = u.tenant_id AND rp.deleted_at IS NULL
       WHERE a.tenant_id = ${ctx.tenantId} AND a.device_id = ${deviceId}
         AND u.deleted_at IS NULL
         -- No PIN, no offline sign-in. There is deliberately no password
         -- fallback: a password opens more than a till (§9).
         AND u.pin_hash IS NOT NULL
       GROUP BY u.id, u.display_name, u.username, u.pin_hash, u.role_id
       ORDER BY u.display_name
    `);

    return rows.rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      username: row.username,
      pinHash: String(row.pin_hash),
      roleId: String(row.role_id),
      permissions: (row.permissions ?? []).map(String),
    }));
  }
}
