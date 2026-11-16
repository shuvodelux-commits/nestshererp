import { AppError, ErrorCode } from '@sher/core-contracts';

export type LifecycleKind = 'unit' | 'brand' | 'category';
type DesiredState = 'ACTIVE' | 'INACTIVE';
export type LifecycleStatusOutcome =
  | Readonly<{ outcome: 'CHANGED' | 'UNCHANGED'; state: DesiredState; version: number }>
  | Readonly<{ outcome: 'NOT_FOUND' | 'STALE_VERSION' | 'ARCHIVED' |
      'VERSION_OVERFLOW' | 'ACTIVE_CHILDREN' | 'PARENT_NOT_ACTIVE' |
      'INVALID_CATEGORY_CONTEXT' }>;

interface LifecycleStatusReceipt {
  readonly data: Readonly<{
    kind: LifecycleKind;
    id: string;
    outcome: 'CHANGED' | 'UNCHANGED';
    state: DesiredState;
    version: number;
  }>;
}

/**
 * MOD-002 P8b3-T0 / #330 — UNMOUNTED HTTP outcome contract mapper.
 *
 * This is NOT an endpoint and does NOT read a tenant or check a permission:
 * a future controller must obtain a signed TenantContext via TenantContextGuard
 * and call the already-authorized Class-M service first. This only maps that
 * service's authoritative outcome, never reissues a write or swallows a denial.
 *
 * Existing global AppErrorFilter owns { error: { code,message,details,traceId }}.
 * The shared ErrorCode vocabulary is closed, so every 409 retains the precise
 * business refusal in details.reason. The future client must inspect the
 * reason rather than assuming every 409 is a version race.
 */
export function mapCatalogLifecycleV1Status(
  kind: LifecycleKind, id: string, result: LifecycleStatusOutcome,
): LifecycleStatusReceipt {
  if (kind !== 'unit' && kind !== 'brand' && kind !== 'category') {
    throw new RangeError('Unsupported catalog lifecycle kind');
  }

  if (result.outcome === 'CHANGED' || result.outcome === 'UNCHANGED') {
    if ((result.state !== 'ACTIVE' && result.state !== 'INACTIVE') ||
        !Number.isSafeInteger(result.version) || result.version < 1 ||
        typeof id !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(id)) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Invalid lifecycle result');
    }
    return { data: {
      kind, id, outcome: result.outcome, state: result.state, version: result.version,
    } };
  }

  switch (result.outcome) {
    case 'NOT_FOUND':
      throw new AppError(ErrorCode.NOT_FOUND, 'Catalog entry was not found',
        { reason: 'NOT_FOUND' });
    case 'STALE_VERSION':
      throw conflict('STALE_VERSION', 'Catalog entry has changed; refresh before retrying');
    case 'ARCHIVED':
      throw conflict('ARCHIVED', 'Archived catalog entries cannot change status');
    case 'VERSION_OVERFLOW':
      throw conflict('VERSION_OVERFLOW', 'Catalog version limit has been reached');
    case 'ACTIVE_CHILDREN':
      throw conflict('ACTIVE_CHILDREN', 'Deactivate active subcategories first');
    case 'PARENT_NOT_ACTIVE':
      throw conflict('PARENT_NOT_ACTIVE', 'Parent category is not active');
    case 'INVALID_CATEGORY_CONTEXT':
      throw conflict('INVALID_CATEGORY_CONTEXT', 'Catalog hierarchy is invalid');
    default:
      // Fail closed for runtime values arriving outside the declared contract.
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Unsupported lifecycle result');
  }
}

function conflict(reason: string, message: string): AppError {
  return new AppError(ErrorCode.CONFLICT_STALE_VERSION, message, { reason });
}
