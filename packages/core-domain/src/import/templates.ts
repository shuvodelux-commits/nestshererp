import { parseMoney, parseQty } from '@sher/shared-utils';

import { toCsv } from './csv';
import type { CsvRecord } from './csv';

/**
 * What each onboarding file is allowed to contain (§5.6).
 *
 * §5.6 requires "a downloadable template, preview, per-row validation and a
 * final summary before posting", and calls the whole thing a migration path
 * rather than a configurable import engine. So the column set is **closed and
 * written here**, not described by the caller: a shop maps its old spreadsheet
 * onto this template once, and every later file is the same shape.
 *
 * This file turns cells into typed values and says what is wrong with the ones
 * it cannot. It resolves nothing that needs the database — a unit, brand,
 * category or customer group arrives here as the **name** a person typed, and
 * the application service is what turns that into one of this tenant's own
 * rows. Keeping it that way is what lets the preview and the posting run the
 * identical reader.
 *
 * Pure: no clock, no I/O, no floating point. Money and quantity go through the
 * shared `parseMoney`/`parseQty`, so a price typed into a spreadsheet is read by
 * exactly the same rule as a price typed into the form (R-C3).
 */

export const IMPORT_TYPES = ['PRODUCTS', 'CUSTOMERS', 'SUPPLIERS', 'OPENING_STOCK'] as const;

export type ImportType = (typeof IMPORT_TYPES)[number];

export interface ImportColumn {
  /** Stable key the code uses; the header is what the shopkeeper sees. */
  readonly key: string;
  readonly header: string;
  readonly required: boolean;
  /** One realistic value, used to build the template's example row. */
  readonly example: string;
  /** The sentence shown beside the column in the guide. */
  readonly help: string;
}

export interface ImportCellError {
  /** The column header, so the message names what the shopkeeper can see. */
  readonly column: string;
  readonly message: string;
}

const PRODUCT_COLUMNS: readonly ImportColumn[] = [
  { key: 'name', header: 'Product Name', required: true, example: 'PVC Pipe 1 inch', help: 'The name as you would say it at the counter' },
  { key: 'unit', header: 'Base Unit', required: true, example: 'Piece', help: 'Must already exist in Units' },
  { key: 'purchasePrice', header: 'Purchase Price', required: true, example: '100.00', help: 'What you pay for one base unit' },
  { key: 'sellingPrice', header: 'Selling Price', required: true, example: '150.00', help: 'What you sell one base unit for' },
  { key: 'minStock', header: 'Reorder Level', required: true, example: '10', help: 'Stock level at which the product is flagged low' },
  { key: 'brand', header: 'Brand', required: false, example: 'RFL', help: 'Must already exist in Brands; leave blank if none' },
  { key: 'category', header: 'Category', required: false, example: 'Plumbing', help: 'Must already exist in Categories' },
  { key: 'subcategory', header: 'Subcategory', required: false, example: 'Pipes', help: 'Must already exist under that category' },
  { key: 'sku', header: 'Product Code', required: false, example: 'PIPE-1IN', help: 'Your own code; must be unique' },
  { key: 'barcode', header: 'Barcode', required: false, example: '', help: 'Must be unique; leave blank to add later' },
  { key: 'description', header: 'Description', required: false, example: '', help: 'Optional note about the product' },
];

const CUSTOMER_COLUMNS: readonly ImportColumn[] = [
  { key: 'name', header: 'Customer Name', required: true, example: 'Rahim Traders', help: 'The name as you would say it at the counter' },
  { key: 'phone', header: 'Phone', required: true, example: '01712345678', help: 'Required, and no two customers may share one' },
  { key: 'address', header: 'Address', required: false, example: 'Mirpur 10, Dhaka', help: 'Optional' },
  { key: 'guardianName', header: 'Father/Guardian Name', required: false, example: '', help: 'Optional; hidden if switched off in Settings' },
  { key: 'nid', header: 'NID', required: false, example: '', help: 'Optional; hidden if switched off in Settings' },
  { key: 'email', header: 'Email', required: false, example: '', help: 'Optional' },
  { key: 'group', header: 'Customer Group', required: false, example: '', help: 'Must already exist in Customer Groups' },
  { key: 'creditLimit', header: 'Credit Limit', required: false, example: '', help: 'Optional; leave blank for no limit' },
  { key: 'notes', header: 'Notes', required: false, example: '', help: 'Optional' },
];

const SUPPLIER_COLUMNS: readonly ImportColumn[] = [
  { key: 'name', header: 'Supplier Name', required: true, example: 'Karim Enterprise', help: 'The business you buy from' },
  { key: 'phone', header: 'Phone', required: false, example: '01812345678', help: 'Optional for a supplier' },
  { key: 'address', header: 'Address', required: false, example: 'Nawabpur Road, Dhaka', help: 'Optional' },
  { key: 'email', header: 'Email', required: false, example: '', help: 'Optional' },
  { key: 'notes', header: 'Notes', required: false, example: '', help: 'Optional' },
];

const OPENING_STOCK_COLUMNS: readonly ImportColumn[] = [
  { key: 'name', header: 'Product Name', required: true, example: 'PVC Pipe 1 inch', help: 'A product that already exists' },
  { key: 'sku', header: 'Product Code', required: false, example: 'PIPE-1IN', help: 'Only needed when two products share a name' },
  { key: 'qty', header: 'Quantity', required: true, example: '25', help: 'How many base units you hold right now' },
  { key: 'unitCost', header: 'Unit Cost', required: false, example: '100.00', help: 'What one unit cost you; blank uses the purchase price' },
  { key: 'businessDate', header: 'Opening Date', required: false, example: '', help: 'YYYY-MM-DD; blank means today' },
  { key: 'expiryDate', header: 'Expiry Date', required: false, example: '', help: 'YYYY-MM-DD; required only if the product tracks expiry' },
];

export const IMPORT_COLUMNS: Record<ImportType, readonly ImportColumn[]> = {
  PRODUCTS: PRODUCT_COLUMNS,
  CUSTOMERS: CUSTOMER_COLUMNS,
  SUPPLIERS: SUPPLIER_COLUMNS,
  OPENING_STOCK: OPENING_STOCK_COLUMNS,
};

/**
 * The downloadable template: the header row and one filled example.
 *
 * The example is a row, not a comment, because a shop opens this in Excel and
 * types over the first line. It is deliberately obvious enough to be recognised
 * and deleted, and the importer has no rule that would treat it specially — a
 * file left with the example in it imports the example, which is honest.
 */
export function importTemplate(type: ImportType): string {
  const columns = IMPORT_COLUMNS[type];
  return toCsv([columns.map((column) => column.header), columns.map((column) => column.example)]);
}

/**
 * Which required columns the file does not have.
 *
 * A missing column is a **file** problem, not a row problem: every row would
 * carry the same error, and the fix is to start again from the template.
 * Matching ignores case and surrounding spaces, and unknown columns are left
 * alone — a shop's own working column is not a reason to refuse its data.
 */
export function missingColumns(type: ImportType, header: readonly string[]): readonly string[] {
  const present = new Set(header.map(headerKey));
  return IMPORT_COLUMNS[type]
    .filter((column) => column.required && !present.has(headerKey(column.header)))
    .map((column) => column.header);
}

/** One record's cells, keyed by column key, trimmed. */
export function valuesOf(
  type: ImportType,
  header: readonly string[],
  record: CsvRecord,
): Readonly<Record<string, string>> {
  const position = new Map(header.map((name, index) => [headerKey(name), index]));
  const values: Record<string, string> = {};
  for (const column of IMPORT_COLUMNS[type]) {
    const index = position.get(headerKey(column.header));
    values[column.key] = index === undefined ? '' : (record.cells[index] ?? '').trim();
  }
  return values;
}

function headerKey(header: string): string {
  return header.trim().toLowerCase();
}

export interface ProductImportDraft {
  readonly name: string;
  readonly unitName: string;
  readonly purchasePriceMinor: number;
  readonly sellingPriceMinor: number;
  readonly minStockQty: number;
  readonly brandName: string | null;
  readonly categoryName: string | null;
  readonly subcategoryName: string | null;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly description: string | null;
}

export interface PartyImportDraft {
  readonly name: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly guardianName: string | null;
  readonly nid: string | null;
  readonly email: string | null;
  readonly notes: string | null;
  readonly groupName: string | null;
  readonly creditLimitMinor: number | null;
}

export interface OpeningStockImportDraft {
  readonly productName: string;
  readonly sku: string | null;
  readonly qty: number;
  /** Blank means "value it at the product's purchase price", as the form does. */
  readonly unitCostMinor: number | null;
  readonly businessDate: string | null;
  readonly expiryDate: string | null;
}

export type ImportDraft = ProductImportDraft | PartyImportDraft | OpeningStockImportDraft;

/** A row that could be read, or the reasons it could not. Never both. */
export type ReadRowResult<T> =
  | { readonly ok: true; readonly draft: T }
  | { readonly ok: false; readonly errors: readonly ImportCellError[] };

export function readProductRow(
  values: Readonly<Record<string, string>>,
): ReadRowResult<ProductImportDraft> {
  const errors: ImportCellError[] = [];
  const name = required(values, PRODUCT_COLUMNS, 'name', errors);
  const unitName = required(values, PRODUCT_COLUMNS, 'unit', errors);
  const purchasePriceMinor = money(values, PRODUCT_COLUMNS, 'purchasePrice', true, errors);
  const sellingPriceMinor = money(values, PRODUCT_COLUMNS, 'sellingPrice', true, errors);
  const minStockQty = quantity(values, PRODUCT_COLUMNS, 'minStock', true, errors);

  // A subcategory with no category above it has nowhere to be filed (§5.5 fixes
  // the depth at two), and silently promoting it to a top-level category would
  // put the product under a group the shopkeeper never created.
  const category = blank(values['category']);
  const subcategory = blank(values['subcategory']);
  if (subcategory !== null && category === null) {
    errors.push({ column: 'Subcategory', message: 'Fill in the Category this subcategory belongs to' });
  }

  if (
    errors.length > 0 ||
    purchasePriceMinor === null ||
    sellingPriceMinor === null ||
    minStockQty === null
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    draft: {
      name,
      unitName,
      purchasePriceMinor,
      sellingPriceMinor,
      minStockQty,
      brandName: blank(values['brand']),
      categoryName: category,
      subcategoryName: subcategory,
      sku: blank(values['sku']),
      barcode: blank(values['barcode']),
      description: blank(values['description']),
    },
  };
}

export function readCustomerRow(
  values: Readonly<Record<string, string>>,
): ReadRowResult<PartyImportDraft> {
  const errors: ImportCellError[] = [];
  const name = required(values, CUSTOMER_COLUMNS, 'name', errors);
  // D-02: a customer's phone is mandatory and unique. The rule itself lives in
  // the domain's `rejectParty`; what this checks is that the cell was filled at
  // all, so the preview can say which row is empty rather than which is invalid.
  const phone = required(values, CUSTOMER_COLUMNS, 'phone', errors);
  const creditLimitMinor = money(values, CUSTOMER_COLUMNS, 'creditLimit', false, errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      name,
      phone,
      address: blank(values['address']),
      guardianName: blank(values['guardianName']),
      nid: blank(values['nid']),
      email: blank(values['email']),
      notes: blank(values['notes']),
      groupName: blank(values['group']),
      creditLimitMinor,
    },
  };
}

export function readSupplierRow(
  values: Readonly<Record<string, string>>,
): ReadRowResult<PartyImportDraft> {
  const errors: ImportCellError[] = [];
  const name = required(values, SUPPLIER_COLUMNS, 'name', errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      name,
      phone: blank(values['phone']),
      address: blank(values['address']),
      guardianName: null,
      nid: null,
      email: blank(values['email']),
      notes: blank(values['notes']),
      groupName: null,
      creditLimitMinor: null,
    },
  };
}

export function readOpeningStockRow(
  values: Readonly<Record<string, string>>,
): ReadRowResult<OpeningStockImportDraft> {
  const errors: ImportCellError[] = [];
  const productName = required(values, OPENING_STOCK_COLUMNS, 'name', errors);
  const qty = quantity(values, OPENING_STOCK_COLUMNS, 'qty', true, errors);
  const unitCostMinor = money(values, OPENING_STOCK_COLUMNS, 'unitCost', false, errors);
  const businessDate = calendarDate(values, OPENING_STOCK_COLUMNS, 'businessDate', errors);
  const expiryDate = calendarDate(values, OPENING_STOCK_COLUMNS, 'expiryDate', errors);

  // Opening stock of nothing is not an opening. `openingStockPosting` refuses it
  // anyway — this only says so in the preview, before the file is posted.
  if (qty !== null && qty <= 0) {
    errors.push({ column: 'Quantity', message: 'Enter how much is in stock — zero opens nothing' });
  }

  if (errors.length > 0 || qty === null) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      productName,
      sku: blank(values['sku']),
      qty,
      unitCostMinor,
      businessDate,
      expiryDate,
    },
  };
}

function headerOf(columns: readonly ImportColumn[], key: string): string {
  return columns.find((column) => column.key === key)?.header ?? key;
}

/**
 * A cell as a value, or `null` when there is nothing in it.
 *
 * Trims here as well as in `valuesOf`, so a cell holding only spaces is empty
 * to every caller — a name of three spaces is not a name, whichever route the
 * row arrived by.
 */
function blank(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function required(
  values: Readonly<Record<string, string>>,
  columns: readonly ImportColumn[],
  key: string,
  errors: ImportCellError[],
): string {
  const value = blank(values[key]);
  if (value === null) errors.push({ column: headerOf(columns, key), message: 'This cannot be empty' });
  return value ?? '';
}

function money(
  values: Readonly<Record<string, string>>,
  columns: readonly ImportColumn[],
  key: string,
  isRequired: boolean,
  errors: ImportCellError[],
): number | null {
  const column = headerOf(columns, key);
  const raw = blank(values[key]);
  if (raw === null) {
    if (isRequired) errors.push({ column, message: 'This cannot be empty' });
    return null;
  }
  // `parseMoney` refuses a third decimal rather than rounding it away, which is
  // exactly right for a file: a price nobody meant is worse than a rejected row.
  const minor = parseMoney(raw);
  if (minor === null) {
    errors.push({ column, message: `"${raw}" is not an amount — write it like 150.75` });
    return null;
  }
  if (minor < 0) {
    errors.push({ column, message: 'This cannot be less than zero' });
    return null;
  }
  return minor;
}

function quantity(
  values: Readonly<Record<string, string>>,
  columns: readonly ImportColumn[],
  key: string,
  isRequired: boolean,
  errors: ImportCellError[],
): number | null {
  const column = headerOf(columns, key);
  const raw = blank(values[key]);
  if (raw === null) {
    if (isRequired) errors.push({ column, message: 'This cannot be empty' });
    return null;
  }
  const scaled = parseQty(raw);
  if (scaled === null) {
    errors.push({ column, message: `"${raw}" is not a quantity — write it like 25 or 2.5` });
    return null;
  }
  if (scaled < 0) {
    errors.push({ column, message: 'This cannot be less than zero' });
    return null;
  }
  return scaled;
}

function calendarDate(
  values: Readonly<Record<string, string>>,
  columns: readonly ImportColumn[],
  key: string,
  errors: ImportCellError[],
): string | null {
  const raw = blank(values[key]);
  if (raw === null) return null;
  if (!isCalendarDate(raw)) {
    errors.push({
      column: headerOf(columns, key),
      message: `"${raw}" is not a date — write it like 2026-08-21`,
    });
    return null;
  }
  return raw;
}

/**
 * A real day, written the one way the whole system writes days (§3.5).
 *
 * Checked by arithmetic rather than by constructing a `Date`, because
 * `core-domain` may not (R-C8) — and because `new Date('2026-02-31')` quietly
 * becomes the 3rd of March, which is precisely the silent shift a stock opening
 * must never make.
 */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
