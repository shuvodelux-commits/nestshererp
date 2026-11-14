import { describe, expect, it } from 'vitest';
import {
  decideCatalogLifecycleStatus,
  type CatalogLifecycleStatusInput,
} from '../src/catalog/catalog-lifecycle-v1';

const base = {
  kind: 'unit' as const,
  currentState: 'ACTIVE' as const,
  desiredState: 'INACTIVE' as const,
  expectedVersion: 3,
  currentVersion: 3,
};
const root = {
  ...base,
  kind: 'category' as const,
  parentState: 'ROOT' as const,
  activeChildCount: 0,
};
const decide = (changes: Partial<CatalogLifecycleStatusInput>) =>
  decideCatalogLifecycleStatus({ ...base, ...changes } as CatalogLifecycleStatusInput);

describe('MOD-002 P8b1 pure lifecycle policy (not a write authorization)', () => {
  it('allows unit and brand deactivation/reactivation without touching product state', () => {
    expect(decideCatalogLifecycleStatus(base)).toEqual({
      allowed: true, nextState: 'INACTIVE', changed: true,
    });
    expect(decide({ kind: 'brand', currentState: 'INACTIVE', desiredState: 'ACTIVE' }))
      .toEqual({ allowed: true, nextState: 'ACTIVE', changed: true });
  });

  it('returns authoritative no-op for same state at matching version; stale always wins', () => {
    expect(decide({ desiredState: 'ACTIVE' }))
      .toEqual({ allowed: true, nextState: 'ACTIVE', changed: false });
    expect(decide({ expectedVersion: 2, desiredState: 'ACTIVE' }))
      .toEqual({ allowed: false, reason: 'STALE_VERSION' });
  });

  it('never uses catalog status mutation to unarchive or delete an archived master', () => {
    expect(decide({ currentState: 'ARCHIVED', desiredState: 'ACTIVE' }))
      .toEqual({ allowed: false, reason: 'ARCHIVED' });
    expect(decide({ currentState: 'ARCHIVED', desiredState: 'INACTIVE' }))
      .toEqual({ allowed: false, reason: 'ARCHIVED' });
  });

  it('rejects invalid/unsafe version numbers before any transition', () => {
    for (const bad of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => decide({ expectedVersion: bad })).toThrow(RangeError);
      expect(() => decide({ currentVersion: bad })).toThrow(RangeError);
    }
  });

  it('allows root category status changes with no active children', () => {
    expect(decideCatalogLifecycleStatus(root))
      .toEqual({ allowed: true, nextState: 'INACTIVE', changed: true });
    expect(decideCatalogLifecycleStatus({
      ...root, currentState: 'INACTIVE', desiredState: 'ACTIVE',
    })).toEqual({ allowed: true, nextState: 'ACTIVE', changed: true });
  });

  it('refuses deactivating a parent while active descendants exist, with no cascade', () => {
    expect(decideCatalogLifecycleStatus({ ...root, activeChildCount: 1 }))
      .toEqual({ allowed: false, reason: 'ACTIVE_CHILDREN' });
    expect(decideCatalogLifecycleStatus({ ...root, activeChildCount: 50 }))
      .toEqual({ allowed: false, reason: 'ACTIVE_CHILDREN' });
  });

  it('activates child category only when parent is active, rejecting missing or archived parent', () => {
    for (const parentState of ['INACTIVE', 'ARCHIVED', 'MISSING'] as const) {
      expect(decideCatalogLifecycleStatus({
        ...root, currentState: 'INACTIVE', desiredState: 'ACTIVE', parentState,
      })).toEqual({ allowed: false, reason: 'PARENT_NOT_ACTIVE' });
    }
    expect(decideCatalogLifecycleStatus({
      ...root, currentState: 'INACTIVE', desiredState: 'ACTIVE', parentState: 'ACTIVE',
    })).toEqual({ allowed: true, nextState: 'ACTIVE', changed: true });
  });

  it('can deactivate a child even when its parent is inactive; no parent status mutation', () => {
    expect(decideCatalogLifecycleStatus({ ...root, parentState: 'INACTIVE' }))
      .toEqual({ allowed: true, nextState: 'INACTIVE', changed: true });
  });

  it('fails closed on malformed category snapshot and does not mutate caller inputs', () => {
    const snapshot = Object.freeze({ ...root, activeChildCount: 0 });
    expect(decideCatalogLifecycleStatus(snapshot).allowed).toBe(true);
    expect(snapshot).toEqual(root);
    expect(decideCatalogLifecycleStatus({ ...root, activeChildCount: -1 }))
      .toEqual({ allowed: false, reason: 'INVALID_CATEGORY_CONTEXT' });
    expect(decideCatalogLifecycleStatus({ ...root, activeChildCount: 1.5 }))
      .toEqual({ allowed: false, reason: 'INVALID_CATEGORY_CONTEXT' });
  });

  it('does not infer category/tenant permissions, deletion safety, product counts or cash effects', () => {
    // Pure decision only: callers must use live permissions, RLS and locked PG CAS.
    const result = decideCatalogLifecycleStatus(root);
    expect(Object.keys(result).sort()).toEqual(['allowed', 'changed', 'nextState']);
  });
});
