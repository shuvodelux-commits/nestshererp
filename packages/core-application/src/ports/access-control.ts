import type { TenantContext } from './tenant-context';
import type { Tx } from './unit-of-work';

/**
 * Permission enforcement (§5.26: Plan → Feature → Setting → Permission → Access).
 *
 * The check runs HERE, inside the use case, not only in an HTTP guard: MCP,
 * background jobs and future offline writes bypass guards entirely (R-D2).
 * V1 evaluates the permission step; the plan/feature/setting steps arrive with
 * entitlements in Phase 10 and settings in Phase 1.
 */
export interface AccessControl {
  /** Throws AppError(PERMISSION_DENIED) when the user's role lacks the code. */
  require(tx: Tx, ctx: TenantContext, permissionCode: string): Promise<void>;
}
