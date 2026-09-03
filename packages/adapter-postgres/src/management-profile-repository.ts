import type { InstallationProfile, ManagementProfileRepository, Tx } from '@sher/core-application';
import { sql } from 'drizzle-orm';

import { txOf } from './unit-of-work';

/**
 * What the sidecar may read about this installation (§6, §22).
 *
 * **Read-only, six columns, and no business table among them.** The queries
 * below touch `tenants`, `schema_migrations` and the two Phase 12 sync tables —
 * deployment facts, every one of them. There is no path from here to a sale, a
 * ledger line or a party, which is what makes the privacy boundary a property
 * of the code rather than a promise about how it is used.
 *
 * It runs `runWithoutTenant`-style raw SQL rather than the tenant-scoped
 * helpers because it answers a question *about* the tenant — which tenant is
 * this machine serving — and cannot know the answer before it asks.
 */
export class PostgresManagementProfileRepository implements ManagementProfileRepository {
  async profile(tx: Tx): Promise<InstallationProfile | null> {
    const db = txOf(tx);

    const tenantRows = await db.execute<{ id: string; name: string; timezone: string }>(
      sql`SELECT id, name, timezone FROM tenants WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    );
    const tenant = tenantRows.rows[0];
    if (tenant === undefined) return null;

    /*
     * The newest applied migration is the schema version. Taken from
     * `schema_migrations` rather than a constant in the build, because the
     * question the control plane is really asking is "what shape is the
     * database in", and only the database can answer that.
     */
    const schemaRows = await db.execute<{ name: string }>(
      sql`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`,
    );

    /*
     * "Pending" here means operations the shop still has to deal with:
     * in flight, blocked behind a dependency, or quarantined by the replay
     * guard. Applied and duplicate operations are settled and uninteresting;
     * counting them would make a healthy busy shop look like a backlog.
     */
    const pendingRows = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*) AS count FROM sync_operations
           WHERE tenant_id = ${tenant.id} AND status IN ('IN_FLIGHT', 'BLOCKED', 'QUARANTINED')`,
    );
    const conflictRows = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*) AS count FROM sync_conflicts
           WHERE tenant_id = ${tenant.id} AND status = 'OPEN'`,
    );

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      timezone: tenant.timezone,
      schemaVersion: schemaRows.rows[0]?.name ?? '',
      syncPending: Number(pendingRows.rows[0]?.count ?? '0'),
      syncConflictsOpen: Number(conflictRows.rows[0]?.count ?? '0'),
    };
  }
}
