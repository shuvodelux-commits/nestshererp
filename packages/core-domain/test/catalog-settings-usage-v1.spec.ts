import { describe, expect, it } from 'vitest';
import {
  computeCatalogSettingsUsageV1,
  type CatalogSettingsUsageInput,
} from '../src/catalog/catalog-settings-usage-v1';

const SHOP_A = '01SHOPAAAAAAAAAAAAAAAAAAAAA';
const SHOP_B = '01SHOPBBBBBBBBBBBBBBBBBBBBB';

const base: CatalogSettingsUsageInput = {
  tenantId: SHOP_A,
  units: [
    { id: 'FEET', tenantId: SHOP_A },
    { id: 'PIPE', tenantId: SHOP_A },
    { id: 'BOX', tenantId: SHOP_A },
    { id: 'UNUSED', tenantId: SHOP_A, deletedAt: 'archived' },
  ],
  brands: [
    { id: 'ACME', tenantId: SHOP_A },
    { id: 'UNUSED_BRAND', tenantId: SHOP_A },
  ],
  categories: [
    { id: 'ELECTRICAL', tenantId: SHOP_A, parentId: null },
    { id: 'CABLE', tenantId: SHOP_A, parentId: 'ELECTRICAL' },
    { id: 'PAINT', tenantId: SHOP_A, parentId: null },
  ],
  products: [],
  conversions: [],
};

type Product = CatalogSettingsUsageInput['products'][number];
const product = (id: string, changes: Partial<Product> = {}): Product => ({
  id, tenantId: SHOP_A, deletedAt: null, status: 'ACTIVE',
  baseUnitId: 'FEET', conversionUnitId: null,
  brandId: 'ACME', categoryId: 'CABLE', ...changes,
});

describe('MOD-002 P7a — Product Settings reference census (pure; NOT server counts)', () => {
  it('reports explicit zero for known unused masters, but never invents an ID', () => {
    const output = computeCatalogSettingsUsageV1(base);
    expect(output.units).toEqual([
      { id: 'FEET', productCount: 0 },
      { id: 'PIPE', productCount: 0 },
      { id: 'BOX', productCount: 0 },
      { id: 'UNUSED', productCount: 0 },
    ]);
    expect(output.brands).toEqual([
      { id: 'ACME', productCount: 0 },
      { id: 'UNUSED_BRAND', productCount: 0 },
    ]);
    expect(output.categories).toEqual([
      { id: 'ELECTRICAL', directProductCount: 0, subtreeProductCount: 0, parentState: 'root' },
      { id: 'CABLE', directProductCount: 0, subtreeProductCount: 0, parentState: 'present' },
      { id: 'PAINT', directProductCount: 0, subtreeProductCount: 0, parentState: 'root' },
    ]);
    expect(output.unresolved).toEqual({
      unitIds: [], brandIds: [], categoryIds: [], parentIds: [],
    });
  });

  it('includes inactive but non-deleted products in all reference counts', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base, products: [product('P1', { status: 'INACTIVE' })],
    });
    expect(output.units.find(x => x.id === 'FEET')?.productCount).toBe(1);
    expect(output.brands.find(x => x.id === 'ACME')?.productCount).toBe(1);
    expect(output.categories.find(x => x.id === 'CABLE')).toMatchObject({
      directProductCount: 1, subtreeProductCount: 1,
    });
    expect(output.categories.find(x => x.id === 'ELECTRICAL')).toMatchObject({
      directProductCount: 0, subtreeProductCount: 1,
    });
  });

  it('counts a product once for each unit across base, legacy and multi-unit rows', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base,
      products: [product('P1', { conversionUnitId: 'PIPE' })],
      conversions: [
        { tenantId: SHOP_A, productId: 'P1', unitId: 'FEET', deletedAt: null },
        { tenantId: SHOP_A, productId: 'P1', unitId: 'PIPE', deletedAt: null },
        { tenantId: SHOP_A, productId: 'P1', unitId: 'PIPE', deletedAt: null },
        { tenantId: SHOP_A, productId: 'P1', unitId: 'BOX', deletedAt: null },
      ],
    });
    expect(output.units.map(x => x.productCount)).toEqual([1, 1, 1, 0]);
  });

  it('counts each distinct product and separates direct vs descendant-inclusive category use', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base,
      products: [
        product('P1'),
        product('P2', { categoryId: 'ELECTRICAL', baseUnitId: 'PIPE' }),
        product('P3', { categoryId: 'PAINT', brandId: null }),
      ],
    });
    expect(output.units.find(x => x.id === 'FEET')?.productCount).toBe(2);
    expect(output.units.find(x => x.id === 'PIPE')?.productCount).toBe(1);
    expect(output.brands.find(x => x.id === 'ACME')?.productCount).toBe(2);
    expect(output.categories.find(x => x.id === 'ELECTRICAL')).toMatchObject({
      directProductCount: 1, subtreeProductCount: 2,
    });
    expect(output.categories.find(x => x.id === 'CABLE')).toMatchObject({
      directProductCount: 1, subtreeProductCount: 1,
    });
    expect(output.categories.find(x => x.id === 'PAINT')).toMatchObject({
      directProductCount: 1, subtreeProductCount: 1,
    });
  });

  it('excludes soft-deleted products and soft-deleted conversion links', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base,
      products: [
        product('DELETED', { deletedAt: 'removed', conversionUnitId: 'PIPE' }),
        product('P1'),
      ],
      conversions: [
        { tenantId: SHOP_A, productId: 'P1', unitId: 'BOX', deletedAt: 'removed' },
        { tenantId: SHOP_A, productId: 'DELETED', unitId: 'PIPE', deletedAt: null },
      ],
    });
    expect(output.units.map(x => x.productCount)).toEqual([1, 0, 0, 0]);
    expect(output.brands.find(x => x.id === 'ACME')?.productCount).toBe(1);
  });

  it('does not count foreign tenant masters, products or conversion links', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base,
      units: [...base.units, { id: 'FOREIGN_ONLY', tenantId: SHOP_B }],
      products: [
        product('P1'),
        product('FOREIGN_P', { tenantId: SHOP_B, baseUnitId: 'PIPE' }),
      ],
      conversions: [
        { tenantId: SHOP_B, productId: 'P1', unitId: 'BOX', deletedAt: null },
        { tenantId: SHOP_A, productId: 'FOREIGN_P', unitId: 'PIPE', deletedAt: null },
      ],
    });
    expect(output.units.map(x => x.id)).not.toContain('FOREIGN_ONLY');
    expect(output.units.map(x => x.productCount)).toEqual([1, 0, 0, 0]);
  });

  it('preserves archived master references without representing them as active', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base,
      products: [product('P1', { baseUnitId: 'UNUSED' })],
    });
    expect(output.units.find(x => x.id === 'UNUSED')?.productCount).toBe(1);
  });

  it('reports missing master references explicitly instead of silently claiming a complete census', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base,
      products: [product('P1', { baseUnitId: 'MISSING_U', brandId: 'MISSING_B', categoryId: 'MISSING_C' })],
      conversions: [
        { tenantId: SHOP_A, productId: 'P1', unitId: 'MISSING_CONVERSION_U', deletedAt: null },
      ],
    });
    expect(output.unresolved).toEqual({
      unitIds: ['MISSING_CONVERSION_U', 'MISSING_U'],
      brandIds: ['MISSING_B'],
      categoryIds: ['MISSING_C'],
      parentIds: [],
    });
    expect(output.units.every(x => x.productCount === 0)).toBe(true);
  });

  it('exposes missing category parents without synthesizing parent rows or counts', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base,
      categories: [
        ...base.categories, { id: 'ORPHAN', tenantId: SHOP_A, parentId: 'MISSING_PARENT' },
      ],
      products: [product('P1', { categoryId: 'ORPHAN' })],
    });
    expect(output.categories.find(x => x.id === 'ORPHAN')).toEqual({
      id: 'ORPHAN', directProductCount: 1, subtreeProductCount: 1, parentState: 'unresolved',
    });
    expect(output.unresolved.parentIds).toEqual(['MISSING_PARENT']);
  });

  it('rejects category cycles and unsupported third-level data instead of guessing totals', () => {
    for (const categories of [
      [
        { id: 'A', tenantId: SHOP_A, parentId: 'B' },
        { id: 'B', tenantId: SHOP_A, parentId: 'A' },
      ],
      [
        { id: 'A', tenantId: SHOP_A, parentId: null },
        { id: 'B', tenantId: SHOP_A, parentId: 'A' },
        { id: 'C', tenantId: SHOP_A, parentId: 'B' },
      ],
    ]) {
      expect(() => computeCatalogSettingsUsageV1({ ...base, categories })).toThrow();
    }
  });

  it('ignores orphan conversion rows unless a current tenant non-deleted product exists', () => {
    const output = computeCatalogSettingsUsageV1({
      ...base,
      conversions: [
        { tenantId: SHOP_A, productId: 'UNKNOWN', unitId: 'PIPE', deletedAt: null },
        { tenantId: SHOP_B, productId: 'UNKNOWN', unitId: 'PIPE', deletedAt: null },
      ],
    });
    expect(output.units.find(x => x.id === 'PIPE')?.productCount).toBe(0);
    expect(output.unresolved.unitIds).toEqual([]);
  });
});
