/**
 * MOD-002 P8b2a: real populated pre-upgrade → 0059 path via runMigrations.
 * Creates and drops only its own uniquely named disposable PostgreSQL database.
 * It NEVER migrates, truncates, or deletes the configured test/retained DB.
 */
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPool, runMigrations } from '@sher/adapter-postgres';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import { expect, it } from 'vitest';

const clock = new SystemClock();
const root = resolve(__dirname, '../../../migrations');
const a = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const b = '01ARZ3NDEKTSV4RRFFQ69G5FB0';

function urls(): { admin: URL; runtime: URL } {
  const adminRaw = process.env['ADMIN_DATABASE_URL'];
  const runtimeRaw = process.env['DATABASE_URL'];
  if (!adminRaw || !runtimeRaw) throw new Error('Explicit isolated PG16 URLs required');
  const admin = new URL(adminRaw);
  const runtime = new URL(runtimeRaw);
  for (const url of [admin, runtime]) {
    if (!['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/sher_test') {
      throw new Error('P8b2a migration-upgrade QA requires local disposable sher_test');
    }
  }
  if (admin.username !== 'postgres' || runtime.username !== 'sher_app' ||
      admin.port !== runtime.port) {
    throw new Error('P8b2a test roles and PostgreSQL server must match');
  }
  return { admin, runtime };
}

async function snapshot(db: pg.Pool): Promise<unknown[]> {
  const r = await db.query(
    "SELECT * FROM (" +
    "SELECT 'unit' AS kind,id,tenant_id,name,name_bn,symbol,version,created_at,updated_at,deleted_at FROM units " +
    "UNION ALL SELECT 'brand',id,tenant_id,name,name_bn,NULL::text,version,created_at,updated_at,deleted_at FROM brands " +
    "UNION ALL SELECT 'category',id,tenant_id,name,name_bn,NULL::text,version,created_at,updated_at,deleted_at FROM categories" +
    ') x ORDER BY id',
  );
  return r.rows;
}

async function seed(db: pg.Pool): Promise<void> {
  const now = clock.now();
  const ts = now;
  for (const [id, name] of [[a, 'Upgrade A'], [b, 'Upgrade B']]) {
    await db.query(
      'INSERT INTO tenants (id,name,timezone,created_at,updated_at,created_by,updated_by,version) ' +
      'VALUES ($1,$2,$3,$4,$4,$1,$1,1)',
      [id, name, 'Asia/Dhaka', ts],
    );
  }
  const rows = [
    ['units', 'FB1', a, 'Feet', 'ফুট', 'ft', 4, null],
    ['units', 'FB2', a, 'Old Feet', 'পুরানো', 'ft', 9, ts],
    ['units', 'FB7', b, 'Feet', 'ফুট', 'ft', 2, null],
    ['brands', 'FB3', a, 'ACME', 'এসি মি', null, 2, null],
    ['brands', 'FB4', a, 'Old ACME', 'পুরাতন', null, 5, ts],
    ['categories', 'FB5', a, 'Hardware', 'হার্ডওয়্যার', null, 8, null],
    ['categories', 'FB6', a, 'Old Hardware', 'পুরাতন', null, 3, ts],
  ] as const;
  for (const [kind, suffix, tenantId, name, nameBn, symbol, version, archived] of rows) {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5' + suffix;
    const category = kind === 'categories';
    const unit = kind === 'units';
    const fields = 'id,tenant_id,name,name_bn,' +
      (unit ? 'symbol,' : '') +
      (category ? 'parent_id,' : '') +
      'created_at,updated_at,created_by,updated_by,version,deleted_at';
    const values: unknown[] = [id, tenantId, name, nameBn];
    if (unit) values.push(symbol);
    if (category) values.push(null);
    values.push(ts, ts, tenantId, tenantId, version, archived);
    await db.query(
      'INSERT INTO ' + kind + ' (' + fields + ') VALUES (' +
        values.map((_, i) => '$' + (i + 1)).join(',') + ')',
      values,
    );
  }
}

it('P8b2a upgrades populated pre-0059 catalogs with no historical mutation or RLS loss', async () => {
  const { admin, runtime } = urls();
  const name = 'mod002_p8b2a_upgrade_' + Ulid.generate(clock).toLowerCase();
  const adminForNew = new URL(admin);
  adminForNew.pathname = '/' + name;
  const runtimeForNew = new URL(runtime);
  runtimeForNew.pathname = '/' + name;
  const server = createPool(admin.toString());
  let upgraded: pg.Pool | undefined;
  let app: pg.Pool | undefined;
  let createdDatabase = false;
  const folder = mkdtempSync(join(tmpdir(), 'mod002-p8b2a-old-'));
  const upgradeFolder = mkdtempSync(join(tmpdir(), 'mod002-p8b2a-new-'));
  try {
    await server.query('CREATE DATABASE "' + name + '"');
    createdDatabase = true;
    upgraded = createPool(adminForNew.toString());
    const files = readdirSync(root)
      .filter(file => file.endsWith('.sql') && file < '0059_')
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(57);
    for (const file of files) symlinkSync(join(root, file), join(folder, file));
    const applied = await runMigrations(upgraded, folder);
    expect(applied).toHaveLength(files.length);
    const missing = await upgraded.query<{ count: string }>(
      "SELECT count(*) FROM information_schema.columns WHERE table_name IN " +
      "('units','brands','categories') AND column_name='is_active'",
    );
    expect(Number(missing.rows[0]!.count)).toBe(0);
    await seed(upgraded);
    const before = await snapshot(upgraded);
    expect(before).toHaveLength(7);

    symlinkSync(join(root, '0059_catalog_lifecycle_active.sql'),
      join(upgradeFolder, '0059_catalog_lifecycle_active.sql'));
    const newlyApplied = await runMigrations(upgraded, upgradeFolder);
    expect(newlyApplied).toContain('0059_catalog_lifecycle_active.sql');
    const after = await snapshot(upgraded);
    expect(after).toEqual(before);

    const active = await upgraded.query<{ total: string; enabled: string; archived: string }>(
      'SELECT count(*) total, count(*) FILTER (WHERE is_active) enabled, ' +
      'count(*) FILTER (WHERE deleted_at IS NOT NULL AND is_active) archived ' +
      'FROM (SELECT is_active,deleted_at FROM units UNION ALL ' +
      'SELECT is_active,deleted_at FROM brands UNION ALL ' +
      'SELECT is_active,deleted_at FROM categories) x',
    );
    expect(active.rows[0]).toEqual({ total: '7', enabled: '7', archived: '3' });
    const columns = await upgraded.query<{ count: string }>(
      "SELECT count(*) FROM information_schema.columns " +
      "WHERE table_name IN ('units','brands','categories') " +
      "AND column_name='is_active' AND is_nullable='NO' AND column_default='true'",
    );
    expect(Number(columns.rows[0]!.count)).toBe(3);
    const rls = await upgraded.query<{ count: string }>(
      "SELECT count(*) FROM pg_class WHERE relname IN " +
      "('units','brands','categories') AND relrowsecurity AND relforcerowsecurity",
    );
    expect(Number(rls.rows[0]!.count)).toBe(3);
    const indexes = await upgraded.query<{ count: string }>(
      "SELECT count(*) FROM pg_indexes WHERE indexname IN " +
      "('units_tenant_name_unique','brands_tenant_name_unique','categories_tenant_sibling_name_unique')",
    );
    expect(Number(indexes.rows[0]!.count)).toBe(3);
    expect(await runMigrations(upgraded, upgradeFolder)).toEqual([]);

    await server.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles " +
      "WHERE rolname = 'sher_app') THEN CREATE ROLE sher_app LOGIN " +
      "PASSWORD 'sher_app_test'; END IF; END $$");
    await upgraded.query('GRANT USAGE ON SCHEMA public TO sher_app');
    await upgraded.query('GRANT SELECT ON units,brands,categories TO sher_app');
    app = createPool(runtimeForNew.toString());
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [b]);
      const denied = await client.query('SELECT id FROM units WHERE tenant_id=$1', [a]);
      const own = await client.query('SELECT id,is_active FROM units WHERE tenant_id=$1', [b]);
      expect(denied.rowCount).toBe(0);
      expect(own.rows).toMatchObject([{ is_active: true }]);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    if (app) await app.end();
    if (upgraded) await upgraded.end();
    if (createdDatabase) await server.query('DROP DATABASE "' + name + '"');
    await server.end();
    rmSync(folder, { recursive: true, force: true });
    rmSync(upgradeFolder, { recursive: true, force: true });
  }
}, 60_000);
