import { describe, expect, it } from 'vitest';
import {
  AppError, ErrorCode, Permission,
  type CatalogMetadataV1Brand, type CatalogMetadataV1Category, type CatalogMetadataV1Unit,
} from '@sher/core-contracts';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter, AuditEvent } from '../ports/audit-writer';
import type { Outbox, OutboxRecord } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { SettingsRepository } from '../settings/settings-repository';
import type { CatalogMetadataV1Repository } from './catalog-metadata-v1-repository';
import type { CatalogMetadataV1FullEditRepository } from './catalog-metadata-v1-full-edit-repository';
import { EditCatalogMetadataV1Service } from './edit-catalog-metadata-v1-service';

const id = {
  tenant: '01ARZ3NDEKTSV4RRFFQ69G5F00', other: '01ARZ3NDEKTSV4RRFFQ69G5F01',
  user: '01ARZ3NDEKTSV4RRFFQ69G5F02',
  unit: '01ARZ3NDEKTSV4RRFFQ69G5F03', unit2: '01ARZ3NDEKTSV4RRFFQ69G5F04',
  brand: '01ARZ3NDEKTSV4RRFFQ69G5F05', brand2: '01ARZ3NDEKTSV4RRFFQ69G5F06',
  root: '01ARZ3NDEKTSV4RRFFQ69G5F07', root2: '01ARZ3NDEKTSV4RRFFQ69G5F08',
  category: '01ARZ3NDEKTSV4RRFFQ69G5F09', sibling: '01ARZ3NDEKTSV4RRFFQ69G5F10',
  otherChild: '01ARZ3NDEKTSV4RRFFQ69G5F11',
};
const ctx: TenantContext = { tenantId: id.tenant, userId: id.user, timezone: 'Asia/Dhaka' };
type Kind = 'unit' | 'brand' | 'category';
type Row = CatalogMetadataV1Unit | CatalogMetadataV1Brand | CatalogMetadataV1Category;
type State = { units: CatalogMetadataV1Unit[]; brands: CatalogMetadataV1Brand[]; categories: CatalogMetadataV1Category[] };
const cases = [
  { kind: 'unit', id: id.unit, version: 4, permission: Permission.UNIT_MANAGE },
  { kind: 'brand', id: id.brand, version: 2, permission: Permission.BRAND_MANAGE },
  { kind: 'category', id: id.category, version: 3, permission: Permission.CATEGORY_MANAGE },
] as const;
function seed(): State {
  return {
    units: [
      { id: id.unit, name: 'Gauge', nameBn: 'গেজ', symbol: 'Gg', version: 4 },
      { id: id.unit2, name: 'Box', nameBn: null, symbol: null, version: 1 },
    ],
    brands: [
      { id: id.brand, name: 'RFL', nameBn: 'আরএফএল', version: 2 },
      { id: id.brand2, name: 'Acme', nameBn: null, version: 1 },
    ],
    categories: [
      { id: id.root, parentId: null, name: 'Electrical', nameBn: null, version: 1 },
      { id: id.root2, parentId: null, name: 'Plumbing', nameBn: null, version: 1 },
      { id: id.category, parentId: id.root, name: 'Wire', nameBn: 'তার', version: 3 },
      { id: id.sibling, parentId: id.root, name: 'Switch', nameBn: null, version: 1 },
      { id: id.otherChild, parentId: id.root2, name: 'Valve', nameBn: null, version: 1 },
    ],
  };
}
function harness() {
  let committed = seed();
  let staged = structuredClone(committed);
  const audits: AuditEvent[] = [];
  const messages: OutboxRecord[] = [];
  let pendingAudit: AuditEvent[] = [];
  let pendingOutbox: OutboxRecord[] = [];
  const calls = { uow: 0, cas: 0, legacy: 0 };
  let denied: string | null = null;
  let casLost = false;
  let failure: 'audit' | 'outbox' | null = null;
  let corrupt: ((r: Row) => Row) | null = null;
  const uow = {
    async run<T>(_context: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
      calls.uow++;
      staged = structuredClone(committed);
      pendingAudit = []; pendingOutbox = [];
      const result = await fn({} as Tx);
      committed = staged;
      audits.push(...pendingAudit);
      messages.push(...pendingOutbox);
      return result;
    },
    async runWithoutTenant<T>(): Promise<T> { throw new Error('no tenantless transaction'); },
  } as UnitOfWork;
  const access = {
    require: async (_tx: Tx, context: TenantContext, permission: string) => {
      if (context.tenantId !== id.tenant || denied === permission)
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'denied');
    },
  } as AccessControl;
  const visible = <K extends keyof State>(kind: K, context: TenantContext): State[K] =>
    context.tenantId === id.tenant ? staged[kind] : ([] as unknown as State[K]);
  const catalog = {
    listUnits: async (_tx: Tx, c: TenantContext) => visible('units', c),
    listBrands: async (_tx: Tx, c: TenantContext) => visible('brands', c),
    listCategories: async (_tx: Tx, c: TenantContext) => visible('categories', c),
    findUnit: async (_tx: Tx, c: TenantContext, key: string) => visible('units', c).find(x => x.id === key) ?? null,
    findBrand: async (_tx: Tx, c: TenantContext, key: string) => visible('brands', c).find(x => x.id === key) ?? null,
    findCategory: async (_tx: Tx, c: TenantContext, key: string) => visible('categories', c).find(x => x.id === key) ?? null,
    compareAndSetUnit: async () => { calls.legacy++; throw new Error('legacy write'); },
    compareAndSetBrand: async () => { calls.legacy++; throw new Error('legacy write'); },
    compareAndSetCategory: async () => { calls.legacy++; throw new Error('legacy write'); },
  } as CatalogMetadataV1Repository;
  const cas = (kind: keyof State, c: TenantContext, key: string, version: number,
    edit: { name: string; nameBn?: string | null; symbol?: string | null }): Row | null => {
    calls.cas++;
    const values = visible(kind, c) as Row[];
    const pos = values.findIndex(x => x.id === key);
    if (casLost || pos < 0 || values[pos]?.version !== version) return null;
    const updated = { ...values[pos], ...edit, version: version + 1 } as Row;
    values[pos] = updated;
    return corrupt ? corrupt(updated) : updated;
  };
  const fullEdit = {
    compareAndSetUnit: async (_tx: Tx, c: TenantContext, key: string, ver: number, edit: { name: string; nameBn?: string | null; symbol?: string | null }) =>
      cas('units', c, key, ver, edit) as CatalogMetadataV1Unit | null,
    compareAndSetBrand: async (_tx: Tx, c: TenantContext, key: string, ver: number, edit: { name: string; nameBn?: string | null }) =>
      cas('brands', c, key, ver, edit) as CatalogMetadataV1Brand | null,
    compareAndSetCategory: async (_tx: Tx, c: TenantContext, key: string, ver: number, edit: { name: string; nameBn?: string | null }) =>
      cas('categories', c, key, ver, edit) as CatalogMetadataV1Category | null,
  } as CatalogMetadataV1FullEditRepository;
  const audit = { append: async (_tx: Tx, _ctx: TenantContext, e: AuditEvent) => {
    if (failure === 'audit') throw new Error('injected audit failure');
    pendingAudit.push(structuredClone(e));
  } } as AuditWriter;
  const outbox = { append: async (_tx: Tx, _ctx: TenantContext, e: OutboxRecord) => {
    if (failure === 'outbox') throw new Error('injected outbox failure');
    pendingOutbox.push(structuredClone(e));
  } } as Outbox;
  const settings = { listStored: async () => [] } as unknown as SettingsRepository;
  const service = new EditCatalogMetadataV1Service(uow, access, catalog, fullEdit, settings, audit, outbox);
  return {
    service, calls, audits, messages, ctx, state: () => committed,
    deny: (role: string) => { denied = role; },
    loseCas: () => { casLost = true; },
    fail: (where: 'audit' | 'outbox') => { failure = where; },
    tamper: (fn: (r: Row) => Row) => { corrupt = fn; },
  };
}
type H = ReturnType<typeof harness>;
function edit(h: H, kind: Kind, key: string, input: unknown, context = ctx) {
  const command = { ctx: context, id: key, input };
  if (kind === 'unit') return h.service.editUnit(command);
  if (kind === 'brand') return h.service.editBrand(command);
  return h.service.editCategory(command);
}

describe('MOD-002 P6b: atomic EN+BN edit application seam', () => {
  it.each(cases)('$kind: one CAS, audit, outbox and authoritative versioned projection', async c => {
    const h = harness();
    const result = await edit(h, c.kind, c.id, { expectedVersion: c.version, name: '  New   Name ', nameBn: ' নতুন  নাম ' });
    const rows = c.kind === 'unit' ? result.units : c.kind === 'brand' ? result.brands : result.categories;
    expect(rows.find(r => r.id === c.id)).toMatchObject({ name: 'New Name', nameBn: 'নতুন নাম', version: c.version + 1 });
    expect(h.calls).toEqual({ uow: 1, cas: 1, legacy: 0 });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      entityType: c.kind, entityId: c.id, action: 'UPDATE', source: 'API',
      before: { name: expect.any(String) }, after: { name: 'New Name', nameBn: 'নতুন নাম' },
    });
    expect(h.messages).toEqual([expect.objectContaining({
      eventType: c.kind + '.updated', aggregateId: c.id,
      payload: expect.objectContaining({ name: 'New Name', nameBn: 'নতুন নাম', version: c.version + 1 }),
    })]);
  });
  it('unit preserves omitted Bengali/symbol and clears only explicit null', async () => {
    const h = harness();
    await edit(h, 'unit', id.unit, { expectedVersion: 4, name: 'Gauge New' });
    expect(h.state().units[0]).toMatchObject({ nameBn: 'গেজ', symbol: 'Gg', version: 5 });
    await edit(h, 'unit', id.unit, { expectedVersion: 5, name: 'Gauge New', nameBn: null, symbol: null });
    expect(h.state().units[0]).toMatchObject({ nameBn: null, symbol: null, version: 6 });
  });
  it('unit normalizes NFC and symbol within the same edit', async () => {
    const h = harness();
    await edit(h, 'unit', id.unit, { expectedVersion: 4, name: ' Gauge ', nameBn: ' গে\u099c ', symbol: ' e\u0301 ' });
    expect(h.state().units[0]).toMatchObject({ name: 'Gauge', nameBn: 'গেজ', symbol: 'é', version: 5 });
  });
  it.each(cases)('$kind: unchanged canonical name plus metadata is legal', async c => {
    const h = harness();
    const name = c.kind === 'unit' ? ' Gauge ' : c.kind === 'brand' ? ' RFL ' : ' Wire ';
    await edit(h, c.kind, c.id, { expectedVersion: c.version, name, nameBn: null });
    expect(h.calls.cas).toBe(1);
  });
  it.each(cases)('$kind: missing/foreign or archived ID is hidden as 404', async c => {
    const h = harness();
    await expect(edit(h, c.kind, id.other, { expectedVersion: c.version, name: 'X' }))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(h.calls.cas).toBe(0);
    expect(h.audits).toHaveLength(0);
  });
  it.each(cases)('$kind: revocation enforced inside UoW', async c => {
    const h = harness();
    h.deny(c.permission);
    await expect(edit(h, c.kind, c.id, { expectedVersion: c.version, name: 'X' }))
      .rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(h.calls.cas).toBe(0);
  });
  it.each(cases)('$kind: stale preflight and CAS loser are 409 with zero effects', async c => {
    const h = harness();
    await expect(edit(h, c.kind, c.id, { expectedVersion: c.version - 1, name: 'X' }))
      .rejects.toMatchObject({ code: ErrorCode.CONFLICT_STALE_VERSION });
    h.loseCas();
    await expect(edit(h, c.kind, c.id, { expectedVersion: c.version, name: 'X' }))
      .rejects.toMatchObject({ code: ErrorCode.CONFLICT_STALE_VERSION });
    expect(h.audits).toHaveLength(0);
    expect(h.messages).toHaveLength(0);
  });
  it.each(cases)('$kind: case-insensitive duplicate in same tenant/sibling is 400', async c => {
    const h = harness();
    const name = c.kind === 'unit' ? ' bOx ' : c.kind === 'brand' ? ' ACME ' : ' SWITCH ';
    await expect(edit(h, c.kind, c.id, { expectedVersion: c.version, name }))
      .rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    expect(h.calls.cas).toBe(0);
  });
  it('category allows equal names in other parent but does not reparent', async () => {
    const h = harness();
    await edit(h, 'category', id.category, { expectedVersion: 3, name: 'Valve' });
    expect(h.state().categories.find(x => x.id === id.category)).toMatchObject({ parentId: id.root, name: 'Valve' });
  });
  it.each(cases)('$kind: strict invalid fields reject before transaction', async c => {
    const h = harness();
    for (const input of [
      { expectedVersion: c.version, name: '' },
      { expectedVersion: 0, name: 'X' },
      { expectedVersion: c.version, name: 'X', tenantId: id.other },
      { expectedVersion: c.version, name: 'X', parentId: id.root2 },
      { expectedVersion: c.version, name: 'X', active: false },
    ]) {
      await expect(edit(h, c.kind, c.id, input)).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    }
    expect(h.calls.uow).toBe(0);
  });
  it.each(cases)('$kind: forged adapter return fails closed and transaction rolls back', async c => {
    for (const makeBad of [
      (r: Row) => ({ ...r, id: id.other }),
      (r: Row) => ({ ...r, name: 'Forged' }),
      (r: Row) => ({ ...r, version: r.version + 1 }),
      (r: Row) => 'parentId' in r ? { ...r, parentId: id.root2 } : { ...r, nameBn: 'forged' },
    ]) {
      const h = harness();
      const before = structuredClone(h.state());
      h.tamper(makeBad);
      await expect(edit(h, c.kind, c.id, { expectedVersion: c.version, name: 'Updated' }))
        .rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
      expect(h.state()).toEqual(before);
      expect(h.messages).toHaveLength(0);
    }
  });
  it.each(cases)('$kind: audit and outbox failures rollback master and effects', async c => {
    for (const where of ['audit', 'outbox'] as const) {
      const h = harness();
      const before = structuredClone(h.state());
      h.fail(where);
      await expect(edit(h, c.kind, c.id, { expectedVersion: c.version, name: 'Updated' }))
        .rejects.toThrow(/injected/);
      expect(h.state()).toEqual(before);
      expect(h.audits).toHaveLength(0);
      expect(h.messages).toHaveLength(0);
    }
  });
  it('foreign tenant cannot read/write another tenant master', async () => {
    const h = harness();
    await expect(edit(h, 'unit', id.unit, { expectedVersion: 4, name: 'Updated' }, { ...ctx, tenantId: id.other }))
      .rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(h.state()).toEqual(seed());
  });
  it('brand edit does not reuse metadata-only legacy writer', async () => {
    const h = harness();
    await edit(h, 'brand', id.brand, { expectedVersion: 2, name: 'Brand New' });
    expect(h.calls.legacy).toBe(0);
  });
});
