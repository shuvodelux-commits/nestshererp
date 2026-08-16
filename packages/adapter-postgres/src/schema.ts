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
  entityId: char('entity_id', { length: 26 }).notNull(),
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
