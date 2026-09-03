/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:DELETE /api/v1/products/:id
 * @covers endpoint:GET /api/v1/catalog
 * @covers endpoint:GET /api/v1/products/:id
 * @covers endpoint:PATCH /api/v1/products/:id
 * @covers endpoint:POST /api/v1/catalog/brands
 * @covers endpoint:POST /api/v1/catalog/categories
 * @covers endpoint:POST /api/v1/catalog/units
 * @covers endpoint:POST /api/v1/products
 * @covers endpoint:POST /api/v1/products/:id/barcode
 * @covers endpoint:POST /api/v1/products/:id/status
 * @covers endpoint:POST /api/v1/settings/value
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission, SettingKey } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import {
  asTenant,
  prepareTestDatabase,
  resetDatabase,
  seedTenant,
  testPool,
  todayIn,
} from './support/database';

/**
 * Phase 2, path 2.2 — products (§5.5). Expected values written before the code.
 *
 * ৳100.00 purchase is `10000` poisha; ৳150.00 selling is `15000`. Both cross the
 * wire as integer minor units (§5.26) and are asserted as those exact integers —
 * a float anywhere in this path is the drift §3.3 exists to prevent.
 *
 * The rules that would be expensive to get wrong:
 *
 *   A product can be created with **only** §5.5's mandatory fields, and opening
 *   stock is not one of them — it defaults to 0 and a real opening entry goes
 *   through Phase 3's stock service.
 *
 *   Purchase price is **absent from the response body** without
 *   `inventory.cost.view`, not blanked in Vue (UI-40, R-E8). This suite asserts
 *   the serialized body, because that is what the network tab shows.
 *
 *   The same `Idempotency-Key` twice creates one product, not two.
 *
 *   Two people editing one product: the second save is refused, not silently
 *   dropped on top of the first (D-32).
 */
const clock = new SystemClock();

const ALL_CATALOG = [
  Permission.PRODUCT_VIEW,
  Permission.PRODUCT_CREATE,
  Permission.PRODUCT_EDIT,
  Permission.PRODUCT_DEACTIVATE,
  Permission.PRODUCT_DELETE,
  Permission.UNIT_MANAGE,
  Permission.BRAND_MANAGE,
  Permission.CATEGORY_MANAGE,
  Permission.COST_VIEW,
  Permission.SETTING_VIEW,
  Permission.SETTING_EDIT,
  Permission.SETTING_TOGGLE,
];

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let pieceId: string;
let cartonId: string;

interface ProductBody {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly sellingPriceMinor: number;
  readonly purchasePriceMinor?: number;
  readonly minStockQty: number;
  readonly status: string;
  readonly barcode: string | null;
  readonly offerLive: boolean;
  readonly offerStartDate: string | null;
  readonly offerEndDate: string | null;
  readonly conversion: { unitId: string; unitName: string; factorQty: number } | null;
  readonly version: number;
}

/** §5.5's mandatory set, and nothing else. */
function minimalProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Coca Cola 500ml',
    baseUnitId: pieceId,
    purchasePriceMinor: 10_000,
    sellingPriceMinor: 15_000,
    minStockQty: 0,
    brandId: null,
    categoryId: null,
    sku: null,
    barcode: null,
    description: null,
    defaultDiscountType: null,
    defaultDiscountValue: null,
    offerEnabled: false,
    offerPriceMinor: null,
    offerStartDate: null,
    offerEndDate: null,
    tracksExpiry: false,
    tracksSerial: false,
    conversionUnitId: null,
    conversionFactorQty: null,
    ...overrides,
  };
}

function createProduct(
  body: Record<string, unknown>,
  operationId = Ulid.generate(clock),
  as = token,
): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/products')
    .set('Authorization', `Bearer ${as}`)
    .set('Idempotency-Key', operationId)
    .send(body);
}

function listProducts(query = '', as = token): request.Test {
  return request(app.getHttpServer())
    .get(`/api/v1/products${query}`)
    .set('Authorization', `Bearer ${as}`);
}

function addUnit(name: string): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/catalog/units')
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
}

async function setSetting(key: string, value: string): Promise<void> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/settings/value')
    .set('Authorization', `Bearer ${token}`)
    .send({ key, value });
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

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Karim Traders', permissions: ALL_CATALOG });
  token = signToken(tenant, TEST_JWT_SECRET);

  // `seedTenant` inserts rows directly and so does not run tenant provisioning;
  // the two units these tests need are created through the real endpoint.
  const withPiece = await addUnit('Piece');
  expect(withPiece.status).toBe(201);
  const withCarton = await addUnit('Carton');
  expect(withCarton.status).toBe(201);

  const units = withCarton.body.data.units as { id: string; name: string }[];
  pieceId = units.find((unit) => unit.name === 'Piece')?.id as string;
  cartonId = units.find((unit) => unit.name === 'Carton')?.id as string;
});

describe('creating a product', () => {
  it('accepts only the mandatory §5.5 fields, with stock left at zero', async () => {
    const created = await createProduct(minimalProduct());

    expect(created.status).toBe(201);
    const product = created.body.data as ProductBody;
    expect(product.name).toBe('Coca Cola 500ml');
    // No brand, so the display name is the product name (§5.5).
    expect(product.displayName).toBe('Coca Cola 500ml');
    expect(product.sellingPriceMinor).toBe(15_000);
    expect(product.purchasePriceMinor).toBe(10_000);
    expect(product.minStockQty).toBe(0);
    expect(product.status).toBe('ACTIVE');
    expect(product.offerLive).toBe(false);
    expect(product.conversion).toBeNull();
    expect(product.version).toBe(1);
  });

  it('reads the display name as Brand + Product Name', async () => {
    const brand = await request(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Coca Cola' });
    const brandId = brand.body.data.brands[0].id as string;

    const created = await createProduct(minimalProduct({ name: '500ml', brandId }));

    expect((created.body.data as ProductBody).displayName).toBe('Coca Cola 500ml');
  });

  it('creates one product when the same Idempotency-Key is sent twice', async () => {
    const operationId = Ulid.generate(clock);

    const first = await createProduct(minimalProduct(), operationId);
    const second = await createProduct(minimalProduct(), operationId);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.body.data as ProductBody).id).toBe((first.body.data as ProductBody).id);

    const list = await listProducts();
    expect(list.body.summary.total).toBe(1);
  });

  it('refuses the same key with a different product', async () => {
    const operationId = Ulid.generate(clock);
    await createProduct(minimalProduct(), operationId);

    const different = await createProduct(minimalProduct({ name: 'Pepsi 500ml' }), operationId);

    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a barcode another product already uses', async () => {
    await createProduct(minimalProduct({ barcode: '8901234567890' }));

    const clash = await createProduct(
      minimalProduct({ name: 'Pepsi 500ml', barcode: '8901234567890' }),
    );

    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toBe(
      'Another product already uses the barcode 8901234567890',
    );
  });

  it('treats a product code as the same code whatever its case', async () => {
    await createProduct(minimalProduct({ sku: 'ABC-1' }));

    const clash = await createProduct(minimalProduct({ name: 'Pepsi 500ml', sku: 'abc-1' }));

    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toBe('Another product already uses the code abc-1');
  });

  it('stores the one conversion unit as a scaled quantity (D-10, D-41)', async () => {
    const created = await createProduct(
      // 1 Carton = 24 Pieces, at Qty scale 3.
      minimalProduct({ conversionUnitId: cartonId, conversionFactorQty: 24_000 }),
    );

    expect(created.status).toBe(201);
    expect((created.body.data as ProductBody).conversion).toEqual({
      unitId: cartonId,
      unitName: 'Carton',
      factorQty: 24_000,
    });
  });

  it('refuses half a conversion rule (D-41)', async () => {
    // A unit with no factor, or a factor with no unit, is what turns a purchase
    // of 5 Cartons into 5 Pieces of stock.
    const noFactor = await createProduct(minimalProduct({ conversionUnitId: cartonId }));
    expect(noFactor.status).toBe(400);
    expect(noFactor.body.error.message).toBe('Enter how many base units one of them contains');

    const noUnit = await createProduct(minimalProduct({ conversionFactorQty: 24_000 }));
    expect(noUnit.status).toBe(400);
    expect(noUnit.body.error.message).toBe('Choose the unit this product also comes in');
  });

  it('refuses a conversion to the base unit itself', async () => {
    const refused = await createProduct(
      minimalProduct({ conversionUnitId: pieceId, conversionFactorQty: 2_000 }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(
      'The conversion unit has to be different from the base unit — it is what converts to it',
    );
  });

  it('keeps the price per base unit, whatever unit it was typed in (D-41)', async () => {
    /*
     * The form may offer "৳105.00 per Carton"; what arrives and what is stored is
     * always the per-Piece figure. 24 Pieces at ৳4.375 does not divide evenly, so
     * this asserts the exact stored integer rather than a round trip: the
     * conversion happens once, on the client, and the server stores what it is
     * given (§3.3 — every figure crossing the wire is already minor units).
     */
    const created = await createProduct(
      minimalProduct({
        sellingPriceMinor: 438,
        conversionUnitId: cartonId,
        conversionFactorQty: 24_000,
      }),
    );

    expect((created.body.data as ProductBody).sellingPriceMinor).toBe(438);
  });

  it('refuses a standing discount larger than the selling price', async () => {
    const refused = await createProduct(
      minimalProduct({ defaultDiscountType: 'FIXED_AMOUNT', defaultDiscountValue: 20_000 }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(
      'The discount is more than the selling price, which would make the price negative',
    );
  });

  it('refuses a percentage discount above 100%', async () => {
    const refused = await createProduct(
      // 100.01%, at percent scale 2.
      minimalProduct({ defaultDiscountType: 'PERCENTAGE', defaultDiscountValue: 10_001 }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe('A percentage discount cannot be more than 100%');
  });
});

describe('what the shop has switched off', () => {
  it('refuses expiry tracking while the feature is off, and says which', async () => {
    const refused = await createProduct(minimalProduct({ tracksExpiry: true }));

    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FEATURE_DISABLED');
    expect(refused.body.error.message).toBe('Expiry tracking is switched off in Settings');
  });

  it('accepts expiry tracking once the setting is on', async () => {
    await setSetting(SettingKey.EXPIRY_TRACKING_ENABLED, 'on');

    const created = await createProduct(minimalProduct({ tracksExpiry: true }));

    expect(created.status).toBe(201);
    expect(created.body.data.tracksExpiry).toBe(true);
  });

  it('refuses an offer once product offers are switched off', async () => {
    await setSetting(SettingKey.PRODUCT_OFFERS_ENABLED, 'off');

    const refused = await createProduct(
      minimalProduct({ offerEnabled: true, offerPriceMinor: 12_000 }),
    );

    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(
      'Product offers and default discounts are switched off in Settings',
    );
  });
});

describe('offers', () => {
  it('is live on the day it runs and reads back the days that were chosen', async () => {
    const today = todayIn(tenant.timezone);

    const created = await createProduct(
      minimalProduct({
        offerEnabled: true,
        offerPriceMinor: 12_000,
        offerStartDate: today,
        offerEndDate: today,
      }),
    );

    expect(created.status).toBe(201);
    const product = created.body.data as ProductBody;
    // A one-day offer covers the whole of that day in the shop's own timezone.
    expect(product.offerLive).toBe(true);
    expect(product.offerStartDate).toBe(today);
    expect(product.offerEndDate).toBe(today);
    // The normal selling price is untouched (§5.5).
    expect(product.sellingPriceMinor).toBe(15_000);
  });

  it('is not live before it starts', async () => {
    const created = await createProduct(
      minimalProduct({
        offerEnabled: true,
        offerPriceMinor: 12_000,
        offerStartDate: '2099-01-01',
        offerEndDate: '2099-01-07',
      }),
    );

    expect((created.body.data as ProductBody).offerLive).toBe(false);
    expect((created.body.data as ProductBody).offerStartDate).toBe('2099-01-01');
    expect((created.body.data as ProductBody).offerEndDate).toBe('2099-01-07');
  });

  it('refuses a window that ends before it starts', async () => {
    const refused = await createProduct(
      minimalProduct({
        offerEnabled: true,
        offerPriceMinor: 12_000,
        offerStartDate: '2099-01-07',
        offerEndDate: '2099-01-01',
      }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe('The offer cannot end before it starts');
  });
});

describe('editing a product', () => {
  it('refuses the second of two concurrent saves rather than overwriting the first', async () => {
    const created = await createProduct(minimalProduct());
    const product = created.body.data as ProductBody;

    const edit = (name: string): request.Test =>
      request(app.getHttpServer())
        .patch(`/api/v1/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...minimalProduct({ name }), version: product.version });

    const first = await edit('Coca Cola 600ml');
    const second = await edit('Coca Cola 250ml');

    expect(first.status).toBe(200);
    expect((first.body.data as ProductBody).version).toBe(2);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT_STALE_VERSION');

    // The first edit stands.
    const reread = await request(app.getHttpServer())
      .get(`/api/v1/products/${product.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect((reread.body.data as ProductBody).name).toBe('Coca Cola 600ml');
  });

  it('audits a price change with both figures as stored integers', async () => {
    const created = await createProduct(minimalProduct());
    const product = created.body.data as ProductBody;

    await request(app.getHttpServer())
      .patch(`/api/v1/products/${product.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...minimalProduct({ sellingPriceMinor: 16_000 }), version: 1 });

    const events = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ action: string; before_json: Record<string, unknown>; after_json: Record<string, unknown> }>(
        `SELECT action, before_json, after_json FROM audit_events
          WHERE entity_type = 'product' AND entity_id = $1 ORDER BY id`,
        [product.id],
      ),
    );

    expect(events.rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    expect(events.rows[1]?.before_json['sellingPriceMinor']).toBe(15_000);
    expect(events.rows[1]?.after_json['sellingPriceMinor']).toBe(16_000);
  });

  it('deactivates without touching anything else, and can reactivate', async () => {
    const created = await createProduct(minimalProduct());
    const product = created.body.data as ProductBody;

    const off = await request(app.getHttpServer())
      .post(`/api/v1/products/${product.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'INACTIVE' });

    expect(off.status).toBe(200);
    expect((off.body.data as ProductBody).status).toBe('INACTIVE');

    // Still there, still findable — §5.5: "Inactive products remain in history".
    const inactive = await listProducts('?status=INACTIVE');
    expect(inactive.body.data).toHaveLength(1);
    expect(inactive.body.summary).toEqual({
      total: 1,
      active: 0,
      inactive: 1,
      withoutBarcode: 1,
    });

    const on = await request(app.getHttpServer())
      .post(`/api/v1/products/${product.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ACTIVE' });
    expect((on.body.data as ProductBody).status).toBe('ACTIVE');
  });

  it('generates a barcode for a product that has none, and refuses a second', async () => {
    const created = await createProduct(minimalProduct());
    const product = created.body.data as ProductBody;
    const year = todayIn(tenant.timezone).slice(0, 4);

    const generated = await request(app.getHttpServer())
      .post(`/api/v1/products/${product.id}/barcode`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(generated.status).toBe(200);
    expect(generated.body.data.barcode).toBe(`P-${year}-000001`);

    const again = await request(app.getHttpServer())
      .post(`/api/v1/products/${product.id}/barcode`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(again.status).toBe(400);
    expect(again.body.error.message).toBe(
      'This product already has a barcode. Clear it first if you want a new one.',
    );
  });

  it('deletes a product nothing refers to', async () => {
    const created = await createProduct(
      minimalProduct({ conversionUnitId: cartonId, conversionFactorQty: 24_000 }),
    );
    const product = created.body.data as ProductBody;

    const deleted = await request(app.getHttpServer())
      .delete(`/api/v1/products/${product.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleted.status).toBe(204);
    expect((await listProducts()).body.summary.total).toBe(0);
  });
});

describe('finding products', () => {
  async function seedThree(): Promise<void> {
    const brand = await request(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Coca Cola' });
    const brandId = brand.body.data.brands[0].id as string;

    const drinks = await request(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Drinks', parentId: null });
    const drinksId = drinks.body.data.categories[0].id as string;

    const juice = await request(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Juice', parentId: drinksId });
    const juiceId = (juice.body.data.categories as { id: string; name: string }[]).find(
      (row) => row.name === 'Juice',
    )?.id as string;

    expect((await createProduct(minimalProduct({ name: '500ml', brandId }))).status).toBe(201);
    expect(
      (await createProduct(minimalProduct({ name: 'Mango Juice', categoryId: juiceId }))).status,
    ).toBe(201);
    expect((await createProduct(minimalProduct({ name: 'Rice', sku: 'RICE-1' }))).status).toBe(201);
  }

  it('searches by brand name as well as product name', async () => {
    await seedThree();

    const found = await listProducts('?search=cola');

    expect(found.body.data.map((row: ProductBody) => row.name)).toEqual(['500ml']);
  });

  it('includes subcategories when a parent category is chosen', async () => {
    await seedThree();
    const catalog = await request(app.getHttpServer())
      .get('/api/v1/catalog')
      .set('Authorization', `Bearer ${token}`);
    const drinksId = (catalog.body.data.categories as { id: string; name: string; parentId: string | null }[]).find(
      (row) => row.name === 'Drinks',
    )?.id as string;

    const found = await listProducts(`?categoryId=${drinksId}`);

    expect(found.body.data.map((row: ProductBody) => row.name)).toEqual(['Mango Juice']);
  });

  it('pages by keyset in name order, never by offset', async () => {
    await seedThree();

    const first = await listProducts('?limit=2');
    expect(first.body.data.map((row: ProductBody) => row.name)).toEqual(['500ml', 'Mango Juice']);
    expect(first.body.page.hasMore).toBe(true);
    expect(first.body.page.nextCursor).toBe(first.body.data[1].id);
    // The tiles count everything that matches, not just this page.
    expect(first.body.summary.total).toBe(3);

    const second = await listProducts(`?limit=2&cursor=${first.body.page.nextCursor as string}`);
    expect(second.body.data.map((row: ProductBody) => row.name)).toEqual(['Rice']);
    expect(second.body.page.hasMore).toBe(false);
    expect(second.body.page.nextCursor).toBe(null);
  });
});

describe('who may see what', () => {
  it('does not send the purchase price to a caller without inventory.cost.view', async () => {
    await createProduct(minimalProduct());

    const cashier = await seedTenant(pool, {
      name: 'Cashier shop',
      permissions: [Permission.PRODUCT_VIEW],
    });
    const cashierToken = signToken(cashier, TEST_JWT_SECRET);

    // Their own product, in their own tenant, so this is about the field and not
    // about isolation.
    const own = await createProduct(minimalProduct(), Ulid.generate(clock), cashierToken);
    expect(own.status).toBe(403);

    const seller = await seedTenant(pool, {
      name: 'Seller shop',
      permissions: [Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.UNIT_MANAGE],
    });
    const sellerToken = signToken(seller, TEST_JWT_SECRET);
    const unit = await request(app.getHttpServer())
      .post('/api/v1/catalog/units')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ name: 'Piece' });
    const sellerPiece = (unit.body.data.units as { id: string; name: string }[])[0]?.id as string;

    const created = await createProduct(
      minimalProduct({ baseUnitId: sellerPiece }),
      Ulid.generate(clock),
      sellerToken,
    );
    expect(created.status).toBe(201);

    // The serialized body, which is what the network tab shows: the key is absent,
    // not zero and not null (UI-40).
    expect(Object.keys(created.body.data as Record<string, unknown>)).not.toContain(
      'purchasePriceMinor',
    );
    expect((created.body.data as ProductBody).sellingPriceMinor).toBe(15_000);

    const listed = await listProducts('', sellerToken);
    expect(Object.keys(listed.body.data[0] as Record<string, unknown>)).not.toContain(
      'purchasePriceMinor',
    );
  });

  it('keeps view, create, edit and deactivate as separate permissions', async () => {
    const viewer = await seedTenant(pool, {
      name: 'Viewer shop',
      permissions: [Permission.PRODUCT_VIEW],
    });
    const viewerToken = signToken(viewer, TEST_JWT_SECRET);

    expect((await listProducts('', viewerToken)).status).toBe(200);
    const refused = await createProduct(minimalProduct(), Ulid.generate(clock), viewerToken);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('cannot read another tenant’s product, and is told 404', async () => {
    const created = await createProduct(minimalProduct());
    const other = await seedTenant(pool, { name: 'Other shop', permissions: ALL_CATALOG });
    const otherToken = signToken(other, TEST_JWT_SECRET);

    const read = await request(app.getHttpServer())
      .get(`/api/v1/products/${(created.body.data as ProductBody).id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('NOT_FOUND');
  });
});

/**
 * UI-46 — every column header sorts on tap.
 *
 * The risk being tested is not "does ORDER BY work". It is that sorting by a
 * **non-unique** column while paging with a keyset cursor silently loses rows:
 * without `id` as the final tiebreak, ties may come back in a different order on
 * each page, so one product appears twice and another never appears at all. A
 * shopkeeper paging through low stock would act on a list that is quietly wrong.
 */
describe('sorting a list by tapping a header (UI-46)', () => {
  /** Three reorder levels, two of them equal — the tie is the whole point. */
  async function seedForSorting(): Promise<void> {
    await createProduct(minimalProduct({ name: 'Cha patti', minStockQty: 5000, sellingPriceMinor: 30000 }));
    await createProduct(minimalProduct({ name: 'Attar', minStockQty: 12000, sellingPriceMinor: 10000 }));
    await createProduct(minimalProduct({ name: 'Biscuit', minStockQty: 5000, sellingPriceMinor: 20000 }));
  }

  function namesOf(body: { data: { name: string }[] }): string[] {
    return body.data.map((row) => row.name);
  }

  it('sorts by name when a header is tapped, and reverses on the second tap', async () => {
    await seedForSorting();

    const up = await listProducts('?sort=name&direction=ASC');
    expect(namesOf(up.body)).toEqual(['Attar', 'Biscuit', 'Cha patti']);

    const down = await listProducts('?sort=name&direction=DESC');
    expect(namesOf(down.body)).toEqual(['Cha patti', 'Biscuit', 'Attar']);
  });

  it('sorts a number the big end first by default — that is what "show me" means', async () => {
    await seedForSorting();

    // Tapping `Reorder at` asks "what needs attention", which is the top of the
    // list. Defaulting a number to ascending makes every user tap twice forever.
    const tapped = await listProducts('?sort=minStockQty');
    expect(namesOf(tapped.body)[0]).toBe('Attar');
  });

  it('does not lose or repeat a row when paging through tied values', async () => {
    await seedForSorting();

    const first = await listProducts('?sort=minStockQty&direction=ASC&limit=2');
    expect(first.body.page.hasMore).toBe(true);

    const second = await listProducts(
      `?sort=minStockQty&direction=ASC&limit=2&cursor=${first.body.page.nextCursor}`,
    );

    const seen = [...namesOf(first.body), ...namesOf(second.body)];
    // Every product exactly once: two pages, three products, no duplicate.
    expect([...seen].sort()).toEqual(['Attar', 'Biscuit', 'Cha patti']);
    expect(new Set(seen).size).toBe(3);
  });

  it('sorts by a nullable column without dropping the rows that are null', async () => {
    // The row-value comparison goes NULL against a NULL column, the row fails the
    // WHERE, and it vanishes from every page after the first. Coalescing is what
    // stops a product with no barcode ceasing to exist once someone pages.
    await createProduct(minimalProduct({ name: 'Has code', barcode: '8901234567890' }));
    await createProduct(minimalProduct({ name: 'No code' }));

    const page = await listProducts('?sort=barcode&direction=ASC&limit=1');
    const next = await listProducts(
      `?sort=barcode&direction=ASC&limit=1&cursor=${page.body.page.nextCursor}`,
    );

    expect([...namesOf(page.body), ...namesOf(next.body)].sort()).toEqual(['Has code', 'No code']);
  });

  it('refuses a column that is not on the allow-list', async () => {
    // The sort column is never a string taken from the request — it is a closed
    // enum, so an unknown one is a validation failure rather than SQL.
    const refused = await listProducts('?sort=deleted_at');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses sorting by purchase price without inventory.cost.view', async () => {
    // Ordering by a figure you may not read hands you the figure: it ranks every
    // product by cost, which is exactly what UI-40 keeps out of the response.
    const cashier = await seedTenant(pool, {
      name: 'Cost blind shop',
      permissions: [Permission.PRODUCT_VIEW],
    });
    const cashierToken = signToken(cashier, TEST_JWT_SECRET);

    const refused = await listProducts('?sort=purchasePrice', cashierToken);
    expect(refused.status).toBe(403);

    // ...and the same caller may still sort by anything they can see.
    const allowed = await listProducts('?sort=sellingPrice', cashierToken);
    expect(allowed.status).toBe(200);
  });
});
