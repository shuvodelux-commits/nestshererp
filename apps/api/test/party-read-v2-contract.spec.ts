/**
 * MOD-004 T09C-P1 — additive Party V2 read-contract safety tests.
 *
 * These are schema-only tests; they DO NOT imply that V1 raw API disclosures
 * are fixed or that a V2 route is mounted. See backend #72, #93 and #137.
 */
import { describe, expect, it } from 'vitest';

import {
  partyReadV2ListResponseSchema,
  partyReadV2Schema,
} from '@sher/core-contracts';

function customerRead() {
  return {
    id: '0'.repeat(26),
    name: 'Shared Customer and Supplier',
    roles: ['CUSTOMER'],
    readRole: 'CUSTOMER',
    phone: '01712345678',
    customerGroupId: null,
    customerGroupName: null,
    creditLimitMinor: null,
    status: 'ACTIVE',
    isSystemReserved: false,
    version: 1,
    balance: {
      netMinor: 0,
      direction: 'SETTLED',
      outstandingMinor: 0,
      advanceMinor: 0,
    },
    profile: { state: 'WITHHELD' },
    globalHistory: { state: 'WITHHELD' },
  };
}

describe('MOD-004 T09C-P1 — V2 Party read contract, not a mounted API', () => {
  it('represents withheld profile and global history without pretending there are no postings', () => {
    const input = customerRead();
    const result = partyReadV2Schema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile).toEqual({ state: 'WITHHELD' });
      expect(result.data.globalHistory).toEqual({ state: 'WITHHELD' });
      expect(JSON.stringify(result.data)).not.toContain('hasLedgerEntries');
    }
  });

  it('supports separately granted profile fields and global history, including a true history flag', () => {
    const result = partyReadV2Schema.safeParse({
      ...customerRead(),
      profile: {
        state: 'VISIBLE',
        data: {
          address: 'Natore',
          guardianName: 'Parent',
          nid: '1234567890',
          email: 'safe@example.test',
          notes: 'Private customer notes',
        },
      },
      globalHistory: { state: 'VISIBLE', hasLedgerEntries: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects V1-style sensitive fields or party-global history on the V2 top level', () => {
    for (const field of ['address', 'guardianName', 'nid', 'email', 'notes', 'hasLedgerEntries']) {
      const result = partyReadV2Schema.safeParse({ ...customerRead(), [field]: 'leaked' });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a withheld profile that contains private values', () => {
    expect(partyReadV2Schema.safeParse({
      ...customerRead(), profile: { state: 'WITHHELD', data: { nid: 'secret' } },
    }).success).toBe(false);
  });

  it('rejects a withheld global-history boolean, including misleading false', () => {
    for (const value of [false, true]) {
      expect(partyReadV2Schema.safeParse({
        ...customerRead(), globalHistory: { state: 'WITHHELD', hasLedgerEntries: value },
      }).success).toBe(false);
    }
  });

  it('requires the history boolean when visibility is explicitly granted', () => {
    expect(partyReadV2Schema.safeParse({
      ...customerRead(), globalHistory: { state: 'VISIBLE' },
    }).success).toBe(false);
    expect(partyReadV2Schema.safeParse({
      ...customerRead(), globalHistory: { state: 'VISIBLE', hasLedgerEntries: false },
    }).success).toBe(true);
  });

  it('requires selected role membership and refuses Customer metadata in a Supplier read', () => {
    expect(partyReadV2Schema.safeParse({
      ...customerRead(), readRole: 'SUPPLIER',
    }).success).toBe(false);
    expect(partyReadV2Schema.safeParse({
      ...customerRead(), readRole: 'SUPPLIER', roles: ['SUPPLIER'],
      customerGroupName: 'Hidden Customer Category',
    }).success).toBe(false);
    expect(partyReadV2Schema.safeParse({
      ...customerRead(), readRole: 'SUPPLIER', roles: ['SUPPLIER'],
      customerGroupId: null, customerGroupName: null, creditLimitMinor: null,
    }).success).toBe(true);
  });

  it('keeps paginated list and role-scoped summary shape separate from private fields', () => {
    const response = partyReadV2ListResponseSchema.safeParse({
      data: [customerRead()],
      page: { nextCursor: null, hasMore: false },
      summary: {
        total: 1, active: 1, inactive: 0,
        ungrouped: 1, totalOutstandingMinor: 0,
        totalAdvanceMinor: 0, overCreditLimit: 0,
      },
    });
    expect(response.success).toBe(true);
  });
});
