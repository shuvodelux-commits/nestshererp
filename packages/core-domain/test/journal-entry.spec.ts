import { describe, expect, it } from 'vitest';

import {
  entryTotalMinor,
  fixedAccount,
  isAccountCode,
  parameterisedAccount,
  parseAccountCode,
  rejectEntry,
  reverseEntry,
} from '../src/index';

/**
 * INV-01 — every journal entry sums to zero.
 *
 * The single invariant the whole posting kernel rests on. Every sale, purchase,
 * payment, opening balance and reversal in SherERP becomes an entry checked
 * here, so a hole in this file is a hole in every report the business runs on.
 */

const AR = fixedAccount('AR');
const SALES = fixedAccount('SALES');
const INVENTORY = fixedAccount('INVENTORY');
const OPENING_EQUITY = fixedAccount('OPENING_EQUITY');

/** Positive is a debit, negative a credit. */
function line(account: string, amountMinor: number, partyId: string | null = null) {
  return { account: account as never, amountMinor, partyId };
}

describe('a balanced entry (INV-01)', () => {
  it('accepts a sale on credit: ৳150.75 to the customer, ৳150.75 to sales', () => {
    const entry = {
      lines: [line(AR, 15075, '01PARTYAAAAAAAAAAAAAAAAAAA'), line(SALES, -15075)],
    };

    expect(rejectEntry(entry)).toBeNull();
    expect(entryTotalMinor(entry)).toBe(15075);
  });

  it('accepts an entry with more than two lines, as long as it sums to zero', () => {
    // Opening stock: two products in, equity out. The counterpart is one line.
    const entry = {
      lines: [line(INVENTORY, 60000), line(INVENTORY, 45050), line(OPENING_EQUITY, -105050)],
    };

    expect(rejectEntry(entry)).toBeNull();
    expect(entryTotalMinor(entry)).toBe(105050);
  });

  it('refuses one that is out by a single poisha', () => {
    // The failure this invariant exists to catch: everything looks right and
    // the books are one poisha apart forever.
    const entry = { lines: [line(AR, 15075, '01PARTYAAAAAAAAAAAAAAAAAAA'), line(SALES, -15074)] };

    expect(rejectEntry(entry)).toBe('ENTRY_DOES_NOT_BALANCE');
  });

  it('refuses an empty entry and a lone line', () => {
    expect(rejectEntry({ lines: [] })).toBe('ENTRY_HAS_NO_LINES');
    expect(rejectEntry({ lines: [line(SALES, -15075)] })).toBe('ENTRY_HAS_ONE_LINE');
  });

  it('refuses a zero line, which is a dropped amount rather than a real posting', () => {
    const entry = { lines: [line(AR, 15075, '01PARTYAAAAAAAAAAAAAAAAAAA'), line(SALES, -15075), line(INVENTORY, 0)] };

    expect(rejectEntry(entry)).toBe('LINE_AMOUNT_IS_ZERO');
  });

  it('refuses a fractional amount — money is integer minor units', () => {
    const entry = { lines: [line(INVENTORY, 100.5), line(OPENING_EQUITY, -100.5)] };

    expect(rejectEntry(entry)).toBe('LINE_AMOUNT_NOT_INTEGER_MINOR');
  });
});

describe('a party account without a party (INV-06)', () => {
  it('refuses a receivable belonging to nobody', () => {
    // It would count towards the AR control account and appear on no statement,
    // which is exactly the drift INV-06 exists to catch.
    const entry = { lines: [line(AR, 15075), line(SALES, -15075)] };

    expect(rejectEntry(entry)).toBe('PARTY_ACCOUNT_WITHOUT_PARTY');
  });

  it.each(['SUPPLIER_ADVANCE', 'VENDOR_ADVANCE'] as const)(
    'refuses a %s balance belonging to nobody',
    (account) => {
      const entry = { lines: [line(fixedAccount(account), 50000), line(OPENING_EQUITY, -50000)] };

      expect(rejectEntry(entry)).toBe('PARTY_ACCOUNT_WITHOUT_PARTY');
    },
  );

  it('allows an owner injection without naming the owner as a party', () => {
    const entry = {
      lines: [
        line(parameterisedAccount('CASH', '01DRAWERAAAAAAAAAAAAAAAAAA'), 500000),
        line(fixedAccount('OWNER_CURRENT_ACCOUNT'), -500000),
      ],
    };

    expect(rejectEntry(entry)).toBeNull();
  });
});

describe('reversal (§2.5, INV-08)', () => {
  it('negates every line, so the pair nets to nothing', () => {
    const original = {
      lines: [line(AR, 15075, '01PARTYAAAAAAAAAAAAAAAAAAA'), line(SALES, -15075)],
    };
    const reversed = reverseEntry(original);

    expect(rejectEntry(reversed)).toBeNull();
    expect(reversed.lines.map((l) => l.amountMinor)).toEqual([-15075, 15075]);

    // INV-08 by construction: the two entries together move nothing.
    const net = [...original.lines, ...reversed.lines].reduce((sum, l) => sum + l.amountMinor, 0);
    expect(net).toBe(0);
  });

  it('keeps the party on each line, so the statement shows both sides', () => {
    const reversed = reverseEntry({ lines: [line(AR, 15075, '01PARTYAAAAAAAAAAAAAAAAAAA'), line(SALES, -15075)] });

    expect(reversed.lines[0]!.partyId).toBe('01PARTYAAAAAAAAAAAAAAAAAAA');
    expect(rejectEntry(reversed)).toBeNull();
  });
});

describe('the closed account list (§2.4)', () => {
  it('builds and reads back a per-cash-account code', () => {
    const drawer = parameterisedAccount('CASH', '01DRAWERAAAAAAAAAAAAAAAAAA');

    expect(drawer).toBe('CASH:01DRAWERAAAAAAAAAAAAAAAAAA');
    expect(parseAccountCode(drawer)).toEqual({ kind: 'CASH', id: '01DRAWERAAAAAAAAAAAAAAAAAA' });
  });

  it('rejects an account that is not on the list', () => {
    // §2.4: an agent needing an account not on the list must stop and report,
    // because a new account changes what every existing report means.
    expect(parseAccountCode('GOODWILL')).toBeNull();
    expect(parseAccountCode('SUSPENSE:01')).toBeNull();
    expect(isAccountCode('INVENTORY')).toBe(true);
  });

  it('rejects an id containing the separator, which would split one account in two', () => {
    expect(() => parameterisedAccount('EXPENSE', 'transport:extra')).toThrow();
    expect(parseAccountCode('EXPENSE:transport:extra')).toBeNull();
  });

  it('rejects a parameterised account used without its id, and vice versa', () => {
    expect(parseAccountCode('CASH')).toBeNull();
    expect(parseAccountCode('INVENTORY:01')).toBeNull();
  });
});
