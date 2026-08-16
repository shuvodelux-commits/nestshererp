import 'reflect-metadata';

import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn } from './support/database';
import type { SeededTenant } from './support/database';

const clock = new SystemClock();

let pool: pg.Pool;
let tenantA: SeededTenant;
let tenantB: SeededTenant;

async function insertNote(tenant: SeededTenant, title: string): Promise<string> {
  const id = Ulid.generate(clock);
  const now = clock.now();
  await asTenant(pool, tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO notes (id, tenant_id, note_number, title, amount_minor, business_date, entry_mode,
                          status, operation_id, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, $3, $4, 1000, $5, 'ON_TIME', 'POSTED', $6, $7, $7, $8, $8, 1)`,
      [id, tenant.tenantId, `NOTE-TEST-${id.slice(-6)}`, title, todayIn(tenant.timezone), Ulid.generate(clock), now, tenant.userId],
    ),
  );
  return id;
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  tenantA = await seedTenant(pool, { name: 'RLS A', permissions: [] });
  tenantB = await seedTenant(pool, { name: 'RLS B', permissions: [] });
});

/**
 * RLS is the net under the tightrope (SRS 3.2): even a raw query that forgets
 * its tenant filter must not see another tenant's rows. FORCE ROW LEVEL SECURITY
 * is what makes this true for the table owner, which is how the app connects.
 */
describe('row level security', () => {
  it('a raw unscoped query returns ZERO rows for the wrong tenant', async () => {
    await insertNote(tenantA, 'A only');

    const seenByB = await asTenant(pool, tenantB.tenantId, (client) =>
      client.query('SELECT id FROM notes'),
    );
    expect(seenByB.rowCount).toBe(0);

    const seenByA = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query('SELECT id FROM notes'),
    );
    expect(seenByA.rowCount).toBe(1);
  });

  it('hides every tenant-scoped table when app.tenant_id is not set at all', async () => {
    await insertNote(tenantA, 'A only');

    const client = await pool.connect();
    try {
      for (const table of ['notes', 'audit_events', 'outbox', 'users', 'roles', 'tenants']) {
        const rows = await client.query(`SELECT 1 FROM ${table}`);
        expect(rows.rowCount, `${table} leaked rows without app.tenant_id`).toBe(0);
      }
    } finally {
      client.release();
    }
  });

  it('refuses an INSERT that claims another tenant', async () => {
    const id = Ulid.generate(clock);
    const now = clock.now();

    await expect(
      asTenant(pool, tenantB.tenantId, (client) =>
        client.query(
          `INSERT INTO notes (id, tenant_id, note_number, title, amount_minor, business_date, entry_mode,
                              status, operation_id, created_at, updated_at, created_by, updated_by, version)
           VALUES ($1, $2, 'NOTE-X-1', 'Forged', 1, $3, 'ON_TIME', 'POSTED', $4, $5, $5, $6, $6, 1)`,
          [id, tenantA.tenantId, todayIn(tenantA.timezone), Ulid.generate(clock), now, tenantB.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot UPDATE or DELETE another tenant\'s row', async () => {
    await insertNote(tenantA, 'A only');

    const attempted = await asTenant(pool, tenantB.tenantId, async (client) => ({
      updated: (await client.query(`UPDATE notes SET title = 'hijacked'`)).rowCount,
      deleted: (await client.query('DELETE FROM notes')).rowCount,
    }));

    expect(attempted).toEqual({ updated: 0, deleted: 0 });

    const stillThere = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query('SELECT title FROM notes'),
    );
    expect(stillThere.rows).toEqual([{ title: 'A only' }]);
  });
});
