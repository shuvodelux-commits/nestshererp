import {
  IMPORT_COLUMNS,
  missingColumns,
  parseCsv,
  readCustomerRow,
  readOpeningStockRow,
  readProductRow,
  readSupplierRow,
  valuesOf,
} from '@sher/core-domain';
import type {
  CsvRejection,
  CsvTable,
  ImportCellError,
  ImportType,
  PartyImportDraft,
} from '@sher/core-domain';
import { AppError, ErrorCode, IMPORT_MAX_ROWS, Permission } from '@sher/core-contracts';
import type { ImportPreviewResponse, ImportResultResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { CatalogRepository, CategoryEntry } from '../catalog/catalog-repository';
import type { ManageProductsService, ProductInput } from '../catalog/manage-products-service';
import type { ProductRepository } from '../catalog/product-repository';
import type { ManageInventoryService } from '../inventory/manage-inventory-service';
import type { ManagePartiesService, PartyInput } from '../parties/manage-parties-service';
import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';

/**
 * The guided onboarding import (§5.6, path 2.4 and Phase 3's opening-stock CSV
 * step).
 *
 * **This service creates nothing itself.** Every row goes through the use case
 * that already owns that record — `ManageProductsService.createWithin`,
 * `ManagePartiesService.createWithin`, `ManageInventoryService.recordOpeningWithin`
 * — so an imported product obeys the same validation, permissions, audit and
 * outbox rules as one typed into the form, and an opening quantity becomes a
 * real stock movement with a real journal entry behind it. §5.6 puts it
 * plainly: "an import must never write balances or stock directly", and INV-02
 * and INV-05 would both break the moment it did.
 *
 * **The whole file is one transaction** (R-D5), which is what "posting is
 * all-or-nothing per file" means: a row that fails takes the file down with it
 * and nothing at all is left behind. That is why the owning services expose an
 * inside-transaction method — calling their public `create` once per row would
 * commit each row separately, and a file that half-posted is exactly the state
 * a migration must never end in.
 *
 * The preview runs the identical evaluation and posts nothing. A row that
 * previews clean is a row that will post, barring another user changing the
 * same data in between.
 */

export interface ImportCommand {
  readonly ctx: TenantContext;
  readonly type: ImportType;
  /** The file, as text. The browser reads it; the server never sees an upload. */
  readonly csv: string;
}

export interface CommitImportCommand extends ImportCommand {
  /** One id for the whole file (§5.6: "idempotent on the supplied import operation ID"). */
  readonly operationId: string;
}

/** Which trust each file needs. The owning use case checks it again on every row. */
const IMPORT_PERMISSIONS: Record<ImportType, string> = {
  PRODUCTS: Permission.PRODUCT_CREATE,
  CUSTOMERS: Permission.CUSTOMER_CREATE,
  SUPPLIERS: Permission.SUPPLIER_CREATE,
  // An opening is a stock document about a product, and `recordOpeningWithin`
  // requires exactly this.
  OPENING_STOCK: Permission.PRODUCT_CREATE,
};

const FILE_REFUSALS: Record<CsvRejection, string> = {
  FILE_IS_EMPTY: 'That file is empty — download the template and fill it in',
  FILE_HAS_NO_ROWS: 'That file has column headings but no rows',
  UNCLOSED_QUOTE: 'That file has a quotation mark that was never closed, so its rows cannot be read',
};

/**
 * One row, evaluated. `post` is present exactly when `errors` is empty — the
 * work the row would do, ready to run inside the caller's transaction, so the
 * preview and the posting can never disagree about what a row means.
 */
interface EvaluatedRow {
  readonly rowNumber: number;
  readonly values: Readonly<Record<string, string>>;
  readonly errors: readonly ImportCellError[];
  readonly post: ((tx: Tx) => Promise<void>) | null;
}

export class ImportDataService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly catalog: CatalogRepository,
    private readonly products: ProductRepository,
    private readonly parties: PartyRepository,
    /** The owning use cases. This service is a caller, never a second writer. */
    private readonly productsService: ManageProductsService,
    private readonly partiesService: ManagePartiesService,
    private readonly inventoryService: ManageInventoryService,
  ) {}

  /** What the file would do. Writes nothing (§5.6's preview step). */
  async preview(command: ImportCommand): Promise<ImportPreviewResponse> {
    const { ctx, type } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, IMPORT_PERMISSIONS[type]);

      const columns = IMPORT_COLUMNS[type].map((column) => ({
        key: column.key,
        header: column.header,
        required: column.required,
        help: column.help,
      }));

      const table = this.readFile(command.csv);
      const missing = missingColumns(type, table.header);
      if (missing.length > 0) {
        return {
          type,
          columns,
          rows: [],
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          missingColumns: [...missing],
        };
      }

      const rows = await this.evaluate(tx, ctx, type, table);
      return {
        type,
        columns,
        rows: rows.map((row) => ({
          rowNumber: row.rowNumber,
          values: { ...row.values },
          errors: row.errors.map((error) => ({ ...error })),
        })),
        totalRows: rows.length,
        validRows: rows.filter((row) => row.errors.length === 0).length,
        invalidRows: rows.filter((row) => row.errors.length > 0).length,
        missingColumns: [],
      };
    });
  }

  /**
   * Posts the file, or nothing at all.
   *
   * Every row is evaluated before any row is written, so a file with a problem
   * on its last line never leaves the first line behind: the refusal happens
   * before the first insert rather than relying on the rollback, and the
   * shopkeeper is told which rows to fix.
   */
  async commit(command: CommitImportCommand): Promise<ImportResultResponse> {
    const { ctx, type } = command;
    const fingerprint = JSON.stringify([type, command.csv.length]);

    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, IMPORT_PERMISSIONS[type]);

      /*
       * §5.6: "idempotent on the supplied import operation ID". A shop with a
       * slow connection pressing Import twice must not import twice, and here
       * the 30-day fast path is the whole guarantee — an import creates many
       * records and has no single document row to hang a permanent unique index
       * on. What protects a late replay instead is the data itself: a repeated
       * product code or customer phone is refused, and a product may hold only
       * one opening (§5.10).
       */
      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This import id was already used for a different file',
          );
        }
        return replayed.response as ImportResultResponse;
      }

      const table = this.readFile(command.csv);
      const missing = missingColumns(type, table.header);
      if (missing.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `That file is missing the ${missing.join(', ')} column${missing.length > 1 ? 's' : ''} — download the template and start from it`,
        );
      }

      const rows = await this.evaluate(tx, ctx, type, table);
      const bad = rows.filter((row) => row.errors.length > 0);
      if (bad.length > 0) throw refusal(bad);

      for (const row of rows) {
        // `post` is non-null exactly when the row has no errors, and every row
        // has been checked by now.
        await row.post?.(tx);
      }

      const response: ImportResultResponse = { type, rows: rows.length, imported: rows.length };

      await this.audit.append(tx, ctx, {
        entityType: 'data_import',
        entityId: command.operationId,
        action: 'IMPORT',
        before: null,
        after: { type, rows: rows.length },
        source: 'IMPORT',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'data.imported',
        aggregateType: 'data_import',
        aggregateId: command.operationId,
        payload: { type, rows: String(rows.length) },
      });
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }

  private readFile(csv: string): CsvTable {
    const parsed = parseCsv(csv);
    if (!parsed.ok) throw new AppError(ErrorCode.VALIDATION_FAILED, FILE_REFUSALS[parsed.rejection]);
    if (parsed.table.records.length > IMPORT_MAX_ROWS) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `That file has ${parsed.table.records.length} rows — import at most ${IMPORT_MAX_ROWS} at a time`,
      );
    }
    return parsed.table;
  }

  private async evaluate(
    tx: Tx,
    ctx: TenantContext,
    type: ImportType,
    table: CsvTable,
  ): Promise<readonly EvaluatedRow[]> {
    switch (type) {
      case 'PRODUCTS':
        return this.evaluateProducts(tx, ctx, table);
      case 'CUSTOMERS':
      case 'SUPPLIERS':
        return this.evaluateParties(tx, ctx, type, table);
      case 'OPENING_STOCK':
        return this.evaluateOpeningStock(tx, ctx, table);
    }
  }

  private async evaluateProducts(
    tx: Tx,
    ctx: TenantContext,
    table: CsvTable,
  ): Promise<readonly EvaluatedRow[]> {
    /*
     * The tenant's own vocabulary, read once for the whole file rather than a
     * query per row. Unknown names are **refused, never created**: a file that
     * quietly added "Kilogrm" to Units would leave a typo in the master data of
     * every later purchase, and inventing master data nobody confirmed is not a
     * rule the SRS gives this importer (R-A5). The preview names every missing
     * one at once, so they can be added in a single pass.
     */
    const [units, brands, categories] = await Promise.all([
      this.catalog.listUnits(tx, ctx),
      this.catalog.listBrands(tx, ctx),
      this.catalog.listCategories(tx, ctx),
    ]);
    const unitsByName = byName(units);
    const brandsByName = byName(brands);
    const column = columnHeaders('PRODUCTS');

    const seenSkus = new Map<string, number>();
    const seenBarcodes = new Map<string, number>();
    const rows: EvaluatedRow[] = [];

    for (const record of table.records) {
      const values = valuesOf('PRODUCTS', table.header, record);
      const read = readProductRow(values);
      if (!read.ok) {
        rows.push({ rowNumber: record.rowNumber, values, errors: read.errors, post: null });
        continue;
      }

      const draft = read.draft;
      const errors: ImportCellError[] = [];

      const baseUnitId = unitsByName.get(key(draft.unitName)) ?? null;
      if (baseUnitId === null) {
        errors.push({ column: column('unit'), message: unknown('unit', draft.unitName, 'Units') });
      }

      let brandId: string | null = null;
      if (draft.brandName !== null) {
        brandId = brandsByName.get(key(draft.brandName)) ?? null;
        if (brandId === null) {
          errors.push({ column: column('brand'), message: unknown('brand', draft.brandName, 'Brands') });
        }
      }

      const categoryId = this.resolveCategory(categories, draft.categoryName, draft.subcategoryName, column, errors);

      // Two rows of one file claiming the same code is a mistake in the file,
      // and nothing in the database would catch it until the second row was
      // already being written. Named with the row it clashes with, because
      // "duplicate code" alone means opening the spreadsheet and searching.
      duplicateInFile(draft.sku, record.rowNumber, seenSkus, column('sku'), 'code', errors);
      duplicateInFile(draft.barcode, record.rowNumber, seenBarcodes, column('barcode'), 'barcode', errors);

      if (errors.length > 0 || baseUnitId === null) {
        rows.push({ rowNumber: record.rowNumber, values, errors, post: null });
        continue;
      }

      const input: ProductInput = {
        name: draft.name,
        baseUnitId,
        purchasePriceMinor: draft.purchasePriceMinor,
        sellingPriceMinor: draft.sellingPriceMinor,
        minStockQty: draft.minStockQty,
        brandId,
        categoryId,
        sku: draft.sku,
        barcode: draft.barcode,
        description: draft.description,
        // Offers, expiry, serial tracking, unit conversion and the Phase 8
        // planner/warranty fields are deliberately not columns in this template:
        // each is behind its own §5.21 feature or is a decision belonging to the
        // product's own screen, where the shopkeeper can see what they are
        // switching on. An import that guessed them would switch on features
        // nobody asked for, across a whole catalogue at once.
        defaultDiscountType: null,
        defaultDiscountValue: null,
        offerEnabled: false,
        offerPriceMinor: null,
        offerStartDate: null,
        offerEndDate: null,
        tracksExpiry: false,
        tracksSerial: false,
        conversionUnitId: null,
        conversionFactorQty: null,
        usualSupplierId: null,
        minOrderQty: null,
        warrantyMonths: null,
        supplierWarrantyMonths: null,
      };

      const rejection = await this.check(() => this.productsService.validate(tx, ctx, input, null));
      rows.push(
        rejection === null
          ? {
              rowNumber: record.rowNumber,
              values,
              errors: [],
              post: async (work: Tx) => {
                await this.productsService.createWithin(work, ctx, input, 'IMPORT');
              },
            }
          : { rowNumber: record.rowNumber, values, errors: [rejection], post: null },
      );
    }

    return rows;
  }

  private resolveCategory(
    categories: readonly CategoryEntry[],
    categoryName: string | null,
    subcategoryName: string | null,
    column: (key: string) => string,
    errors: ImportCellError[],
  ): string | null {
    if (categoryName === null) return null;

    const parent = categories.find(
      (entry) => entry.parentId === null && key(entry.name) === key(categoryName),
    );
    if (parent === undefined) {
      errors.push({ column: column('category'), message: unknown('category', categoryName, 'Categories') });
      return null;
    }
    if (subcategoryName === null) return parent.id;

    const child = categories.find(
      (entry) => entry.parentId === parent.id && key(entry.name) === key(subcategoryName),
    );
    if (child === undefined) {
      errors.push({
        column: column('subcategory'),
        message: `There is no subcategory "${subcategoryName}" under ${parent.name} — add it in Categories first`,
      });
      return null;
    }
    // The deepest one, which is what the product form stores: a product filed
    // under a subcategory is not also filed under its parent twice.
    return child.id;
  }

  private async evaluateParties(
    tx: Tx,
    ctx: TenantContext,
    type: 'CUSTOMERS' | 'SUPPLIERS',
    table: CsvTable,
  ): Promise<readonly EvaluatedRow[]> {
    const groups = type === 'CUSTOMERS' ? await this.parties.listGroups(tx, ctx) : [];
    const groupsByName = byName(groups);
    const column = columnHeaders(type);
    const seenPhones = new Map<string, number>();
    const rows: EvaluatedRow[] = [];

    for (const record of table.records) {
      const values = valuesOf(type, table.header, record);
      const read = type === 'CUSTOMERS' ? readCustomerRow(values) : readSupplierRow(values);
      if (!read.ok) {
        rows.push({ rowNumber: record.rowNumber, values, errors: read.errors, post: null });
        continue;
      }

      const draft: PartyImportDraft = read.draft;
      const errors: ImportCellError[] = [];

      let customerGroupId: string | null = null;
      if (draft.groupName !== null) {
        customerGroupId = groupsByName.get(key(draft.groupName)) ?? null;
        if (customerGroupId === null) {
          errors.push({
            column: column('group'),
            message: unknown('customer group', draft.groupName, 'Customer Groups'),
          });
        }
      }

      // D-02 makes a customer's phone unique, and the database enforces it — but
      // only against rows that already exist. Two rows of one file are caught
      // here, where the message can name both.
      if (type === 'CUSTOMERS') {
        duplicateInFile(draft.phone, record.rowNumber, seenPhones, column('phone'), 'phone number', errors);
      }

      const input: PartyInput = {
        name: draft.name,
        roles: [type === 'CUSTOMERS' ? 'CUSTOMER' : 'SUPPLIER'],
        phone: draft.phone,
        address: draft.address,
        guardianName: draft.guardianName,
        nid: draft.nid,
        email: draft.email,
        notes: draft.notes,
        customerGroupId,
        creditLimitMinor: draft.creditLimitMinor,
      };

      if (errors.length === 0) {
        const rejection = await this.check(() => this.partiesService.validate(tx, ctx, input, null));
        if (rejection !== null) errors.push(rejection);
      }

      rows.push(
        errors.length === 0
          ? {
              rowNumber: record.rowNumber,
              values,
              errors: [],
              post: async (work: Tx) => {
                await this.partiesService.createWithin(work, ctx, input, 'IMPORT');
              },
            }
          : { rowNumber: record.rowNumber, values, errors, post: null },
      );
    }

    return rows;
  }

  private async evaluateOpeningStock(
    tx: Tx,
    ctx: TenantContext,
    table: CsvTable,
  ): Promise<readonly EvaluatedRow[]> {
    const column = columnHeaders('OPENING_STOCK');
    const seenProducts = new Map<string, number>();
    const rows: EvaluatedRow[] = [];

    for (const record of table.records) {
      const values = valuesOf('OPENING_STOCK', table.header, record);
      const read = readOpeningStockRow(values);
      if (!read.ok) {
        rows.push({ rowNumber: record.rowNumber, values, errors: read.errors, post: null });
        continue;
      }

      const draft = read.draft;
      const errors: ImportCellError[] = [];
      const productId = await this.resolveProduct(tx, ctx, draft.productName, draft.sku, column, errors);

      // §5.10 allows a product exactly one opening. Two rows for the same
      // product would be refused by the second insert; saying so in the preview
      // is the difference between a fixable file and a failed import.
      if (productId !== null) {
        const earlier = seenProducts.get(productId);
        if (earlier !== undefined) {
          errors.push({
            column: column('name'),
            message: `Row ${earlier} already opens this product, and a product can have only one opening`,
          });
        } else {
          seenProducts.set(productId, record.rowNumber);
        }
      }

      if (errors.length > 0 || productId === null) {
        rows.push({ rowNumber: record.rowNumber, values, errors, post: null });
        continue;
      }

      const opening = {
        productId,
        qty: draft.qty,
        unitCostMinor: draft.unitCostMinor,
        businessDate: draft.businessDate ?? undefined,
        expiryDate: draft.expiryDate,
        source: 'IMPORT',
      };

      rows.push({
        rowNumber: record.rowNumber,
        values,
        errors: [],
        post: async (work: Tx) => {
          await this.inventoryService.recordOpeningWithin(work, ctx, {
            // Each opening keeps its own permanent operation id (R-C10); the
            // file's id belongs to the import, not to any one document.
            operationId: Ulid.generate(this.clock),
            ...opening,
          });
        },
      });
    }

    return rows;
  }

  private async resolveProduct(
    tx: Tx,
    ctx: TenantContext,
    name: string,
    sku: string | null,
    column: (key: string) => string,
    errors: ImportCellError[],
  ): Promise<string | null> {
    if (sku !== null) {
      const bySku = await this.products.findIdBySku(tx, ctx, sku);
      if (bySku === null) {
        errors.push({ column: column('sku'), message: `No product has the code "${sku}"` });
        return null;
      }
      return bySku;
    }

    const byName = await this.products.findIdsByName(tx, ctx, name);
    const first = byName[0];
    if (first === undefined) {
      errors.push({
        column: column('name'),
        message: `There is no product called "${name}" — import the products first`,
      });
      return null;
    }
    if (byName.length > 1) {
      // Picking one would open the stock against the wrong item, and nothing
      // afterwards would look wrong enough to notice.
      errors.push({
        column: column('name'),
        message: `${byName.length} products are called "${name}" — add its Product Code to say which`,
      });
      return null;
    }
    return first;
  }

  /**
   * Runs one owning-service validation and turns its refusal into a cell error.
   *
   * The rules stay where they are: this asks the product and party use cases
   * the same question the form asks them, so an imported row is refused for
   * exactly the reasons a typed one is, in the same words.
   */
  private async check(validate: () => Promise<unknown>): Promise<ImportCellError | null> {
    try {
      await validate();
      return null;
    } catch (error) {
      if (error instanceof AppError) return { column: 'Row', message: error.message };
      throw error;
    }
  }
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

function byName(entries: readonly { readonly id: string; readonly name: string }[]): Map<string, string> {
  return new Map(entries.map((entry) => [key(entry.name), entry.id]));
}

/** The header a shopkeeper sees for one column key, so a message names what is on screen. */
function columnHeaders(type: ImportType): (key: string) => string {
  const headers = new Map(IMPORT_COLUMNS[type].map((column) => [column.key, column.header]));
  return (key: string) => headers.get(key) ?? key;
}

function unknown(what: string, name: string, screen: string): string {
  return `There is no ${what} called "${name}" — add it in ${screen} first`;
}

function duplicateInFile(
  value: string | null,
  rowNumber: number,
  seen: Map<string, number>,
  column: string,
  what: string,
  errors: ImportCellError[],
): void {
  if (value === null) return;
  const earlier = seen.get(key(value));
  if (earlier !== undefined) {
    errors.push({ column, message: `Row ${earlier} already uses this ${what}` });
    return;
  }
  seen.set(key(value), rowNumber);
}

/**
 * The refusal a whole file gets. It names the first few rows rather than all of
 * them — the preview is where the complete list lives, and an error message
 * with two hundred lines in it is one nobody reads.
 */
function refusal(bad: readonly EvaluatedRow[]): AppError {
  const named = bad
    .slice(0, 3)
    .map((row) => `row ${row.rowNumber} (${row.errors[0]?.message ?? 'invalid'})`)
    .join(', ');
  const rest = bad.length > 3 ? `, and ${bad.length - 3} more` : '';
  return new AppError(
    ErrorCode.VALIDATION_FAILED,
    `Nothing was imported: ${named}${rest}. Fix the file and preview it again.`,
    { invalidRows: String(bad.length) },
  );
}
