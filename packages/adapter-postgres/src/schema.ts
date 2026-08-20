import {
  bigint,
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
