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
import { prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
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
