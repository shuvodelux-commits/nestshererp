import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** One stored setting. Absent keys are the shipped default, not a row. */
export interface StoredSetting {
  readonly key: string;
  readonly value: string;
  readonly version: number;
}

/**
 * Tenant settings (§5.21).
 *
 * No business rule lives here (R-B6): whether a value is allowed, whether a
 * parent feature is on, and what turning one off cascades to are all decided in
 * the use case. This reads and writes rows.
 */
export interface SettingsRepository {
  /** Every value this tenant has changed. Never the defaults — those are not rows. */
  listStored(tx: Tx, ctx: TenantContext): Promise<readonly StoredSetting[]>;
  findByKey(tx: Tx, ctx: TenantContext, key: string): Promise<StoredSetting | null>;
  /**
   * Writes the value, creating the row the first time the tenant changes it.
   *
   * One statement rather than read-then-branch: two people saving the same
   * setting at the same moment would otherwise both find no row and both
   * insert, and one of them would lose to the unique constraint with a 500
   * rather than a saved value.
   */
  put(tx: Tx, ctx: TenantContext, key: string, value: string): Promise<void>;
}

/** The tenant's own profile row (§5.2): the name and timezone on `tenants`. */
export interface BusinessProfile {
  readonly businessName: string;
  readonly timezone: string;
}

export interface BusinessProfileRepository {
  findProfile(tx: Tx, ctx: TenantContext): Promise<BusinessProfile | null>;
  updateProfile(tx: Tx, ctx: TenantContext, profile: BusinessProfile): Promise<void>;
}
