import { z } from 'zod';

/**
 * Account reconciliation — agreeing the shop's books with the bank's own
 * statement (Phase 11, §5.17, UI-70, D-43).
 *
 * Money crosses the wire as integer minor units with a `Minor` suffix, and a
 * statement amount is **signed the way the ledger signs it**: money in
 * positive, money out negative. One convention on both sides of the screen is
 * what lets the two be compared without a translation step that could invert a
 * figure.
 *
 * Nothing in this file describes a posting. Every request here creates, moves
 * or removes a **link**; when the owner needs a transaction created, corrected
 * or cancelled, the screen opens that module's own dialog and that module's own
 * contract carries it.
 */
const ULID = z.string().length(26);

export const reconciliationStatusSchema = z.union([
  z.literal('DRAFT'),
  z.literal('COMPLETED'),
  z.literal('REVIEW_REQUIRED'),
]);
export type ReconciliationStatusValue = z.infer<typeof reconciliationStatusSchema>;

export const matchStateSchema = z.union([
  z.literal('AUTO'),
  z.literal('CONFIRMED'),
  z.literal('MANUAL'),
  z.literal('REJECTED'),
  z.literal('NEEDS_REVIEW'),
  z.literal('OUTSTANDING'),
]);
export type MatchStateValue = z.infer<typeof matchStateSchema>;

export const statementParseStatusSchema = z.union([
  z.literal('PARSED'),
  z.literal('PARTIAL'),
  z.literal('UNREADABLE'),
]);
export type StatementParseStatusValue = z.infer<typeof statementParseStatusSchema>;

/* --------------------------------------------------------------- requests */

export const startReconciliationRequestSchema = z
  .object({
    accountId: ULID,
    fromDate: z.string().date(),
    toDate: z.string().date(),
    operationId: ULID,
  })
  .strict();

export type StartReconciliationRequest = z.infer<typeof startReconciliationRequestSchema>;

/**
 * The PDF, base64 in the body.
 *
 * The same road the CSV import takes (§5.6) rather than a multipart upload: one
 * request shape, one guard, one error envelope. A statement is a few hundred
 * kilobytes, so the 8 MB ceiling is generous — and it is a ceiling rather than
 * a limit discovered at runtime, because "the upload silently did nothing" is
 * the worst possible answer to a file that was too big.
 */
export const uploadStatementRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    contentBase64: z.string().min(1).max(11_500_000),
  })
  .strict();

export type UploadStatementRequest = z.infer<typeof uploadStatementRequestSchema>;

/** One row of the parsed statement, as the owner confirms or repairs it. */
export const statementLineDraftSchema = z
  .object({
    lineNo: z.number().int().positive(),
    businessDate: z.string().date(),
    description: z.string().trim().max(300),
    reference: z.string().trim().max(64).nullable().default(null),
    /** Signed, and never zero: a row that moved nothing is not a row. */
    amountMinor: z.number().int().refine((value) => value !== 0, 'Amount cannot be zero'),
    balanceMinor: z.number().int().nullable().default(null),
    editedByUser: z.boolean().default(false),
  })
  .strict();

export type StatementLineDraft = z.infer<typeof statementLineDraftSchema>;

/**
 * Importing what the preview showed — after the owner has read it.
 *
 * The lines travel back rather than being taken from the parse the server
 * already holds, because the owner may have repaired a row the parser read
 * wrongly, and what gets reconciled must be what they saw and approved.
 */
export const confirmStatementRequestSchema = z
  .object({
    fileId: ULID,
    lines: z.array(statementLineDraftSchema).max(2000),
    openingBalanceMinor: z.number().int().nullable().default(null),
    closingBalanceMinor: z.number().int().nullable().default(null),
  })
  .strict();

export type ConfirmStatementRequest = z.infer<typeof confirmStatementRequestSchema>;

/**
 * Linking, unlinking and classifying — the whole of what this module writes.
 *
 * No `operationId`: a link is not a document. Migration 0039's unique indexes
 * already allow a row only one live link, so a second tap changes nothing.
 *
 * `state` says what kind of statement the person is making. `MANUAL` and
 * `CONFIRMED` need both sides; `OUTSTANDING` and `NEEDS_REVIEW` may carry one.
 */
export const saveMatchRequestSchema = z
  .object({
    statementLineId: ULID.nullable().default(null),
    journalLineId: ULID.nullable().default(null),
    state: matchStateSchema,
  })
  .strict()
  .refine(
    (value) => value.statementLineId !== null || value.journalLineId !== null,
    'A match needs at least one side',
  );

export type SaveMatchRequest = z.infer<typeof saveMatchRequestSchema>;

export const completeReconciliationRequestSchema = z
  .object({
    statementClosingBalanceMinor: z.number().int(),
    note: z.string().trim().max(300).nullable().default(null),
    version: z.number().int().positive(),
  })
  .strict();

export type CompleteReconciliationRequest = z.infer<typeof completeReconciliationRequestSchema>;

export const reopenReconciliationRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(300),
    version: z.number().int().positive(),
  })
  .strict();

export type ReopenReconciliationRequest = z.infer<typeof reopenReconciliationRequestSchema>;

/* -------------------------------------------------------------- responses */

export const matchReasonSchema = z.object({
  label: z.string(),
  detail: z.string(),
  ok: z.boolean(),
});

export type MatchReasonResponse = z.infer<typeof matchReasonSchema>;

/** The preview the owner reads before anything is imported. */
export const statementPreviewResponseSchema = z.object({
  fileId: ULID,
  fileName: z.string(),
  parseStatus: statementParseStatusSchema,
  fromDate: z.string().nullable(),
  toDate: z.string().nullable(),
  openingBalanceMinor: z.number().int().nullable(),
  closingBalanceMinor: z.number().int().nullable(),
  lines: z.array(statementLineDraftSchema),
  problems: z.array(
    z.object({ lineNo: z.number().int(), text: z.string(), reason: z.string() }),
  ),
});

export type StatementPreviewResponse = z.infer<typeof statementPreviewResponseSchema>;

/**
 * One row of the shop's own ledger, as the workspace shows it.
 *
 * A projection of `journal_lines`, re-read on every request. `documentType` and
 * `documentId` are what the row's `Correct` and `Void` actions hand to the
 * owning module — reconciliation names the document, and that module changes it.
 */
export const reconciliationLedgerRowSchema = z.object({
  journalLineId: ULID,
  businessDate: z.string(),
  createdAt: z.string(),
  sourceType: z.string(),
  sourceNumber: z.string(),
  documentType: z.string().nullable(),
  documentId: ULID.nullable(),
  documentVersion: z.number().int().nullable(),
  description: z.string(),
  reference: z.string().nullable(),
  amountMinor: z.number().int(),
  matchId: ULID.nullable(),
  matchState: matchStateSchema.nullable(),
  /** The statement line this row is linked to, when it is linked. */
  statementLineId: ULID.nullable(),
});

export type ReconciliationLedgerRow = z.infer<typeof reconciliationLedgerRowSchema>;

export const reconciliationStatementRowSchema = z.object({
  statementLineId: ULID,
  lineNo: z.number().int(),
  businessDate: z.string(),
  description: z.string(),
  reference: z.string().nullable(),
  amountMinor: z.number().int(),
  balanceMinor: z.number().int().nullable(),
  editedByUser: z.boolean(),
  matchId: ULID.nullable(),
  matchState: matchStateSchema.nullable(),
  journalLineId: ULID.nullable(),
  /**
   * The same amount and reference posted to a **different** bank account
   * (§5.17). A warning to be read, never a transfer to be made: only the owner
   * may move a transaction, and only through the owning module's correction.
   */
  possibleWrongAccount: z
    .object({ accountId: ULID, accountName: z.string(), sourceNumber: z.string() })
    .nullable(),
});

export type ReconciliationStatementRow = z.infer<typeof reconciliationStatementRowSchema>;

/** A pairing the engine is not sure enough to make on its own. */
export const matchSuggestionSchema = z.object({
  journalLineId: ULID,
  statementLineId: ULID,
  score: z.number().int(),
  reasons: z.array(matchReasonSchema),
});

export type MatchSuggestion = z.infer<typeof matchSuggestionSchema>;

export const matchConflictSchema = z.object({
  journalLineId: ULID,
  statementLineId: ULID,
  reference: z.string(),
  ledgerAmountMinor: z.number().int(),
  statementAmountMinor: z.number().int(),
});

export type MatchConflictResponse = z.infer<typeof matchConflictSchema>;

export const reconciliationSummarySchema = z.object({
  statementOpeningMinor: z.number().int().nullable(),
  statementClosingMinor: z.number().int().nullable(),
  bookOpeningMinor: z.number().int(),
  bookClosingMinor: z.number().int(),
  /** Opening plus everything matched — what the bank should be showing. */
  reconciledBalanceMinor: z.number().int(),
  differenceMinor: z.number().int(),
  autoMatched: z.number().int(),
  manualMatched: z.number().int(),
  suggested: z.number().int(),
  statementOnly: z.number().int(),
  ledgerOnly: z.number().int(),
  outstanding: z.number().int(),
  conflicts: z.number().int(),
  needsReview: z.number().int(),
  /** Empty when the reconciliation may be completed; otherwise why not. */
  blockers: z.array(z.string()),
});

export type ReconciliationSummary = z.infer<typeof reconciliationSummarySchema>;

/** Everything one screen needs, in one response — recomputed on every read. */
export const reconciliationWorkspaceResponseSchema = z.object({
  id: ULID,
  accountId: ULID,
  accountName: z.string(),
  accountType: z.string(),
  fromDate: z.string(),
  toDate: z.string(),
  status: reconciliationStatusSchema,
  note: z.string().nullable(),
  completedAt: z.string().nullable(),
  completedByName: z.string().nullable(),
  version: z.number().int(),
  /** The evidence: the statements uploaded against this reconciliation. */
  files: z.array(
    z.object({
      fileId: ULID,
      fileName: z.string(),
      parseStatus: statementParseStatusSchema,
      byteSize: z.number().int(),
      importedAt: z.string().nullable(),
      uploadedAt: z.string(),
    }),
  ),
  ledgerRows: z.array(reconciliationLedgerRowSchema),
  statementRows: z.array(reconciliationStatementRowSchema),
  suggestions: z.array(matchSuggestionSchema),
  conflicts: z.array(matchConflictSchema),
  summary: reconciliationSummarySchema,
  /** Documents that changed after this was signed off (R-22). */
  changedSinceCompletion: z.array(
    z.object({ journalLineId: ULID, sourceNumber: z.string(), sourceType: z.string() }),
  ),
});

export type ReconciliationWorkspaceResponse = z.infer<
  typeof reconciliationWorkspaceResponseSchema
>;

export const reconciliationListRowSchema = z.object({
  id: ULID,
  accountId: ULID,
  accountName: z.string(),
  fromDate: z.string(),
  toDate: z.string(),
  status: reconciliationStatusSchema,
  differenceMinor: z.number().int().nullable(),
  completedAt: z.string().nullable(),
});

export type ReconciliationListRow = z.infer<typeof reconciliationListRowSchema>;

export const reconciliationListResponseSchema = z.object({
  rows: z.array(reconciliationListRowSchema),
});

export type ReconciliationListResponse = z.infer<typeof reconciliationListResponseSchema>;

export const reconciliationListQuerySchema = z
  .object({ accountId: ULID.optional() })
  .strict();

export type ReconciliationListQuery = z.infer<typeof reconciliationListQuerySchema>;
