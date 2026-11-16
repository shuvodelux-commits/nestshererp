import { Permission } from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type {
  CatalogLifecycleV1CategoryEntry,
  CatalogLifecycleV1Entry,
  CatalogLifecycleV1RosterRepository,
  CatalogLifecycleV1UnitEntry,
} from './catalog-lifecycle-v1-repository';

type Kind = 'unit' | 'brand' | 'category';
type Result =
  | Readonly<{ kind: 'unit'; entries: readonly CatalogLifecycleV1UnitEntry[] }>
  | Readonly<{ kind: 'brand'; entries: readonly CatalogLifecycleV1Entry[] }>
  | Readonly<{ kind: 'category'; entries: readonly CatalogLifecycleV1CategoryEntry[] }>;

/**
 * MOD-002 P8b3-A: UNMOUNTED, read-only lifecycle roster application service.
 *
 * The tenant and actor MUST come from an independently authenticated context
 * (future controller's TenantContextGuard, not a request body/query).
 * Every call rechecks the CURRENT DB role and entitlement with PRODUCT_VIEW in
 * the SAME tenant-RLS UnitOfWork as the authoritative catalog read. A stale
 * signed token granting a revoked permission cannot authorize the service.
 *
 * This is deliberately NOT a Nest provider or route; mounting, audit/outbox
 * status writes and Product Settings live cutover require separate approval.
 */
export class ReadCatalogLifecycleV1Service {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly roster: CatalogLifecycleV1RosterRepository,
  ) {}

  async read(ctx: TenantContext, kind: Kind): Promise<Result> {
    // Fail closed on malformed dispatches, including non-TypeScript callers.
    if (kind !== 'unit' && kind !== 'brand' && kind !== 'category') {
      throw new RangeError('Unsupported catalog lifecycle roster kind');
    }

    return this.uow.run(ctx, async tx => {
      await this.access.require(tx, ctx, Permission.PRODUCT_VIEW);

      switch (kind) {
        case 'unit':
          return { kind, entries: await this.roster.listUnits(tx, ctx) };
        case 'brand':
          return { kind, entries: await this.roster.listBrands(tx, ctx) };
        case 'category':
          return { kind, entries: await this.roster.listCategories(tx, ctx) };
      }
    });
  }
}
