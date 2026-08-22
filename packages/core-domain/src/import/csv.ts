/**
 * Reading the file a shop hands over at onboarding (§5.6, opening-data import).
 *
 * It is a spreadsheet export, so it is CSV as Excel writes it: a byte-order
 * mark, `\r\n` line endings, quoted fields containing commas or newlines, and a
 * doubled `""` for a quote inside one. All of that is handled here, once, so no
 * caller ever splits a line on commas and loses a shop whose address contains
 * one.
 *
 * Pure: no I/O, no clock, no encoding decisions — the caller supplies text.
 *
 * **Row numbers are the ones the shopkeeper can see.** They count physical
 * records from 1 including the header, exactly as the spreadsheet's own row
 * numbers do, because the whole point of a preview is "row 14 is wrong" being a
 * sentence someone can act on.
 */

export interface CsvRecord {
  /** The row number as the spreadsheet shows it; the header is row 1. */
  readonly rowNumber: number;
  readonly cells: readonly string[];
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly records: readonly CsvRecord[];
}

export type CsvRejection =
  /** Nothing but whitespace — usually the wrong file, or an empty export. */
  | 'FILE_IS_EMPTY'
  /** A header and no data. Posting nothing is not an import. */
  | 'FILE_HAS_NO_ROWS'
  /** A `"` was opened and the file ended before it closed. */
  | 'UNCLOSED_QUOTE';

export type CsvParseResult =
  | { readonly ok: true; readonly table: CsvTable }
  | { readonly ok: false; readonly rejection: CsvRejection };

const BOM = '﻿';

/**
 * Splits the text into records without interpreting any of them.
 *
 * A record's cells are returned exactly as they were written apart from the
 * surrounding quotes: trimming belongs to the column that knows whether a
 * leading space is meaningful, and a name is not a number.
 */
export function parseCsv(text: string): CsvParseResult {
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const records: (readonly string[])[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;

  const endCell = (): void => {
    cells.push(cell);
    cell = '';
    started = false;
  };
  const endRecord = (): void => {
    endCell();
    records.push(cells);
    cells = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;

    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      // A doubled quote inside a quoted field is one literal quote.
      if (source[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"' && !started && cell === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ',') {
      endCell();
      continue;
    }
    if (char === '\r') {
      // `\r\n` is one ending; a lone `\r` (old Mac exports) is also one.
      if (source[index + 1] === '\n') index += 1;
      endRecord();
      continue;
    }
    if (char === '\n') {
      endRecord();
      continue;
    }

    cell += char;
    started = true;
  }

  if (quoted) return { ok: false, rejection: 'UNCLOSED_QUOTE' };
  // A file ending in a newline has already closed its last record; anything
  // still in hand is a final record without one.
  if (cell !== '' || cells.length > 0) endRecord();

  // Blank lines are dropped, but only after numbering: a trailing empty line is
  // normal in every export, and a stray one in the middle must not shift every
  // later row number away from what the spreadsheet shows.
  const numbered = records
    .map((row, index) => ({ rowNumber: index + 1, cells: row }))
    .filter((row) => !isBlank(row.cells));

  const header = numbered[0];
  if (header === undefined) return { ok: false, rejection: 'FILE_IS_EMPTY' };

  const body = numbered.slice(1);
  if (body.length === 0) return { ok: false, rejection: 'FILE_HAS_NO_ROWS' };

  return {
    ok: true,
    table: { header: header.cells.map((value) => value.trim()), records: body },
  };
}

function isBlank(cells: readonly string[]): boolean {
  return cells.every((value) => value.trim() === '');
}

/**
 * Writes a table back out, for the downloadable template (§5.6).
 *
 * The same escaping rules in reverse, in the same file, so a template this
 * project generates is a file this project can read back.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((cells) => cells.map(escapeCell).join(',')).join('\r\n');
}

function escapeCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
