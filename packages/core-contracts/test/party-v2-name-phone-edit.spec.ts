import { describe, expect, it } from 'vitest';

import {
  partyV2NamePhoneEditRequestSchema,
  partyV2MutationReceiptEnvelopeSchema,
} from '../src/party-v2-write';

/**
 * MOD-004 SEC-N02C (#311) contract-only RED: this does not authorize
 * PATCH transport, identity-wide status, finance, or private profile editing.
 */
const request = () => ({
  selectedRole: 'CUSTOMER',
  version: 2,
  name: '  নতুন দোকানের নাম  ',
  phone: ' 01712345678 ',
});
const receipt = () => ({
  data: {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
    version: 3,
    selectedRole: 'CUSTOMER',
    status: 'ACTIVE',
  },
});

describe('MOD-004 SEC-N02C strict selected-role Party directory edit contract', () => {
  it('accepts bilingual name and phone with the common Party schema trimming rules', () => {
    const parsed = partyV2NamePhoneEditRequestSchema.safeParse(request());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({
      selectedRole: 'CUSTOMER',
      version: 2,
      name: 'নতুন দোকানের নাম',
      phone: '01712345678',
    });
  });

  it('permits selected Supplier and Vendor editing the two shared directory fields', () => {
    for (const selectedRole of ['SUPPLIER', 'VENDOR']) {
      const parsed = partyV2NamePhoneEditRequestSchema.safeParse({
        ...request(), selectedRole, phone: null,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.selectedRole).toBe(selectedRole);
        expect(parsed.data.phone).toBeNull();
      }
    }
  });

  it.each(['All', 'OWNER', 'LENDER', 'BORROWER', 'PAYEE', '', null, undefined])(
    'rejects absent or unsupported selected relationship %s', selectedRole => {
      expect(partyV2NamePhoneEditRequestSchema.safeParse({
        ...request(), selectedRole,
      }).success).toBe(false);
    },
  );

  it('requires explicit, positive, safe optimistic version and does not coerce strings', () => {
    for (const version of [
      undefined, null, '2', 0, -1, 1.5,
      Number.MAX_SAFE_INTEGER + 1, Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(partyV2NamePhoneEditRequestSchema.safeParse({
        ...request(), version,
      }).success).toBe(false);
    }
    expect(partyV2NamePhoneEditRequestSchema.safeParse({
      ...request(), version: Number.MAX_SAFE_INTEGER,
    }).success).toBe(true);
  });

  it('inherits existing name and phone boundaries without inventing identity rules', () => {
    for (const bad of [
      { name: '' }, { name: '   ' },
      { name: 'x'.repeat(201) },
      { name: null }, { name: 42 },
      { phone: 17777777777 }, { phone: 'x'.repeat(31) },
    ]) {
      expect(partyV2NamePhoneEditRequestSchema.safeParse({
        ...request(), ...bad,
      }).success).toBe(false);
    }
    expect(partyV2NamePhoneEditRequestSchema.safeParse({
      ...request(), name: 'x'.repeat(200), phone: 'x'.repeat(30),
    }).success).toBe(true);
  });

  it('rejects missing required fields, rather than silently leaving unknown values', () => {
    for (const key of ['selectedRole', 'version', 'name', 'phone']) {
      const incomplete: Record<string, unknown> = { ...request() };
      delete incomplete[key];
      expect(partyV2NamePhoneEditRequestSchema.safeParse(incomplete).success).toBe(false);
    }
  });

  it('refuses role mutations, opening, status, private data and cash/finance fields', () => {
    for (const key of [
      'roles', 'opening', 'address', 'guardianName', 'nid', 'email',
      'notes', 'customerGroupId', 'creditLimitMinor', 'balance',
      'hasLedgerEntries', 'globalHistory', 'status', 'tenantId', 'partyId',
      'id', 'operationId', 'cashSessionId', 'amountMinor', 'journalEntryId',
    ]) {
      expect(partyV2NamePhoneEditRequestSchema.safeParse({
        ...request(), [key]: key === 'opening' ? null : 'disallowed',
      }).success).toBe(false);
    }
  });

  it('never implies a balance, another role or sensitive profile from an edit receipt', () => {
    const accepted = partyV2MutationReceiptEnvelopeSchema.safeParse(receipt());
    expect(accepted.success).toBe(true);
    if (accepted.success) expect(accepted.data).toEqual(receipt());
    for (const key of [
      'name', 'phone', 'roles', 'balance', 'nid', 'address',
      'customerGroupId', 'globalHistory', 'hasLedgerEntries',
    ]) {
      expect(partyV2MutationReceiptEnvelopeSchema.safeParse({
        data: { ...receipt().data, [key]: 'unprivileged' },
      }).success).toBe(false);
    }
  });
});
