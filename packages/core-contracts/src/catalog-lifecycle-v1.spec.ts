import { describe, expect, it } from 'vitest';
import {
  catalogLifecycleV1StatusRequestSchema,
  catalogLifecycleV1UnitRosterEnvelopeSchema,
  catalogLifecycleV1BrandRosterEnvelopeSchema,
  catalogLifecycleV1CategoryRosterEnvelopeSchema,
} from './catalog-lifecycle-v1';

const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const parent = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const version = 3;
const common = { id, name: 'Electrical', nameBn: 'ইলেকট্রিক্যাল', version, state: 'ACTIVE', archivedAt: null };
const unit = { ...common, symbol: 'pcs' };
const brand = { ...common };
const category = { ...common, parentId: parent };

describe('MOD-002 P8b1 lifecycle-v1 opt-in wire contracts (not mounted)', () => {
  it('requires positive safe version and explicit ACTIVE/INACTIVE desired state', () => {
    expect(catalogLifecycleV1StatusRequestSchema.parse({
      expectedVersion: 1, desiredState: 'INACTIVE',
    })).toEqual({ expectedVersion: 1, desiredState: 'INACTIVE' });
    expect(catalogLifecycleV1StatusRequestSchema.parse({
      expectedVersion: Number.MAX_SAFE_INTEGER, desiredState: 'ACTIVE',
    })).toMatchObject({ desiredState: 'ACTIVE' });
  });

  it('rejects archived/deleted transitions, absent/invalid versions and extra fields', () => {
    const valid = { expectedVersion: 1, desiredState: 'INACTIVE' };
    for (const desiredState of ['ARCHIVED', 'DELETED', '', null, 0, 'inactive']) {
      expect(catalogLifecycleV1StatusRequestSchema.safeParse({ ...valid, desiredState }).success)
        .toBe(false);
    }
    for (const expectedVersion of [undefined, null, 0, -1, 1.25, '1',
      Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity]) {
      expect(catalogLifecycleV1StatusRequestSchema.safeParse({ ...valid, expectedVersion }).success)
        .toBe(false);
    }
    for (const key of ['tenantId', 'actorId', 'id', 'parentId', 'status', 'deletedAt',
      'version', 'name', 'symbol', 'price', 'replayKey']) {
      expect(catalogLifecycleV1StatusRequestSchema.safeParse({ ...valid, [key]: true }).success, key)
        .toBe(false);
    }
  });

  it('separates unit, brand and category rosters without coercion or synthetic defaults', () => {
    const cases = [
      [catalogLifecycleV1UnitRosterEnvelopeSchema, 'unit', unit],
      [catalogLifecycleV1BrandRosterEnvelopeSchema, 'brand', brand],
      [catalogLifecycleV1CategoryRosterEnvelopeSchema, 'category', category],
    ] as const;
    for (const [schema, kind, entry] of cases) {
      const payload = { data: { kind, entries: [entry] } };
      expect(schema.parse(payload)).toEqual(payload);
      expect(schema.safeParse({ data: { kind: 'wrong', entries: [entry] } }).success).toBe(false);
      expect(schema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
      expect(schema.safeParse({ data: { ...payload.data, count: 0 } }).success).toBe(false);
    }
  });

  it('requires archive timestamp only on ARCHIVED, and never equates INACTIVE with archive', () => {
    for (const [schema, kind, row] of [
      [catalogLifecycleV1UnitRosterEnvelopeSchema, 'unit', unit],
      [catalogLifecycleV1BrandRosterEnvelopeSchema, 'brand', brand],
      [catalogLifecycleV1CategoryRosterEnvelopeSchema, 'category', category],
    ] as const) {
      const wrap = (change: object) => ({ data: { kind, entries: [{ ...row, ...change }] } });
      expect(schema.safeParse(wrap({ state: 'INACTIVE', archivedAt: null })).success).toBe(true);
      expect(schema.safeParse(wrap({ state: 'ARCHIVED', archivedAt: '2026-11-14T12:00:00Z' })).success)
        .toBe(true);
      expect(schema.safeParse(wrap({ state: 'ARCHIVED', archivedAt: null })).success).toBe(false);
      expect(schema.safeParse(wrap({ state: 'ACTIVE', archivedAt: '2026-11-14T12:00:00Z' })).success)
        .toBe(false);
      expect(schema.safeParse(wrap({ state: 'DELETED' })).success).toBe(false);
    }
  });

  it('rejects invalid row identity, metadata, version and dates for every kind', () => {
    const cases = [
      [catalogLifecycleV1UnitRosterEnvelopeSchema, 'unit', unit],
      [catalogLifecycleV1BrandRosterEnvelopeSchema, 'brand', brand],
      [catalogLifecycleV1CategoryRosterEnvelopeSchema, 'category', category],
    ] as const;
    for (const [schema, kind, row] of cases) {
      const wrap = (change: object) => ({ data: { kind, entries: [{ ...row, ...change }] } });
      for (const change of [{ id: 'wrong' }, { id: 'I'.repeat(26) }, { version: 0 },
        { version: Number.MAX_SAFE_INTEGER + 1 }, { nameBn: undefined }, { nameBn: 7 },
        { archivedAt: 'not-a-date' }, { usage: 0 }, { active: true }, { unitKind: 'Base' }]) {
        expect(schema.safeParse(wrap(change)).success, JSON.stringify(change)).toBe(false);
      }
    }
  });

  it('validates kind-specific fields and parent identity without inventing classification', () => {
    expect(catalogLifecycleV1UnitRosterEnvelopeSchema.safeParse({
      data: { kind: 'unit', entries: [{ ...unit, symbol: null }] },
    }).success).toBe(true);
    expect(catalogLifecycleV1UnitRosterEnvelopeSchema.safeParse({
      data: { kind: 'unit', entries: [{ ...unit, parentId: null }] },
    }).success).toBe(false);
    expect(catalogLifecycleV1BrandRosterEnvelopeSchema.safeParse({
      data: { kind: 'brand', entries: [{ ...brand, symbol: 'pcs' }] },
    }).success).toBe(false);
    expect(catalogLifecycleV1CategoryRosterEnvelopeSchema.safeParse({
      data: { kind: 'category', entries: [{ ...category, parentId: null }] },
    }).success).toBe(true);
    expect(catalogLifecycleV1CategoryRosterEnvelopeSchema.safeParse({
      data: { kind: 'category', entries: [{ ...category, parentId: 'missing' }] },
    }).success).toBe(false);
  });

  it('allows empty explicit roster without a fabricated status or missing data', () => {
    expect(catalogLifecycleV1UnitRosterEnvelopeSchema.parse({
      data: { kind: 'unit', entries: [] },
    })).toEqual({ data: { kind: 'unit', entries: [] } });
  });
});
