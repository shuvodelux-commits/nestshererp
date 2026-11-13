/**
 * Synthetic ONLY audit fixture for issue #44.
 *
 * This file is prepared for review; its SQL/database execution requires a
 * SECOND explicit owner approval. It is NOT part of ordinary CI test commands.
 * It fails closed before constructing a database pool unless all gates match.
 *
 * Environment proposal: a brand-new disposable Podman PostgreSQL 16 at
 * 127.0.0.1:55544, DB hisabiq_issue44_synthetic_20261113, two fabricated tenants.
 * Only admin fixture setup can write. Audit queries use a separate SELECT-only
 * non-BYPASSRLS login and transaction-local app.tenant_id.
 */
import { join } from 'node:path';

import { runMigrations } from '@sher/adapter-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PURCHASE_AUDIT_SQL, SALES_AUDIT_SQL } from './issue44-audit-queries';
import type { ReturnAuditSummary } from './issue44-audit-queries';

const TENANT_A = '01H0000000000000000000000A';
const TENANT_B = '01H0000000000000000000000B';
const DATABASE = 'hisabiq_issue44_synthetic_20261113';
const AUDIT_ROLE = 'hisabiq_audit_probe_44';
const EXECUTION_GATE = 'issue44-synthetic-only-explicit-second-approval';
const TABLES = [
  'sales', 'sale_lines', 'sales_returns', 'sales_return_lines',
  'purchases', 'purchase_lines', 'purchase_returns', 'purchase_return_lines',
] as const;
const DATE = '2026-01-15';
const NOW = '2026-01-15T12:00:00Z';

let nextId = 0;
const syntheticId = (): string => {
  nextId += 1;
  return '01J' + String(nextId).padStart(23, '0');
};

type Client = pg.PoolClient;
interface TenantFixture {
  readonly tenant: string;
  readonly actor: string;
  readonly party: string;
  readonly product: string;
  readonly otherProduct: string;
  readonly location: string;
}

interface SaleSource {
  readonly id: string;
  readonly lineId: string;
  readonly movementId: string;
}
interface PurchaseSource {
  readonly id: string;
  readonly lineId: string;
  readonly movementId: string;
  readonly lotId: string;
}

let admin: pg.Pool | undefined;
let audit: pg.Pool | undefined;

function verifyGates(): { adminUrl: string; auditUrl: string; password: string } {
  if (process.env['ISSUE44_ALLOW_SYNTHETIC_SQL'] !== EXECUTION_GATE) {
    throw new Error('Issue #44 execution is not owner-authorized; fixture SQL is blocked');
  }
  const raw = process.env['ISSUE44_ADMIN_DATABASE_URL'];
  const password = process.env['ISSUE44_AUDIT_PASSWORD'];
  if (!raw || !password || !/^[a-f0-9]{64}$/.test(password)) {
    throw new Error('Issue #44 isolated admin URL and 64-hex synthetic-only password are required');
  }
  const url = new URL(raw);
  if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
      url.port !== '55544' || url.pathname !== '/' + DATABASE ||
      url.username !== 'postgres' || url.search !== '' || url.hash !== '') {
    throw new Error('Issue #44 database target mismatch: requires localhost:55544 and dedicated DB');
  }
  const auditUrl = new URL(raw);
  auditUrl.username = AUDIT_ROLE;
  auditUrl.password = password;
  return { adminUrl: raw, auditUrl: auditUrl.toString(), password };
}

/** Every ID is fabricated; no source contains a real customer or tenant. */
async function seedTenant(db: Client, tenant: string): Promise<TenantFixture> {
  const actor = syntheticId();
  const party = syntheticId();
  const unit = syntheticId();
  const product = syntheticId();
  const otherProduct = syntheticId();
  const location = syntheticId();

  await db.query(
    "INSERT INTO tenants (id,name,timezone,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,'Asia/Dhaka',$3,$3,$4,$4,1)",
    [tenant, 'Issue44 Synthetic ' + (tenant === TENANT_A ? 'A' : 'B'), NOW, actor],
  );
  await db.query(
    'INSERT INTO units (id,tenant_id,name,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$4,$5,$5,1)',
    [unit, tenant, 'Pcs', NOW, actor],
  );
  await db.query(
    'INSERT INTO parties (id,tenant_id,name,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$4,$5,$5,1)',
    [party, tenant, 'Fake Counterparty', NOW, actor],
  );
  await db.query(
    'INSERT INTO inventory_locations (id,tenant_id,name,is_default,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,TRUE,$4,$4,$5,$5,1)',
    [location, tenant, 'Fake Warehouse', NOW, actor],
  );
  for (const [id, name] of [[product, 'Synthetic Wire'], [otherProduct, 'Synthetic Pipe']] as const) {
    await db.query(
      'INSERT INTO products (id,tenant_id,name,base_unit_id,purchase_price_minor,selling_price_minor,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,1,1,$5,$5,$6,$6,1)',
      [id, tenant, name, unit, NOW, actor],
    );
  }
  return { tenant, actor, party, product, otherProduct, location };
}

/** Stock movements are synthetic FK anchors, not real stock operations. */
async function movement(
  db: Client, t: TenantFixture, direction: 'IN' | 'OUT',
  documentType: string, documentId: string, lotId: string | null = null,
): Promise<string> {
  const id = syntheticId();
  await db.query(
    'INSERT INTO stock_movements (id,tenant_id,created_at,created_by,product_id,location_id,lot_id,qty,direction,business_date,source_document_type,source_document_id,source_number) VALUES ($1,$2,$3,$4,$5,$6,$7,1000,$8,$9,$10,$11,$12)',
    [id, t.tenant, NOW, t.actor, t.product, t.location, lotId,
      direction, DATE, documentType, documentId, 'FAKE-' + id],
  );
  return id;
}

async function saleSource(
  db: Client, t: TenantFixture, netMinor: number, qty = 5_000, costMinor = 0,
): Promise<SaleSource> {
  const id = syntheticId();
  const lineId = syntheticId();
  const movementId = await movement(db, t, 'OUT', 'SALE', id);
  await db.query(
    "INSERT INTO sales (id,tenant_id,sale_number,party_id,customer_name_snapshot,location_id,items_total_minor,discount_minor,grand_total_minor,cogs_minor,paid_minor,business_date,entry_mode,status,operation_id,created_at,updated_at,created_by,updated_by) VALUES ($1,$2,$3,$4,'Synthetic Only',$5,$6,0,$6,$7,0,$8,'ON_TIME','POSTED',$9,$10,$10,$11,$11)",
    [id, t.tenant, 'SA-' + id, t.party, t.location, netMinor, costMinor, DATE, syntheticId(), NOW, t.actor],
  );
  await db.query(
    "INSERT INTO sale_lines (id,tenant_id,sale_id,line_no,product_id,qty,unit_price_minor,line_discount_minor,line_total_minor,discount_share_minor,net_amount_minor,cost_minor,source,movement_id,created_at,created_by) VALUES ($1,$2,$3,1,$4,$5,1,0,$6,0,$6,$7,'OWN_STOCK',$8,$9,$10)",
    [lineId, t.tenant, id, t.product, qty, netMinor, costMinor, movementId, NOW, t.actor],
  );
  return { id, lineId, movementId };
}

async function purchaseSource(
  db: Client, t: TenantFixture, billedMinor: number, qty = 5_000, actualUnitCost = 0,
): Promise<PurchaseSource> {
  const id = syntheticId();
  const lineId = syntheticId();
  const lotId = syntheticId();
  const sourceCost = Math.round(actualUnitCost * qty / 100_000);
  await db.query(
    "INSERT INTO inventory_lots (id,tenant_id,product_id,location_id,owner_type,source_document_type,source_document_id,source_number,qty_received,qty_remaining,purchase_unit_cost,landed_cost_total,actual_unit_cost,business_date,status,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,'OWNED','PURCHASE',$5,$6,$7,$7,$8,$9,$10,$11,'OPEN',$12,$12,$13,$13,1)",
    [lotId, t.tenant, t.product, t.location, id, 'PU-' + id,
      qty, billedMinor, sourceCost, actualUnitCost, DATE, NOW, t.actor],
  );
  const movementId = await movement(db, t, 'IN', 'PURCHASE', id, lotId);
  await db.query(
    "INSERT INTO purchases (id,tenant_id,purchase_number,supplier_party_id,location_id,items_total_minor,discount_minor,extra_cost_minor,grand_total_minor,paid_minor,business_date,entry_mode,status,operation_id,created_at,updated_at,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,0,0,$6,0,$7,'ON_TIME','POSTED',$8,$9,$9,$10,$10)",
    [id, t.tenant, 'PU-' + id, t.party, t.location, billedMinor, DATE, syntheticId(), NOW, t.actor],
  );
  await db.query(
    'INSERT INTO purchase_lines (id,tenant_id,purchase_id,line_no,product_id,qty,unit_price_minor,line_total_minor,discount_share_minor,extra_cost_share_minor,actual_unit_cost,lot_id,movement_id,created_at,created_by) VALUES ($1,$2,$3,1,$4,$5,1,$6,0,0,$7,$8,$9,$10,$11)',
    [lineId, t.tenant, id, t.product, qty, billedMinor, actualUnitCost, lotId, movementId, NOW, t.actor],
  );
  return { id, lineId, movementId, lotId };
}

async function saleReturn(
  db: Client, t: TenantFixture, source: SaleSource, qty: number,
  value: number, options: {
    readonly status?: 'POSTED' | 'VOIDED';
    readonly parentSaleId?: string;
    readonly productId?: string;
    readonly costMinor?: number;
    readonly parentReturnId?: string;
  } = {},
): Promise<string> {
  const id = options.parentReturnId ?? syntheticId();
  const cost = options.costMinor ?? 0;
  const m = await movement(db, t, 'IN', 'SALES_RETURN', id);
  if (!options.parentReturnId) {
    await db.query(
      "INSERT INTO sales_returns (id,tenant_id,return_number,sale_id,party_id,customer_name_snapshot,location_id,reason,return_value_minor,refund_minor,credit_minor,settled_minor,cogs_minor,business_date,entry_mode,status,operation_id,created_at,updated_at,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,'Synthetic Only',$6,'OTHER',$7,0,$7,0,$8,$9,'ON_TIME',$10,$11,$12,$12,$13,$13)",
      [id, t.tenant, 'SR-' + id, options.parentSaleId ?? source.id, t.party,
        t.location, value, cost, DATE, options.status ?? 'POSTED', syntheticId(), NOW, t.actor],
    );
  }
  await db.query(
    'INSERT INTO sales_return_lines (id,tenant_id,return_id,line_no,sale_line_id,product_id,qty,value_minor,cost_minor,movement_id,created_at,created_by) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)',
    [syntheticId(), t.tenant, id, source.lineId, options.productId ?? t.product,
      qty, value, cost, m, NOW, t.actor],
  );
  return id;
}

async function purchaseReturn(
  db: Client, t: TenantFixture, source: PurchaseSource, qty: number,
  value: number, options: {
    readonly status?: 'POSTED' | 'VOIDED';
    readonly parentPurchaseId?: string;
    readonly productId?: string;
    readonly lotId?: string;
    readonly costMinor?: number;
    readonly parentReturnId?: string;
  } = {},
): Promise<string> {
  const id = options.parentReturnId ?? syntheticId();
  const cost = options.costMinor ?? 0;
  const m = await movement(db, t, 'OUT', 'PURCHASE_RETURN', id, source.lotId);
  if (!options.parentReturnId) {
    await db.query(
      "INSERT INTO purchase_returns (id,tenant_id,return_number,purchase_id,supplier_party_id,supplier_name_snapshot,location_id,reason,return_value_minor,inventory_minor,received_minor,credit_minor,settled_minor,business_date,entry_mode,status,operation_id,created_at,updated_at,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,'Fake Supplier',$6,'OTHER',$7,$8,0,$7,0,$9,'ON_TIME',$10,$11,$12,$12,$13,$13)",
      [id, t.tenant, 'PR-' + id, options.parentPurchaseId ?? source.id,
        t.party, t.location, value, cost, DATE, options.status ?? 'POSTED',
        syntheticId(), NOW, t.actor],
    );
  }
  await db.query(
    'INSERT INTO purchase_return_lines (id,tenant_id,return_id,line_no,purchase_line_id,product_id,lot_id,qty,value_minor,cost_minor,movement_id,created_at,created_by) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [syntheticId(), t.tenant, id, source.lineId, options.productId ?? t.product,
      options.lotId ?? source.lotId, qty, value, cost, m, NOW, t.actor],
  );
  return id;
}

async function seedSyntheticHistory(db: Client): Promise<void> {
  // The only write connection is the fresh-container admin. No real-world data.
  await db.query('BEGIN');
  try {
    const a = await seedTenant(db, TENANT_A);
    const b = await seedTenant(db, TENANT_B);

    const saleGood = await saleSource(db, a, 3);
    const saleBad = await saleSource(db, a, 3);
    const saleTooMany = await saleSource(db, a, 1, 1_000);
    const saleMismatch = await saleSource(db, a, 2);
    const purchasedGood = await purchaseSource(db, a, 3, 5_000, 100);
    const purchasedBad = await purchaseSource(db, a, 3);
    const purchasedTooMany = await purchaseSource(db, a, 1, 1_000);
    const purchasedMismatch = await purchaseSource(db, a, 2);
    const purchasedCost = await purchaseSource(db, a, 3, 5_000, 100);

    const bSale = await saleSource(db, b, 3);
    const bPurchase = await purchaseSource(db, b, 3);
    // Separate clean source for a B parent used by the A cross-tenant-link probe.
    // Do NOT over-return B's ordinary five-piece control line.
    const bParentSaleSource = await saleSource(db, b, 1, 1_000);
    const bParentPurchaseSource = await purchaseSource(db, b, 1, 1_000);

    const good = [1, 0, 1, 0, 1];
    for (let index = 0; index < 5; index += 1) {
      await saleReturn(db, a, saleGood, 1_000, good[index] ?? 0);
      await saleReturn(db, a, saleBad, 1_000, 1);
      await purchaseReturn(db, a, purchasedGood, 1_000, good[index] ?? 0,
        { costMinor: 1 });
      await purchaseReturn(db, a, purchasedBad, 1_000, 1);
      await saleReturn(db, b, bSale, 1_000, good[index] ?? 0);
      await purchaseReturn(db, b, bPurchase, 1_000, good[index] ?? 0);
    }
    await saleReturn(db, a, saleGood, 1_000, 1, { status: 'VOIDED' });
    await purchaseReturn(db, a, purchasedGood, 1_000, 1, { status: 'VOIDED' });

    await saleReturn(db, a, saleTooMany, 2_000, 1);
    await saleReturn(db, a, saleMismatch, 1_000, 1,
      { parentSaleId: saleGood.id, productId: a.otherProduct });

    await purchaseReturn(db, a, purchasedTooMany, 2_000, 1);
    await purchaseReturn(db, a, purchasedMismatch, 1_000, 1,
      { parentPurchaseId: purchasedGood.id, productId: a.otherProduct });
    await purchaseReturn(db, a, purchasedCost, 1_000, 1, { costMinor: 6 });

    // Explicitly synthetic cross-tenant parent references. The schema's FK is
    // global-by-ID, but RLS on the audit role must hide the other tenant parent.
    const bParentSale = await saleReturn(db, b, bParentSaleSource, 1_000, 0);
    const bParentPurchase = await purchaseReturn(db, b, bParentPurchaseSource, 1_000, 0);
    await saleReturn(db, a, saleGood, 1_000, 0, { parentReturnId: bParentSale });
    await purchaseReturn(db, a, purchasedGood, 1_000, 0,
      { parentReturnId: bParentPurchase });

    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function auditedRead(
  tenantContext: string, queryTenant: string, sqlText: string,
): Promise<ReturnAuditSummary> {
  if (audit === undefined) throw new Error('Issue #44 audit pool is not prepared');
  const client = await audit.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL work_mem = '4MB'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantContext]);
    const result = await client.query<ReturnAuditSummary>(sqlText, [queryTenant]);
    await client.query('ROLLBACK');
    const row = result.rows[0];
    if (row === undefined) throw new Error('Missing synthetic audit aggregate');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const isExplicitlyEnabled = process.env['ISSUE44_ALLOW_SYNTHETIC_SQL'] === EXECUTION_GATE;

// Normal CI MUST skip the fixture before any hook can create a pool or touch SQL.
// The owner must approve the exact synthetic-only command in a separate turn.
describe.skipIf(!isExplicitlyEnabled)(
  'Issue #44 historical return audit — explicit SQL execution approval required',
  () => {
beforeAll(async () => {
  // MUST precede any new Pool, query, migration, role operation or fixture setup.
  const cfg = verifyGates();
  admin = new pg.Pool({ connectionString: cfg.adminUrl, max: 1 });
  const info = await admin.query<{ database: string; user_name: string }>(
    'SELECT current_database() AS database, current_user AS user_name',
  );
  if (info.rows[0]?.database !== DATABASE || info.rows[0]?.user_name !== 'postgres') {
    throw new Error('Issue #44 refused non-disposable DB/role connection');
  }
  const existing = await admin.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'",
  );
  if (existing.rows[0]?.count !== '0') {
    throw new Error('Issue #44 DB already contains tables; refusing to touch existing data');
  }
  await runMigrations(admin, join(__dirname, '../../../../migrations'));
  await admin.query(
    "CREATE ROLE " + AUDIT_ROLE +
      " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '" +
      cfg.password + "'",
  );
  await admin.query('GRANT USAGE ON SCHEMA public TO ' + AUDIT_ROLE);
  await admin.query('GRANT SELECT ON ' + TABLES.join(', ') + ' TO ' + AUDIT_ROLE);

  const fixture = await admin.connect();
  try {
    await seedSyntheticHistory(fixture);
  } finally {
    fixture.release();
  }
  audit = new pg.Pool({ connectionString: cfg.auditUrl, max: 1 });
}, 60_000);

afterAll(async () => {
  await audit?.end();
  await admin?.end();
});

  it('uses a non-superuser, non-BYPASSRLS, read-only role', async () => {
    if (audit === undefined) throw new Error('Audit role unavailable');
    const role = await audit.query<{
      rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; can_insert: boolean;
    }>(
      "SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, " +
        "has_table_privilege(current_user,'sales_return_lines','INSERT') AS can_insert " +
        "FROM pg_roles r WHERE r.rolname = current_user",
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false, rolbypassrls: false, rolcreaterole: false, can_insert: false,
    });
  });

  it('finds only the synthetic A legacy 2-poisha sale overcredit', async () => {
    const x = await auditedRead(TENANT_A, TENANT_A, SALES_AUDIT_SQL);
    expect(Number(x.overcredited_sales_line_count)).toBe(1);
    expect(Number(x.max_excess_poisha)).toBe(2);
    expect(Number(x.out_of_bounds_qty_count)).toBe(1);
    expect(Number(x.source_mismatch_line_count)).toBe(1);
    expect(Number(x.unresolved_parent_return_rows)).toBe(1);
    expect(Number(x.zero_poisha_positive_qty_count)).toBe(2);
    expect(Number(x.source_lines_checked)).toBe(4);
    expect(Number(x.posted_return_rows_checked)).toBe(12);
  });

  it('finds synthetic A supplier overcredit, plus separate lot-cost candidate', async () => {
    const x = await auditedRead(TENANT_A, TENANT_A, PURCHASE_AUDIT_SQL);
    expect(Number(x.overcredited_purchase_line_count)).toBe(1);
    expect(Number(x.max_excess_poisha)).toBe(2);
    expect(Number(x.out_of_bounds_qty_count)).toBe(1);
    expect(Number(x.source_mismatch_line_count)).toBe(1);
    expect(Number(x.unresolved_parent_return_rows)).toBe(1);
    expect(Number(x.zero_poisha_positive_qty_count)).toBe(2);
    expect(Number(x.source_lines_checked)).toBe(5);
    expect(Number(x.posted_return_rows_checked)).toBe(13);
    expect(Number(x.candidate_cost_review_count)).toBe(1);
  });

  it('isolates the second fabricated tenant for both audit queries', async () => {
    const a = await auditedRead(TENANT_B, TENANT_B, SALES_AUDIT_SQL);
    const b = await auditedRead(TENANT_B, TENANT_B, PURCHASE_AUDIT_SQL);
    expect(Number(a.overcredited_sales_line_count)).toBe(0);
    expect(Number(b.overcredited_purchase_line_count)).toBe(0);
    expect(Number(a.max_excess_poisha)).toBe(0);
    expect(Number(b.max_excess_poisha)).toBe(0);
    expect(Number(a.unresolved_parent_return_rows)).toBe(0);
    expect(Number(b.unresolved_parent_return_rows)).toBe(0);
    expect(Number(a.source_lines_checked)).toBe(2);
    expect(Number(b.source_lines_checked)).toBe(2);
    expect(Number(a.out_of_bounds_qty_count)).toBe(0);
    expect(Number(b.out_of_bounds_qty_count)).toBe(0);
  });

  it('cannot bypass RLS by changing only the bound query tenant', async () => {
    const a = await auditedRead(TENANT_A, TENANT_B, SALES_AUDIT_SQL);
    const b = await auditedRead(TENANT_B, TENANT_A, PURCHASE_AUDIT_SQL);
    expect(Number(a.source_lines_checked)).toBe(0);
    expect(Number(b.source_lines_checked)).toBe(0);
    expect(Number(a.unresolved_parent_return_rows)).toBe(0);
    expect(Number(b.unresolved_parent_return_rows)).toBe(0);
  });
  },
);
