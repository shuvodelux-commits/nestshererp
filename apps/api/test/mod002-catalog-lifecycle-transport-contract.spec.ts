/**
 * MOD-002 P8b3-T0: pure HTTP response mapping contract for unmounted lifecycle API.
 * No controller/DI/route is registered here; permission and RLS are separate use cases.
 */
import { AppError, ErrorCode, httpStatusFor } from '@sher/core-contracts';
import { describe, expect, it } from 'vitest';
import { mapCatalogLifecycleV1Status } from '../src/catalog/catalog-lifecycle-v1-status-response';

const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
type Kind = 'unit' | 'brand' | 'category';
const kinds: readonly Kind[] = ['unit', 'brand', 'category'];

describe('MOD-002 P8b3-T0 lifecycle-v1 unmounted HTTP outcome contract', () => {
  it.each(kinds)('%s returns 200 data receipt for a real CHANGED transition', kind => {
    expect(mapCatalogLifecycleV1Status(kind, id, {
      outcome: 'CHANGED', state: 'INACTIVE', version: 2,
    })).toEqual({
      data: { kind, id, outcome: 'CHANGED', state: 'INACTIVE', version: 2 },
    });
  });

  it.each(kinds)('%s returns an unchanged receipt for exact-version no-op without implying a write', kind => {
    expect(mapCatalogLifecycleV1Status(kind, id, {
      outcome: 'UNCHANGED', state: 'ACTIVE', version: 7,
    })).toEqual({
      data: { kind, id, outcome: 'UNCHANGED', state: 'ACTIVE', version: 7 },
    });
  });

  const cases = [
    ['NOT_FOUND', ErrorCode.NOT_FOUND, 404],
    ['STALE_VERSION', ErrorCode.CONFLICT_STALE_VERSION, 409],
    ['ARCHIVED', ErrorCode.CONFLICT_STALE_VERSION, 409],
    ['VERSION_OVERFLOW', ErrorCode.CONFLICT_STALE_VERSION, 409],
    ['ACTIVE_CHILDREN', ErrorCode.CONFLICT_STALE_VERSION, 409],
    ['PARENT_NOT_ACTIVE', ErrorCode.CONFLICT_STALE_VERSION, 409],
    ['INVALID_CATEGORY_CONTEXT', ErrorCode.CONFLICT_STALE_VERSION, 409],
  ] as const;
  it.each(cases)('%s is a genuine HTTP refusal (%s/%d), preserving its typed reason', (
    outcome, code, status,
  ) => {
    let failure: unknown;
    try {
      mapCatalogLifecycleV1Status('category', id, { outcome });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    const appError = failure as AppError;
    expect(appError.code).toBe(code);
    expect(httpStatusFor(appError.code)).toBe(status);
    expect(appError.details).toEqual({ reason: outcome });
    expect(appError.message).not.toContain(id);
    expect(appError.message).not.toContain('বাংলা');
    expect(appError.message.length).toBeGreaterThan(0);
  });

  it('missing and foreign identifiers are indistinguishable (404), with no existence leak', () => {
    for (const identifyingId of [id, '01ARZ3NDEKTSV4RRFFQ69G5FAW']) {
      try {
        mapCatalogLifecycleV1Status('unit', identifyingId, { outcome: 'NOT_FOUND' });
        throw new Error('unexpected success');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        const appError = error as AppError;
        expect(appError.code).toBe(ErrorCode.NOT_FOUND);
        expect(appError.message).toBe('Catalog entry was not found');
        expect(appError.details).toEqual({ reason: 'NOT_FOUND' });
      }
    }
  });

  it('refuses stale lost-ack replay and never maps it to UNCHANGED', () => {
    expect(() => mapCatalogLifecycleV1Status('brand', id, {
      outcome: 'STALE_VERSION',
    })).toThrow(AppError);
    expect(() => mapCatalogLifecycleV1Status('brand', id, {
      outcome: 'STALE_VERSION',
    })).toThrow('changed');
  });

  it('fails closed on unrecognized outcomes and does not return HTTP success', () => {
    expect(() => mapCatalogLifecycleV1Status('unit', id,
      { outcome: 'WRONG' } as never)).toThrow(AppError);
    try {
      mapCatalogLifecycleV1Status('unit', id, { outcome: 'WRONG' } as never);
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(httpStatusFor((error as AppError).code)).toBe(500);
    }
  });

  it('rejects an invalid kind rather than constructing an apparently valid receipt', () => {
    expect(() => mapCatalogLifecycleV1Status('other' as Kind, id, {
      outcome: 'CHANGED', state: 'ACTIVE', version: 2,
    })).toThrow(RangeError);
  });

  it('rejects malformed success snapshots before constructing the response envelope', () => {
    expect(() => mapCatalogLifecycleV1Status('unit', id, {
      outcome: 'CHANGED', state: 'ACTIVE', version: 0,
    })).toThrow(AppError);
    expect(() => mapCatalogLifecycleV1Status('unit', id, {
      outcome: 'UNCHANGED', state: 'INVALID', version: 4,
    } as never)).toThrow(AppError);
  });
});
