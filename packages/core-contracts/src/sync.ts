import { z } from 'zod';

import { recordExpenseRequestSchema } from './expenses';
import { adjustStockRequestSchema } from './inventory';
import {
  closeDayRequestSchema,
  recordCashMovementRequestSchema,
  startDayRequestSchema,
} from './money';
import { savePartyRequestSchema } from './parties';
import { saveProductRequestSchema } from './products';
import { createPurchaseRequestSchema, paySupplierRequestSchema } from './purchasing';
import { createPurchaseReturnRequestSchema, createSalesReturnRequestSchema } from './returns';
import { createSaleRequestSchema, receiveCustomerPaymentRequestSchema } from './sales';

/**
 * The wire between the shop's one offline machine and its books (§5.23, Phase
 * 12.4, owner decisions 2026-09-02).
 *
 * **An operation is a command, not a document.** What the device queues is the
 * exact zod-validated request body the online endpoint takes, and replay hands
 * that body to the very same application service the online controller calls.
 * That is the whole of the design, and everything else follows from it:
 *
 * - There is one posting implementation in this application, not two. A rule
 *   the counter obeys online is a rule it obeys offline, because it is the same
 *   code being run — a day later, by the server, on the server's own state.
 * - The server never has to trust a figure the device computed. It recomputes
 *   everything and compares (§5.23: the server never trusts device-computed
 *   totals, costs or balances).
 * - A command that could not be posted is refused rather than half-applied,
 *   because refusing is what the service already does when a period is closed
 *   or a permission is missing.
 *
 * The device still computes the money it must show the customer — the printed
 * invoice cannot say "total available after sync" — but it computes it with the
 * same domain arithmetic the server uses, and the printed figure is then
 * **immutable** (§5 of the owner's specification): the server may not quietly
 * rewrite what a customer was charged, so a disagreement about customer-facing
 * money is a Sync Issue, never a silent correction.
 */

/**
 * The wire's own version, checked before a batch is looked at.
 *
 * A device built against an older wire is told `SCHEMA_INCOMPATIBLE` and
 * **nothing in its batch is written** — a partly-understood batch is how a shop
 * ends up with half a day posted and no way to tell which half.
 */
export const SYNC_WIRE_VERSION = 1;

/**
 * Closing the day carries the session it closes.
 *
 * Online, that id is a URL parameter; there is no URL here, so it travels in
 * the body. The rest of the shape is the endpoint's own schema, extended rather
 * than restated, so a field added to closing a day reaches this wire by itself.
 *
 * Offline the id is the **operation id of the day's opening**, because a day
 * opened during an outage has no server id yet. Replay rewrites it into the
 * real one once the opening has posted (see `remapLocalReferences`).
 */
export const syncCloseDayPayloadSchema = closeDayRequestSchema
  .extend({ sessionId: z.string().length(26) })
  .strict();

export type SyncCloseDayPayload = z.infer<typeof syncCloseDayPayloadSchema>;

/* ------------------------------------------------------------- operations */

/**
 * What a disconnected shop may do, and nothing else.
 *
 * Configuration and system-wide policy are deliberately absent: users and
 * permissions, accounting policy, costing method, tax setup, the chart of
 * accounts, device authorization, fiscal periods and anything destructive stay
 * online-only (owner decision 2026-09-02). Those change what every later
 * document means, and a shop cannot reason about a rule that was changed on a
 * machine nobody could see.
 */
export const SYNC_OP_TYPES = [
  'SALE_CREATE',
  'PURCHASE_CREATE',
  'SALES_RETURN_CREATE',
  'PURCHASE_RETURN_CREATE',
  'CUSTOMER_RECEIPT_RECORD',
  'SUPPLIER_PAYMENT_RECORD',
  'EXPENSE_RECORD',
  'CASH_MOVEMENT_RECORD',
  'STOCK_ADJUST',
  'CASH_DAY_OPEN',
  'CASH_DAY_CLOSE',
  'PARTY_CREATE',
  'PRODUCT_CREATE',
] as const;

export const syncOpTypeSchema = z.enum(SYNC_OP_TYPES);
export type SyncOpType = z.infer<typeof syncOpTypeSchema>;

/**
 * The payload each type carries — the online endpoint's own request schema,
 * imported rather than restated.
 *
 * Restating them here would be a second definition of a sale, and the first
 * time the two drifted the offline counter would accept a command the server
 * refuses, at the exact moment nobody is watching. A field added to the POS
 * next month reaches this table with no edit at all.
 */
export const SYNC_OP_PAYLOAD_SCHEMAS = {
  SALE_CREATE: createSaleRequestSchema,
  PURCHASE_CREATE: createPurchaseRequestSchema,
  SALES_RETURN_CREATE: createSalesReturnRequestSchema,
  PURCHASE_RETURN_CREATE: createPurchaseReturnRequestSchema,
  CUSTOMER_RECEIPT_RECORD: receiveCustomerPaymentRequestSchema,
  SUPPLIER_PAYMENT_RECORD: paySupplierRequestSchema,
  EXPENSE_RECORD: recordExpenseRequestSchema,
  CASH_MOVEMENT_RECORD: recordCashMovementRequestSchema,
  STOCK_ADJUST: adjustStockRequestSchema,
  CASH_DAY_OPEN: startDayRequestSchema,
  CASH_DAY_CLOSE: syncCloseDayPayloadSchema,
  PARTY_CREATE: savePartyRequestSchema,
  PRODUCT_CREATE: saveProductRequestSchema,
} as const satisfies Record<SyncOpType, z.ZodTypeAny>;

/**
 * What the device believed the customer-facing money was.
 *
 * Compared against what the server computes, and never used in its place. The
 * money a customer was charged is on paper in their hand, so a difference is a
 * refusal a person must look at — not a figure to be replaced (§5).
 */
export const clientResultDigestSchema = z
  .object({
    /** Before the bill-level discount. */
    itemsTotalMinor: z.number().int(),
    discountMinor: z.number().int(),
    grandTotalMinor: z.number().int(),
    paidMinor: z.number().int(),
    /** What the customer still owes on this document, as the slip said. */
    dueMinor: z.number().int(),
  })
  .partial()
  .strict();

export type ClientResultDigest = z.infer<typeof clientResultDigestSchema>;

/**
 * What was true on the machine when the cashier pressed the button.
 *
 * `userId` is the **original** actor and stays the actor through replay: the
 * shop's audit must say who sold the goods, not who happened to be signed in
 * when the line came back.
 */
export const syncOpContextSchema = z
  .object({
    userId: z.string().length(26),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    deviceCreatedAt: z.string().datetime({ offset: true }),
    /**
     * What the device believed it was allowed to do. Advisory: the server
     * re-checks the live permission at replay time and refuses on its own
     * answer, because a permission taken away during the outage was taken away
     * for a reason (SY-07).
     */
    permissionsSnapshotHash: z.string().max(128).optional(),
  })
  .strict();

export type SyncOpContext = z.infer<typeof syncOpContextSchema>;

export const syncOperationSchema = z
  .object({
    operationId: z.string().length(26),
    localSeq: z.number().int().positive(),
    type: syncOpTypeSchema,
    /**
     * Left as `unknown` here and parsed by the type's own schema at replay
     * time, so a payload the server cannot understand is one refused operation
     * rather than a whole batch rejected at the door.
     */
    payload: z.unknown(),
    context: syncOpContextSchema,
    /**
     * `localSeq` values this one may not go before — the product a sale names,
     * the purchase that put its stock on the shelf. Ordering is dependency
     * first and creation order second; a timestamp alone is not enough
     * (§3 of the owner's specification).
     */
    dependsOn: z.array(z.number().int().positive()).default([]),
    clientResultDigest: clientResultDigestSchema.optional(),
    /** The number the machine printed, where the document carries one. */
    documentNumber: z.string().max(64).optional(),
  })
  .strict();

export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const syncPushRequestSchema = z
  .object({
    wireVersion: z.number().int(),
    /** The device's public key — the identity D-01 binds authority to. */
    deviceKey: z.string().min(1).max(512),
    /**
     * Empty is allowed, and means something: "I have nothing left to send".
     * That is how a machine being handed over finishes draining, and how one
     * that has caught up says so without inventing work to say it with.
     */
    operations: z.array(syncOperationSchema).max(200),
    /**
     * The machine's own statement that its queue is empty after this batch.
     *
     * Only the device knows what it is still holding — the server sees what has
     * arrived, never what has not — so a drain can only finish on the device's
     * word. It is a statement, not a permission: a machine that lies here ends
     * its own authority early and loses nothing, because anything it had not
     * sent is still in its outbox and still refused once the slot has moved.
     */
    queueEmpty: z.boolean().default(false),
  })
  .strict();

export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

/* --------------------------------------------------------------- outcomes */

/**
 * What became of one pushed operation.
 *
 * `DUPLICATE` is a success, not a failure: it is what a resumed push returns
 * for everything the server already took, and the device clears those from its
 * queue exactly as it clears an `APPLIED` one.
 */
export const syncOutcomeSchema = z.enum([
  'APPLIED',
  'DUPLICATE',
  'QUARANTINED',
  'BLOCKED',
  'IDEMPOTENCY_MISMATCH',
  'SCHEMA_INCOMPATIBLE',
  'AUTHORITY_REVOKED',
]);

export type SyncOutcome = z.infer<typeof syncOutcomeSchema>;

/**
 * Why an operation was refused. Each maps to one sentence a shopkeeper can act
 * on and to the set of resolutions that make sense for it — a closed period
 * cannot be merged, and a duplicate phone number cannot be kept both ways
 * without an edit.
 */
export const syncReasonCodeSchema = z.enum([
  'PERIOD_CLOSED',
  'PERMISSION_REVOKED',
  'ENTITY_MISSING',
  'ENTITY_INACTIVE',
  'UNIQUE_COLLISION',
  'AMOUNT_DIVERGENCE',
  'VALIDATION_FAILED',
  'DEPENDENCY_FAILED',
  'AUTHORITY_REVOKED',
  'BUSINESS_RULE',
  'UNKNOWN',
]);

export type SyncReasonCode = z.infer<typeof syncReasonCodeSchema>;

export const syncResolutionSchema = z.enum([
  'RETRY',
  'MERGE',
  'KEEP_BOTH_EDIT',
  'DISCARD_WITH_REASON',
]);

export type SyncResolution = z.infer<typeof syncResolutionSchema>;

export const syncOperationResultSchema = z
  .object({
    operationId: z.string().length(26),
    localSeq: z.number().int(),
    outcome: syncOutcomeSchema,
    /** The shop's order of acceptance, and the device's resume point. */
    serverSeq: z.number().int().nullable(),
    documentId: z.string().length(26).nullable(),
    /** Never different from what was printed. Echoed so the device can match. */
    documentNumber: z.string().nullable(),
    reasonCode: syncReasonCodeSchema.nullable(),
    message: z.string().nullable(),
    conflictId: z.string().length(26).nullable(),
    /**
     * Set when the server's own arithmetic differed from the device's. Recorded
     * on the operation and shown in Sync Issues; never applied silently over
     * the customer's printed figure.
     */
    divergence: z.record(z.string(), z.number().int()).nullable(),
  })
  .strict();

export type SyncOperationResult = z.infer<typeof syncOperationResultSchema>;

export const syncPushResponseSchema = z
  .object({
    wireVersion: z.number().int(),
    serverTime: z.string(),
    results: z.array(syncOperationResultSchema),
    /** Still open across the whole shop, so the badge is right after a push. */
    openConflicts: z.number().int().nonnegative(),
  })
  .strict();

export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

/* ------------------------------------------------------------------- pull */

export const syncChangeKindSchema = z.enum(['UPSERT', 'TOMBSTONE']);

export const syncChangeSchema = z
  .object({
    entity: z.enum(['PRODUCT', 'PARTY']),
    id: z.string().length(26),
    kind: syncChangeKindSchema,
    entityVersion: z.number().int(),
    /** The server's own response object, whole, exactly as 12.3 stores it. */
    payload: z.unknown().nullable(),
    /** Only for a party, which is stored once per role it holds (D-04). */
    role: z.string().nullable(),
    changedAt: z.string(),
  })
  .strict();

export type SyncChange = z.infer<typeof syncChangeSchema>;

export const syncPullResponseSchema = z
  .object({
    changes: z.array(syncChangeSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    serverTime: z.string(),
  })
  .strict();

export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

export const syncPullQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;

/* ----------------------------------------------------------------- status */

export const syncStatusResponseSchema = z
  .object({
    wireVersion: z.number().int(),
    lastPushAt: z.string().nullable(),
    lastPullAt: z.string().nullable(),
    cursor: z.string().nullable(),
    /** Accepted, in the shop's books. */
    appliedCount: z.number().int().nonnegative(),
    /** Waiting for a person. This is the number the top bar badges. */
    openConflictCount: z.number().int().nonnegative(),
    resolvedConflictCount: z.number().int().nonnegative(),
    discardedCount: z.number().int().nonnegative(),
    writer: z
      .object({
        deviceId: z.string().length(26),
        name: z.string(),
        deviceCode: z.string().nullable(),
        status: z.string(),
      })
      .strict()
      .nullable(),
    serverTime: z.string(),
  })
  .strict();

export type SyncStatusResponse = z.infer<typeof syncStatusResponseSchema>;

/* -------------------------------------------------------------- conflicts */

export const syncConflictResponseSchema = z
  .object({
    id: z.string().length(26),
    operationId: z.string().length(26),
    opType: syncOpTypeSchema,
    /** What the slip said, so the manager need not open a second screen. */
    documentNumber: z.string().nullable(),
    deviceName: z.string(),
    deviceCode: z.string().nullable(),
    deviceCreatedAt: z.string(),
    businessDate: z.string(),
    recordedByName: z.string(),
    reasonCode: syncReasonCodeSchema,
    reasonMessage: z.string(),
    localState: z.unknown().nullable(),
    serverState: z.unknown().nullable(),
    payload: z.unknown(),
    suggestedActions: z.array(syncResolutionSchema),
    status: z.enum(['OPEN', 'RESOLVED', 'DISCARDED']),
    resolution: syncResolutionSchema.nullable(),
    resolutionReason: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    resolvedByName: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();

export type SyncConflictResponse = z.infer<typeof syncConflictResponseSchema>;

export const syncConflictListQuerySchema = z
  .object({
    status: z.enum(['OPEN', 'RESOLVED', 'DISCARDED', 'ALL']).default('OPEN'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export type SyncConflictListQuery = z.infer<typeof syncConflictListQuerySchema>;

/**
 * A person's decision about one refused operation.
 *
 * `RETRY` and `MERGE` hand the operation back to the same application service
 * that refused it, against live state — so a resolution can never post
 * something the counter could not have posted online, and never needs a direct
 * database correction to "make sync pass" (§24, §27).
 *
 * `patch` carries the manager's edits for `KEEP_BOTH_EDIT` — a changed phone
 * number, a different customer — and is validated by the operation's own schema
 * exactly as a fresh request would be.
 */
export const resolveSyncConflictRequestSchema = z
  .object({
    resolution: syncResolutionSchema,
    reason: z.string().trim().min(3).max(500).optional(),
    patch: z.unknown().optional(),
  })
  .strict();

export type ResolveSyncConflictRequest = z.infer<typeof resolveSyncConflictRequestSchema>;

/**
 * Which resolutions make sense for a given refusal.
 *
 * Offering all four everywhere would be offering three that fail — a manager
 * who presses Merge on a closed period learns nothing from the refusal except
 * that the screen lied to them.
 */
export function resolutionsFor(reason: SyncReasonCode): readonly SyncResolution[] {
  switch (reason) {
    case 'PERIOD_CLOSED':
      // Reopening the month is the owner's separate, audited act (Phase 7). The
      // only thing this screen can offer is to try again once it is open, or to
      // decide the document will never be posted.
      return ['RETRY', 'DISCARD_WITH_REASON'];
    case 'UNIQUE_COLLISION':
      // The same customer, added twice. Merge into the one the shop already
      // has, or keep both after editing what collided.
      return ['MERGE', 'KEEP_BOTH_EDIT', 'DISCARD_WITH_REASON'];
    case 'AMOUNT_DIVERGENCE':
      // The printed figure stands or the document does not post. Editing it
      // would rewrite what the customer is holding.
      return ['RETRY', 'DISCARD_WITH_REASON'];
    case 'ENTITY_MISSING':
    case 'ENTITY_INACTIVE':
    case 'VALIDATION_FAILED':
      return ['RETRY', 'KEEP_BOTH_EDIT', 'DISCARD_WITH_REASON'];
    case 'DEPENDENCY_FAILED':
      // Fix what it waits on and it goes in by itself.
      return ['RETRY', 'DISCARD_WITH_REASON'];
    case 'AUTHORITY_REVOKED':
    case 'PERMISSION_REVOKED':
    case 'BUSINESS_RULE':
    case 'UNKNOWN':
      return ['RETRY', 'DISCARD_WITH_REASON'];
  }
}
