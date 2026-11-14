/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/inventory/valuation
 * @covers endpoint:GET /api/v1/parties
 * @covers endpoint:GET /api/v1/products
 * @covers endpoint:POST /api/v1/catalog/units
 * @covers endpoint:POST /api/v1/imports
 * @covers endpoint:POST /api/v1/imports/preview
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

/**
 * The guided onboarding import (§5.6) — path 2.4 and Phase 3's opening-stock
 * CSV step. **Expected numbers written before the code.**
 *
 *   Two products at ৳100.00 and ৳550.50 purchase → `10000` and `55050` poisha,
 *   reorder levels `10000` and `5000` at quantity scale 3.
 *
 *   Opening stock: 10 Rice with no unit cost in the file → valued at the
 *   product's ৳100.00 purchase price = ৳1,000.00 (`100000`). 5 Dal with
 *   ৳60.00 stated in the file, over a product whose purchase price is ৳50.00 →
 *   ৳300.00 (`30000`), because §5.6's import carries its own unit cost.
 *   Valuation totals ৳1,300.00 (`130000`), and the `INVENTORY` account the same to
 *   the poisha (INV-05).
 *
 * The rule that matters most here is **all-or-nothing**: a file with one bad
 * row creates nothing at all. It is asserted by counting what exists after the
 * refusal, not by trusting the status code.
 */
const clock = new SystemClock();

const PERMISSIONS = [
  Permission.PRODUCT_VIEW,
  Permission.PRODUCT_CREATE,
  Permission.UNIT_MANAGE,
  Permission.BRAND_MANAGE,
  Permission.COST_VIEW,
  Permission.CUSTOMER_VIEW,
  Permission.CUSTOMER_CREATE,
  Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE,
];

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;

const PRODUCT_HEADER =
  'Product Name,Base Unit,Purchase Price,Selling Price,Reorder Level,Brand,Category,Subcategory,Product Code,Barcode,Description';
const OPENING_HEADER = 'Product Name,Product Code,Quantity,Unit Cost,Opening Date,Expiry Date';
const CUSTOMER_HEADER =
  'Customer Name,Phone,Address,Father/Guardian Name,NID,Email,Customer Group,Credit Limit,Notes';

interface PreviewBody {
  readonly rows: readonly {
    readonly rowNumber: number;
    readonly errors: readonly { readonly column: string; readonly message: string }[];
  }[];
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly missingColumns: readonly string[];
}

function preview(type: string, csv: string, as = token): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/imports/preview')
    .set('Authorization', `Bearer ${as}`)
    .send({ type, csv });
}

function commit(type: string, csv: string, operationId = Ulid.generate(clock), as = token): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/imports')
    .set('Authorization', `Bearer ${as}`)
    .set('Idempotency-Key', operationId)
    .send({ type, csv });
}

async function products(as = token): Promise<readonly Record<string, unknown>[]> {
  const response = await request(app.getHttpServer())
    .get('/api/v1/products')
    .set('Authorization', `Bearer ${as}`);
  expect(response.status).toBe(200);
  return response.body.data as readonly Record<string, unknown>[];
}

async function customers(): Promise<readonly Record<string, unknown>[]> {
  const response = await request(app.getHttpServer())
    .get('/api/v1/parties?role=CUSTOMER')
    .set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
  return response.body.data as readonly Record<string, unknown>[];
}

async function valuation(): Promise<{ totalValueMinor: number; inventoryAccountMinor: number; reconciled: boolean }> {
  const response = await request(app.getHttpServer())
    .get('/api/v1/inventory/valuation')
    .set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
  return response.body.data as { totalValueMinor: number; inventoryAccountMinor: number; reconciled: boolean };
}


/**
 * Simulate 30-day cache pruning under the same unprivileged tenant RLS policy
 * the application uses. This is NOT deletion of the permanent business import
 * operation document; that document must survive this fast-cache cleanup.
 */
async function pruneFastImportReplay(operationId: string): Promise<void> {
  const deleted = await asTenant(pool, tenant.tenantId, async (client) => {
    const result = await client.query(
      'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND operation_id = $2',
      [tenant.tenantId, operationId],
    );
    return result.rowCount;
  });
  expect(deleted).toBe(1);
}

async function addUnit(name: string, as = token): Promise<void> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/catalog/units')
    .set('Authorization', `Bearer ${as}`)
    .send({ name });
  expect(response.status).toBe(201);
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

/** §3.11: an import that moves stock is held to the same five invariants. */
afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Onboarding Shop', permissions: PERMISSIONS });
  token = signToken(tenant, TEST_JWT_SECRET);
  await addUnit('Piece');
});

describe('importing products', () => {
  const file = [
    PRODUCT_HEADER,
    'PVC Pipe 1 inch,Piece,100.00,150.00,10,,,,PIPE-1IN,,',
    'Cement Bag,Piece,550.50,600.00,5,,,,CEM-50,,',
  ].join('\r\n');

  it('previews every row without creating anything', async () => {
    const previewed = await preview('PRODUCTS', file);

    expect(previewed.status).toBe(200);
    const body = previewed.body.data as PreviewBody;
    expect(body.totalRows).toBe(2);
    expect(body.validRows).toBe(2);
    expect(body.invalidRows).toBe(0);
    // The preview step is a read. Nothing exists until Import is pressed.
    expect(await products()).toEqual([]);
  });

  it('creates the products with the exact figures in the file', async () => {
    const imported = await commit('PRODUCTS', file);

    expect(imported.status).toBe(201);
    expect(imported.body.data).toEqual({ type: 'PRODUCTS', rows: 2, imported: 2 });

    const rows = await products();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'PVC Pipe 1 inch',
          purchasePriceMinor: 10_000,
          sellingPriceMinor: 15_000,
          minStockQty: 10_000,
          sku: 'PIPE-1IN',
          status: 'ACTIVE',
        }),
        expect.objectContaining({
          name: 'Cement Bag',
          purchasePriceMinor: 55_050,
          sellingPriceMinor: 60_000,
          minStockQty: 5_000,
        }),
      ]),
    );
  });

  /*
   * The rule the whole feature stands on (§5.6: "posting is all-or-nothing per
   * file. A failed row posts nothing"). Asserted by counting what exists after
   * the refusal — a status code alone would not notice a half-written file.
   */
  it('creates nothing at all when one row names a unit that does not exist', async () => {
    const withTypo = [
      PRODUCT_HEADER,
      'PVC Pipe 1 inch,Piece,100.00,150.00,10,,,,PIPE-1IN,,',
      'Cement Bag,Peice,550.50,600.00,5,,,,CEM-50,,',
    ].join('\r\n');

    const previewed = await preview('PRODUCTS', withTypo);
    const body = previewed.body.data as PreviewBody;
    expect(body.validRows).toBe(1);
    expect(body.invalidRows).toBe(1);
    expect(body.rows[1]?.rowNumber).toBe(3);
    expect(body.rows[1]?.errors).toEqual([
      { column: 'Base Unit', message: 'There is no unit called "Peice" — add it in Units first' },
    ]);

    const refused = await commit('PRODUCTS', withTypo);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    expect(await products()).toEqual([]);
  });

  it('refuses two rows that claim the same product code, naming the row above', async () => {
    const clashing = [
      PRODUCT_HEADER,
      'PVC Pipe 1 inch,Piece,100.00,150.00,10,,,,PIPE-1IN,,',
      'PVC Pipe 2 inch,Piece,200.00,250.00,10,,,,PIPE-1IN,,',
    ].join('\r\n');

    const body = (await preview('PRODUCTS', clashing)).body.data as PreviewBody;
    expect(body.rows[1]?.errors).toEqual([
      { column: 'Product Code', message: 'Row 2 already uses this code' },
    ]);
    expect((await commit('PRODUCTS', clashing)).status).toBe(400);
    expect(await products()).toEqual([]);
  });

  it('names the columns a file is missing instead of failing every row', async () => {
    const body = (await preview('PRODUCTS', 'Product Name\r\nPVC Pipe')).body.data as PreviewBody;
    expect(body.missingColumns).toEqual([
      'Base Unit',
      'Purchase Price',
      'Selling Price',
      'Reorder Level',
    ]);
    expect(body.rows).toEqual([]);
  });

  // §5.6: "idempotent on the supplied import operation ID". A shop on a slow
  // connection presses Import twice; the catalogue must not double.
  it('imports once when the same import id is sent twice', async () => {
    const operationId = Ulid.generate(clock);
    const first = await commit('PRODUCTS', file, operationId);
    const second = await commit('PRODUCTS', file, operationId);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(await products()).toHaveLength(2);
  });


  // C003-02R RED: the 30-day idempotency cache is an optimization, never the
  // permanent import operation identity. A SKU-less product has no natural
  // uniqueness constraint to rescue a replay months later.
  it('replays a pruned SKU-less product import exactly once', async () => {
    const operationId = Ulid.generate(clock);
    const noSkuFile = [
      PRODUCT_HEADER,
      'Hex Bolt 01,Piece,10.00,15.00,1,,,,,,',
    ].join('\r\n');

    const first = await commit('PRODUCTS', noSkuFile, operationId);
    expect(first.status).toBe(201);
    expect((await products()).filter((row) => row.name === 'Hex Bolt 01')).toHaveLength(1);

    await pruneFastImportReplay(operationId);
    const replay = await commit('PRODUCTS', noSkuFile, operationId);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect((await products()).filter((row) => row.name === 'Hex Bolt 01')).toHaveLength(1);
  });

  it('rejects a changed equal-length SKU-less CSV after the fast replay cache is pruned', async () => {
    const operationId = Ulid.generate(clock);
    const original = [PRODUCT_HEADER, 'Hex Bolt 01,Piece,10.00,15.00,1,,,,,,'].join('\r\n');
    const changed = [PRODUCT_HEADER, 'Hex Bolt 02,Piece,10.00,15.00,1,,,,,,'].join('\r\n');
    expect(changed.length).toBe(original.length);
    expect((await commit('PRODUCTS', original, operationId)).status).toBe(201);

    await pruneFastImportReplay(operationId);
    const refused = await commit('PRODUCTS', changed, operationId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await products()).toHaveLength(1);
    expect((await products()).some((row) => row.name === 'Hex Bolt 02')).toBe(false);
  });


  // C003-02: two HTTP requests can race on separate Nest connections. The
  // durable UNIQUE claim is acquired before the owning product writer.
  it('serializes simultaneous equal-body SKU-less imports across database transactions', async () => {
    const operationId = Ulid.generate(clock);
    const csv = [PRODUCT_HEADER, 'Hex Bolt 01,Piece,10.00,15.00,1,,,,,,'].join('\r\n');

    const [left, right] = await Promise.all([
      commit('PRODUCTS', csv, operationId),
      commit('PRODUCTS', csv, operationId),
    ]);
    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(right.body.data).toEqual(left.body.data);
    expect((await products()).filter((row) => row.name === 'Hex Bolt 01')).toHaveLength(1);

    const observed = await asTenant(pool, tenant.tenantId, (client) =>
      client.query(
        'SELECT operation_id, request_fingerprint, response_json FROM import_operations WHERE tenant_id = $1 AND operation_id = $2',
        [tenant.tenantId, operationId],
      ),
    );
    expect(observed.rows).toHaveLength(1);
    expect(observed.rows[0]?.response_json).toEqual(left.body.data);
    expect(observed.rows[0]?.request_fingerprint).toMatch(/^import:sha256:v1:[0-9a-f]{64}$/);
    expect(JSON.stringify(observed.rows[0])).not.toContain(csv);
  });

  it('serializes racing changed-body imports as one 201 and one 409', async () => {
    const operationId = Ulid.generate(clock);
    const original = [PRODUCT_HEADER, 'Hex Bolt 01,Piece,10.00,15.00,1,,,,,,'].join('\r\n');
    const different = [PRODUCT_HEADER, 'Hex Bolt 02,Piece,10.00,15.00,1,,,,,,'].join('\r\n');
    const [left, right] = await Promise.all([
      commit('PRODUCTS', original, operationId),
      commit('PRODUCTS', different, operationId),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    const refused = left.status === 409 ? left : right;
    expect(refused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await products()).toHaveLength(1);
  });

  it('rolls back a durable claim when the CSV validation fails, allowing a corrected retry', async () => {
    const operationId = Ulid.generate(clock);
    const bad = [
      PRODUCT_HEADER,
      'Hex Bolt 01,Piece,10.00,15.00,1,,,,,,',
      'Invalid Unit,Peice,10.00,15.00,1,,,,,,',
    ].join('\r\n');
    expect((await commit('PRODUCTS', bad, operationId)).status).toBe(400);
    const saved = await asTenant(pool, tenant.tenantId, (client) =>
      client.query('SELECT id FROM import_operations WHERE tenant_id = $1 AND operation_id = $2',
        [tenant.tenantId, operationId]),
    );
    expect(saved.rows).toHaveLength(0);
    expect(await products()).toHaveLength(0);

    const corrected = [PRODUCT_HEADER, 'Hex Bolt 01,Piece,10.00,15.00,1,,,,,,'].join('\r\n');
    const result = await commit('PRODUCTS', corrected, operationId);
    expect(result.status).toBe(201);
    expect(await products()).toHaveLength(1);
  });

  it('never exposes tenant A durable import identity to tenant B under RLS', async () => {
    const operationId = Ulid.generate(clock);
    const csv = [PRODUCT_HEADER, 'Hex Bolt 01,Piece,10.00,15.00,1,,,,,,'].join('\r\n');
    expect((await commit('PRODUCTS', csv, operationId)).status).toBe(201);

    const other = await seedTenant(pool, { name: 'Isolated Import Tenant', permissions: PERMISSIONS });
    const foreign = await asTenant(pool, other.tenantId, (client) =>
      client.query('SELECT response_json FROM import_operations WHERE operation_id = $1', [operationId]),
    );
    expect(foreign.rows).toHaveLength(0);
    const own = await asTenant(pool, tenant.tenantId, (client) =>
      client.query(
        'SELECT current_user AS principal, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls, response_json FROM import_operations WHERE operation_id = $1',
        [operationId],
      ),
    );
    expect(own.rows).toHaveLength(1);
    expect(own.rows[0]?.principal).toBe('sher_app');
    expect(own.rows[0]?.is_superuser).toBe(false);
    expect(own.rows[0]?.bypass_rls).toBe(false);
    expect(own.rows[0]?.response_json).toEqual({ type: 'PRODUCTS', rows: 1, imported: 1 });
  });


  it('preserves permanent import type identity after fast cache pruning', async () => {
    const operationId = Ulid.generate(clock);
    const productCsv = [PRODUCT_HEADER, 'Hex Bolt 01,Piece,10.00,15.00,1,,,,,,'].join('\r\n');
    expect((await commit('PRODUCTS', productCsv, operationId)).status).toBe(201);

    await pruneFastImportReplay(operationId);
    const refused = await commit('CUSTOMERS', productCsv, operationId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await products()).toHaveLength(1);
    expect(await customers()).toHaveLength(0);
  });

  // C003-01: two different files can have identical character counts. The
  // operation id must never return success for a different import payload.
  it('rejects a same-length changed CSV under an already committed import id', async () => {
    const operationId = Ulid.generate(clock);
    const changedFile = file.replace('PVC Pipe 1 inch', 'PVC Tube 1 inch');
    expect(changedFile).not.toBe(file);
    expect(changedFile.length).toBe(file.length);

    const original = await commit('PRODUCTS', file, operationId);
    expect(original.status).toBe(201);

    const rejected = await commit('PRODUCTS', changedFile, operationId);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Reusing the same key for another import type must also refuse before
    // parsing or posting that new type's rows.
    const changedType = await commit('CUSTOMERS', file, operationId);
    expect(changedType.status).toBe(409);
    expect(changedType.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    expect((await products()).map((row) => row.name)).toEqual(
      expect.arrayContaining(['PVC Pipe 1 inch', 'Cement Bag']),
    );
    expect((await products()).some((row) => row.name === 'PVC Tube 1 inch')).toBe(false);

    const retry = await commit('PRODUCTS', file, operationId);
    expect(retry.status).toBe(201);
    expect(retry.body.data).toEqual(original.body.data);
    expect(await products()).toHaveLength(2);
  });

  // Before C003-01, imports stored only [type, csv.length]. Such legacy
  // records cannot prove what bytes the original request actually contained.
  it('fails closed when a stored import fingerprint uses the legacy length format', async () => {
    const operationId = Ulid.generate(clock);
    expect((await commit('PRODUCTS', file, operationId)).status).toBe(201);
    const legacyFingerprint = JSON.stringify(['PRODUCTS', file.length]);
    const updatedCount = await asTenant(pool, tenant.tenantId, async (client) => {
      const updated = await client.query(
        'UPDATE idempotency_keys SET request_fingerprint = $1 WHERE tenant_id = $2 AND operation_id = $3',
        [legacyFingerprint, tenant.tenantId, operationId],
      );
      return updated.rowCount;
    });
    expect(updatedCount).toBe(1);

    const replay = await commit('PRODUCTS', file, operationId);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await products()).toHaveLength(2);
  });

  it('keeps the same import operation id tenant scoped', async () => {
    const operationId = Ulid.generate(clock);
    expect((await commit('PRODUCTS', file, operationId)).status).toBe(201);

    const other = await seedTenant(pool, { name: 'Second Import Shop', permissions: PERMISSIONS });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    await addUnit('Piece', otherToken);
    const otherFile = file.replace('PVC Pipe 1 inch', 'PVC Tube 1 inch');
    expect((await commit('PRODUCTS', otherFile, operationId, otherToken)).status).toBe(201);
    expect((await products()).some((row) => row.name === 'PVC Pipe 1 inch')).toBe(true);
    expect((await products(otherToken)).some((row) => row.name === 'PVC Tube 1 inch')).toBe(true);
    expect(await products()).toHaveLength(2);
    expect(await products(otherToken)).toHaveLength(2);
  });

  it('refuses a caller who may not create products, before reading the file', async () => {
    const readOnly = await seedTenant(pool, {
      name: 'Onboarding Shop Reader',
      permissions: [Permission.PRODUCT_VIEW],
    });
    const readOnlyToken = signToken(readOnly, TEST_JWT_SECRET);

    expect((await preview('PRODUCTS', file, readOnlyToken)).status).toBe(403);
    expect((await commit('PRODUCTS', file, Ulid.generate(clock), readOnlyToken)).status).toBe(403);
    expect(await products(readOnlyToken)).toEqual([]);
  });
});

describe('importing customers', () => {
  it('creates customers and refuses a phone repeated inside the file (D-02)', async () => {
    const good = [
      CUSTOMER_HEADER,
      'Rahim Traders,01712345678,"Mirpur 10, Dhaka",,,,,,',
      'Karim Store,01812345678,Uttara,,,,,,',
    ].join('\r\n');

    expect((await commit('CUSTOMERS', good)).status).toBe(201);
    const rows = await customers();
    // `seedTenant` inserts rows directly rather than running tenant provisioning,
    // so the only customers here are the two the file created.
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Rahim Traders', phone: '01712345678', address: 'Mirpur 10, Dhaka' }),
        expect.objectContaining({ name: 'Karim Store', phone: '01812345678' }),
      ]),
    );

    const clashing = [
      CUSTOMER_HEADER,
      'New Shop,01912345678,,,,,,,',
      'Same Number,01912345678,,,,,,,',
    ].join('\r\n');
    const body = (await preview('CUSTOMERS', clashing)).body.data as PreviewBody;
    expect(body.rows[1]?.errors).toEqual([
      { column: 'Phone', message: 'Row 2 already uses this phone number' },
    ]);
    expect((await commit('CUSTOMERS', clashing)).status).toBe(400);
    // Still only the two from the good file.
    expect(await customers()).toHaveLength(2);
  });
});

describe('importing opening stock', () => {
  beforeEach(async () => {
    const file = [
      PRODUCT_HEADER,
      'Rice,Piece,100.00,120.00,10,,,,RICE-1,,',
      'Dal,Piece,50.00,70.00,5,,,,DAL-1,,',
    ].join('\r\n');
    expect((await commit('PRODUCTS', file)).status).toBe(201);
  });

  /*
   * The number this whole path exists for. The opening posts through the same
   * stock-opening service the product form calls, so valuation and the
   * `INVENTORY` account agree to the poisha (INV-05) — and the golden
   * invariants run afterwards over everything the import wrote.
   */
  it('posts real stock, valued at the file cost where one is given', async () => {
    const file = [
      OPENING_HEADER,
      'Rice,,10,,,',
      'Dal,,5,60.00,,',
    ].join('\r\n');

    const imported = await commit('OPENING_STOCK', file);
    expect(imported.status).toBe(201);
    expect(imported.body.data).toEqual({ type: 'OPENING_STOCK', rows: 2, imported: 2 });

    const rows = await products();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Rice', stockQty: 10_000, stockValueMinor: 100_000 }),
        expect.objectContaining({ name: 'Dal', stockQty: 5_000, stockValueMinor: 30_000 }),
      ]),
    );

    expect(await valuation()).toEqual(
      expect.objectContaining({
        totalValueMinor: 130_000,
        inventoryAccountMinor: 130_000,
        reconciled: true,
      }),
    );
  });


  // C003-02R RED: a stored opening prevents duplicate stock, but the import
  // operation must also retain the original HTTP response after cache pruning.
  it('replays the original opening-stock CSV result after the fast cache is pruned', async () => {
    const operationId = Ulid.generate(clock);
    const file = [OPENING_HEADER, 'Rice,,10,,,', 'Dal,,5,60.00,,'].join('\r\n');
    const first = await commit('OPENING_STOCK', file, operationId);
    expect(first.status).toBe(201);
    const original = await valuation();
    expect(original).toEqual(expect.objectContaining({
      totalValueMinor: 130_000,
      inventoryAccountMinor: 130_000,
      reconciled: true,
    }));


    // Prove that idempotency protects the owning accounting and stock writers,
    // not only the API response or the cached valuation projection.
    const sourceCounts = async () => asTenant(pool, tenant.tenantId, async (client) => {
      const result = await client.query(
        `SELECT
          (SELECT count(*)::integer FROM stock_openings WHERE tenant_id = $1) AS openings,
          (SELECT count(*)::integer FROM inventory_lots WHERE tenant_id = $1) AS lots,
          (SELECT count(*)::integer FROM stock_movements WHERE tenant_id = $1) AS movements,
          (SELECT count(*)::integer FROM journal_entries WHERE tenant_id = $1) AS journals,
          (SELECT count(*)::integer FROM audit_events WHERE tenant_id = $1 AND entity_type = 'data_import' AND entity_id = $2) AS imports,
          (SELECT count(*)::integer FROM outbox WHERE tenant_id = $1 AND event_type = 'data.imported' AND aggregate_id = $2) AS events`,
        [tenant.tenantId, operationId],
      );
      return result.rows[0];
    });
    const beforeCounts = await sourceCounts();
    expect(beforeCounts?.openings).toBe(2);
    expect(beforeCounts?.imports).toBe(1);
    expect(beforeCounts?.events).toBe(1);

    await pruneFastImportReplay(operationId);
    const replay = await commit('OPENING_STOCK', file, operationId);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await valuation()).toEqual(original);
    expect((await products()).filter((row) => row.name === 'Rice')[0]?.stockQty).toBe(10_000);
    expect(await sourceCounts()).toEqual(beforeCounts);
  });

  it('posts no stock at all when one row names a product that does not exist', async () => {
    const file = [OPENING_HEADER, 'Rice,,10,,,', 'Sugar,,5,,,'].join('\r\n');

    const body = (await preview('OPENING_STOCK', file)).body.data as PreviewBody;
    expect(body.rows[1]?.errors).toEqual([
      {
        column: 'Product Name',
        message: 'There is no product called "Sugar" — import the products first',
      },
    ]);

    expect((await commit('OPENING_STOCK', file)).status).toBe(400);
    expect(await valuation()).toEqual(
      expect.objectContaining({ totalValueMinor: 0, inventoryAccountMinor: 0, reconciled: true }),
    );
  });

  // §5.10: a product may hold exactly one opening. The second row would be
  // refused by the insert; saying so in the preview is what makes the file
  // fixable rather than merely rejected.
  it('refuses a file that opens the same product twice', async () => {
    const file = [OPENING_HEADER, 'Rice,,10,,,', 'Rice,,4,,,'].join('\r\n');

    const body = (await preview('OPENING_STOCK', file)).body.data as PreviewBody;
    expect(body.rows[1]?.errors).toEqual([
      {
        column: 'Product Name',
        message: 'Row 2 already opens this product, and a product can have only one opening',
      },
    ]);
    expect((await commit('OPENING_STOCK', file)).status).toBe(400);
    expect(await valuation()).toEqual(expect.objectContaining({ totalValueMinor: 0 }));
  });

  /*
   * `findIdsByName` is a new query pattern, so it gets its own isolation proof
   * (R-E5): another tenant's product of the same name must not be findable, and
   * the row must fail as "no such product" rather than opening stock in the
   * wrong shop.
   */
  it('cannot see another tenant’s product of the same name', async () => {
    const other = await seedTenant(pool, { name: 'Other Shop', permissions: PERMISSIONS });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    await addUnit('Piece', otherToken);
    const otherFile = [PRODUCT_HEADER, 'Sugar,Piece,80.00,90.00,1,,,,SUG-1,,'].join('\r\n');
    expect((await commit('PRODUCTS', otherFile, Ulid.generate(clock), otherToken)).status).toBe(201);

    const body = (await preview('OPENING_STOCK', [OPENING_HEADER, 'Sugar,,5,,,'].join('\r\n')))
      .body.data as PreviewBody;
    expect(body.rows[0]?.errors).toEqual([
      {
        column: 'Product Name',
        message: 'There is no product called "Sugar" — import the products first',
      },
    ]);
  });
});
