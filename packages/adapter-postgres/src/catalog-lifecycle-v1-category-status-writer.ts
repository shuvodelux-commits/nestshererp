import type { TenantContext, Tx } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

type Desired = 'ACTIVE' | 'INACTIVE';
type Result =
  | { outcome: 'CHANGED' | 'UNCHANGED'; state: Desired; version: number }
  | { outcome: 'NOT_FOUND' | 'STALE_VERSION' | 'ARCHIVED' | 'VERSION_OVERFLOW' |
      'ACTIVE_CHILDREN' | 'PARENT_NOT_ACTIVE' };

/** RED stub: the category status storage writer is intentionally unimplemented. */
export class PostgresCatalogLifecycleV1CategoryStatusWriter {
  constructor(private readonly clock: Clock) {
    void clock;
  }
  async transitionCategory(
    _tx: Tx, _ctx: TenantContext, _id: string, _expectedVersion: number, _desiredState: Desired,
  ): Promise<Result> {
    return { outcome: 'NOT_FOUND' };
  }
}
