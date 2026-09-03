import {
  bigint,
  customType,
  boolean,
  char,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Raw bytes, for the one column that stores a file: a product thumbnail. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Drizzle mirror of migrations/0001_foundation.sql.
 *
 * The SQL file is the source of truth — migrations are hand-written and
 * forward-only (SRS 3.10). This file must be kept in step with it by hand;
 * `pnpm db:migrate` never generates either one from the other.
 */

export const tenants = pgTable('tenants', {
  id: char('id', { length: 26 }).primaryKey(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

export const roles = pgTable('roles', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isSystem: boolean('is_system').notNull(),
  /** How much cash this role may refund; null is unlimited (Phase 7). */
  cashRefundPerReturnMinor: bigint('cash_refund_per_return_minor', { mode: 'number' }),
  cashRefundPerDayMinor: bigint('cash_refund_per_day_minor', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

export const rolePermissions = pgTable('role_permissions', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  roleId: char('role_id', { length: 26 }).notNull(),
  permissionCode: text('permission_code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

export const users = pgTable('users', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  roleId: char('role_id', { length: 26 }).notNull(),
  email: text('email'),
  displayName: text('display_name').notNull(),
  username: text('username'),
  phone: text('phone'),
  passwordHash: text('password_hash'),
  pinHash: text('pin_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

export const periodLocks = pgTable('period_locks', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  periodYear: integer('period_year').notNull(),
  periodMonth: integer('period_month').notNull(),
  status: text('status').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

export const numberingCounters = pgTable(
  'numbering_counters',
  {
    id: char('id', { length: 26 }).primaryKey(),
    tenantId: char('tenant_id', { length: 26 }).notNull(),
    docType: text('doc_type').notNull(),
    year: integer('year').notNull(),
    nextValue: integer('next_value').notNull(),
    prefix: text('prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    createdBy: char('created_by', { length: 26 }).notNull(),
    updatedBy: char('updated_by', { length: 26 }).notNull(),
  },
  (table) => ({
    unique: unique('numbering_counters_unique').on(table.tenantId, table.docType, table.year),
  }),
);

/** Class C — append-only. `tenant_id` is null on a platform event (§5.3 OTP sends). */
export const auditEvents = pgTable('audit_events', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  entityType: text('entity_type').notNull(),
  // TEXT, not CHAR(26): an audited entity is not always a ULID. A setting is
  // identified by its catalogue key and a denial by its permission code, and
  // CHAR would blank-pad both (migration 0006).
  entityId: text('entity_id').notNull(),
  action: text('action').notNull(),
  beforeJson: jsonb('before_json'),
  afterJson: jsonb('after_json'),
  reason: text('reason'),
  source: text('source').notNull(),
});

/** Class C — append-only. Nothing reads it until Phase 12 (D7). */
export const outbox = pgTable('outbox', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  eventType: text('event_type').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: char('aggregate_id', { length: 26 }).notNull(),
  payload: jsonb('payload').notNull(),
});

/** Class C — append-only, pruned after 30 days. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: char('id', { length: 26 }).primaryKey(),
    tenantId: char('tenant_id', { length: 26 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdBy: char('created_by', { length: 26 }).notNull(),
    operationId: char('operation_id', { length: 26 }).notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    responseJson: jsonb('response_json').notNull(),
  },
  (table) => ({
    unique: unique('idempotency_keys_unique').on(table.tenantId, table.operationId),
  }),
);

/**
 * Signup verification. No tenant_id and no RLS — an OTP is verified before a
 * tenant exists. Codes are stored hashed; expiry is derived from created_at by
 * the domain, never stored (§5.3).
 */
export const otpCodes = pgTable('otp_codes', {
  id: char('id', { length: 26 }).primaryKey(),
  identifier: text('identifier').notNull(),
  channel: text('channel').notNull(),
  purpose: text('purpose').notNull(),
  codeHash: text('code_hash').notNull(),
  attemptCount: integer('attempt_count').notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
});

/**
 * The pre-authentication index from an identifier to the account that owns it.
 * Not RLS-scoped: it must be readable before authentication. Never exposed
 * through an API — confirming an identifier is taken is an enumeration oracle.
 */
export const userIdentifiers = pgTable(
  'user_identifiers',
  {
    id: char('id', { length: 26 }).primaryKey(),
    identifier: text('identifier').notNull(),
    channel: text('channel').notNull(),
    tenantId: char('tenant_id', { length: 26 }).notNull(),
    userId: char('user_id', { length: 26 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdBy: char('created_by', { length: 26 }).notNull(),
  },
  (table) => ({
    unique: unique('user_identifiers_unique').on(table.identifier),
  }),
);

/**
 * One row per signed-in device session (§5.3). Not RLS-scoped: a refresh
 * request arrives with no tenant context — the token is what reveals the
 * tenant. Stored hashed, so a database read cannot mint a session.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: char('id', { length: 26 }).primaryKey(),
    tenantId: char('tenant_id', { length: 26 }).notNull(),
    userId: char('user_id', { length: 26 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    rotatedTo: char('rotated_to', { length: 26 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdBy: char('created_by', { length: 26 }).notNull(),
  },
  (table) => ({
    unique: unique('refresh_tokens_hash_unique').on(table.tokenHash),
  }),
);

/** Class B — transactional document, with the R-C9 reserved columns. */
export const notes = pgTable(
  'notes',
  {
    id: char('id', { length: 26 }).primaryKey(),
    tenantId: char('tenant_id', { length: 26 }).notNull(),
    noteNumber: text('note_number').notNull(),
    title: text('title').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    entryMode: text('entry_mode').notNull(),
    status: text('status').notNull(),
    operationId: char('operation_id', { length: 26 }).notNull(),
    locationId: char('location_id', { length: 26 }),
    taxRateId: char('tax_rate_id', { length: 26 }),
    taxAmount: bigint('tax_amount', { mode: 'number' }),
    isTaxInclusive: boolean('is_tax_inclusive'),
    packSize: integer('pack_size'),
    devicePrefix: text('device_prefix'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    createdBy: char('created_by', { length: 26 }).notNull(),
    updatedBy: char('updated_by', { length: 26 }).notNull(),
    version: integer('version').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: char('deleted_by', { length: 26 }),
  },
  (table) => ({
    operationUnique: unique('notes_tenant_operation_unique').on(table.tenantId, table.operationId),
    numberUnique: unique('notes_tenant_number_unique').on(table.tenantId, table.noteNumber),
  }),
);

/**
 * Class A — tenant settings (§5.21, migration 0005). One row per setting a
 * tenant has actually changed; an absent row means the shipped default.
 */
export const settings = pgTable(
  'settings',
  {
    id: char('id', { length: 26 }).primaryKey(),
    tenantId: char('tenant_id', { length: 26 }).notNull(),
    settingKey: text('setting_key').notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    createdBy: char('created_by', { length: 26 }).notNull(),
    updatedBy: char('updated_by', { length: 26 }).notNull(),
    version: integer('version').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: char('deleted_by', { length: 26 }),
  },
  (table) => ({
    keyUnique: unique('settings_tenant_key_unique').on(table.tenantId, table.settingKey),
  }),
);

/**
 * Class A — units of measure (D-10), migration 0007.
 *
 * Unique per tenant on `lower(name)`, which Drizzle cannot express; that
 * constraint lives in the migration, and this mirror exists for queries. The
 * same is true of `brands` and `categories` below.
 */
export const units = pgTable('units', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/** Class A — brands (§5.5, migration 0007). */
export const brands = pgTable('brands', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/**
 * Class A — categories and their subcategories in one self-referencing table
 * (§5.5, migration 0007). `parentId IS NULL` is a top-level category; exactly
 * two levels exist, enforced in the use case where the refusal can be explained.
 */
/**
 * Class A — products (§5.5, migration 0008).
 *
 * Master data, so no `business_date`, no `status` transitions in the Class B
 * sense, and none of the R-C9 reserved transaction columns (§3.9). Money is
 * `bigint` minor units at scale 2; `minStockQty` is a scale-3 quantity.
 */
export const products = pgTable('products', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  name: text('name').notNull(),
  baseUnitId: char('base_unit_id', { length: 26 }).notNull(),
  purchasePriceMinor: bigint('purchase_price_minor', { mode: 'number' }).notNull(),
  sellingPriceMinor: bigint('selling_price_minor', { mode: 'number' }).notNull(),
  minStockQty: bigint('min_stock_qty', { mode: 'number' }).notNull(),
  brandId: char('brand_id', { length: 26 }),
  categoryId: char('category_id', { length: 26 }),
  sku: text('sku'),
  barcode: text('barcode'),
  description: text('description'),
  status: text('status').notNull(),
  defaultDiscountType: text('default_discount_type'),
  defaultDiscountValue: bigint('default_discount_value', { mode: 'number' }),
  offerEnabled: boolean('offer_enabled').notNull(),
  offerPriceMinor: bigint('offer_price_minor', { mode: 'number' }),
  offerStartAt: timestamp('offer_start_at', { withTimezone: true }),
  offerEndAt: timestamp('offer_end_at', { withTimezone: true }),
  tracksExpiry: boolean('tracks_expiry').notNull(),
  tracksSerial: boolean('tracks_serial').notNull(),
  // One optional conversion unit and its factor (D-41, migration 0010). Both or
  // neither — the CHECK constraint in the migration enforces the pair.
  conversionUnitId: char('conversion_unit_id', { length: 26 }),
  conversionFactorQty: bigint('conversion_factor_qty', { mode: 'number' }),
  // Phase 8 (migrations 0031, 0033). All optional: a blank usual supplier falls
  // back to purchase history, a blank minimum applies no minimum, and blank
  // warranty months mean the product carries no warranty.
  usualSupplierId: char('usual_supplier_id', { length: 26 }),
  minOrderQty: bigint('min_order_qty', { mode: 'number' }),
  warrantyMonths: integer('warranty_months'),
  supplierWarrantyMonths: integer('supplier_warranty_months'),
  // One optional thumbnail (migration 0018), stored with the tenant's own data
  // so a backup carries it and an on-prem install needs no object store.
  // One precomputed, normalised line per product (migration 0026) — what the
  // counter's search actually matches against.
  aliases: text('aliases'),
  searchText: text('search_text').notNull(),
  imageMime: text('image_mime'),
  imageBytes: bytea('image_bytes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/**
 * Class A — per-product unit conversions (D-10, migration 0008). `factorQty` is
 * how many base units one of `unitId` contains, as a scale-3 integer: 1 Carton =
 * 24 Pieces is 24000.
 */
export const productUnitConversions = pgTable('product_unit_conversions', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  unitId: char('unit_id', { length: 26 }).notNull(),
  factorQty: bigint('factor_qty', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

export const inventoryLocations = pgTable('inventory_locations', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  name: text('name').notNull(), isDefault: boolean('is_default').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(), version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const stockOpenings = pgTable('stock_openings', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), openingNumber: text('opening_number').notNull(),
  productId: char('product_id', { length: 26 }).notNull(), locationId: char('location_id', { length: 26 }).notNull(), qty: bigint('qty', { mode: 'number' }).notNull(),
  unitCost: bigint('unit_cost', { mode: 'number' }).notNull(), valueMinor: bigint('value_minor', { mode: 'number' }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(), status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(), version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const stockAdjustments = pgTable('stock_adjustments', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), adjustmentNumber: text('adjustment_number').notNull(),
  productId: char('product_id', { length: 26 }).notNull(), locationId: char('location_id', { length: 26 }).notNull(),
  qtyDelta: bigint('qty_delta', { mode: 'number' }).notNull(), direction: text('direction').notNull(), qty: bigint('qty', { mode: 'number' }).notNull(),
  valueMinor: bigint('value_minor', { mode: 'number' }).notNull(), reason: text('reason').notNull(), note: text('note'),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(), status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(), version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),

});

export const inventoryLots = pgTable('inventory_lots', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), productId: char('product_id', { length: 26 }).notNull(), locationId: char('location_id', { length: 26 }).notNull(),
  ownerType: text('owner_type').notNull(), vendorPartyId: char('vendor_party_id', { length: 26 }), supplierPartyId: char('supplier_party_id', { length: 26 }),
  sourceDocumentType: text('source_document_type').notNull(), sourceDocumentId: char('source_document_id', { length: 26 }).notNull(), sourceNumber: text('source_number').notNull(),
  qtyReceived: bigint('qty_received', { mode: 'number' }).notNull(), qtyRemaining: bigint('qty_remaining', { mode: 'number' }).notNull(), purchaseUnitCost: bigint('purchase_unit_cost', { mode: 'number' }).notNull(),
  landedCostTotal: bigint('landed_cost_total', { mode: 'number' }).notNull(), actualUnitCost: bigint('actual_unit_cost', { mode: 'number' }).notNull(), businessDate: date('business_date', { mode: 'string' }).notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }), status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(), version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const stockMovements = pgTable('stock_movements', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(), locationId: char('location_id', { length: 26 }).notNull(), lotId: char('lot_id', { length: 26 }), qty: bigint('qty', { mode: 'number' }).notNull(), direction: text('direction').notNull(), businessDate: date('business_date', { mode: 'string' }).notNull(), sourceDocumentType: text('source_document_type').notNull(), sourceDocumentId: char('source_document_id', { length: 26 }).notNull(), sourceNumber: text('source_number').notNull(), unitCost: bigint('unit_cost', { mode: 'number' }),
});

export const lotConsumptions = pgTable('lot_consumptions', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
  movementId: char('movement_id', { length: 26 }).notNull(), lotId: char('lot_id', { length: 26 }).notNull(), qty: bigint('qty', { mode: 'number' }).notNull(), unitCostUsed: bigint('unit_cost_used', { mode: 'number' }).notNull(), documentType: text('document_type').notNull(), documentId: char('document_id', { length: 26 }).notNull(), businessDate: date('business_date', { mode: 'string' }).notNull(), supersededBy: char('superseded_by', { length: 26 }),
});

export const costAdjustments = pgTable('cost_adjustments', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(), productId: char('product_id', { length: 26 }).notNull(), lotId: char('lot_id', { length: 26 }), reason: text('reason').notNull(), documentRef: text('document_ref').notNull(), amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(), businessDate: date('business_date', { mode: 'string' }).notNull(),
});

export const journalEntries = pgTable('journal_entries', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(), businessDate: date('business_date', { mode: 'string' }).notNull(), sourceDocumentType: text('source_document_type').notNull(), sourceDocumentId: char('source_document_id', { length: 26 }).notNull(), sourceNumber: text('source_number').notNull(), entryMode: text('entry_mode').notNull(),
});

export const journalLines = pgTable('journal_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(), journalEntryId: char('journal_entry_id', { length: 26 }).notNull(), accountCode: text('account_code').notNull(), amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(), partyId: char('party_id', { length: 26 }),
});

export const productCostState = pgTable('product_cost_state', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), productId: char('product_id', { length: 26 }).notNull(), locationId: char('location_id', { length: 26 }).notNull(), avgUnitCost: bigint('avg_unit_cost', { mode: 'number' }).notNull(), qtyOnHand: bigint('qty_on_hand', { mode: 'number' }).notNull(), lastRecomputedAt: timestamp('last_recomputed_at', { withTimezone: true }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(), version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const categories = pgTable('categories', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  parentId: char('parent_id', { length: 26 }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/** Class A — customer groups (§5.6, migration 0009). */
export const customerGroups = pgTable('customer_groups', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/**
 * Class A — parties (§5.6, D-02, D-04, migration 0009).
 *
 * `customerPhoneKey` is the column D-02's partial unique index is built on. It
 * is derived from the roles and the phone in the same statement that writes
 * them; nothing reads it to decide what a party is.
 */
export const parties = pgTable('parties', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  address: text('address'),
  guardianName: text('guardian_name'),
  nid: text('nid'),
  email: text('email'),
  notes: text('notes'),
  customerGroupId: char('customer_group_id', { length: 26 }),
  creditLimitMinor: bigint('credit_limit_minor', { mode: 'number' }),
  status: text('status').notNull(),
  isSystemReserved: boolean('is_system_reserved').notNull(),
  customerPhoneKey: text('customer_phone_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/** Class B — the opening receivable/payable document (§5.6, migration 0015). */
export const partyOpenings = pgTable('party_openings', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(), openingNumber: text('opening_number').notNull(),
  partyId: char('party_id', { length: 26 }).notNull(), role: text('role').notNull(),
  direction: text('direction').notNull(), amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(), status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(), version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

/** Class A — D-04's role flags as rows (§5.6, migration 0009). */
export const partyRoles = pgTable('party_roles', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  partyId: char('party_id', { length: 26 }).notNull(),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/* ------------------------------------------- Phase 4 money (migration 0016) */

/** Class A — where money sits: the drawer, the safe, a bank, bKash (§2.4). */
export const accounts = pgTable('accounts', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  holderName: text('holder_name'),
  reference: text('reference'),
  isDrawer: boolean('is_drawer').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/** Class B — the balance a migrating shop starts an account with (§5.16). */
export const accountOpenings = pgTable('account_openings', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  openingNumber: text('opening_number').notNull(),
  accountId: char('account_id', { length: 26 }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  entryMode: text('entry_mode').notNull(),
  status: text('status').notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/** Class B — one trading day at the drawer (§5.16.1). */
export const cashSessions = pgTable('cash_sessions', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  sessionNumber: text('session_number').notNull(),
  accountId: char('account_id', { length: 26 }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  status: text('status').notNull(),
  openingAmountMinor: bigint('opening_amount_minor', { mode: 'number' }).notNull(),
  previousClosingMinor: bigint('previous_closing_minor', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/**
 * Class B — one attempt to close a day (§5.16.4 and the 2026-08-24 reopen
 * amendment). A day closed by mistake has two rows, and both stay.
 */
export const cashSessionCloses = pgTable('cash_session_closes', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  sessionId: char('session_id', { length: 26 }).notNull(),
  status: text('status').notNull(),
  openingAmountMinor: bigint('opening_amount_minor', { mode: 'number' }).notNull(),
  cashInMinor: bigint('cash_in_minor', { mode: 'number' }).notNull(),
  cashOutMinor: bigint('cash_out_minor', { mode: 'number' }).notNull(),
  expectedClosingMinor: bigint('expected_closing_minor', { mode: 'number' }).notNull(),
  countedClosingMinor: bigint('counted_closing_minor', { mode: 'number' }).notNull(),
  differenceMinor: bigint('difference_minor', { mode: 'number' }).notNull(),
  differenceReason: text('difference_reason'),
  reopenReason: text('reopen_reason'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  supersededBy: char('superseded_by', { length: 26 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
});

/** Class B — money crossing between two named places (§5.16.3, §5.16.5). */
export const cashMovements = pgTable('cash_movements', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  movementNumber: text('movement_number').notNull(),
  kind: text('kind').notNull(),
  fromAccountCode: text('from_account_code').notNull(),
  toAccountCode: text('to_account_code').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  // Migration 0043: the slip, cheque or bKash number, searchable on its own.
  reference: text('reference'),
  note: text('note'),
  sessionId: char('session_id', { length: 26 }),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  entryMode: text('entry_mode').notNull(),
  status: text('status').notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),

});

/**
 * Class B — one supplier bill (migration 0017, §5.9).
 *
 * `paid_minor` is only what was handed over **with the bill**; everything paid
 * later lives in `payment_allocations`, and what is still owed is derived from
 * the two. There is deliberately no outstanding column.
 */
export const purchases = pgTable('purchases', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  purchaseNumber: text('purchase_number').notNull(),
  // Migration 0035: which supplier order this bill was raised against, when
  // the shopkeeper pressed Convert rather than typing it from scratch.
  supplierOrderId: char('supplier_order_id', { length: 26 }),
  supplierPartyId: char('supplier_party_id', { length: 26 }).notNull(),
  supplierBillRef: text('supplier_bill_ref'),
  locationId: char('location_id', { length: 26 }).notNull(),
  dueDate: date('due_date', { mode: 'string' }),
  itemsTotalMinor: bigint('items_total_minor', { mode: 'number' }).notNull(),
  discountMinor: bigint('discount_minor', { mode: 'number' }).notNull(),
  extraCostMinor: bigint('extra_cost_minor', { mode: 'number' }).notNull(),
  grandTotalMinor: bigint('grand_total_minor', { mode: 'number' }).notNull(),
  paidMinor: bigint('paid_minor', { mode: 'number' }).notNull(),
  paidAccountCode: text('paid_account_code'),
  sessionId: char('session_id', { length: 26 }),
  notes: text('notes'),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  entryMode: text('entry_mode').notNull(),
  status: text('status').notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),

});

export const purchaseLines = pgTable('purchase_lines', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  purchaseId: char('purchase_id', { length: 26 }).notNull(),
  // Phase 8. Which plan line this bought, so fulfilment is a SUM rather than a
  // counter that would have to be unwound when a bill is voided (migration 0031),
  // and the supplier's warranty terms for this delivery when they differ from
  // the product's usual ones (migration 0033).
  planLineId: char('plan_line_id', { length: 26 }),
  supplierWarrantyMonths: integer('supplier_warranty_months'),
  lineNo: integer('line_no').notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
  lineTotalMinor: bigint('line_total_minor', { mode: 'number' }).notNull(),
  discountShareMinor: bigint('discount_share_minor', { mode: 'number' }).notNull(),
  extraCostShareMinor: bigint('extra_cost_share_minor', { mode: 'number' }).notNull(),
  actualUnitCost: bigint('actual_unit_cost', { mode: 'number' }).notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }),
  lotId: char('lot_id', { length: 26 }).notNull(),
  movementId: char('movement_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
});

/** Class B — money handed to a supplier after the goods arrived (§5.9). */
export const supplierPayments = pgTable('supplier_payments', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  paymentNumber: text('payment_number').notNull(),
  supplierPartyId: char('supplier_party_id', { length: 26 }).notNull(),
  accountCode: text('account_code').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  note: text('note'),
  sessionId: char('session_id', { length: 26 }),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  entryMode: text('entry_mode').notNull(),
  status: text('status').notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
  updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),

});

/** Which bills a payment settled. Allocation moves no money (§5.9). */
export const paymentAllocations = pgTable('payment_allocations', {
  id: char('id', { length: 26 }).primaryKey(),
  tenantId: char('tenant_id', { length: 26 }).notNull(),
  paymentId: char('payment_id', { length: 26 }).notNull(),
  purchaseId: char('purchase_id', { length: 26 }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
});

// ---------------------------------------------------------------- selling
// Phase 6 (migration 0018). What is still owed on an invoice is never a column
// here: it is `grand_total − Σ sale_payments − Σ receipt_allocations`, computed
// in the same statement as the row it belongs to.
export const sales = pgTable('sales', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  saleNumber: text('sale_number').notNull(), partyId: char('party_id', { length: 26 }).notNull(),
  customerNameSnapshot: text('customer_name_snapshot').notNull(),
  customerPhoneSnapshot: text('customer_phone_snapshot'),
  customerGuardianNameSnapshot: text('customer_guardian_name_snapshot'),
  customerAddressSnapshot: text('customer_address_snapshot'),
  locationId: char('location_id', { length: 26 }).notNull(), dueDate: date('due_date', { mode: 'string' }),
  itemsTotalMinor: bigint('items_total_minor', { mode: 'number' }).notNull(),
  discountMinor: bigint('discount_minor', { mode: 'number' }).notNull(),
  grandTotalMinor: bigint('grand_total_minor', { mode: 'number' }).notNull(),
  cogsMinor: bigint('cogs_minor', { mode: 'number' }).notNull(),
  paidMinor: bigint('paid_minor', { mode: 'number' }).notNull(),
  sessionId: char('session_id', { length: 26 }), notes: text('notes'),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(),
  status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),
  /*
   * Phase 12.4 (§18) — the origin trail, permanent and informational. Migration
   * 0047 puts the same five columns on every operational document table; only
   * the ones a screen actually reads are declared here.
   */
  originMode: text('origin_mode').notNull().default('ONLINE'),
  originDeviceId: char('origin_device_id', { length: 26 }),
  deviceCreatedAt: timestamp('device_created_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  deviceSeq: bigint('device_seq', { mode: 'number' }),
});

export const saleLines = pgTable('sale_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  saleId: char('sale_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  productId: char('product_id', { length: 26 }).notNull(), qty: bigint('qty', { mode: 'number' }).notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
  lineDiscountMinor: bigint('line_discount_minor', { mode: 'number' }).notNull(),
  lineTotalMinor: bigint('line_total_minor', { mode: 'number' }).notNull(),
  discountShareMinor: bigint('discount_share_minor', { mode: 'number' }).notNull(),
  netAmountMinor: bigint('net_amount_minor', { mode: 'number' }).notNull(),
  costMinor: bigint('cost_minor', { mode: 'number' }).notNull(), source: text('source').notNull(),
  vendorPartyId: char('vendor_party_id', { length: 26 }), vendorUnitCost: bigint('vendor_unit_cost', { mode: 'number' }),
  movementId: char('movement_id', { length: 26 }).notNull(), vendorLotId: char('vendor_lot_id', { length: 26 }),
  isProvisionalCost: boolean('is_provisional_cost').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

/** Immutable origin facts for a mixed-source sale line (migration 0045). */
export const saleLineSourceAllocations = pgTable('sale_line_source_allocations', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  saleId: char('sale_id', { length: 26 }).notNull(), saleLineId: char('sale_line_id', { length: 26 }).notNull(),
  sourceType: text('source_type').notNull(), qty: bigint('qty', { mode: 'number' }).notNull(),
  ownedLotId: char('owned_lot_id', { length: 26 }), vendorPartyId: char('vendor_party_id', { length: 26 }),
  vendorStockReceiptId: char('vendor_stock_receipt_id', { length: 26 }),
  vendorLotId: char('vendor_lot_id', { length: 26 }), inventoryUnitId: char('inventory_unit_id', { length: 26 }),
  unitCostUsed: bigint('unit_cost_used', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

/** Append-only proof that an exact origin allocation was restored. */
export const saleSourceAllocationReversals = pgTable('sale_source_allocation_reversals', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  sourceAllocationId: char('source_allocation_id', { length: 26 }).notNull(),
  sourceDocumentType: text('source_document_type').notNull(), sourceDocumentId: char('source_document_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  serialPreviousStatus: text('serial_previous_status'),
  serialSaleId: char('serial_sale_id', { length: 26 }), serialSaleLineId: char('serial_sale_line_id', { length: 26 }),
  serialCustomerPartyId: char('serial_customer_party_id', { length: 26 }),
  serialSoldDate: date('serial_sold_date', { mode: 'string' }),
  serialCustomerWarrantyMonths: integer('serial_customer_warranty_months'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

export const salePayments = pgTable('sale_payments', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  saleId: char('sale_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  accountCode: text('account_code').notNull(), amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  sessionId: char('session_id', { length: 26 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

export const customerReceipts = pgTable('customer_receipts', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  receiptNumber: text('receipt_number').notNull(), customerPartyId: char('customer_party_id', { length: 26 }).notNull(),
  accountCode: text('account_code').notNull(), amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  note: text('note'), sessionId: char('session_id', { length: 26 }),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(),
  status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),

});

export const receiptAllocations = pgTable('receipt_allocations', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  receiptId: char('receipt_id', { length: 26 }).notNull(), saleId: char('sale_id', { length: 26 }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

export const invoicePresentation = pgTable('invoice_presentation', {
  saleId: char('sale_id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  customerDisplayName: text('customer_display_name'), customerPhone: text('customer_phone'),
  customerGuardianName: text('customer_guardian_name'),
  customerAddress: text('customer_address'), deliveryAddress: text('delivery_address'),
  courierName: text('courier_name'), deliveryInstruction: text('delivery_instruction'),
  paymentNote: text('payment_note'),
  customLabel1: text('custom_label_1'), customValue1: text('custom_value_1'),
  customLabel2: text('custom_label_2'), customValue2: text('custom_value_2'),
  customLabel3: text('custom_label_3'), customValue3: text('custom_value_3'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

export const invoiceLinePresentation = pgTable('invoice_line_presentation', {
  saleLineId: char('sale_line_id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  saleId: char('sale_id', { length: 26 }).notNull(), displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

export const invoiceSettings = pgTable('invoice_settings', {
  tenantId: char('tenant_id', { length: 26 }).primaryKey(),
  language: text('language').notNull(), defaultTemplate: text('default_template').notNull(),
  showLogo: boolean('show_logo').notNull(), showBusinessBlock: boolean('show_business_block').notNull(),
  showCustomerBlock: boolean('show_customer_block').notNull(), showSku: boolean('show_sku').notNull(),
  showBarcode: boolean('show_barcode').notNull(), showDiscount: boolean('show_discount').notNull(),
  showPaymentBreakdown: boolean('show_payment_breakdown').notNull(), showDue: boolean('show_due').notNull(),
  showAmountInWords: boolean('show_amount_in_words').notNull(),
  headerText: text('header_text'), showHeaderText: boolean('show_header_text').notNull(),
  invoiceTitle: text('invoice_title'),
  businessNameEn: text('business_name_en'), proprietorName: text('proprietor_name'), proprietorNote: text('proprietor_note'),
  businessDescription: text('business_description'), businessPhone2: text('business_phone_2'),
  contactPhones: jsonb('contact_phones').notNull(),
  mfsNumbers: jsonb('mfs_numbers').notNull(), terms: jsonb('terms').notNull(),
  paymentTermsDays: integer('payment_terms_days').notNull(), paymentTermsLabel: text('payment_terms_label'),
  thermalPaper: text('thermal_paper').notNull(), showSignatureLines: boolean('show_signature_lines').notNull(),
  logoMime: text('logo_mime'), logoBytes: bytea('logo_bytes'),
  businessName: text('business_name'), businessAddress: text('business_address'),
  businessPhone: text('business_phone'),
  footerText: text('footer_text'), termsText: text('terms_text'),
  businessPadEnabled: boolean('business_pad_enabled').notNull(),
  businessPadTopMm: integer('business_pad_top_mm').notNull(), pageMarginMm: integer('page_margin_mm').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

export const productGroupPrices = pgTable('product_group_prices', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(), customerGroupId: char('customer_group_id', { length: 26 }).notNull(),
  priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

export const quotations = pgTable('quotations', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  quotationNumber: text('quotation_number').notNull(), partyId: char('party_id', { length: 26 }),
  customerNameSnapshot: text('customer_name_snapshot').notNull(), customerPhoneSnapshot: text('customer_phone_snapshot'),
  validUntil: date('valid_until', { mode: 'string' }),
  itemsTotalMinor: bigint('items_total_minor', { mode: 'number' }).notNull(),
  discountMinor: bigint('discount_minor', { mode: 'number' }).notNull(),
  grandTotalMinor: bigint('grand_total_minor', { mode: 'number' }).notNull(),
  notes: text('notes'), businessDate: date('business_date', { mode: 'string' }).notNull(),
  status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const quotationLines = pgTable('quotation_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  quotationId: char('quotation_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  productId: char('product_id', { length: 26 }).notNull(), qty: bigint('qty', { mode: 'number' }).notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
  lineDiscountMinor: bigint('line_discount_minor', { mode: 'number' }).notNull(),
  lineTotalMinor: bigint('line_total_minor', { mode: 'number' }).notNull(),
  qtyConverted: bigint('qty_converted', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

export const salesOrders = pgTable('sales_orders', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  orderNumber: text('order_number').notNull(), partyId: char('party_id', { length: 26 }),
  customerNameSnapshot: text('customer_name_snapshot').notNull(), customerPhoneSnapshot: text('customer_phone_snapshot'),
  sourceQuotationId: char('source_quotation_id', { length: 26 }), expectedDate: date('expected_date', { mode: 'string' }),
  itemsTotalMinor: bigint('items_total_minor', { mode: 'number' }).notNull(),
  discountMinor: bigint('discount_minor', { mode: 'number' }).notNull(),
  grandTotalMinor: bigint('grand_total_minor', { mode: 'number' }).notNull(),
  notes: text('notes'), businessDate: date('business_date', { mode: 'string' }).notNull(),
  status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const salesOrderLines = pgTable('sales_order_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  salesOrderId: char('sales_order_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  productId: char('product_id', { length: 26 }).notNull(), qty: bigint('qty', { mode: 'number' }).notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
  lineDiscountMinor: bigint('line_discount_minor', { mode: 'number' }).notNull(),
  lineTotalMinor: bigint('line_total_minor', { mode: 'number' }).notNull(),
  qtyConverted: bigint('qty_converted', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

export const saleDrafts = pgTable('sale_drafts', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  label: text('label').notNull(), customerName: text('customer_name'),
  itemCount: integer('item_count').notNull(),
  grandTotalMinor: bigint('grand_total_minor', { mode: 'number' }).notNull(),
  cart: jsonb('cart').notNull(), businessDate: date('business_date', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

export const salesReturns = pgTable('sales_returns', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  returnNumber: text('return_number').notNull(), saleId: char('sale_id', { length: 26 }).notNull(),
  partyId: char('party_id', { length: 26 }).notNull(),
  customerNameSnapshot: text('customer_name_snapshot').notNull(),
  locationId: char('location_id', { length: 26 }).notNull(),
  reason: text('reason').notNull(), note: text('note'),
  returnValueMinor: bigint('return_value_minor', { mode: 'number' }).notNull(),
  refundMinor: bigint('refund_minor', { mode: 'number' }).notNull(),
  creditMinor: bigint('credit_minor', { mode: 'number' }).notNull(),
  settledMinor: bigint('settled_minor', { mode: 'number' }).notNull(),
  cogsMinor: bigint('cogs_minor', { mode: 'number' }).notNull(),
  refundAccountCode: text('refund_account_code'),
  approvedBy: char('approved_by', { length: 26 }),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(),
  backdateReason: text('backdate_reason'),
  status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),

});

export const salesReturnLines = pgTable('sales_return_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  returnId: char('return_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  saleLineId: char('sale_line_id', { length: 26 }).notNull(), productId: char('product_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  valueMinor: bigint('value_minor', { mode: 'number' }).notNull(),
  costMinor: bigint('cost_minor', { mode: 'number' }).notNull(),
  movementId: char('movement_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

export const purchaseReturns = pgTable('purchase_returns', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  returnNumber: text('return_number').notNull(), purchaseId: char('purchase_id', { length: 26 }).notNull(),
  supplierPartyId: char('supplier_party_id', { length: 26 }).notNull(),
  supplierNameSnapshot: text('supplier_name_snapshot').notNull(),
  locationId: char('location_id', { length: 26 }).notNull(),
  reason: text('reason').notNull(), note: text('note'),
  returnValueMinor: bigint('return_value_minor', { mode: 'number' }).notNull(),
  inventoryMinor: bigint('inventory_minor', { mode: 'number' }).notNull(),
  receivedMinor: bigint('received_minor', { mode: 'number' }).notNull(),
  creditMinor: bigint('credit_minor', { mode: 'number' }).notNull(),
  settledMinor: bigint('settled_minor', { mode: 'number' }).notNull(),
  receiptAccountCode: text('receipt_account_code'),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(),
  backdateReason: text('backdate_reason'),
  status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),

});

export const purchaseReturnLines = pgTable('purchase_return_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  returnId: char('return_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  purchaseLineId: char('purchase_line_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(), lotId: char('lot_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  valueMinor: bigint('value_minor', { mode: 'number' }).notNull(),
  costMinor: bigint('cost_minor', { mode: 'number' }).notNull(),
  movementId: char('movement_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

export const expenseCategories = pgTable('expense_categories', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  code: text('code').notNull(), name: text('name').notNull(),
  isSystem: boolean('is_system').notNull(), status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const expenses = pgTable('expenses', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  expenseNumber: text('expense_number').notNull(),
  categoryId: char('category_id', { length: 26 }).notNull(),
  categoryCodeSnapshot: text('category_code_snapshot').notNull(),
  categoryNameSnapshot: text('category_name_snapshot').notNull(),
  payeePartyId: char('payee_party_id', { length: 26 }), payeeNameSnapshot: text('payee_name_snapshot'),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  accountCode: text('account_code').notNull(), sessionId: char('session_id', { length: 26 }),
  note: text('note'),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(),
  backdateReason: text('backdate_reason'),
  status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
  voidReason: text('void_reason'),
  correctionReason: text('correction_reason'),
  originalBusinessDate: date('original_business_date', { mode: 'string' }),

});

export const stockCounts = pgTable('stock_counts', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  countNumber: text('count_number').notNull(), locationId: char('location_id', { length: 26 }).notNull(),
  scopeLabel: text('scope_label').notNull(), note: text('note'),
  lineCount: integer('line_count').notNull(), differenceCount: integer('difference_count').notNull(),
  shortageValueMinor: bigint('shortage_value_minor', { mode: 'number' }).notNull(),
  surplusValueMinor: bigint('surplus_value_minor', { mode: 'number' }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(), entryMode: text('entry_mode').notNull(),
  backdateReason: text('backdate_reason'),
  status: text('status').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const stockCountLines = pgTable('stock_count_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  countId: char('count_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  countedQty: bigint('counted_qty', { mode: 'number' }).notNull(),
  systemQty: bigint('system_qty', { mode: 'number' }).notNull(),
  postedSystemQty: bigint('posted_system_qty', { mode: 'number' }).notNull(),
  qtyDelta: bigint('qty_delta', { mode: 'number' }).notNull(),
  valueMinor: bigint('value_minor', { mode: 'number' }).notNull(),
  adjustmentId: char('adjustment_id', { length: 26 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

// ------------------------------------------------------------------ Phase 8
// Purchase planning (migration 0031). None of these tables posts anything —
// there is no journal entry, no lot and no operation id, because a plan is a
// decision about the future rather than a financial write (§5.9).
export const purchasePlans = pgTable('purchase_plans', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  planNumber: text('plan_number').notNull(), title: text('title'),
  lookBackDays: integer('look_back_days').notNull(), coverDays: integer('cover_days').notNull(),
  budgetMinor: bigint('budget_minor', { mode: 'number' }),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }), closedBy: char('closed_by', { length: 26 }),
  // Migration 0035: a plan is agreed or it is not, and approving is what
  // produces the supplier orders.
  status: text('status').notNull(), notes: text('notes'),
  decidedAt: timestamp('decided_at', { withTimezone: true }), decidedBy: char('decided_by', { length: 26 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

export const purchasePlanLines = pgTable('purchase_plan_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  planId: char('plan_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  supplierPartyId: char('supplier_party_id', { length: 26 }),
  suggestedQty: bigint('suggested_qty', { mode: 'number' }).notNull(),
  plannedQty: bigint('planned_qty', { mode: 'number' }).notNull(),
  priority: text('priority').notNull(),
  stockQty: bigint('stock_qty', { mode: 'number' }).notNull(),
  dailySalesQty: bigint('daily_sales_qty', { mode: 'number' }).notNull(),
  coverDays: integer('cover_days'),
  unitCostMinor: bigint('unit_cost_minor', { mode: 'number' }).notNull(),
  sellingPriceMinor: bigint('selling_price_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
});

export const supplierPurchaseOrders = pgTable('supplier_purchase_orders', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  planId: char('plan_id', { length: 26 }).notNull(),
  supplierPartyId: char('supplier_party_id', { length: 26 }).notNull(),
  orderNumber: text('order_number').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(), note: text('note'),
  // Migration 0035: Open until a bill is raised from it, then it names that bill.
  status: text('status').notNull(), purchaseId: char('purchase_id', { length: 26 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

// No cost, price, stock or profit column exists here, and none may be added:
// the supplier's copy never carries them (owner rule 2026-08-26).
export const supplierPurchaseOrderLines = pgTable('supplier_purchase_order_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  orderId: char('order_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  productName: text('product_name').notNull(), unitName: text('unit_name').notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

// Landed cost (migration 0032).
export const purchaseLandedCosts = pgTable('purchase_landed_costs', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  purchaseId: char('purchase_id', { length: 26 }).notNull(), lineNo: integer('line_no').notNull(),
  category: text('category').notNull(), method: text('method').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  inventoryShareMinor: bigint('inventory_share_minor', { mode: 'number' }).notNull(),
  cogsShareMinor: bigint('cogs_share_minor', { mode: 'number' }).notNull(),
  journalEntryId: char('journal_entry_id', { length: 26 }),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  operationId: char('operation_id', { length: 26 }),
  description: text('description'), paidAccountCode: text('paid_account_code'),
  sessionId: char('session_id', { length: 26 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

export const purchaseLandedCostAllocations = pgTable('purchase_landed_cost_allocations', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  landedCostId: char('landed_cost_id', { length: 26 }).notNull(),
  purchaseLineId: char('purchase_line_id', { length: 26 }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

// Serialised units (migration 0033). A unit is not stock: quantity and value
// stay in lots and movements, and nothing here reaches INV-01…INV-05.
export const inventoryUnits = pgTable('inventory_units', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(), serialNo: text('serial_no').notNull(),
  lotId: char('lot_id', { length: 26 }), purchaseId: char('purchase_id', { length: 26 }),
  purchaseLineId: char('purchase_line_id', { length: 26 }),
  supplierPartyId: char('supplier_party_id', { length: 26 }),
  receivedDate: date('received_date', { mode: 'string' }).notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }),
  supplierWarrantyMonths: integer('supplier_warranty_months'),
  saleId: char('sale_id', { length: 26 }), saleLineId: char('sale_line_id', { length: 26 }),
  customerPartyId: char('customer_party_id', { length: 26 }),
  soldDate: date('sold_date', { mode: 'string' }),
  customerWarrantyMonths: integer('customer_warranty_months'),
  vendorPartyId: char('vendor_party_id', { length: 26 }),
  vendorStockReceiptId: char('vendor_stock_receipt_id', { length: 26 }),
  vendorLotId: char('vendor_lot_id', { length: 26 }),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

// Warranty claims (migration 0034). No receivable is ever created here — a
// pending claim is a status, not an asset (§5.19).
export const warrantyClaims = pgTable('warranty_claims', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  claimNumber: text('claim_number').notNull(),
  customerPartyId: char('customer_party_id', { length: 26 }),
  customerName: text('customer_name').notNull(), customerPhone: text('customer_phone'),
  productId: char('product_id', { length: 26 }).notNull(),
  inventoryUnitId: char('inventory_unit_id', { length: 26 }), serialNo: text('serial_no'),
  saleId: char('sale_id', { length: 26 }), invoiceNumber: text('invoice_number'),
  purchaseId: char('purchase_id', { length: 26 }),
  supplierPartyId: char('supplier_party_id', { length: 26 }),
  customerWarrantyEnd: date('customer_warranty_end', { mode: 'string' }),
  supplierWarrantyEnd: date('supplier_warranty_end', { mode: 'string' }),
  complaint: text('complaint').notNull(),
  receivedDate: date('received_date', { mode: 'string' }).notNull(),
  handling: text('handling').notNull(), courierName: text('courier_name'),
  status: text('status').notNull(), settlementType: text('settlement_type'),
  settlementNote: text('settlement_note'),
  sentToSupplierDate: date('sent_to_supplier_date', { mode: 'string' }),
  settledDate: date('settled_date', { mode: 'string' }),
  replacementUnitId: char('replacement_unit_id', { length: 26 }),
  replacementJournalEntryId: char('replacement_journal_entry_id', { length: 26 }),
  recoveryJournalEntryId: char('recovery_journal_entry_id', { length: 26 }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: char('deleted_by', { length: 26 }),
});

// Vendor-held stock (migration 0034). Neither table posts a journal entry: the
// shop never bought these goods, and the money happens at the till (DR13.10).
export const vendorStockReceipts = pgTable('vendor_stock_receipts', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  receiptNumber: text('receipt_number').notNull(),
  vendorPartyId: char('vendor_party_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  locationId: char('location_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  vendorUnitCost: bigint('vendor_unit_cost', { mode: 'number' }).notNull(),
  lotId: char('lot_id', { length: 26 }).notNull(), movementId: char('movement_id', { length: 26 }).notNull(),
  note: text('note'), businessDate: date('business_date', { mode: 'string' }).notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

export const vendorStockReturns = pgTable('vendor_stock_returns', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  returnNumber: text('return_number').notNull(),
  receiptId: char('receipt_id', { length: 26 }).notNull(),
  vendorPartyId: char('vendor_party_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  movementId: char('movement_id', { length: 26 }).notNull(),
  note: text('note'), businessDate: date('business_date', { mode: 'string' }).notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/* ------------------------------------------- Phase 9: reporting and Daybook */

/** One typed target per month for the whole shop (§5.20, O-10). */
export const profitTargets = pgTable('profit_targets', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  month: char('month', { length: 7 }).notNull(),
  basis: text('basis').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** That a day was checked against the notebook, by whom, with a note (§5.27). */
export const daybookReviewMarks = pgTable('daybook_review_marks', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
  reviewedBy: char('reviewed_by', { length: 26 }).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** Every day-end print, with the totals it showed, so a reprint can prove itself (§5.27). */
export const daybookPrints = pgTable('daybook_prints', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  fromDate: date('from_date', { mode: 'string' }).notNull(),
  toDate: date('to_date', { mode: 'string' }).notNull(),
  format: text('format').notNull(),
  printSerial: integer('print_serial').notNull(),
  printedAt: timestamp('printed_at', { withTimezone: true }).notNull(),
  printedBy: char('printed_by', { length: 26 }).notNull(),
  openingCashMinor: bigint('opening_cash_minor', { mode: 'number' }).notNull(),
  closingCashMinor: bigint('closing_cash_minor', { mode: 'number' }).notNull(),
  transactionCount: integer('transaction_count').notNull(),
  totalsJson: jsonb('totals_json').notNull(),
  reprintOfId: char('reprint_of_id', { length: 26 }),
});

/* ------------------------------------------- Phase 11 — account reconciliation */

/** The bank's own PDF, kept whole as the evidence a reconciliation rests on (§5.17). */
export const bankStatementFiles = pgTable('bank_statement_files', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  accountId: char('account_id', { length: 26 }).notNull(),
  reconciliationId: char('reconciliation_id', { length: 26 }),
  fileName: text('file_name').notNull(),
  byteSize: integer('byte_size').notNull(),
  content: bytea('content').notNull(),
  parseStatus: text('parse_status').notNull(),
  parsedFromDate: date('parsed_from_date', { mode: 'string' }),
  parsedToDate: date('parsed_to_date', { mode: 'string' }),
  parsedOpeningMinor: bigint('parsed_opening_minor', { mode: 'number' }),
  parsedClosingMinor: bigint('parsed_closing_minor', { mode: 'number' }),
  problemsJson: jsonb('problems_json').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** That PDF parsed into rows: one signed amount, money in positive (§5.17). */
export const statementLines = pgTable('statement_lines', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  fileId: char('file_id', { length: 26 }).notNull(),
  reconciliationId: char('reconciliation_id', { length: 26 }).notNull(),
  lineNo: integer('line_no').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  description: text('description').notNull(),
  reference: text('reference'),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  balanceMinor: bigint('balance_minor', { mode: 'number' }),
  editedByUser: boolean('edited_by_user').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** The sign-off itself — the only place a reconciliation figure is stored (§5.17). */
export const accountReconciliations = pgTable('account_reconciliations', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  accountId: char('account_id', { length: 26 }).notNull(),
  fromDate: date('from_date', { mode: 'string' }).notNull(),
  toDate: date('to_date', { mode: 'string' }).notNull(),
  status: text('status').notNull(),
  statementOpeningMinor: bigint('statement_opening_minor', { mode: 'number' }),
  statementClosingMinor: bigint('statement_closing_minor', { mode: 'number' }),
  bookOpeningMinor: bigint('book_opening_minor', { mode: 'number' }),
  reconciledBalanceMinor: bigint('reconciled_balance_minor', { mode: 'number' }),
  differenceMinor: bigint('difference_minor', { mode: 'number' }),
  note: text('note'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedBy: char('completed_by', { length: 26 }),
  reopenedReason: text('reopened_reason'),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** Which of our rows is which of theirs — a link, and only ever a link (§5.17). */
export const reconciliationMatches = pgTable('reconciliation_matches', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  reconciliationId: char('reconciliation_id', { length: 26 }).notNull(),
  statementLineId: char('statement_line_id', { length: 26 }),
  journalLineId: char('journal_line_id', { length: 26 }),
  state: text('state').notNull(),
  score: integer('score'),
  reasonsJson: jsonb('reasons_json').notNull(),
  documentType: text('document_type'),
  documentId: char('document_id', { length: 26 }),
  documentVersion: integer('document_version'),
  matchedAt: timestamp('matched_at', { withTimezone: true }).notNull(),
  matchedBy: char('matched_by', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/* ------------------------------------------ Phase 8.3: the Vendor Workspace */

/**
 * Money handed to a vendor: settling the consignment payable, or paying ahead
 * of it. `intent` is stored because the ledger cannot recover it afterwards.
 */
export const vendorPayments = pgTable('vendor_payments', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  paymentNumber: text('payment_number').notNull(),
  vendorPartyId: char('vendor_party_id', { length: 26 }).notNull(),
  intent: text('intent').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  accountCode: text('account_code').notNull(),
  cashSessionId: char('cash_session_id', { length: 26 }),
  journalEntryId: char('journal_entry_id', { length: 26 }).notNull(),
  note: text('note'), businessDate: date('business_date', { mode: 'string' }).notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** An advance handed back by a vendor. Money they owe for goods is a receipt. */
export const vendorReceipts = pgTable('vendor_receipts', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  receiptNumber: text('receipt_number').notNull(),
  vendorPartyId: char('vendor_party_id', { length: 26 }).notNull(),
  intent: text('intent').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  accountCode: text('account_code').notNull(),
  cashSessionId: char('cash_session_id', { length: 26 }),
  journalEntryId: char('journal_entry_id', { length: 26 }).notNull(),
  note: text('note'), businessDate: date('business_date', { mode: 'string' }).notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** The shop's own goods in a vendor's hands. No journal entry exists for one. */
export const vendorProductIssues = pgTable('vendor_product_issues', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  issueNumber: text('issue_number').notNull(),
  vendorPartyId: char('vendor_party_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  locationId: char('location_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  returnedQty: bigint('returned_qty', { mode: 'number' }).notNull(),
  costMinor: bigint('cost_minor', { mode: 'number' }).notNull(),
  movementId: char('movement_id', { length: 26 }).notNull(),
  note: text('note'), businessDate: date('business_date', { mode: 'string' }).notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** Cost provenance: which lots the goods left from, and what is still out. */
export const vendorProductIssueLots = pgTable('vendor_product_issue_lots', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  issueId: char('issue_id', { length: 26 }).notNull(),
  lotId: char('lot_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  unitCost: bigint('unit_cost', { mode: 'number' }).notNull(),
  qtyOutstanding: bigint('qty_outstanding', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(),
});

export const vendorProductIssueReturns = pgTable('vendor_product_issue_returns', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  returnNumber: text('return_number').notNull(),
  issueId: char('issue_id', { length: 26 }).notNull(),
  qty: bigint('qty', { mode: 'number' }).notNull(),
  costMinor: bigint('cost_minor', { mode: 'number' }).notNull(),
  movementId: char('movement_id', { length: 26 }).notNull(),
  note: text('note'), businessDate: date('business_date', { mode: 'string' }).notNull(),
  operationId: char('operation_id', { length: 26 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdBy: char('created_by', { length: 26 }).notNull(), updatedBy: char('updated_by', { length: 26 }).notNull(),
  version: integer('version').notNull(),
});

/** Products received from a vendor and applied against that vendor's AR (0045). */
export const vendorProductSettlements = pgTable('vendor_product_settlements', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  settlementNumber: text('settlement_number').notNull(), operationId: char('operation_id', { length: 26 }).notNull(),
  vendorPartyId: char('vendor_party_id', { length: 26 }).notNull(), purchaseId: char('purchase_id', { length: 26 }).notNull(),
  grossProductMinor: bigint('gross_product_minor', { mode: 'number' }).notNull(),
  discountMinor: bigint('discount_minor', { mode: 'number' }).notNull(),
  netProductMinor: bigint('net_product_minor', { mode: 'number' }).notNull(),
  landedCostMinor: bigint('landed_cost_minor', { mode: 'number' }).notNull(),
  receivableBeforeMinor: bigint('receivable_before_minor', { mode: 'number' }).notNull(),
  receivableAfterMinor: bigint('receivable_after_minor', { mode: 'number' }).notNull(),
  journalEntryId: char('journal_entry_id', { length: 26 }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});

export const vendorReceivableSettlementAllocations = pgTable('vendor_receivable_settlement_allocations', {
  id: char('id', { length: 26 }).primaryKey(), tenantId: char('tenant_id', { length: 26 }).notNull(),
  settlementId: char('settlement_id', { length: 26 }).notNull(), saleId: char('sale_id', { length: 26 }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), createdBy: char('created_by', { length: 26 }).notNull(),
});
