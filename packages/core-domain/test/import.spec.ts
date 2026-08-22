import { describe, expect, it } from 'vitest';

import {
  IMPORT_COLUMNS,
  importTemplate,
  isCalendarDate,
  missingColumns,
  parseCsv,
  readCustomerRow,
  readOpeningStockRow,
  readProductRow,
  readSupplierRow,
  toCsv,
  valuesOf,
} from '../src/index';
import type { CsvTable } from '../src/index';

/**
 * The onboarding file (§5.6).
 *
 * This is the layer a shop's own spreadsheet meets first, so the cases here are
 * the ones a real export produces: a byte-order mark, `\r\n` endings, an
 * address with a comma in it, a price with a currency separator, and a date
 * that does not exist.
 */

const tableOf = (text: string): CsvTable => {
  const result = parseCsv(text);
  if (!result.ok) throw new Error(`expected a table, got ${result.rejection}`);
  return result.table;
};

describe('parseCsv', () => {
  it('reads what Excel writes: a BOM, CRLF endings and a trailing newline', () => {
    const table = tableOf('﻿Product Name,Base Unit\r\nPVC Pipe,Piece\r\n');
    expect(table.header).toEqual(['Product Name', 'Base Unit']);
    expect(table.records).toEqual([{ rowNumber: 2, cells: ['PVC Pipe', 'Piece'] }]);
  });

  it('keeps a comma, a newline and a quote that are inside a quoted field', () => {
    const table = tableOf('Name,Address\r\n"Rahim Traders","Mirpur 10, Dhaka"\r\n"A ""B""","Line 1\nLine 2"');
    expect(table.records[0]?.cells).toEqual(['Rahim Traders', 'Mirpur 10, Dhaka']);
    expect(table.records[1]?.cells).toEqual(['A "B"', 'Line 1\nLine 2']);
  });

  /*
   * A blank line in the middle of an export is normal, and the row numbers
   * after it must still be the ones the spreadsheet shows — the whole value of
   * a preview is "row 4 is wrong" being a sentence someone can act on.
   */
  it('drops blank lines without renumbering the rows after them', () => {
    const table = tableOf('Name\r\nOne\r\n\r\nThree\r\n');
    expect(table.records).toEqual([
      { rowNumber: 2, cells: ['One'] },
      { rowNumber: 4, cells: ['Three'] },
    ]);
  });

  it('refuses an empty file, a header with no rows, and an unclosed quote', () => {
    expect(parseCsv('   ')).toEqual({ ok: false, rejection: 'FILE_IS_EMPTY' });
    expect(parseCsv('Name,Phone\r\n')).toEqual({ ok: false, rejection: 'FILE_HAS_NO_ROWS' });
    expect(parseCsv('Name\r\n"unterminated')).toEqual({ ok: false, rejection: 'UNCLOSED_QUOTE' });
  });

  it('reads back everything it writes', () => {
    const rows = [
      ['Name', 'Address'],
      ['A "B"', 'Mirpur 10, Dhaka\nFlat 3'],
    ];
    const table = tableOf(toCsv(rows));
    expect([table.header, ...table.records.map((record) => record.cells)]).toEqual(rows);
  });
});

describe('the file shape', () => {
  it('names every required column the file is missing, ignoring case and spaces', () => {
    expect(missingColumns('PRODUCTS', [' product name ', 'BASE UNIT', 'Purchase Price', 'Selling Price', 'Reorder Level'])).toEqual([]);
    expect(missingColumns('PRODUCTS', ['Product Name'])).toEqual([
      'Base Unit',
      'Purchase Price',
      'Selling Price',
      'Reorder Level',
    ]);
  });

  // A shop's own working column is not a reason to refuse its data.
  it('ignores a column the template does not know', () => {
    const table = tableOf('Customer Name,Phone,Old System Id\r\nRahim,01712345678,X-99');
    const record = table.records[0];
    if (record === undefined) throw new Error('expected a row');
    expect(valuesOf('CUSTOMERS', table.header, record)).toMatchObject({
      name: 'Rahim',
      phone: '01712345678',
    });
  });

  it('produces a template this importer can read back', () => {
    for (const type of ['PRODUCTS', 'CUSTOMERS', 'SUPPLIERS', 'OPENING_STOCK'] as const) {
      const table = tableOf(importTemplate(type));
      expect(missingColumns(type, table.header)).toEqual([]);
      expect(table.header).toEqual(IMPORT_COLUMNS[type].map((column) => column.header));
    }
  });
});

describe('readProductRow', () => {
  const values = {
    name: 'PVC Pipe 1 inch',
    unit: 'Piece',
    purchasePrice: '1,250.75',
    sellingPrice: '1500',
    minStock: '10',
    brand: 'RFL',
    category: 'Plumbing',
    subcategory: 'Pipes',
    sku: 'PIPE-1IN',
    barcode: '',
    description: '',
  };

  it('reads money and quantity as exact minor units', () => {
    const result = readProductRow(values);
    if (!result.ok) throw new Error('expected the row to read');
    expect(result.draft.purchasePriceMinor).toBe(125_075);
    expect(result.draft.sellingPriceMinor).toBe(150_000);
    expect(result.draft.minStockQty).toBe(10_000);
    expect(result.draft.barcode).toBeNull();
    expect(result.draft.brandName).toBe('RFL');
  });

  it('names the column a shopkeeper can see when a cell is empty or not a number', () => {
    const result = readProductRow({ ...values, name: '  ', purchasePrice: 'one fifty' });
    if (result.ok) throw new Error('expected the row to be refused');
    expect(result.errors).toEqual([
      { column: 'Product Name', message: 'This cannot be empty' },
      { column: 'Purchase Price', message: '"one fifty" is not an amount — write it like 150.75' },
    ]);
  });

  // 150.756 is not an amount of poisha. Rounding it here would lose a fraction
  // nobody was told about — the same rule `parseMoney` applies to a typed price.
  it('refuses a third decimal rather than rounding it away', () => {
    const result = readProductRow({ ...values, sellingPrice: '150.756' });
    expect(result.ok).toBe(false);
  });

  it('refuses a subcategory with no category above it', () => {
    const result = readProductRow({ ...values, category: '', subcategory: 'Pipes' });
    if (result.ok) throw new Error('expected the row to be refused');
    expect(result.errors).toEqual([
      { column: 'Subcategory', message: 'Fill in the Category this subcategory belongs to' },
    ]);
  });
});

describe('readCustomerRow and readSupplierRow', () => {
  it('demands a customer phone (D-02) and accepts a supplier without one', () => {
    const customer = readCustomerRow({ name: 'Rahim Traders', phone: '' });
    if (customer.ok) throw new Error('expected the customer row to be refused');
    expect(customer.errors).toEqual([{ column: 'Phone', message: 'This cannot be empty' }]);

    const supplier = readSupplierRow({ name: 'Karim Enterprise', phone: '' });
    if (!supplier.ok) throw new Error('expected the supplier row to read');
    expect(supplier.draft.phone).toBeNull();
  });

  it('reads an optional credit limit as poisha and leaves a blank one unset', () => {
    const withLimit = readCustomerRow({ name: 'A', phone: '01712345678', creditLimit: '5000' });
    if (!withLimit.ok) throw new Error('expected the row to read');
    expect(withLimit.draft.creditLimitMinor).toBe(500_000);

    const without = readCustomerRow({ name: 'A', phone: '01712345678', creditLimit: '' });
    if (!without.ok) throw new Error('expected the row to read');
    expect(without.draft.creditLimitMinor).toBeNull();
  });

  // §5.6 gives a supplier no group and no credit limit; those are customer
  // fields, and a supplier file that carried them would be inventing a rule.
  it('leaves the customer-only fields unset on a supplier', () => {
    const supplier = readSupplierRow({ name: 'Karim Enterprise' });
    if (!supplier.ok) throw new Error('expected the row to read');
    expect(supplier.draft.groupName).toBeNull();
    expect(supplier.draft.creditLimitMinor).toBeNull();
    expect(supplier.draft.nid).toBeNull();
  });
});

describe('readOpeningStockRow', () => {
  it('reads a quantity, an optional cost and optional dates', () => {
    const result = readOpeningStockRow({
      name: 'PVC Pipe 1 inch',
      sku: 'PIPE-1IN',
      qty: '2.5',
      unitCost: '100',
      businessDate: '2026-08-21',
      expiryDate: '',
    });
    if (!result.ok) throw new Error('expected the row to read');
    expect(result.draft).toEqual({
      productName: 'PVC Pipe 1 inch',
      sku: 'PIPE-1IN',
      qty: 2_500,
      unitCostMinor: 10_000,
      businessDate: '2026-08-21',
      expiryDate: null,
    });
  });

  it('refuses an opening of nothing', () => {
    const result = readOpeningStockRow({ name: 'A', qty: '0' });
    if (result.ok) throw new Error('expected the row to be refused');
    expect(result.errors).toEqual([
      { column: 'Quantity', message: 'Enter how much is in stock — zero opens nothing' },
    ]);
  });

  it('refuses a day that does not exist rather than shifting it', () => {
    const result = readOpeningStockRow({ name: 'A', qty: '5', businessDate: '2026-02-31' });
    if (result.ok) throw new Error('expected the row to be refused');
    expect(result.errors).toEqual([
      { column: 'Opening Date', message: '"2026-02-31" is not a date — write it like 2026-08-21' },
    ]);
  });
});

describe('isCalendarDate', () => {
  it('accepts real days and refuses impossible ones', () => {
    expect(isCalendarDate('2026-08-21')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2000-02-29')).toBe(true);
    expect(isCalendarDate('1900-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
    expect(isCalendarDate('21-08-2026')).toBe(false);
  });
});
