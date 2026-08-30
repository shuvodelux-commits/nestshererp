import { z } from 'zod';

/**
 * Backup, restore and the two operations that can empty this installation
 * (Phase 10, §5.25, D-15, owner decisions 2026-08-30).
 *
 * **The backup secret never appears in this file, in either direction.** It is
 * held in a restricted installation-level key file outside PostgreSQL and is
 * never sent to the browser, never returned by an endpoint and never written to
 * a log. What crosses the wire is the caller's own password, for step-up, and
 * the archive bytes themselves.
 *
 * Export, restore and reset all carry `confirmPassword` because §5.3 classifies
 * every one of them as a sensitive action needing a fresh credential. A PIN
 * never satisfies step-up.
 */

/* --------------------------------------------------------------- requests */

export const exportBackupRequestSchema = z
  .object({ confirmPassword: z.string().min(1) })
  .strict();
export type ExportBackupRequest = z.infer<typeof exportBackupRequestSchema>;

/**
 * Reading an archive without writing anything.
 *
 * The file arrives base64 in the body, the way the CSV import and the bank
 * statement PDF already do (§5.6, §5.17). The secret is not in here: the server
 * opens the archive with the installation's own key, which is the only secret
 * that can have encrypted it.
 */
export const inspectArchiveRequestSchema = z
  .object({
    fileName: z.string().min(1).max(200),
    contentBase64: z.string().min(1),
  })
  .strict();
export type InspectArchiveRequest = z.infer<typeof inspectArchiveRequestSchema>;

/**
 * Restoring, after the owner has read the preview and confirmed it.
 *
 * The file is sent again rather than held on the server between the two calls.
 * A half-uploaded archive parked in a temporary directory is a file somebody
 * has to clean up, and one the server could confuse with another; re-sending
 * costs a minute on a shop LAN and removes the whole class of problem.
 */
export const restoreBackupRequestSchema = inspectArchiveRequestSchema
  .extend({ confirmPassword: z.string().min(1) })
  .strict();
export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;

/** The exact words a reset demands, so a mis-click cannot produce them. */
export const RESET_CONFIRMATION_PHRASE = 'DELETE ALL DATA';

export const resetBusinessRequestSchema = z
  .object({
    confirmPassword: z.string().min(1),
    confirmPhrase: z.string().min(1),
  })
  .strict();
export type ResetBusinessRequest = z.infer<typeof resetBusinessRequestSchema>;

export const replaceBackupSecretRequestSchema = z
  .object({
    confirmPassword: z.string().min(1),
    newSecret: z.string().min(12).max(200),
  })
  .strict();
export type ReplaceBackupSecretRequest = z.infer<typeof replaceBackupSecretRequestSchema>;

/* -------------------------------------------------------------- responses */

export const backupRunKindSchema = z.union([z.literal('AUTO'), z.literal('MANUAL')]);
export type BackupRunKind = z.infer<typeof backupRunKindSchema>;

export const backupRunStatusSchema = z.union([
  z.literal('RUNNING'),
  z.literal('SUCCESS'),
  z.literal('FAILED'),
]);
export type BackupRunStatus = z.infer<typeof backupRunStatusSchema>;

export const backupRunSchema = z.object({
  id: z.string(),
  kind: backupRunKindSchema,
  status: backupRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Null until the archive has been reopened and read back. */
  verifiedAt: z.string().nullable(),
  fileName: z.string().nullable(),
  byteSize: z.number().nullable(),
  /** Present on failures, in words a shopkeeper can act on. */
  error: z.string().nullable(),
});
export type BackupRun = z.infer<typeof backupRunSchema>;

export const backupStatusResponseSchema = z.object({
  /** False when no key file is configured — nothing can be encrypted yet. */
  secretConfigured: z.boolean(),
  automaticEnabled: z.boolean(),
  lastAutomatic: backupRunSchema.nullable(),
  lastManualExportAt: z.string().nullable(),
  /** Days since the last manual export, or null when there has never been one. */
  daysSinceManualExport: z.number().nullable(),
  /** True once that gap passes the reminder threshold, or there is no export at all. */
  manualExportOverdue: z.boolean(),
  /** True when the most recent automatic run failed, or failed to verify. */
  automaticFailing: z.boolean(),
  retainedCount: z.number(),
  retentionLimit: z.number(),
  history: z.array(backupRunSchema),
  /** Whether this installation holds business data — restore needs it empty. */
  businessEmpty: z.boolean(),
});
export type BackupStatusResponse = z.infer<typeof backupStatusResponseSchema>;

/**
 * What an archive says it contains, shown before a single row is written.
 *
 * `compatibility` is the honest answer to "can this build read this file", and
 * a refusal names both versions rather than saying "incompatible" — a shop
 * ringing for help needs to be able to read the two numbers out loud.
 */
export const archivePreviewResponseSchema = z.object({
  fileName: z.string(),
  businessName: z.string(),
  takenAt: z.string(),
  appVersion: z.string(),
  archiveSchemaVersion: z.string(),
  buildSchemaVersion: z.string(),
  compatibility: z.union([
    z.literal('SAME'),
    z.literal('FORWARD_MIGRATE'),
    z.literal('TOO_NEW'),
    z.literal('UNSUPPORTED_FORMAT'),
  ]),
  /** Human-facing counts, largest first, for the confirmation screen. */
  contents: z.array(z.object({ label: z.string(), rows: z.number() })),
  totalRows: z.number(),
  evidenceBytes: z.number(),
  /** Whether this installation is empty enough to accept it. */
  canRestore: z.boolean(),
  /** Why not, when `canRestore` is false. */
  blockedReason: z.string().nullable(),
});
export type ArchivePreviewResponse = z.infer<typeof archivePreviewResponseSchema>;

export const restoreResultResponseSchema = z.object({
  businessName: z.string(),
  rowsRestored: z.number(),
  /** Always true: the recovery session ends with the identity it belonged to. */
  signedOut: z.literal(true),
});
export type RestoreResultResponse = z.infer<typeof restoreResultResponseSchema>;

export const resetResultResponseSchema = z.object({
  /** Where the pre-reset PostgreSQL dump was written, so it can be found again. */
  recoveryDumpPath: z.string(),
  recoveryDumpBytes: z.number(),
  rowsCleared: z.number(),
});
export type ResetResultResponse = z.infer<typeof resetResultResponseSchema>;

