import { describe, expect, it } from 'vitest';

import {
  buildPartyLedger,
  exceedsCreditLimit,
  openingBalancePosting,
  partyBalanceOf,
  rejectEntry,
  rejectOpeningBalance,
} from '../src/index';

/**
 * Party balances, openings and ledgers (§2.4, §5.6, INV-01, INV-06).
 *
 * These are the rules that decide whether a shopkeeper collects the right
 * amount, so they are asserted here — pure, with no database — rather than only
 * through an HTTP round trip.
 */
describe('partyBalanceOf', () => {
  it('reads a positive net as money the shop will receive', () => {
    expect(partyBalanceOf(250_000)).toEqual({
      netMinor: 250_000,
      direction: 'RECEIVABLE',
      outstandingMinor: 250_000,
      advanceMinor: 0,
    });
  });

  it('reads a negative net as money the shop will pay back', () => {
    expect(partyBalanceOf(-100_000)).toEqual({
      netMinor: -100_000,
      direction: 'PAYABLE',
      outstandingMinor: 0,
      advanceMinor: 100_000,
    });
  });

  /* Zero is its own case: "settled" and "৳0 পাবো" do not read the same. */
  it('reads zero as settled rather than as a receivable of nothing', () => {
    expect(partyBalanceOf(0).direction).toBe('SETTLED');
  });

  it('refuses a net that is not whole minor units', () => {
    expect(() => partyBalanceOf(1.5)).toThrow(/integer minor units/);
  });
});

describe('exceedsCreditLimit', () => {
  it('treats no limit as no limit, not as a limit of zero', () => {
    expect(exceedsCreditLimit(partyBalanceOf(500_000), null)).toBe(false);
  });

  it('lets a customer land exactly on their limit', () => {
    expect(exceedsCreditLimit(partyBalanceOf(500_000), 500_000)).toBe(false);
  });

  it('counts the sale being rung up, not just what is already owed', () => {
    expect(exceedsCreditLimit(partyBalanceOf(400_000), 500_000, 150_000)).toBe(true);
  });

  /* An advance is not headroom the limit has to police — it is money in hand. */
  it('does not treat an advance as credit used', () => {
    expect(exceedsCreditLimit(partyBalanceOf(-100_000), 0)).toBe(false);
  });
});

describe('openingBalancePosting', () => {
  it('posts a customer receivable to AR against opening equity, and balances', () => {
    const posting = openingBalancePosting({
      partyId: '01PARTYKARIMAAAAAAAAAAAAAA',
      role: 'CUSTOMER',
      direction: 'RECEIVABLE',
      amountMinor: 250_000,
    });

    expect(posting.journal.lines).toEqual([
      {
        account: 'AR',
        amountMinor: 250_000,
        partyId: '01PARTYKARIMAAAAAAAAAAAAAA',
      },
      { account: 'OPENING_EQUITY', amountMinor: -250_000, partyId: null },
    ]);
    // INV-01, checked by the kernel itself rather than by re-adding here.
    expect(rejectEntry(posting.journal)).toBeNull();
  });

  /*
   * The mistake this prevents: money paid ahead to a supplier is not `AR`.
   * Posting it there would put a supplier into the sales-side control account.
   */
  it('posts a supplier receivable as a supplier advance, not as AR', () => {
    const posting = openingBalancePosting({
      partyId: '01PARTYRAFIQAAAAAAAAAAAAAA',
      role: 'SUPPLIER',
      direction: 'RECEIVABLE',
      amountMinor: 90_000,
    });

    expect(posting.journal.lines[0]?.account).toBe('SUPPLIER_ADVANCE');
  });

  it('posts a customer deposit as a customer advance', () => {
    const posting = openingBalancePosting({
      partyId: '01PARTYKARIMAAAAAAAAAAAAAA',
      role: 'CUSTOMER',
      direction: 'PAYABLE',
      amountMinor: 100_000,
    });

    expect(posting.journal.lines[0]).toEqual({
      account: 'CUSTOMER_ADVANCE',
      amountMinor: -100_000,
      partyId: '01PARTYKARIMAAAAAAAAAAAAAA',
    });
  });
});

describe('rejectOpeningBalance', () => {
  const base = {
    partyId: '01PARTYKARIMAAAAAAAAAAAAAA',
    role: 'CUSTOMER' as const,
    direction: 'RECEIVABLE' as const,
    amountMinor: 250_000,
  };

  it('accepts a well-formed opening', () => {
    expect(rejectOpeningBalance(base)).toBeNull();
  });

  it('refuses zero — a document that moves nothing', () => {
    expect(rejectOpeningBalance({ ...base, amountMinor: 0 })).toBe(
      'OPENING_AMOUNT_NOT_POSITIVE',
    );
  });

  it('refuses a fraction of a poisha', () => {
    expect(rejectOpeningBalance({ ...base, amountMinor: 1.5 })).toBe(
      'OPENING_AMOUNT_NOT_INTEGER_MINOR',
    );
  });

  /*
   * A vendor is someone the shop pays. A vendor opening pointing the other way
   * is far more likely a mistyped direction than the real thing.
   */
  it('refuses a vendor opening that says the vendor owes the shop', () => {
    expect(rejectOpeningBalance({ ...base, role: 'VENDOR', direction: 'RECEIVABLE' })).toBe(
      'OPENING_DIRECTION_NOT_VALID_FOR_ROLE',
    );
  });

  it('allows a customer deposit and a supplier advance, which both happen', () => {
    expect(rejectOpeningBalance({ ...base, direction: 'PAYABLE' })).toBeNull();
    expect(rejectOpeningBalance({ ...base, role: 'SUPPLIER', direction: 'RECEIVABLE' })).toBeNull();
  });
});

describe('buildPartyLedger', () => {
  const line = (id: string, amountMinor: number) => ({
    journalEntryId: `01ENTRY${id}`,
    journalLineId: `01LINE${id}`,
    businessDate: '2026-01-05',
    sourceDocumentType: 'SALE',
    sourceDocumentId: `01DOC${id}`,
    sourceNumber: `INV-${id}`,
    account: 'AR',
    amountMinor,
  });

  it('runs the balance forward and splits each signed line into debit or credit', () => {
    const ledger = buildPartyLedger([line('A', 250_000), line('B', -100_000)]);

    expect(ledger.rows.map((row) => row.runningBalanceMinor)).toEqual([250_000, 150_000]);
    expect(ledger.rows[0]).toMatchObject({ debitMinor: 250_000, creditMinor: 0 });
    expect(ledger.rows[1]).toMatchObject({ debitMinor: 0, creditMinor: 100_000 });
    expect(ledger.totalDebitMinor).toBe(250_000);
    expect(ledger.totalCreditMinor).toBe(100_000);
    expect(ledger.closingBalance.direction).toBe('RECEIVABLE');
  });

  /*
   * The failure this guards: a second page, or a date-filtered statement, whose
   * running balance restarted at zero. It would be wrong and still look right.
   */
  it('continues from what came before instead of restarting at zero', () => {
    const ledger = buildPartyLedger([line('C', 50_000)], 200_000);

    expect(ledger.openingBalance.netMinor).toBe(200_000);
    expect(ledger.rows[0]?.runningBalanceMinor).toBe(250_000);
    expect(ledger.closingBalance.netMinor).toBe(250_000);
  });

  it('opens and closes at settled when there is nothing to show', () => {
    const ledger = buildPartyLedger([]);

    expect(ledger.rows).toEqual([]);
    expect(ledger.openingBalance.direction).toBe('SETTLED');
    expect(ledger.closingBalance.direction).toBe('SETTLED');
  });
});
