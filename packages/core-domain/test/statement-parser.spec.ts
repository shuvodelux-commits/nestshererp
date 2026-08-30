import { describe, expect, it } from 'vitest';

import { parseStatement } from '../src/reconciliation/statement-parser';
import type { ExtractedTextLine } from '../src/reconciliation/statement-parser';

/**
 * Reading a bank statement's text (§5.17, Phase 11).
 *
 * The parser's job is to be right or to say it does not know. These assert both
 * halves: what it reads out of an ordinary statement, and that a line it cannot
 * read comes back as a problem the owner is shown rather than a row that
 * quietly reconciles to the wrong figure.
 */

function lines(...texts: readonly string[]): readonly ExtractedTextLine[] {
  return texts.map((text, index) => ({ page: 1, y: 800 - index * 20, text }));
}

describe('reading a statement', () => {
  const statement = parseStatement(
    lines(
      'SHER TEST BANK — STATEMENT OF ACCOUNT',
      'Opening balance 30,000.00',
      '05-08-2026 TX889 Deposit from Karim 10,000.00 40,000.00',
      '08-08-2026 TR223 Service charge 500.00 39,500.00',
      'Closing balance 39,500.00',
    ),
  );

  it('reads the dates, ignoring the headings around them', () => {
    expect(statement.lines.map((line) => line.businessDate)).toEqual(['2026-08-05', '2026-08-08']);
    expect(statement.fromDate).toBe('2026-08-05');
    expect(statement.toDate).toBe('2026-08-08');
  });

  it('takes the direction from the balance the bank itself printed', () => {
    // Nothing in "Service charge" is trusted for this: the balance fell by 500,
    // so 500 left. That is the bank's own arithmetic, not our reading of it.
    expect(statement.lines.map((line) => line.amountMinor)).toEqual([1_000_000, -50_000]);
  });

  it('parses money exactly, in integer poisha', () => {
    expect(statement.lines[0]?.amountMinor).toBe(1_000_000);
    expect(statement.lines[0]?.balanceMinor).toBe(4_000_000);
    expect(statement.openingBalanceMinor).toBe(3_000_000);
    expect(statement.closingBalanceMinor).toBe(3_950_000);
  });

  it('picks the bank’s own reference out of the narration', () => {
    expect(statement.lines.map((line) => line.reference)).toEqual(['TX889', 'TR223']);
  });

  it('calls a statement it read completely PARSED', () => {
    expect(statement.status).toBe('PARSED');
    expect(statement.problems).toEqual([]);
  });
});

describe('what it refuses to guess', () => {
  it('reports a row whose direction nothing establishes', () => {
    // No balance column, no sign, no word that means in or out.
    const parsed = parseStatement(lines('05-08-2026 REF12345 Adjustment 1,200.00'));

    expect(parsed.lines).toEqual([]);
    expect(parsed.problems).toEqual([
      { lineNo: 1, text: '05-08-2026 REF12345 Adjustment 1,200.00', reason: 'DIRECTION_UNKNOWN' },
    ]);
    expect(parsed.status).toBe('PARTIAL');
  });

  it('reports a dated row carrying no amount', () => {
    const parsed = parseStatement(lines('05-08-2026 Cheque returned unpaid'));

    expect(parsed.problems).toEqual([
      { lineNo: 1, text: '05-08-2026 Cheque returned unpaid', reason: 'NO_AMOUNT' },
    ]);
  });

  it('calls a statement with nothing readable in it UNREADABLE, and does not fail', () => {
    // A scan: the extractor found no text at all. The file is still kept as
    // evidence and the owner reconciles by hand (owner decision 2026-08-30).
    const parsed = parseStatement([]);

    expect(parsed.status).toBe('UNREADABLE');
    expect(parsed.lines).toEqual([]);
    expect(parsed.problems).toEqual([]);
  });

  it('reads an explicit minus and bracketed figures without needing a balance', () => {
    const parsed = parseStatement(
      lines('05-08-2026 ATM withdrawal (2,500.00)', '06-08-2026 TX900 Refund 1,250.50'),
    );

    expect(parsed.lines[0]?.amountMinor).toBe(-250_000);
    expect(parsed.lines[1]?.amountMinor).toBe(125_050);
  });
});
