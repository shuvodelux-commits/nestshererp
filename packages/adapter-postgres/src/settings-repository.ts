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
import { and, eq, isNull, sql } from 'drizzle-orm';

import { settings, tenants } from './schema';
import { txOf } from './unit-of-work';

/**
 * Tenant settings rows (§5.21, migration 0005). No business rule here (R-B6) —
 * which values are legal and what a change cascades to is decided in the use
 * case before anything reaches this file.
 */
export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly clock: Clock) {}

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
