import { z } from 'zod';

/**
 * The guided onboarding import (§5.6): "a downloadable template, preview,
 * per-row validation and a final summary before posting".
 *
 * Two endpoints over one file. `preview` writes nothing and answers what would
 * happen; `commit` posts the whole file or none of it. Both take the file as
 * **text**, not as a multipart upload: the browser reads the file it was given,
 * so the server never handles an upload stream, and the same string the
 * shopkeeper previewed is the one that posts.
 */

/**
 * The four onboarding files that exist today. Opening receivables, payables,
 * cash and bank are named by §5.6 as well, and arrive with the Phase 4 posting
 * services that can give them a journal entry — they are absent here rather
 * than accepted and ignored.
 */
export const importTypeSchema = z.enum(['PRODUCTS', 'CUSTOMERS', 'SUPPLIERS', 'OPENING_STOCK']);
export type ImportTypeValue = z.infer<typeof importTypeSchema>;

/**
 * How much of a file one request may carry.
 *
 * A whole file posts in one transaction (R-D5), so its size is how long that
 * transaction holds its locks. 2,000 rows covers a shop's catalogue several
 * times over; a larger migration is split into files, which is also how a
 * shopkeeper can tell which half failed.
 */
export const IMPORT_MAX_ROWS = 2_000;
export const IMPORT_MAX_CHARACTERS = 2_000_000;

const csvSchema = z.string().min(1).max(IMPORT_MAX_CHARACTERS);

export const importRequestSchema = z
  .object({ type: importTypeSchema, csv: csvSchema })
  .strict();
export type ImportRequest = z.infer<typeof importRequestSchema>;

export const importColumnSchema = z
  .object({
    key: z.string(),
    header: z.string(),
    required: z.boolean(),
    help: z.string(),
  })
  .strict();
export type ImportColumnDescription = z.infer<typeof importColumnSchema>;

export const importCellErrorSchema = z
  .object({ column: z.string(), message: z.string() })
  .strict();
export type ImportCellErrorResponse = z.infer<typeof importCellErrorSchema>;

export const importPreviewRowSchema = z
  .object({
    /** The spreadsheet's own row number, so "row 14" means row 14 (§5.6). */
    rowNumber: z.number().int().positive(),
    /** The cells, keyed by column key, exactly as they will be read. */
    values: z.record(z.string()),
    /** Empty when the row is ready to post. */
    errors: z.array(importCellErrorSchema),
  })
  .strict();
export type ImportPreviewRow = z.infer<typeof importPreviewRowSchema>;

export const importPreviewResponseSchema = z
  .object({
    type: importTypeSchema,
    columns: z.array(importColumnSchema),
    rows: z.array(importPreviewRowSchema),
    totalRows: z.number().int().nonnegative(),
    validRows: z.number().int().nonnegative(),
    invalidRows: z.number().int().nonnegative(),
    /**
     * Required headers the file does not have. A file problem, not a row
     * problem: every row would carry the same error and the fix is to start
     * again from the template, so `rows` is empty when this is not.
     */
    missingColumns: z.array(z.string()),
  })
  .strict();
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

export const importResultResponseSchema = z
  .object({
    type: importTypeSchema,
    /** How many rows the file held, and how many records it created. Equal, or nothing posted. */
    rows: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
  })
  .strict();
export type ImportResultResponse = z.infer<typeof importResultResponseSchema>;
