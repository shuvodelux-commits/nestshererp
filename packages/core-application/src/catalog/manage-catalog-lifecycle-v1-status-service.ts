import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type {
  CatalogLifecycleV1DesiredState, CatalogLifecycleV1StatusRepository,
  CatalogLifecycleV1StatusResult,
} from './catalog-lifecycle-v1-status-repository';

type Kind = 'unit' | 'brand' | 'category';
type Result = CatalogLifecycleV1StatusResult |
  { outcome: 'ACTIVE_CHILDREN' | 'PARENT_NOT_ACTIVE' | 'INVALID_CATEGORY_CONTEXT' };
interface CategoryPort {
  transitionCategory(tx: Tx, ctx: TenantContext, id: string,
    expectedVersion: number, desiredState: CatalogLifecycleV1DesiredState): Promise<Result>;
}
interface Command {
  readonly ctx: TenantContext; readonly kind: Kind; readonly id: string;
  readonly expectedVersion: number; readonly desiredState: CatalogLifecycleV1DesiredState;
}
/** RED stub. All behavior is introduced only after test failure. */
export class ManageCatalogLifecycleV1StatusService {
  constructor(
    private readonly uow: UnitOfWork, private readonly access: AccessControl,
    private readonly statuses: CatalogLifecycleV1StatusRepository,
    private readonly categories: CategoryPort,
    private readonly audit: AuditWriter, private readonly outbox: Outbox,
  ) {
    void uow; void access; void statuses; void categories; void audit; void outbox;
  }
  async transition(_command: Command): Promise<Result> {
    throw new Error('P8b3-B not yet implemented');
  }
}
