import { parseMoney } from '@sher/shared-utils';

/**
 * A bank or MFS statement, read out of the text a PDF carries (§5.17, Phase 11).
 *
 * **Pure and deterministic.** Nothing here opens a file — extracting text from
 * a PDF needs a Node library, and a library in `core-domain` would end the
 * layering rule that keeps this package testable with a string. The extractor
 * hands over positioned text lines; everything from there is arithmetic and
 * pattern-reading that behaves identically on every machine.
 *
 * **What makes this hard, and the rule that makes it possible.** Every bank in
 * Bangladesh lays a statement out differently — some print debit and credit in
 * two columns, some print one signed amount, some mark direction with `Dr`/`Cr`
 * and some with brackets. Only one thing is common to all of them: a running
 * balance in the last column. So the parser's strongest signal for **which way
 * the money went** is not a column heading or a keyword — it is that the
 * balance moved. `balance − previous balance` is the direction, and it is the
 * bank's own arithmetic rather than our reading of its layout.
 *
 * Keywords and signs are fallbacks, used only when there is no balance to
 * subtract, and a row where none of them answers is returned as a **problem**
 * rather than a guess. A guessed direction reconciles to the wrong number
 * twice as fast as a missing one, and the owner cannot see that it happened.
 */

/** One line of text as the extractor found it, top of the page first. */
export interface ExtractedTextLine {
  readonly page: number;
  /** Distance down the page. Only the ordering matters here. */
  readonly y: number;
  readonly text: string;
}

/** A row the parser is sure enough about to show the owner. */
export interface ParsedStatementLine {
  readonly lineNo: number;
  readonly businessDate: string;
  readonly description: string;
  readonly reference: string | null;
  /** Signed poisha: money in positive, money out negative. */
  readonly amountMinor: number;
  /** The bank's own running balance, when the statement prints one. */
  readonly balanceMinor: number | null;
}

/** A line the parser could not read, kept so the owner can repair or drop it. */
export interface StatementProblem {
  readonly lineNo: number;
  readonly text: string;
  readonly reason:
    | 'NO_AMOUNT'
    | 'NO_DATE'
    | 'DIRECTION_UNKNOWN'
    | 'BALANCE_DOES_NOT_FOLLOW';
}

export type StatementParseStatus = 'PARSED' | 'PARTIAL' | 'UNREADABLE';

export interface ParsedStatement {
  readonly status: StatementParseStatus;
  readonly lines: readonly ParsedStatementLine[];
  readonly problems: readonly StatementProblem[];
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly openingBalanceMinor: number | null;
  readonly closingBalanceMinor: number | null;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * `05-08-2026` · `05/08/2026` · `2026-08-05` · `05-Aug-2026` · `05 Aug 2026`.
 *
 * Day-first where it is ambiguous, because that is how every statement printed
 * in Bangladesh reads. A four-digit year at the front is unambiguous and taken
 * as ISO.
 */
const DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})$|^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$|^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ](\d{2,4})$/;

/** `10,000.00` · `10000.00` · `(2,500.00)` · `2,500.00-` · `-2,500.00`. */
const MONEY_TOKEN = /\(?-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?\)?-?(?:\s*(?:DR|CR|Dr|Cr))?/g;

/** Words a bank prints when it is taking money out. */
const OUT_WORDS = /\b(withdraw\w*|debit|dr\.?|payment|charge|fee|transfer out|paid|purchase|atm|chq|cheque)\b/i;
/** Words a bank prints when it is putting money in. */
const IN_WORDS = /\b(deposit\w*|credit|cr\.?|received|receipt|transfer in|refund|cash in|interest)\b/i;

/**
 * A reference the bank prints: a transaction id, a cheque number, a UTR.
 *
 * Letters and digits together (`TX889`), or six digits and up on its own. The
 * mix is what makes it a reference rather than a word or a quantity, and the
 * length floor keeps a two-character fragment from colliding with another
 * two-character fragment and producing a confident wrong match.
 */
const REFERENCE_PATTERN =
  /\b(?=[A-Z0-9-]{4,24}\b)(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z][A-Z0-9-]{3,23}\b|\b\d{6,20}\b/;

export function parseStatement(textLines: readonly ExtractedTextLine[]): ParsedStatement {
  const lines: ParsedStatementLine[] = [];
  const problems: StatementProblem[] = [];

  let openingBalanceMinor: number | null = null;
  let closingBalanceMinor: number | null = null;
  let previousBalance: number | null = null;
  let lineNo = 0;

  for (const raw of textLines) {
    const text = raw.text.replace(/\s+/g, ' ').trim();
    if (text === '') continue;

    // A statement's own summary lines, which are figures rather than rows.
    const labelled = readLabelledBalance(text);
    if (labelled !== null) {
      if (labelled.kind === 'OPENING') {
        openingBalanceMinor ??= labelled.amountMinor;
        previousBalance ??= labelled.amountMinor;
      } else {
        closingBalanceMinor = labelled.amountMinor;
      }
      continue;
    }

    const date = readLeadingDate(text);
    if (date === null) continue; // a heading, a footer, an address — not a row.

    lineNo += 1;
    /*
     * The date comes off before any figure is read. `05-08-2026` is three
     * numbers separated by hyphens, and a money scanner let loose on it finds
     * `-08` — eight taka out, on a row that never mentioned eight taka. Taking
     * the date away first is the whole fix, and it is why the tokeniser below
     * never sees it.
     */
    const body = text.slice(date.raw.length);
    const tokens = readMoneyTokens(body);
    if (tokens.length === 0) {
      problems.push({ lineNo, text, reason: 'NO_AMOUNT' });
      continue;
    }

    // The last figure on a statement row is the running balance whenever there
    // is more than one figure. With a single figure there is no balance column
    // and the row carries only its own amount.
    const balanceMinor = tokens.length > 1 ? (tokens[tokens.length - 1]?.minor ?? null) : null;
    const amountToken = tokens.length > 1 ? tokens[tokens.length - 2] : tokens[0];
    if (amountToken === undefined) {
      problems.push({ lineNo, text, reason: 'NO_AMOUNT' });
      continue;
    }

    const magnitude = Math.abs(amountToken.minor);
    if (magnitude === 0) {
      problems.push({ lineNo, text, reason: 'NO_AMOUNT' });
      continue;
    }

    const direction = readDirection({
      token: amountToken,
      text: body,
      balanceMinor,
      previousBalance,
      magnitude,
    });

    if (direction === null) {
      problems.push({ lineNo, text, reason: 'DIRECTION_UNKNOWN' });
      // The balance still moves the story forward for the next row even when
      // this one could not be read.
      if (balanceMinor !== null) previousBalance = balanceMinor;
      continue;
    }

    const description = describe(body, tokens);

    lines.push({
      lineNo,
      businessDate: date.iso,
      description,
      reference: REFERENCE_PATTERN.exec(description.toUpperCase())?.[0] ?? null,
      amountMinor: direction * magnitude,
      balanceMinor,
    });

    if (balanceMinor !== null) previousBalance = balanceMinor;
  }

  // A statement that prints a running balance tells us its opening without
  // saying so: the first row's balance, less what that row did.
  const first = lines[0];
  if (openingBalanceMinor === null && first !== undefined && first.balanceMinor !== null) {
    openingBalanceMinor = first.balanceMinor - first.amountMinor;
  }
  const last = lines[lines.length - 1];
  if (closingBalanceMinor === null && last !== undefined && last.balanceMinor !== null) {
    closingBalanceMinor = last.balanceMinor;
  }

  const dates = lines.map((line) => line.businessDate).sort();

  return {
    status: statusOf(lines, problems, openingBalanceMinor, closingBalanceMinor),
    lines,
    problems,
    fromDate: dates[0] ?? null,
    toDate: dates[dates.length - 1] ?? null,
    openingBalanceMinor,
    closingBalanceMinor,
  };
}

/* ------------------------------------------------------------------ reading */

interface MoneyToken {
  readonly raw: string;
  /** Signed as printed: brackets, a trailing minus or `DR` all mean negative. */
  readonly minor: number;
  readonly explicitlySigned: boolean;
}

function readMoneyTokens(text: string): readonly MoneyToken[] {
  const tokens: MoneyToken[] = [];
  MONEY_TOKEN.lastIndex = 0;

  for (const match of text.matchAll(MONEY_TOKEN)) {
    const raw = match[0].trim();
    // A bare integer with no separator and no decimals is far more likely to be
    // a reference, an account number or a cheque number than an amount.
    if (!/[.,]/.test(raw) && /^\d+$/.test(raw)) continue;

    const negative = /^\(|\)$|^-|-$|DR$/i.test(raw) && !/CR$/i.test(raw);
    const digits = raw.replace(/[(),\s]|DR$|CR$|Dr$|Cr$|^-|-$/gi, '');
    const money = parseMoney(digits);
    if (money === null) continue;

    tokens.push({
      raw,
      minor: negative ? -money : money,
      explicitlySigned: /^\(|\)$|^-|-$|DR$|CR$/i.test(raw),
    });
  }

  return tokens;
}

function readLeadingDate(text: string): { readonly iso: string; readonly raw: string } | null {
  const candidate = text.split(' ').slice(0, 3);

  for (let take = 1; take <= candidate.length; take += 1) {
    const raw = candidate.slice(0, take).join(' ');
    const match = DATE_PATTERN.exec(raw);
    if (match === null) continue;

    const iso = toIso(match);
    if (iso !== null) return { iso, raw };
  }

  return null;
}

function toIso(match: RegExpExecArray): string | null {
  if (match[1] !== undefined) return `${match[1]}-${match[2] ?? ''}-${match[3] ?? ''}`;

  const [day, monthText, yearText] =
    match[4] !== undefined
      ? [match[4], match[5] ?? '', match[6] ?? '']
      : [match[7] ?? '', match[8] ?? '', match[9] ?? ''];

  const month = /^\d+$/.test(monthText)
    ? Number(monthText)
    : (MONTHS[monthText.slice(0, 3).toLowerCase()] ?? 0);
  if (month < 1 || month > 12) return null;

  const dayNumber = Number(day);
  if (dayNumber < 1 || dayNumber > 31) return null;

  // A two-digit year on a shop's statement is this century; a statement from
  // 1998 is not a thing anyone is reconciling.
  const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  if (year < 2000 || year > 2999) return null;

  return `${String(year)}-${String(month).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
}

interface DirectionInput {
  readonly token: MoneyToken;
  readonly text: string;
  readonly balanceMinor: number | null;
  readonly previousBalance: number | null;
  readonly magnitude: number;
}

/**
 * Which way the money went: `+1` in, `-1` out, `null` when nothing says.
 *
 * The order is the order of trust. The bank's own balance arithmetic beats a
 * printed sign, a printed sign beats a two-column layout, and a keyword in the
 * narration is the last resort — `Bank charge` is a good hint and a terrible
 * proof.
 */
function readDirection(input: DirectionInput): number | null {
  const { token, text, balanceMinor, previousBalance, magnitude } = input;

  if (balanceMinor !== null && previousBalance !== null) {
    const moved = balanceMinor - previousBalance;
    if (moved === magnitude) return 1;
    if (moved === -magnitude) return -1;
    // The balance moved by something other than this row's amount. Falling
    // through to the weaker signals is right: a mid-statement carried-forward
    // line or a page break can break the chain without the row being wrong.
  }

  if (token.explicitlySigned) return token.minor < 0 ? -1 : 1;

  const out = OUT_WORDS.test(text);
  const inward = IN_WORDS.test(text);
  if (out && !inward) return -1;
  if (inward && !out) return 1;

  return null;
}

function readLabelledBalance(
  text: string,
): { readonly kind: 'OPENING' | 'CLOSING'; readonly amountMinor: number } | null {
  const opening = /\b(opening balance|balance b\/?f|brought forward|b\/f)\b/i.test(text);
  const closing = /\b(closing balance|balance c\/?f|carried forward|c\/f|ending balance)\b/i.test(text);
  if (!opening && !closing) return null;

  const tokens = readMoneyTokens(text);
  const amount = tokens[tokens.length - 1];
  if (amount === undefined) return null;

  return { kind: opening ? 'OPENING' : 'CLOSING', amountMinor: amount.minor };
}

/** The row with its figures taken out — what is left is the story. */
function describe(body: string, tokens: readonly MoneyToken[]): string {
  let description = body;
  for (const token of tokens) description = description.replace(token.raw, ' ');

  return description.replace(/\s+/g, ' ').trim();
}

function statusOf(
  lines: readonly ParsedStatementLine[],
  problems: readonly StatementProblem[],
  openingBalanceMinor: number | null,
  closingBalanceMinor: number | null,
): StatementParseStatus {
  // Nothing readable **and nothing even attempted** is the scanned-image case:
  // the file is kept as evidence and the owner reconciles against the paper
  // (owner decision 2026-08-30). A file where rows were found and could not be
  // read is a different thing — it is PARTIAL, and the owner repairs it.
  if (lines.length === 0 && problems.length === 0) return 'UNREADABLE';
  if (problems.length > 0 || openingBalanceMinor === null || closingBalanceMinor === null) {
    return 'PARTIAL';
  }
  return 'PARSED';
}
