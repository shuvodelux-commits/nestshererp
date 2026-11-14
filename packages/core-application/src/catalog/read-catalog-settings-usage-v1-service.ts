import { Permission } from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type {
  CatalogSettingsUsageV1Repository,
  CatalogSettingsUsageV1Snapshot,
} from './catalog-settings-usage-v1-repository';

/**
 * MOD-002 P7b2: signed read-only Product Settings usage contract.
 * Access control MUST be checked from the current DB role in the SAME
 * transaction as the RLS-protected census. This protects non-HTTP callers,
 * revoked roles, tenant switches, and future batch jobs as well as HTTP.
 */
export class ReadCatalogSettingsUsageV1Service {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly catalog: CatalogSettingsUsageV1Repository,
  ) {}

  async read(ctx: TenantContext): Promise<CatalogSettingsUsageV1Snapshot> {
    return this.uow.run(ctx, async tx => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_VIEW);
      return this.catalog.read(tx, ctx);
    });
  }
}
