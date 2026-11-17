/**
 * P0 #259 / issue #225: signed owner recovery must remain compatible with
 * immutable operation identities and least-privilege runtime database roles.
 *
 * RED FIRST, test-only, intentionally unmergeable until a reviewed recovery
 * mechanism exists. Never run against an existing development/production DB.
 * @covers endpoint:POST /api/v1/backup/export
 * @covers endpoint:POST /api/v1/backup/restore
 * @covers permission:backup.export
 * @covers permission:backup.restore
 */
import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { ScryptPasswordHasher } from '../src/auth/password-hasher';
import { AesArchiveCodec } from '../src/infrastructure/archive-codec';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

const sentinel = 'MOD259_IMMUTABLE_RECOVERY_DISPOSABLE_20261115';
const databaseName = 'hisabiq_mod259_recovery_red_20261115';
const databasePort = '55859';
const suite = process.env['MOD259_RECOVERY_TEST_ONLY'] === sentinel ? describe : describe.skip;
const clock = new SystemClock();
const hasher = new ScryptPasswordHasher();
const ownerPassword = 'p0-259-signed-owner-password';
const backupSecret = 'mod259-disposable-backup-secret-only';

let app: INestApplication;
let pool: pg.Pool;
let workspace: string;

function assertDisposable(): void {
  if (process.env['MOD259_RECOVERY_TEST_ONLY'] !== sentinel) {
    throw new Error('P0 #259 isolated-test sentinel is mandatory');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL'] as const) {
    const raw = process.env[key];
    if (!raw) throw new Error('Missing disposable ' + key);
    const url = new URL(raw);
    if (
      url.protocol !== 'postgres:' ||
      url.hostname !== '127.0.0.1' ||
      url.port !== databasePort ||
      url.pathname !== '/' + databaseName ||
      url.username !== (key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app')
    ) {
      throw new Error('Refusing to run P0 #259 recovery tests on a non-isolated DB');
    }
  }
}

async function signedOwner(name: string): Promise<{ tenant: SeededTenant; token: string }> {
  const tenant = await seedTenant(pool, {
    name,
    permissions: [Permission.BACKUP_EXPORT, Permission.BACKUP_RESTORE],
  });
  const hash = await hasher.hash(ownerPassword);
  await asTenant(pool, tenant.tenantId, async (db) => {
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      hash, tenant.userId,
    ]);
  });
  return { tenant, token: signToken(tenant, TEST_JWT_SECRET) };
}

async function insertCompletedImport(tenant: SeededTenant, operationId: string): Promise<void> {
  await asTenant(pool, tenant.tenantId, async (db) => {
    const now = clock.now();
    await db.query(
      `INSERT INTO import_operations (
         id, tenant_id, operation_id, import_type, request_fingerprint,
         response_json, created_at, created_by, completed_at
       ) VALUES ($1, $2, $3, 'PRODUCTS', $4, $5::jsonb, $6, $7, $6)`,
      [
        Ulid.generate(clock), tenant.tenantId, operationId,
        'import:sha256:v1:' + 'a'.repeat(64),
        JSON.stringify({ type: 'PRODUCTS', rows: 1, imported: 1 }),
        now, tenant.userId,
      ],
    );
  });
}

suite('P0 #259: immutable operation identity and signed backup restore', () => {
  beforeAll(async () => {
    assertDisposable(); // Before migration, fixture reset, or any SQL.
    pool = testPool();
    await prepareTestDatabase();
    workspace = mkdtempSync(join(tmpdir(), 'mod259-recovery-disposable-'));
    writeFileSync(join(workspace, 'backup.key'), backupSecret + '\n', { mode: 0o600 });
    process.env['BACKUP_DIR'] = join(workspace, 'archives');
    process.env['BACKUP_KEY_PATH'] = join(workspace, 'backup.key');
    process.env['RECOVERY_DUMP_DIR'] = join(workspace, 'recovery');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => { await resetDatabase(pool); });

  it('allows tenant-scoped reads but denies runtime DELETE/TRUNCATE and foreign tenant inspection', async () => {
    const owner = await signedOwner('Original tenant');
    const foreign = await signedOwner('Foreign tenant');
    const key = Ulid.generate(clock);
    await insertCompletedImport(owner.tenant, key);

    const rights = await asTenant(pool, owner.tenant.tenantId, async (db) => {
      const result = await db.query<{
        can_select: boolean; can_delete: boolean; can_truncate: boolean; count: string;
      }>(`SELECT
          has_table_privilege(current_user, 'public.import_operations', 'SELECT') AS can_select,
          has_table_privilege(current_user, 'public.import_operations', 'DELETE') AS can_delete,
          has_table_privilege(current_user, 'public.import_operations', 'TRUNCATE') AS can_truncate,
          (SELECT count(*)::text FROM import_operations) AS count`);
      return result.rows[0];
    });
    expect(rights).toEqual({
      can_select: true, can_delete: false, can_truncate: false, count: '1',
    });

    await expect(asTenant(pool, owner.tenant.tenantId, async (db) => {
      await db.query('DELETE FROM import_operations WHERE tenant_id=$1', [
        owner.tenant.tenantId,
      ]);
    })).rejects.toMatchObject({ code: '42501' });

    const foreignCount = await asTenant(pool, foreign.tenant.tenantId, async (db) => {
      const result = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM import_operations',
      );
      return result.rows[0]?.n;
    });
    expect(foreignCount).toBe('0');
  });

  it('restores an owner-verified archive with its permanent operation key intact (RED)', async () => {
    const original = await signedOwner('Archived source tenant');
    const key = Ulid.generate(clock);
    await insertCompletedImport(original.tenant, key);

    const exported = await request(app.getHttpServer())
      .post('/api/v1/backup/export')
      .set('authorization', 'Bearer ' + original.token)
      .send({ confirmPassword: ownerPassword })
      .expect(200);
    const bytes = Buffer.from(exported.body as Buffer);
    const archive = await new AesArchiveCodec().decode(bytes, backupSecret);
    const operations = archive.tables.find((table) => table.name === 'import_operations');
    expect(operations?.rows).toHaveLength(1);
    expect(operations?.rows[0]?.[operations.columns.indexOf('operation_id')]).toBe(key);

    // Simulate a true disaster using test ADMIN only, never runtime DELETE.
    await resetDatabase(pool);
    const recovery = await signedOwner('Brand-new empty installation');
    const restored = await request(app.getHttpServer())
      .post('/api/v1/backup/restore')
      .set('authorization', 'Bearer ' + recovery.token)
      .send({
        fileName: 'mod259-recovery.sherdb',
        contentBase64: bytes.toString('base64'),
        confirmPassword: ownerPassword,
      });

    // Current #253 returns HTTP 500 (DELETE import_operations denied).
    // Future approved recovery mechanism must satisfy this source/identity gate.
    expect(restored.status).toBe(200);

    const result = await asTenant(pool, original.tenant.tenantId, async (db) => {
      return db.query<{ operation_id: string }>(
        'SELECT operation_id FROM import_operations ORDER BY created_at',
      );
    });
    expect(result.rows.map((row) => row.operation_id)).toEqual([key]);
  });
});
