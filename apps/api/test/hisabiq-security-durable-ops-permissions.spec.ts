/**
 * P0 security #225 — runtime PostgreSQL role must never be able to destroy
 * permanent operation identities through TRUNCATE (which bypasses RLS).
 * Real PG16, no mocks, isolated test schema only.
 */
import type pg from 'pg';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

const clock = new SystemClock();
let pool: pg.Pool;

type GrantRow = {
  actor: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
};

async function privileges(table: string): Promise<GrantRow> {
  // The caller passes known, constant internal table identifiers only.
  const result = await pool.query<GrantRow>(
    `SELECT current_user AS actor,
            has_table_privilege(current_user, $1, 'SELECT') AS can_select,
            has_table_privilege(current_user, $1, 'INSERT') AS can_insert,
            has_table_privilege(current_user, $1, 'UPDATE') AS can_update,
            has_table_privilege(current_user, $1, 'DELETE') AS can_delete,
            has_table_privilege(current_user, $1, 'TRUNCATE') AS can_truncate`,
    [table],
  );
  return result.rows[0];
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
}, 180_000);
beforeEach(async () => { await resetDatabase(pool); });
afterAll(async () => { await pool?.end(); });

describe('issue #225: disposable PG16 app-role privilege boundaries', () => {
  it('keeps import operation source append-only for DELETE and TRUNCATE', async () => {
    const found = await privileges('public.import_operations');
    expect(found.actor).toBe('sher_app');
    expect(found).toMatchObject({
      can_select: true, can_insert: true, can_update: true,
      can_delete: false, can_truncate: false,
    });
  });

  it('rejects direct runtime TRUNCATE even when no tenant context is supplied', async () => {
    await expect(pool.query('TRUNCATE public.import_operations'))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('reserves destructive cleanup for test-admin and never gives runtime a reset privilege', async () => {
    const tenant = await seedTenant(pool, { name: 'Reset must use admin', permissions: [] });
    const beforeReset = await asTenant(pool, tenant.tenantId, client =>
      client.query('SELECT id FROM tenants WHERE id=$1', [tenant.tenantId]));
    expect(beforeReset.rows).toHaveLength(1);
    await resetDatabase(pool);
    const count = await pool.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM tenants');
    expect(count.rows[0].total).toBe('0');
    const found = await privileges('public.import_operations');
    expect(found.can_truncate).toBe(false);
  });

  it('allows valid runtime insert and completion UPDATE while denying DELETE and isolating tenants', async () => {
    const owner = await seedTenant(pool, { name: 'Owner A', permissions: [] });
    const outsider = await seedTenant(pool, { name: 'Owner B', permissions: [] });
    const id = Ulid.generate(clock);
    const operationId = Ulid.generate(clock);
    const now = clock.now();
    await asTenant(pool, owner.tenantId, client => client.query(
      `INSERT INTO import_operations
       (id,tenant_id,operation_id,import_type,request_fingerprint,response_json,
        created_at,created_by,completed_at)
       VALUES ($1,$2,$3,'PRODUCTS',$4,NULL,$5,$6,NULL)`,
      [id, owner.tenantId, operationId, 'import:sha256:v1:' + '0'.repeat(64), now, owner.userId],
    ));
    const otherView = await asTenant(pool, outsider.tenantId, client =>
      client.query('SELECT id FROM import_operations WHERE id=$1', [id]));
    expect(otherView.rows).toEqual([]);
    const updated = await asTenant(pool, owner.tenantId, client =>
      client.query(
        'UPDATE import_operations SET response_json=$1, completed_at=$2 WHERE id=$3 RETURNING id',
        [JSON.stringify({ type: 'PRODUCTS', rows: 0, imported: 0 }), now, id],
      ));
    expect(updated.rows).toHaveLength(1);
    await expect(asTenant(pool, owner.tenantId, client =>
      client.query('DELETE FROM import_operations WHERE id=$1', [id])))
      .rejects.toMatchObject({ code: '42501' });
    const stillThere = await asTenant(pool, owner.tenantId, client =>
      client.query('SELECT operation_id FROM import_operations WHERE id=$1', [id]));
    expect(stillThere.rows).toHaveLength(1);
  });

  it('repeated provisioning does not restore old destructive test-role grants', async () => {
    await prepareTestDatabase();
    const found = await privileges('public.import_operations');
    expect(found.can_truncate).toBe(false);
    expect(found.can_delete).toBe(false);
  });

  it('enforces immutable draft-create tombstone grants when migration 0058 is adopted', async () => {
    const exists = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.sale_draft_create_operations') IS NOT NULL AS present",
    );
    // #221 is a separate, unmerged PR on this base. Its exact-head integration
    // must rerun this assertion after migration 0058 has actually landed.
    if (!exists.rows[0].present) return;
    const found = await privileges('public.sale_draft_create_operations');
    expect(found).toMatchObject({
      can_select: true, can_insert: true,
      can_update: false, can_delete: false, can_truncate: false,
    });
  });
});
