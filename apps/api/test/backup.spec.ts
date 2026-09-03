/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/backup/status
 * @covers endpoint:POST /api/v1/backup/export
 * @covers endpoint:POST /api/v1/backup/inspect
 * @covers endpoint:POST /api/v1/backup/restore
 */
import 'reflect-metadata';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ArchiveOpenError } from '@sher/core-application';
import { Permission } from '@sher/core-contracts';
import { addSeconds, SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { AesArchiveCodec } from '../src/infrastructure/archive-codec';
import { ScryptPasswordHasher } from '../src/auth/password-hasher';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

/**
 * Backup and restore, end to end (Phase 10, §5.25, owner decisions 2026-08-30).
 *
 * The gate this phase is measured by is one sentence: **backup → wipe →
 * restore matches exactly.** So that is what the main test does, over HTTP,
 * with a real database — a shop with products, a customer and a purchase is
 * exported, the whole database is destroyed, a fresh empty installation is
 * created, and the file is restored into it. Then every figure is counted
 * again.
 *
 * Around it are the refusals, because each one is a way a real shop loses data
 * if it does not hold: restoring over a business that already exists, opening a
 * file with the wrong password, and restoring a file damaged in transit.
 */

const clock = new SystemClock();
const hasher = new ScryptPasswordHasher();

const OWNER_PASSWORD = 'correct-horse-battery';
const BACKUP_SECRET = 'a-very-long-backup-secret';

const BACKUP_PERMISSIONS = [
  Permission.BACKUP_EXPORT,
  Permission.BACKUP_RESTORE,
  Permission.BUSINESS_RESET,
  Permission.LICENSE_VIEW,
  Permission.PRODUCT_VIEW,
];

let app: INestApplication;
let pool: pg.Pool;
let workDirectory: string;

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();

  /*
   * The key file and the archive directory are configuration, read once when
   * the module graph is built — so they are set before the module is compiled,
   * not before each test. A temporary directory keeps a test run from writing
   * into the developer's own backups folder.
   */
  workDirectory = mkdtempSync(join(tmpdir(), 'sher-backup-test-'));
  writeFileSync(join(workDirectory, 'backup.key'), `${BACKUP_SECRET}\n`, { mode: 0o600 });
  process.env['BACKUP_DIR'] = join(workDirectory, 'archives');
  process.env['BACKUP_KEY_PATH'] = join(workDirectory, 'backup.key');
  process.env['RECOVERY_DUMP_DIR'] = join(workDirectory, 'recovery');

  /*
   * Imported statically like every other spec: `loadConfig` is not called until
   * the module factory runs inside `compile()`, so the environment set above is
   * the environment it reads.
   */
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

/** A signed-in owner who can actually satisfy step-up. */
async function seedOwner(name: string): Promise<{ tenant: SeededTenant; token: string }> {
  const tenant = await seedTenant(pool, { name, permissions: BACKUP_PERMISSIONS });
  const passwordHash = await hasher.hash(OWNER_PASSWORD);

  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      tenant.userId,
    ]);
  });

  return { tenant, token: signToken(tenant, TEST_JWT_SECRET) };
}

/** Something for the backup to be a backup *of*. */
async function seedBusinessData(tenant: SeededTenant): Promise<void> {
  const now = clock.now();
  await asTenant(pool, tenant.tenantId, async (client) => {
    const unitId = Ulid.generate(clock);
    await client.query(
      `INSERT INTO units (id, tenant_id, name, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, 'Piece', $3, $3, $4, $4, 1)`,
      [unitId, tenant.tenantId, now, tenant.userId],
    );

    for (const [index, productName] of ['Rice 5kg', 'Soap bar', 'Cooking oil 1L'].entries()) {
      await client.query(
        `INSERT INTO products
           (id, tenant_id, name, base_unit_id, purchase_price_minor, selling_price_minor,
            created_at, updated_at, created_by, updated_by, version)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $6, $7, $7, 1)`,
        [
          Ulid.generate(clock),
          tenant.tenantId,
          productName,
          unitId,
          (index + 1) * 10_000,
          now,
          tenant.userId,
        ],
      );
    }

    const partyId = Ulid.generate(clock);
    await client.query(
      `INSERT INTO parties (id, tenant_id, name, phone, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, 'Karim Mia', '01712345678', $3, $3, $4, $4, 1)`,
      [partyId, tenant.tenantId, now, tenant.userId],
    );
    await client.query(
      `INSERT INTO party_roles (id, tenant_id, party_id, role, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, $3, 'CUSTOMER', $4, $4, $5, $5, 1)`,
      [Ulid.generate(clock), tenant.tenantId, partyId, now, tenant.userId],
    );
  });
}

async function countIn(tenantId: string, table: string): Promise<number> {
  return asTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

describe('the archive file itself', () => {
  const codec = new AesArchiveCodec();
  const body = {
    manifest: {
      archiveVersion: 1,
      schemaVersion: '0040_backup_and_license.sql',
      appVersion: '0.0.0',
      tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      businessName: 'Rahim Store',
      takenAt: '2026-08-31T02:00:00.000Z',
      rowCounts: { products: 3 },
      evidenceBytes: 0,
    },
    tables: [{ name: 'products', columns: ['id', 'name'], rows: [['x', 'Rice 5kg']] }],
  };

  it('comes back byte for byte with the right secret', async () => {
    const encoded = await codec.encode(body, BACKUP_SECRET);
    const decoded = await codec.decode(encoded.bytes, BACKUP_SECRET);

    expect(decoded.manifest).toEqual(body.manifest);
    expect(decoded.tables).toEqual(body.tables);
    expect(decoded.checksum).toBe(encoded.checksum);
  });

  /**
   * "Wrong password" and "damaged file" send a shopkeeper to two different
   * places — the other secret they wrote down, or another copy of the file —
   * so the codec must not flatten them into one answer.
   */
  it('says the password is wrong, not that the file is broken', async () => {
    const encoded = await codec.encode(body, BACKUP_SECRET);

    await expect(codec.decode(encoded.bytes, 'some-other-secret')).rejects.toMatchObject({
      failure: 'WRONG_SECRET',
    });
  });

  it('refuses a file that is not a SherERP backup at all', async () => {
    await expect(
      codec.decode(Buffer.from('this is a photograph, not a backup'), BACKUP_SECRET),
    ).rejects.toMatchObject({ failure: 'NOT_AN_ARCHIVE' });
  });

  /** A byte flipped anywhere must fail the tag rather than restore a changed figure. */
  it('refuses an archive whose bytes were altered in transit', async () => {
    const encoded = await codec.encode(body, BACKUP_SECRET);
    const tampered = Buffer.from(encoded.bytes);
    const target = tampered.length - 5;
    tampered[target] = (tampered[target] ?? 0) ^ 0xff;

    await expect(codec.decode(tampered, BACKUP_SECRET)).rejects.toBeInstanceOf(ArchiveOpenError);
  });
});

describe('backup, wipe, restore', () => {
  /**
   * The Phase 10 gate, in one test.
   *
   * Everything the shop had comes back: its name, its user, its password, its
   * products and its customer — and its `tenant_id`, which is what keeps every
   * foreign key and audit row still meaning what it meant.
   */
  it('restores a destroyed installation from its own backup', async () => {
    const original = await seedOwner('Rahim Store');
    await seedBusinessData(original.tenant);

    const exported = await request(app.getHttpServer())
      .post('/api/v1/backup/export')
      .set('authorization', `Bearer ${original.token}`)
      .send({ confirmPassword: OWNER_PASSWORD })
      .expect(200);

    expect(exported.headers['content-disposition']).toContain('rahim-store-');
    const archive = Buffer.from(exported.body as Buffer).toString('base64');

    // The disaster: the whole database, gone.
    await resetDatabase(pool);

    // A fresh installation with its own seeded identity, and nothing else.
    const fresh = await seedOwner('Newly installed');

    const preview = await request(app.getHttpServer())
      .post('/api/v1/backup/inspect')
      .set('authorization', `Bearer ${fresh.token}`)
      .send({ fileName: 'rahim-store.sherdb', contentBase64: archive })
      .expect(200);

    expect(preview.body.data.businessName).toBe('Rahim Store');
    expect(preview.body.data.canRestore).toBe(true);
    expect(preview.body.data.contents).toContainEqual({ label: 'Products', rows: 3 });

    await request(app.getHttpServer())
      .post('/api/v1/backup/restore')
      .set('authorization', `Bearer ${fresh.token}`)
      .send({
        fileName: 'rahim-store.sherdb',
        contentBase64: archive,
        confirmPassword: OWNER_PASSWORD,
      })
      .expect(200);

    /*
     * The business that came back is the one that was lost, not a copy of it
     * wearing the new installation's identity.
     *
     * Read through `asTenant`, like everything else: `tenants` is under FORCE
     * row-level security, so a query with no `app.tenant_id` set correctly
     * returns nothing at all.
     */
    const restoredTenant = await asTenant(pool, original.tenant.tenantId, async (client) => {
      const result = await client.query<{ id: string; name: string }>('SELECT id, name FROM tenants');
      return result.rows;
    });
    expect(restoredTenant).toEqual([{ id: original.tenant.tenantId, name: 'Rahim Store' }]);

    expect(await countIn(original.tenant.tenantId, 'products')).toBe(3);
    expect(await countIn(original.tenant.tenantId, 'parties')).toBe(1);
    expect(await countIn(original.tenant.tenantId, 'users')).toBe(1);

    // The owner signs in the way they always did: the credential hash travelled.
    const restoredUser = await asTenant(pool, original.tenant.tenantId, async (client) => {
      const result = await client.query<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM users',
      );
      return result.rows[0];
    });
    expect(restoredUser?.id).toBe(original.tenant.userId);
    expect(await hasher.verify(OWNER_PASSWORD, restoredUser?.password_hash ?? '')).toBe(true);

    // And the temporary recovery identity is gone, as the owner specified.
    const gone = await asTenant(pool, fresh.tenant.tenantId, async (client) =>
      client.query('SELECT 1 FROM tenants WHERE id = $1', [fresh.tenant.tenantId]),
    );
    expect(gone.rowCount).toBe(0);
  });

  /**
   * The safety property the whole design rests on: restore writes into an empty
   * installation and refuses anywhere else, so a mis-clicked restore cannot
   * erase a working shop.
   */
  it('refuses to restore over a business that already has data', async () => {
    const original = await seedOwner('Rahim Store');
    await seedBusinessData(original.tenant);

    const exported = await request(app.getHttpServer())
      .post('/api/v1/backup/export')
      .set('authorization', `Bearer ${original.token}`)
      .send({ confirmPassword: OWNER_PASSWORD })
      .expect(200);
    const archive = Buffer.from(exported.body as Buffer).toString('base64');

    const preview = await request(app.getHttpServer())
      .post('/api/v1/backup/inspect')
      .set('authorization', `Bearer ${original.token}`)
      .send({ fileName: 'rahim-store.sherdb', contentBase64: archive })
      .expect(200);

    expect(preview.body.data.canRestore).toBe(false);
    expect(preview.body.data.blockedReason).toContain('already has business data');

    await request(app.getHttpServer())
      .post('/api/v1/backup/restore')
      .set('authorization', `Bearer ${original.token}`)
      .send({
        fileName: 'rahim-store.sherdb',
        contentBase64: archive,
        confirmPassword: OWNER_PASSWORD,
      })
      .expect(400);

    // Untouched: refusing is not a partial restore.
    expect(await countIn(original.tenant.tenantId, 'products')).toBe(3);
  });

  it('refuses an export without the caller’s own password', async () => {
    const owner = await seedOwner('Rahim Store');

    await request(app.getHttpServer())
      .post('/api/v1/backup/export')
      .set('authorization', `Bearer ${owner.token}`)
      .send({ confirmPassword: 'not-the-password' })
      .expect(400);
  });

  /**
   * A role without the permission never reaches the data, whatever the screen
   * may have rendered. Backup is Owner-only by seed (owner decision
   * 2026-08-30).
   */
  it('refuses a user whose role does not hold backup.export', async () => {
    const cashier = await seedTenant(pool, {
      name: 'Rahim Store',
      permissions: [Permission.SALE_CREATE],
    });

    await request(app.getHttpServer())
      .get('/api/v1/backup/status')
      .set('authorization', `Bearer ${signToken(cashier, TEST_JWT_SECRET)}`)
      .expect(403);
  });
});

describe('what the archive carries', () => {
  /**
   * Ephemeral runtime state is excluded and recreated clean (owner decision
   * 2026-08-30). A restored refresh token would be a live credential minted in
   * a database that no longer exists.
   */
  it('leaves sessions behind', async () => {
    const owner = await seedOwner('Rahim Store');
    await seedBusinessData(owner.tenant);

    await asTenant(pool, owner.tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO refresh_tokens (id, tenant_id, user_id, token_hash, expires_at, created_at, created_by)
         VALUES ($1, $2, $3, 'hash', $4, $5, $3)`,
        [
          Ulid.generate(clock),
          owner.tenant.tenantId,
          owner.tenant.userId,
          addSeconds(clock.now(), 86_400),
          clock.now(),
        ],
      );
    });

    const exported = await request(app.getHttpServer())
      .post('/api/v1/backup/export')
      .set('authorization', `Bearer ${owner.token}`)
      .send({ confirmPassword: OWNER_PASSWORD })
      .expect(200);

    const decoded = await new AesArchiveCodec().decode(
      new Uint8Array(exported.body as Buffer),
      BACKUP_SECRET,
    );

    const tables = decoded.tables.map((table) => table.name);
    expect(tables).toContain('products');
    expect(tables).toContain('audit_events');
    expect(tables).not.toContain('refresh_tokens');
    expect(tables).not.toContain('otp_codes');
    expect(tables).not.toContain('idempotency_keys');
    expect(tables).not.toContain('outbox');
    // Machine-local: a restore that claimed fourteen nightly backups existed on
    // a new computer would be lying about the one thing this screen is for.
    expect(tables).not.toContain('backup_runs');
  });

  /**
   * The rule that keeps a backup honest as the product grows: every
   * tenant-scoped table is exported unless it was deliberately excluded. A
   * module added next month is in the backup without anybody remembering to add
   * it, which is the failure this replaces.
   */
  it('exports every tenant-scoped table the database has', async () => {
    const owner = await seedOwner('Rahim Store');

    const exported = await request(app.getHttpServer())
      .post('/api/v1/backup/export')
      .set('authorization', `Bearer ${owner.token}`)
      .send({ confirmPassword: OWNER_PASSWORD })
      .expect(200);

    const decoded = await new AesArchiveCodec().decode(
      new Uint8Array(exported.body as Buffer),
      BACKUP_SECRET,
    );
    const exportedTables = new Set(decoded.tables.map((table) => table.name));

    const all = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
    );

    const excluded = new Set([
      'otp_codes',
      'refresh_tokens',
      'idempotency_keys',
      'outbox',
      'backup_runs',
      'restore_events',
    ]);
    const missing = all.rows
      .map((row) => row.table_name)
      .filter((name) => !excluded.has(name) && !exportedTables.has(name));

    expect(missing).toEqual([]);
  });
});
