import type {
  BusinessProfile,
  BusinessProfileRepository,
  SettingsRepository,
  StoredSetting,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import { SettingKey } from '@sher/core-contracts';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';

import { auditEvents, settings, tenants } from './schema';
import { txOf } from './unit-of-work';

/**
 * Tenant settings rows (§5.21, migration 0005). No business rule here (R-B6) —
 * which values are legal and what a change cascades to is decided in the use
 * case before anything reaches this file.
 */
export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly clock: Clock) {}

  async lockTenant(
    tx: Tx,
    ctx: TenantContext,
  ): ReturnType<SettingsRepository['lockTenant']> {
    const [row] = await txOf(tx)
      .select({ timezone: tenants.timezone, createdAt: tenants.createdAt, version: tenants.version })
      .from(tenants)
      .where(and(eq(tenants.id, ctx.tenantId), isNull(tenants.deletedAt)))
      .for('update');
    return row ?? null;
  }

  async cashSessionHistory(
    tx: Tx,
    ctx: TenantContext,
  ): ReturnType<SettingsRepository['cashSessionHistory']> {
    const [stored] = await txOf(tx)
      .select({
        key: settings.settingKey, value: settings.value, version: settings.version,
        createdAt: settings.createdAt, updatedAt: settings.updatedAt, deletedAt: settings.deletedAt,
      })
      .from(settings)
      .where(and(
        eq(settings.tenantId, ctx.tenantId),
        eq(settings.settingKey, SettingKey.CASH_SESSION_ENABLED),
      ));
    const events = await txOf(tx)
      .select({
        entityType: auditEvents.entityType, action: auditEvents.action,
        occurredAt: auditEvents.createdAt, before: auditEvents.beforeJson, after: auditEvents.afterJson,
      })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, ctx.tenantId), or(
        and(eq(auditEvents.entityType, 'setting'), eq(auditEvents.entityId, SettingKey.CASH_SESSION_ENABLED)),
        and(eq(auditEvents.entityType, 'tenant'), eq(auditEvents.entityId, ctx.tenantId), eq(auditEvents.action, 'UPDATE')),
      )))
      .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
    return { stored: stored ?? null, events };
  }

  async listStored(tx: Tx, ctx: TenantContext): Promise<readonly StoredSetting[]> {
    const rows = await txOf(tx)
      .select({
        key: settings.settingKey,
        value: settings.value,
        version: settings.version,
      })
      .from(settings)
      .where(and(eq(settings.tenantId, ctx.tenantId), isNull(settings.deletedAt)));

    return rows;
  }

  async findByKey(tx: Tx, ctx: TenantContext, key: string): Promise<StoredSetting | null> {
    const rows = await txOf(tx)
      .select({
        key: settings.settingKey,
        value: settings.value,
        version: settings.version,
      })
      .from(settings)
      .where(
        and(
          eq(settings.tenantId, ctx.tenantId),
          eq(settings.settingKey, key),
          isNull(settings.deletedAt),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Insert-or-update in one statement, keyed on the unique `(tenant_id,
   * setting_key)`.
   *
   * Read-then-branch would let two concurrent saves of the same key both see no
   * row, both insert, and one fail on the constraint with a 500 instead of a
   * saved value. `version` counts changes for the optimistic lock the Class A
   * column set exists for.
   */
  async put(tx: Tx, ctx: TenantContext, key: string, value: string): Promise<void> {
    const now = this.clock.now();

    await txOf(tx)
      .insert(settings)
      .values({
        id: Ulid.generate(this.clock),
        tenantId: ctx.tenantId,
        settingKey: key,
        value,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      })
      .onConflictDoUpdate({
        target: [settings.tenantId, settings.settingKey],
        set: {
          value,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${settings.version} + 1`,
        },
      });
  }
}

/** The business name and timezone on the tenant's own row (§5.2, §3.5). */
export class PostgresBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly clock: Clock) {}

  async findProfile(tx: Tx, ctx: TenantContext): Promise<BusinessProfile | null> {
    const rows = await txOf(tx)
      .select({ businessName: tenants.name, timezone: tenants.timezone })
      .from(tenants)
      .where(and(eq(tenants.id, ctx.tenantId), isNull(tenants.deletedAt)))
      .limit(1);

    return rows[0] ?? null;
  }

  async updateProfile(tx: Tx, ctx: TenantContext, profile: BusinessProfile): Promise<void> {
    await txOf(tx)
      .update(tenants)
      .set({
        name: profile.businessName,
        timezone: profile.timezone,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${tenants.version} + 1`,
      })
      .where(and(eq(tenants.id, ctx.tenantId), isNull(tenants.deletedAt)));
  }
}
