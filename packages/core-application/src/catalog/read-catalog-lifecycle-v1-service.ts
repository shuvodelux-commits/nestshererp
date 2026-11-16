import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { CatalogLifecycleV1RosterRepository } from './catalog-lifecycle-v1-repository';

type Kind = 'unit' | 'brand' | 'category';

/** P8b3-A RED stub; implementation follows passing all authorization tests. */
export class ReadCatalogLifecycleV1Service {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly roster: CatalogLifecycleV1RosterRepository,
  ) {
    void this.uow; void this.access; void this.roster;
  }
  async read(_ctx: TenantContext, _kind: Kind): Promise<never> {
    throw new Error('P8b3-A not yet implemented');
  }
}
