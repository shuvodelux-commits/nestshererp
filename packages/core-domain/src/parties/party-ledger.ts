import { partyBalanceOf } from './party-balance';
import type { PartyBalance } from './party-balance';

/**
 * A party's ledger — the projection of their journal lines into statement rows
 * (§2.4, INV-06, INV-10).
 *
 * Nothing here is stored. A ledger is journal lines read back in order with a
 * running total attached, which is what makes INV-06 true by construction: the
 * closing balance of this projection *is* the sum of the lines, so a list column
 * and a statement cannot disagree unless they were given different lines.
 *
 * Pure: no clock, no I/O. Ordering is the caller's — the repository returns
 * rows in business-date, then created-at, then id order (the same key
 * `journal_lines` is indexed on), because a running balance recomputed under a
 * different sort would produce different intermediate figures for the same
 * ledger.
 */

/** One journal line as a statement row, before the running total is applied. */
export interface PartyLedgerLine {
  readonly journalEntryId: string;
  readonly journalLineId: string;
  readonly businessDate: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly sourceNumber: string;
  readonly account: string;
  /** Signed: positive is a debit, exactly as stored. */
  readonly amountMinor: number;
}

/**
 * A statement row: the line, plus what the balance stood at after it.
 *
 * `debitMinor` and `creditMinor` are the unsigned display halves §2.4 calls a
 * display mapping over the signed line. They are computed here rather than in
 * each screen so the সাল/জমা, Debit/Credit and পাবো/দিব renderings all split
 * the same number the same way.
 */
export interface PartyLedgerRow extends PartyLedgerLine {
  readonly debitMinor: number;
  readonly creditMinor: number;
  /** The party's net balance after this row, signed as `PartyBalance.netMinor`. */
  readonly runningBalanceMinor: number;
}

export interface PartyLedger {
  /** Net balance before the first row — the sum of everything earlier. */
  readonly openingBalance: PartyBalance;
  readonly rows: readonly PartyLedgerRow[];
  /** Net balance after the last row. What the list column must also show. */
  readonly closingBalance: PartyBalance;
  /** Unsigned totals across the rows shown, for the statement footer. */
  readonly totalDebitMinor: number;
  readonly totalCreditMinor: number;
}

/**
 * Attaches a running balance to a party's lines.
 *
 * `openingNetMinor` is the sum of every line *before* this page — passed in
 * rather than derived, because a ledger is paged and a running balance that
 * restarted at zero on page two would be wrong in a way that looks plausible.
 */
export function buildPartyLedger(
  lines: readonly PartyLedgerLine[],
  openingNetMinor = 0,
): PartyLedger {
  let running = openingNetMinor;
  let totalDebitMinor = 0;
  let totalCreditMinor = 0;

  const rows = lines.map((line): PartyLedgerRow => {
    running += line.amountMinor;

    const debitMinor = line.amountMinor > 0 ? line.amountMinor : 0;
    const creditMinor = line.amountMinor < 0 ? -line.amountMinor : 0;

    totalDebitMinor += debitMinor;
    totalCreditMinor += creditMinor;

    return { ...line, debitMinor, creditMinor, runningBalanceMinor: running };
  });

  return {
    openingBalance: partyBalanceOf(openingNetMinor),
    rows,
    closingBalance: partyBalanceOf(running),
    totalDebitMinor,
    totalCreditMinor,
  };
}
