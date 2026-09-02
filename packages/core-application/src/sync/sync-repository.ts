import type {
  SyncOpType,
  SyncReasonCode,
  SyncResolution,
} from '@sher/core-contracts';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * The stored side of synchronisation (§5.23, Phase 12.4).
 *
 * **Nothing here holds a business figure.** These rows record what a device
 * sent, in what order, and what the server did with it — the documents
 * themselves live where they always did, written by the ordinary application
 * services. A sync table that carried a total would be the first thing to
 * disagree with the ledger (INV-10), and it would disagree quietly.
 */

export type SyncOperationStatus =
  | 'IN_FLIGHT'
  | 'APPLIED'
  | 'DUPLICATE'
  | 'QUARANTINED'
  | 'DISCARDED'
  | 'BLOCKED';

export interface SyncOperationRow {
  readonly id: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceCode: string | null;
  readonly operationId: string;
  readonly localSeq: number;
  readonly opType: SyncOpType;
  readonly payload: unknown;
  readonly context: {
    readonly userId: string;
    readonly businessDate: string;
    readonly deviceCreatedAt: string;
    readonly permissionsSnapshotHash?: string;
  };
  readonly dependsOn: readonly number[];
  readonly clientResultDigest: Record<string, number> | null;
  readonly deviceCreatedAt: Date;
  readonly businessDate: string;
  readonly status: SyncOperationStatus;
  readonly resultDocumentId: string | null;
  readonly resultDocumentNumber: string | null;
  readonly serverResultDigest: Record<string, number> | null;
  readonly divergence: Record<string, number> | null;
  readonly serverSeq: number | null;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly receivedAt: Date;
  readonly appliedAt: Date | null;
}

export interface NewSyncOperation {
  readonly id: string;
  readonly deviceId: string;
  readonly operationId: string;
  readonly localSeq: number;
  readonly opType: SyncOpType;
  readonly payload: unknown;
  readonly context: unknown;
  readonly dependsOn: readonly number[];
  readonly clientResultDigest: unknown;
  readonly deviceCreatedAt: Date;
  readonly businessDate: string;
  readonly receivedAt: Date;
}

export interface SyncOperationOutcome {
  readonly status: SyncOperationStatus;
  readonly resultDocumentId?: string | null;
  readonly resultDocumentNumber?: string | null;
  readonly serverResultDigest?: Record<string, number> | null;
  readonly divergence?: Record<string, number> | null;
  /** Taken from the shop's own sequence, so the order of acceptance is a fact. */
  readonly assignServerSeq?: boolean;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly at: Date;
}

export interface SyncConflictRow {
  readonly id: string;
  readonly syncOperationId: string;
  readonly reasonCode: SyncReasonCode;
  readonly reasonMessage: string;
  readonly serverState: unknown;
  readonly localState: unknown;
  readonly suggestedActions: readonly SyncResolution[];
  readonly status: 'OPEN' | 'RESOLVED' | 'DISCARDED';
  readonly resolution: SyncResolution | null;
  readonly resolutionReason: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedByName: string | null;
  readonly createdAt: Date;
  /** Joined, because Sync Issues shows the operation beside its refusal. */
  readonly operation: SyncOperationRow;
  readonly recordedByName: string;
}

export interface NewSyncConflict {
  readonly id: string;
  readonly syncOperationId: string;
  readonly reasonCode: SyncReasonCode;
  readonly reasonMessage: string;
  readonly serverState: unknown;
  readonly localState: unknown;
  readonly suggestedActions: readonly SyncResolution[];
  readonly at: Date;
}

export interface SyncCounts {
  readonly applied: number;
  readonly openConflicts: number;
  readonly resolvedConflicts: number;
  readonly discarded: number;
}

/** One master-data row that has changed since a device's cursor. */
export interface SyncChangeRow {
  readonly entity: 'PRODUCT' | 'PARTY';
  readonly id: string;
  readonly kind: 'UPSERT' | 'TOMBSTONE';
  readonly entityVersion: number;
  readonly role: string | null;
  readonly changedAt: Date;
}

export interface SyncRepository {
  /** Null when this shop has never seen this operation id (§2's fast path). */
  findOperationByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<SyncOperationRow | null>;
  findOperationById(tx: Tx, ctx: TenantContext, id: string): Promise<SyncOperationRow | null>;
  /**
   * What this machine already sent under that sequence number, if anything.
   *
   * A device's `local_seq` is strictly increasing and never reused, so a second
   * operation arriving under a number the shop has already seen means the
   * machine's counter went backwards — a restored backup whose queue was
   * rolled back, or two profiles sharing copied storage. Either is a fault to
   * refuse and explain, never a row to overwrite.
   */
  findOperationByDeviceSeq(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    localSeq: number,
  ): Promise<SyncOperationRow | null>;
  insertOperation(tx: Tx, ctx: TenantContext, op: NewSyncOperation): Promise<void>;
  recordOutcome(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    outcome: SyncOperationOutcome,
  ): Promise<number | null>;
  /** One more try recorded against the operation, whatever came of it. */
  countAttempt(tx: Tx, ctx: TenantContext, id: string, at: Date): Promise<void>;

  openConflictFor(
    tx: Tx,
    ctx: TenantContext,
    syncOperationId: string,
  ): Promise<SyncConflictRow | null>;
  upsertConflict(tx: Tx, ctx: TenantContext, conflict: NewSyncConflict): Promise<string>;
  findConflictById(tx: Tx, ctx: TenantContext, id: string): Promise<SyncConflictRow | null>;
  listConflicts(
    tx: Tx,
    ctx: TenantContext,
    query: { readonly status: 'OPEN' | 'RESOLVED' | 'DISCARDED' | 'ALL'; readonly limit: number; readonly cursor?: string },
  ): Promise<readonly SyncConflictRow[]>;
  closeConflict(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    decision: {
      readonly status: 'RESOLVED' | 'DISCARDED';
      readonly resolution: SyncResolution;
      readonly reason: string | null;
      readonly at: Date;
    },
  ): Promise<void>;
  counts(tx: Tx, ctx: TenantContext): Promise<SyncCounts>;
  /** The device got through just now — what the Sync screen calls Last sent. */
  recordPush(tx: Tx, ctx: TenantContext, deviceId: string, at: Date): Promise<void>;
  recordPull(tx: Tx, ctx: TenantContext, deviceId: string, at: Date, cursor: Date): Promise<void>;

  /**
   * Local id → the id the shop's books gave it.
   *
   * An entity created during an outage is referred to by the operation id it
   * was created under, because it has no server id until it posts. Only ids
   * this shop has actually accepted come back, so nothing else in a payload can
   * be rewritten by accident.
   */
  resolveLocalIds(
    tx: Tx,
    ctx: TenantContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  /**
   * Master-data rows changed since `cursor`, oldest first.
   *
   * Served from the tables' own `updated_at` rather than a change-feed table,
   * because a feed is a second copy of when a product changed and the day it
   * drifts a device stops learning about a price it must charge.
   */
  changesSince(
    tx: Tx,
    ctx: TenantContext,
    cursor: Date | null,
    limit: number,
  ): Promise<readonly SyncChangeRow[]>;

  /**
   * Stamps the origin trail on a document that was made offline (§18).
   *
   * Deliberately a separate, narrow write rather than a field threaded through
   * thirteen posting services: it touches only `origin_mode`,
   * `origin_device_id`, `device_created_at`, `device_seq` and `synced_at`, can
   * never alter a figure, and is safe to repeat. The alternative would have
   * meant editing every service and repository in the application to carry a
   * value none of them reason about — more surface, more risk, and no more
   * truth in the result.
   *
   * It is not a correction and never stands in for one: a document that could
   * not be posted is quarantined, never stamped into existence (§27).
   */
  markOffline(
    tx: Tx,
    ctx: TenantContext,
    stamp: {
      readonly table: string;
      readonly documentId: string;
      readonly deviceId: string;
      readonly deviceCreatedAt: Date;
      readonly deviceSeq: number;
      readonly syncedAt: Date;
    },
  ): Promise<void>;
}

/**
 * Which table a given operation's document lands in, for the origin stamp.
 *
 * A closed list rather than a lookup, because the stamp writes a table name
 * into SQL and the set of names it may write must be readable in one place.
 */
export const OP_DOCUMENT_TABLE: Readonly<Record<SyncOpType, string>> = {
  SALE_CREATE: 'sales',
  PURCHASE_CREATE: 'purchases',
  SALES_RETURN_CREATE: 'sales_returns',
  PURCHASE_RETURN_CREATE: 'purchase_returns',
  CUSTOMER_RECEIPT_RECORD: 'customer_receipts',
  SUPPLIER_PAYMENT_RECORD: 'supplier_payments',
  EXPENSE_RECORD: 'expenses',
  CASH_MOVEMENT_RECORD: 'cash_movements',
  STOCK_ADJUST: 'stock_adjustments',
  CASH_DAY_OPEN: 'cash_sessions',
  CASH_DAY_CLOSE: 'cash_session_closes',
  PARTY_CREATE: 'parties',
  PRODUCT_CREATE: 'products',
};
