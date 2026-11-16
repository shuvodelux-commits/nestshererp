import type { AppError } from '@sher/core-contracts';

export type LifecycleKind = 'unit' | 'brand' | 'category';
export type LifecycleStatusOutcome =
  | Readonly<{ outcome: 'CHANGED' | 'UNCHANGED'; state: 'ACTIVE' | 'INACTIVE'; version: number }>
  | Readonly<{ outcome: 'NOT_FOUND' | 'STALE_VERSION' | 'ARCHIVED' |
      'VERSION_OVERFLOW' | 'ACTIVE_CHILDREN' | 'PARENT_NOT_ACTIVE' |
      'INVALID_CATEGORY_CONTEXT' }>;

export function mapCatalogLifecycleV1Status(
  _kind: LifecycleKind, _id: string, _result: LifecycleStatusOutcome,
): { data: { kind: LifecycleKind; id: string; outcome: 'CHANGED' | 'UNCHANGED';
  state: 'ACTIVE' | 'INACTIVE'; version: number } } {
  void (null as unknown as AppError);
  throw new Error('P8b3-T0 not implemented');
}
