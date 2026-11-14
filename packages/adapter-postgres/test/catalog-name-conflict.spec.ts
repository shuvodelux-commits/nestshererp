import { ErrorCode } from '@sher/core-contracts';
import { describe, expect, it } from 'vitest';

import {
  rethrowCatalogNameConflict,
  type CatalogNameKind,
} from '../src/catalog-name-conflict';

const constraints: Record<CatalogNameKind, string> = {
  unit: 'units_tenant_name_unique',
  brand: 'brands_tenant_name_unique',
  category: 'categories_tenant_sibling_name_unique',
};

describe('MOD-002 PostgreSQL name collision mapping', () => {
  it('converts only exact active-master unique index violations to validation errors', () => {
    for (const kind of ['unit', 'brand', 'category'] as const) {
      const databaseError = { code: '23505', constraint: constraints[kind] };
      try {
        rethrowCatalogNameConflict(databaseError, kind);
        throw new Error('Expected error mapping to throw');
      } catch (error) {
        expect(error).toMatchObject({
          code: ErrorCode.VALIDATION_FAILED,
          message: `Another ${kind} already uses that name`,
        });
      }
    }
  });

  it('preserves unrelated PG 23505 constraints and any other SQLSTATE', () => {
    const unrelated = [
      { code: '23505', constraint: 'products_tenant_barcode_unique' },
      { code: '23505', constraint: constraints.category },
      { code: '23503', constraint: constraints.brand },
      { code: '40001', constraint: constraints.brand },
      { code: '23505' },
      null,
    ];
    for (const input of unrelated) {
      try {
        rethrowCatalogNameConflict(input, 'brand');
        throw new Error('Expected original error to escape');
      } catch (error) {
        expect(error).toBe(input);
      }
    }
  });

  it('never exposes a raw duplicate SQL error message or submitted name', () => {
    const error = {
      code: '23505',
      constraint: constraints.unit,
      detail: 'Key (tenant_id,name)=(secret, PII) already exists',
    };
    try {
      rethrowCatalogNameConflict(error, 'unit');
      throw new Error('Expected mapped error');
    } catch (mapped) {
      expect(mapped).toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
      expect((mapped as Error).message).not.toContain('PII');
      expect((mapped as Error).message).not.toContain('tenant_id');
    }
  });
});
