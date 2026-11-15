import { describe, expect, it } from 'vitest';

import {
  partyV2CreateRequestSchema,
  partyV2MutationReceiptEnvelopeSchema,
} from '../src/party-v2-write';

/**
 * MOD-004 SEC-N02A (#306): contract-only TDD for a future, unmounted
 * selected-role V2 Party directory writer.
 * No API routes, journal, cash session, idempotency persistence or DB writes.
 */
const partyId = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const customer = () => ({
  selectedRole: 'CUSTOMER',
  name: '  নাম ও দোকান  ',
  roles: ['CUSTOMER'],
  phone: '01712345678',
  address: null,
  guardianName: null,
  nid: null,
  email: null,
  notes: null,
  customerGroupId: null,
  creditLimitMinor: null,
});
const receipt = () => ({
  data: { id: partyId, version: 1, selectedRole: 'CUSTOMER', status: 'ACTIVE' },
});

describe('MOD-004 SEC-N02A strict V2 Party directory-only creation request', () => {
  it('requires one explicit selected trading role and preserves bilingual names', () => {
    const parsed = partyV2CreateRequestSchema.safeParse(customer());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.selectedRole).toBe('CUSTOMER');
    expect(parsed.data.name).toBe('নাম ও দোকান');
    expect(parsed.data.roles).toEqual(['CUSTOMER']);
    expect('opening' in parsed.data).toBe(false);
  });

  it('permits a shared Customer + Supplier identity with one explicitly selected role', () => {
    const parsed = partyV2CreateRequestSchema.safeParse({
      ...customer(),
      selectedRole: 'SUPPLIER',
      roles: ['CUSTOMER', 'SUPPLIER'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.selectedRole).toBe('SUPPLIER');
  });

  it.each(['All', 'OWNER', 'LENDER', 'BORROWER', 'PAYEE', null, undefined])(
    'rejects unsupported or absent selected role %s', (selectedRole) => {
      expect(partyV2CreateRequestSchema.safeParse({ ...customer(), selectedRole }).success)
        .toBe(false);
    },
  );

  it('rejects a selected trading role not included among requested relationships', () => {
    expect(partyV2CreateRequestSchema.safeParse({
      ...customer(), selectedRole: 'SUPPLIER',
    }).success).toBe(false);
  });

  it('refuses duplicate relationships and bypasses through extra roles', () => {
    for (const roles of [
      ['CUSTOMER', 'CUSTOMER'],
      ['CUSTOMER', 'PAYEE'],
      ['CUSTOMER', 'All'],
      [],
      ['CUSTOMER', 'SUPPLIER', 'VENDOR', 'OWNER'],
    ]) {
      expect(partyV2CreateRequestSchema.safeParse({ ...customer(), roles }).success).toBe(false);
    }
  });

  it('refuses historical opening in directory creation, including a null opening', () => {
    for (const opening of [null, {
      role: 'CUSTOMER', direction: 'RECEIVABLE',
      amountMinor: 10000, businessDate: '2026-11-15',
    }]) {
      expect(partyV2CreateRequestSchema.safeParse({ ...customer(), opening }).success)
        .toBe(false);
    }
  });

  it('refuses unexpected finance or history input rather than silently dropping it', () => {
    for (const property of ['balance', 'hasLedgerEntries', 'globalHistory', 'partyId', 'loanId']) {
      expect(partyV2CreateRequestSchema.safeParse({
        ...customer(), [property]: property === 'balance' ? {} : 'injected',
      }).success).toBe(false);
    }
  });

  it('preserves existing name, phone, and money validation from the common Party schema', () => {
    for (const invalid of [
      { name: '  ' },
      { phone: 1712345678 },
      { creditLimitMinor: -1 },
      { creditLimitMinor: 3.14 },
      { customerGroupId: 'other-tenant-short-id' },
    ]) {
      expect(partyV2CreateRequestSchema.safeParse({ ...customer(), ...invalid }).success)
        .toBe(false);
    }
  });
});

describe('MOD-004 SEC-N02A strict minimal V2 Party mutation receipt', () => {
  it('accepts exactly the non-sensitive identifier/version/selectedRole/status envelope', () => {
    const parsed = partyV2MutationReceiptEnvelopeSchema.safeParse(receipt());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data.data).sort()).toEqual([
      'id', 'selectedRole', 'status', 'version',
    ]);
    expect(parsed.data.data).toEqual(receipt().data);
  });

  it('refuses sensitive fields, balances, roles and history, even for an otherwise valid response', () => {
    for (const key of [
      'name', 'phone', 'address', 'guardianName', 'nid', 'email', 'notes',
      'roles', 'balance', 'hasLedgerEntries', 'globalHistory', 'profile',
      'customerGroupId', 'creditLimitMinor', 'opening',
    ]) {
      expect(partyV2MutationReceiptEnvelopeSchema.safeParse({
        data: { ...receipt().data, [key]: 'unauthorized' },
      }).success).toBe(false);
    }
  });

  it('rejects incorrect IDs, versions, status and non-trading selected roles', () => {
    for (const bad of [
      { id: 'short' }, { version: 0 }, { version: -1 }, { version: 1.5 },
      { selectedRole: 'LENDER' }, { selectedRole: 'All' }, { status: 'DELETED' },
    ]) {
      expect(partyV2MutationReceiptEnvelopeSchema.safeParse({
        data: { ...receipt().data, ...bad },
      }).success).toBe(false);
    }
  });

  it('refuses missing data, empty envelopes, and extra top-level fields', () => {
    for (const bad of [{}, { data: null }, { data: receipt().data, meta: {} }]) {
      expect(partyV2MutationReceiptEnvelopeSchema.safeParse(bad).success).toBe(false);
    }
  });
});
