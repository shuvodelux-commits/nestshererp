import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Authenticated Product Settings reference census.
 * No client-supplied tenant, no stock quantities or artificial status flags.
 * An unresolved reference signals incomplete historical catalog relations.
 */
export interface CatalogSettingsUsageV1Snapshot {
  readonly units: readonly { readonly id: string; readonly productCount: number }[];
  readonly brands: readonly { readonly id: string; readonly productCount: number }[];
  readonly categories: readonly {
    readonly id: string;
    readonly directProductCount: number;
    readonly subtreeProductCount: number;
    readonly parentState: 'root' | 'present' | 'unresolved';
  }[];
  readonly unresolved: {
    readonly unitIds: readonly string[];
    readonly brandIds: readonly string[];
    readonly categoryIds: readonly string[];
    readonly parentIds: readonly string[];
  };
}

/** Must be called inside UoW's tenant-local RLS transaction. */
export interface CatalogSettingsUsageV1Repository {
  read(tx: Tx, ctx: TenantContext): Promise<CatalogSettingsUsageV1Snapshot>;
}
