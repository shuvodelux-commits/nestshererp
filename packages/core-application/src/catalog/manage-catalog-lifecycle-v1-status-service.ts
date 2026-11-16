import { AppError, catalogLifecycleV1StatusRequestSchema, ErrorCode, Permission } from '@sher/core-contracts';

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
  Readonly<{ outcome: 'ACTIVE_CHILDREN' | 'PARENT_NOT_ACTIVE' | 'INVALID_CATEGORY_CONTEXT' }>;
interface CategoryPort {
  transitionCategory(tx: Tx, ctx: TenantContext, id: string,
    expectedVersion: number, desiredState: CatalogLifecycleV1DesiredState): Promise<Result>;
}
export interface CatalogLifecycleV1StatusCommand {
  readonly ctx: TenantContext;
  readonly kind: Kind;
  readonly id: string;
  readonly expectedVersion: number;
  readonly desiredState: CatalogLifecycleV1DesiredState;
}
const permissionFor = {
  unit: Permission.UNIT_MANAGE,
  brand: Permission.BRAND_MANAGE,
  category: Permission.CATEGORY_MANAGE,
} as const;

/**
 * MOD-002 P8b3-B / #324: UNMOUNTED Class-M lifecycle status use case.
 *
 * Requires authenticated TenantContext from its future caller; no route, DI
 * provider or UI action is authorized by the existence of this service.
 * The authoritative CURRENT DB role permission, parent/child CAS, one audit
 * and one outbox all share a single tenant-RLS UnitOfWork. If either event
 * writer fails, the status update and any earlier event are rolled back.
 *
 * Existing P8b2 writers own row locks and exact version/state arbitration.
 * The returned typed refusals are NOT successful status changes and must be
 * mapped by a separately approved transport layer without hiding conflicts.
 */
export class ManageCatalogLifecycleV1StatusService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly statuses: CatalogLifecycleV1StatusRepository,
    private readonly categories: CategoryPort,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async transition(command: CatalogLifecycleV1StatusCommand): Promise<Result> {
    const { ctx, kind, id } = command;
    if (kind !== 'unit' && kind !== 'brand' && kind !== 'category') {
      throw new RangeError('Unsupported catalog lifecycle status kind');
    }
    const parsed = catalogLifecycleV1StatusRequestSchema.safeParse({
      expectedVersion: command.expectedVersion,
      desiredState: command.desiredState,
    });
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED,
        'Invalid catalog lifecycle status request');
    }
    if (typeof id !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(id)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid catalog entry ID');
    }
    const { expectedVersion, desiredState } = parsed.data;

    return this.uow.run(ctx, async tx => {
      await this.access.require(tx, ctx, permissionFor[kind]);

      const result = kind === 'unit'
        ? await this.statuses.transitionUnit(tx, ctx, id, expectedVersion, desiredState)
        : kind === 'brand'
          ? await this.statuses.transitionBrand(tx, ctx, id, expectedVersion, desiredState)
          : await this.categories.transitionCategory(tx, ctx, id, expectedVersion, desiredState);

      if (result.outcome !== 'CHANGED') return result;
      // The CAS result must prove exactly one versioned transition. A broken
      // adapter cannot become an authoritative audit/outbox snapshot.
      if (result.version !== expectedVersion + 1 || result.state !== desiredState) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Invalid catalog lifecycle status CAS result');
      }

      // CHANGED means the prior state was precisely the opposite, because
      // ACTIVE/INACTIVE is a two-state toggle independent of ARCHIVED.
      const previousState = desiredState === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
      await this.audit.append(tx, ctx, {
        entityType: kind, entityId: id, action: 'UPDATE',
        before: { state: previousState, version: expectedVersion },
        after: { state: desiredState, version: result.version },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: kind + '.updated', aggregateType: kind,
        aggregateId: id,
        payload: {
          change: 'status', fromState: previousState, state: desiredState,
          previousVersion: expectedVersion, version: result.version,
        },
      });
      return result;
    });
  }
}
