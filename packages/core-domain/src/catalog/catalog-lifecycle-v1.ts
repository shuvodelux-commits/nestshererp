/**
 * MOD-002 P8b1: pure advisory transition decision only.
 *
 * A real status writer MUST read/lock rows under current tenant RLS, check
 * current permission and category ancestry, execute one versioned SQL CAS,
 * and commit audit/outbox in that transaction. This function alone cannot
 * authorize writes, archival, deletion or restoration.
 *
 * Active/Inactive never changes existing products, historical references,
 * source documents, quantities, prices, stock, cash or journal entries.
 */
export type CatalogLifecycleState = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type CatalogDesiredState = 'ACTIVE' | 'INACTIVE';
export type CatalogParentState = 'ROOT' | CatalogLifecycleState | 'MISSING';

interface Common {
  readonly currentState: CatalogLifecycleState;
  readonly desiredState: CatalogDesiredState;
  readonly expectedVersion: number;
  readonly currentVersion: number;
}

export type CatalogLifecycleStatusInput = Readonly<
  | (Common & { readonly kind: 'unit' | 'brand' })
  | (Common & {
    readonly kind: 'category';
    /** ROOT means this is the top-level category, not a missing parent. */
    readonly parentState: CatalogParentState;
    /** Must be counted and locked in the same future server transaction. */
    readonly activeChildCount: number;
  })
>;

export type CatalogLifecycleRefusal =
  | 'STALE_VERSION'
  | 'ARCHIVED'
  | 'ACTIVE_CHILDREN'
  | 'PARENT_NOT_ACTIVE'
  | 'INVALID_CATEGORY_CONTEXT';

export type CatalogLifecycleDecision =
  | Readonly<{ allowed: true; nextState: CatalogDesiredState; changed: boolean }>
  | Readonly<{ allowed: false; reason: CatalogLifecycleRefusal }>;

const refuse = (reason: CatalogLifecycleRefusal): CatalogLifecycleDecision =>
  Object.freeze({ allowed: false, reason });

export function decideCatalogLifecycleStatus(
  input: CatalogLifecycleStatusInput,
): CatalogLifecycleDecision {
  if (![input.expectedVersion, input.currentVersion].every(
    v => Number.isSafeInteger(v) && v > 0,
  )) {
    throw new RangeError('Catalog lifecycle versions must be positive safe integers');
  }
  if (input.expectedVersion !== input.currentVersion) return refuse('STALE_VERSION');
  if (input.currentState === 'ARCHIVED') return refuse('ARCHIVED');

  if (input.kind === 'category') {
    if (!Number.isSafeInteger(input.activeChildCount) || input.activeChildCount < 0 ||
        (input.parentState !== 'ROOT' && input.activeChildCount > 0)) {
      return refuse('INVALID_CATEGORY_CONTEXT');
    }
  }

  // The same current state/version is already confirmed: no audit/outbox
  // transition should be created. Stale no-ops still conflict above.
  if (input.currentState === input.desiredState) {
    return Object.freeze({ allowed: true, nextState: input.desiredState, changed: false });
  }

  if (input.kind === 'category') {
    if (input.desiredState === 'INACTIVE' && input.activeChildCount > 0) {
      return refuse('ACTIVE_CHILDREN');
    }
    if (input.desiredState === 'ACTIVE' &&
        input.parentState !== 'ROOT' && input.parentState !== 'ACTIVE') {
      return refuse('PARENT_NOT_ACTIVE');
    }
  }

  return Object.freeze({ allowed: true, nextState: input.desiredState, changed: true });
}
