import { describe, expect, it } from 'vitest';

import {
  catalogMetadataNameBnSchema,
  catalogMetadataUnitSymbolSchema,
  createCatalogMetadataV1BrandRequestSchema,
  createCatalogMetadataV1CategoryRequestSchema,
  createCatalogMetadataV1UnitRequestSchema,
  editCatalogMetadataV1BrandRequestSchema,
  editCatalogMetadataV1CategoryRequestSchema,
  editCatalogMetadataV1UnitRequestSchema,
  patchCatalogMetadataV1BrandRequestSchema,
  patchCatalogMetadataV1CategoryRequestSchema,
  patchCatalogMetadataV1UnitRequestSchema,
} from './catalog-metadata-v1';
import { renameCategoryRequestSchema } from './catalog';

type EditSchema = { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
const cases: ReadonlyArray<[string, EditSchema]> = [
  ['unit', editCatalogMetadataV1UnitRequestSchema],
  ['brand', editCatalogMetadataV1BrandRequestSchema],
  ['category', editCatalogMetadataV1CategoryRequestSchema],
];

describe('MOD-002 P6a: strict atomic full-English-and-Bengali catalog edit contracts', () => {
  it.each(cases)('%s requires both stable expectedVersion and canonical English name', (_kind, schema) => {
    expect(schema.safeParse({ expectedVersion: 1, name: '  Electrical  ' })).toMatchObject({
      success: true,
      data: { expectedVersion: 1, name: 'Electrical' },
    });
    expect(schema.safeParse({ expectedVersion: Number.MAX_SAFE_INTEGER, name: 'N'.repeat(120) }).success)
      .toBe(true);
  });

  it('units normalize NFC Bengali whitespace and the optional unit symbol in the same request', () => {
    const result = editCatalogMetadataV1UnitRequestSchema.parse({
      expectedVersion: 3,
      name: '  Gauge  ',
      nameBn: '  গে\u099c  \n  একক  ',
      symbol: '  Gg  ',
    });
    expect(result).toEqual({ expectedVersion: 3, name: 'Gauge', nameBn: 'গেজ একক', symbol: 'Gg' });
  });

  it('brands and categories normalize Bengali text without changing category parent', () => {
    const body = { expectedVersion: 8, name: '  Wire  ', nameBn: '  তার\t একক  ' };
    expect(editCatalogMetadataV1BrandRequestSchema.parse(body))
      .toEqual({ expectedVersion: 8, name: 'Wire', nameBn: 'তার একক' });
    expect(editCatalogMetadataV1CategoryRequestSchema.parse(body))
      .toEqual({ expectedVersion: 8, name: 'Wire', nameBn: 'তার একক' });
  });

  it.each(cases)('%s preserves omitted Bengali metadata and clears only explicit null', (_kind, schema) => {
    expect(schema.safeParse({ expectedVersion: 1, name: 'Wire' })).toEqual({
      success: true, data: { expectedVersion: 1, name: 'Wire' },
    });
    expect(schema.safeParse({ expectedVersion: 1, name: 'Wire', nameBn: null })).toEqual({
      success: true, data: { expectedVersion: 1, name: 'Wire', nameBn: null },
    });
  });

  it('units distinguish omitted symbol from explicit null and normalize combining sequences', () => {
    const base = { expectedVersion: 1, name: 'Piece' };
    expect(editCatalogMetadataV1UnitRequestSchema.parse(base)).toEqual(base);
    expect(editCatalogMetadataV1UnitRequestSchema.parse({ ...base, symbol: null }))
      .toEqual({ ...base, symbol: null });
    expect(editCatalogMetadataV1UnitRequestSchema.parse({
      ...base,
      nameBn: '  cafe\u0301  ',
      symbol: '  e\u0301  ',
    })).toEqual({ ...base, nameBn: 'café', symbol: 'é' });
  });

  it.each(cases)('%s rejects invalid English names without coercion', (_kind, schema) => {
    for (const name of [undefined, null, '', '    ', '\n\t', 'Z'.repeat(121), 42, ['Wire']]) {
      expect(schema.safeParse({ expectedVersion: 1, name }).success, JSON.stringify(name))
        .toBe(false);
    }
    expect(schema.safeParse({ expectedVersion: 1, name: 'X'.repeat(120) }).success).toBe(true);
  });

  it.each(cases)('%s rejects missing, invalid, unsafe or fractional versions', (_kind, schema) => {
    for (const expectedVersion of [
      undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1,
      Number.NaN, Number.POSITIVE_INFINITY, '1', true, {},
    ]) {
      expect(schema.safeParse({ expectedVersion, name: 'Wire' }).success, String(expectedVersion))
        .toBe(false);
    }
  });

  it.each(cases)('%s rejects empty, whitespace, oversized and non-string Bengali metadata', (_kind, schema) => {
    for (const nameBn of [
      '', '  ', '\n\t', 'আ'.repeat(121), 12, [], {},
    ]) {
      expect(schema.safeParse({ expectedVersion: 1, name: 'Wire', nameBn }).success, String(nameBn))
        .toBe(false);
    }
    expect(schema.safeParse({ expectedVersion: 1, name: 'Wire', nameBn: 'আ'.repeat(120) }).success)
      .toBe(true);
  });

  it('unit symbol validates 1–4 non-whitespace Unicode code points', () => {
    const base = { expectedVersion: 1, name: 'Gauge' };
    for (const symbol of ['', ' ', '\t', 'a b', 'abcdE', 'ঙ'.repeat(5), 100, [], {}]) {
      expect(editCatalogMetadataV1UnitRequestSchema.safeParse({ ...base, symbol }).success,
        String(symbol)).toBe(false);
    }
    for (const symbol of ['a', 'abcd', 'ঙঙ', 'é', null]) {
      expect(editCatalogMetadataV1UnitRequestSchema.safeParse({ ...base, symbol }).success,
        String(symbol)).toBe(true);
    }
  });

  it.each(cases)('%s rejects unknown properties, identity injection and category moves', (_kind, schema) => {
    const base = { expectedVersion: 1, name: 'Wire' };
    const injection: ReadonlyArray<[string, unknown]> = [
      ['id', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      ['tenantId', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      ['actorId', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      ['createdBy', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      ['version', 1],
      ['parentId', null],
      ['active', false],
      ['conversionFactor', 12],
      ['basePrice', 100],
      ['arbitrary', 'value'],
    ];
    for (const [key, value] of injection) {
      expect(schema.safeParse({ ...base, [key]: value }).success, key).toBe(false);
    }
  });

  it('brand/category reject unit-only symbols; unit rejects category parent', () => {
    const body = { expectedVersion: 1, name: 'Wire' };
    expect(editCatalogMetadataV1BrandRequestSchema.safeParse({ ...body, symbol: 'P' }).success)
      .toBe(false);
    expect(editCatalogMetadataV1CategoryRequestSchema.safeParse({ ...body, symbol: 'P' }).success)
      .toBe(false);
    expect(editCatalogMetadataV1UnitRequestSchema.safeParse({ ...body, parentId: null }).success)
      .toBe(false);
  });

  it('reuses existing Bengali metadata and symbol normalization unchanged', () => {
    const bangla = '  গে\u099c  \t একক ';
    const symbol = ' e\u0301 ';
    const parsed = editCatalogMetadataV1UnitRequestSchema.parse({
      expectedVersion: 4, name: ' Gauge ', nameBn: bangla, symbol,
    });
    expect(parsed.nameBn).toBe(catalogMetadataNameBnSchema.parse(bangla));
    expect(parsed.symbol).toBe(catalogMetadataUnitSymbolSchema.parse(symbol));
  });

  it('retains old metadata-only PATCH semantics and does not permit English rename', () => {
    const metadata = { expectedVersion: 2, nameBn: 'তার' };
    expect(patchCatalogMetadataV1UnitRequestSchema.safeParse(metadata).success).toBe(true);
    expect(patchCatalogMetadataV1BrandRequestSchema.safeParse(metadata).success).toBe(true);
    expect(patchCatalogMetadataV1CategoryRequestSchema.safeParse(metadata).success).toBe(true);
    for (const schema of [
      patchCatalogMetadataV1UnitRequestSchema,
      patchCatalogMetadataV1BrandRequestSchema,
      patchCatalogMetadataV1CategoryRequestSchema,
    ]) {
      expect(schema.safeParse({ ...metadata, name: 'Wire' }).success).toBe(false);
    }
    expect(patchCatalogMetadataV1UnitRequestSchema.safeParse({
      expectedVersion: 2, symbol: null,
    }).success).toBe(true);
  });

  it('retains CREATE and legacy category rename request contracts unchanged', () => {
    expect(createCatalogMetadataV1UnitRequestSchema.parse({ name: 'Gauge' }))
      .toEqual({ name: 'Gauge' });
    expect(createCatalogMetadataV1BrandRequestSchema.parse({ name: 'RFL', nameBn: null }))
      .toEqual({ name: 'RFL', nameBn: null });
    expect(createCatalogMetadataV1CategoryRequestSchema.parse({
      name: 'Wire', parentId: null,
    })).toEqual({ name: 'Wire', parentId: null });
    expect(renameCategoryRequestSchema.safeParse({ name: 'Wire', nameBn: 'তার' }).success)
      .toBe(false);
  });
});
