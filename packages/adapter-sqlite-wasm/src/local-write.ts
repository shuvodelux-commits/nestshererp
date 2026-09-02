import { LIVE_FILE, openLocalDb } from './local-database';
import type { LocalDb } from './local-database';

/**
 * Writing on the shop's own machine (§5.23, Phase 12.4).
 *
 * **Every write here is committed before the caller is told it worked**, and
 * therefore before a slip is printed or a screen says "saved". That ordering is
 * the whole contract of an offline till: a customer holding a receipt for a
 * sale this database never heard of is the one failure the shop cannot recover
 * from, and §19 makes it explicit — never confirm a transaction unless the
 * durable local commit succeeded.
 *
 * **What a row here is, and is not.** It is the command the online endpoint
 * would have received, queued to be replayed by the server through the very
 * service the counter calls when the line is up. It is not a posted document:
 * no journal, no lot, no cost, no balance. The device works out the money the
 * customer must be told — with the same domain arithmetic the server uses — and
 * leaves everything the ledger cares about to the ledger (§4).
 */

/** One command, as the counter queues it. */
export interface QueuedOperation {
  readonly operationId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly context: {
    readonly userId: string;
    readonly businessDate: string;
    readonly deviceCreatedAt: string;
    readonly permissionsSnapshotHash?: string;
  };
  readonly dependsOn?: readonly number[];
  readonly digest?: Record<string, number> | undefined;
  readonly documentNumber?: string | null;
  /** What the counter shows for it until the server has spoken. */
  readonly document?: {
    readonly partyId: string | null;
    readonly partyName: string | null;
    readonly totalMinor: number;
    readonly paidMinor: number;
    readonly dueMinor: number;
    readonly view: unknown;
  };
  /**
   * Stock this operation moves, so the counter's own figures include it (§11).
   * Signed base-unit quantities at `QTY_SCALE`, keyed by product.
   */
  readonly stockDelta?: Readonly<Record<string, number>>;
  /** Signed minor units the party's balance moves by, if any. */
  readonly balanceDelta?: { readonly partyId: string; readonly amountMinor: number };
}

export interface QueuedResult {
  readonly operationId: string;
  readonly localSeq: number;
  readonly documentNumber: string | null;
}

export interface LocalState {
  readonly nextLocalSeq: number;
  readonly nextSaleSeq: number;
  readonly deviceCode: string | null;
  readonly deviceId: string | null;
  readonly syncCursor: string | null;
  readonly lastPushAt: string | null;
  readonly lastPullAt: string | null;
  readonly openSessionOp: string | null;
}

async function withDb<T>(work: (db: LocalDb) => T): Promise<T> {
  const db = await openLocalDb(LIVE_FILE);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

export async function readLocalState(): Promise<LocalState | null> {
  return withDb((db) => {
    const row = db.selectObject('SELECT * FROM local_state WHERE id = 1');
    if (row === undefined) return null;
    return {
      nextLocalSeq: Number(row['next_local_seq']),
      nextSaleSeq: Number(row['next_sale_seq']),
      deviceCode: str(row['device_code']),
      deviceId: str(row['device_id']),
      syncCursor: str(row['sync_cursor']),
      lastPushAt: str(row['last_push_at']),
      lastPullAt: str(row['last_pull_at']),
      openSessionOp: str(row['open_session_op']),
    };
  });
}

/** Remembers which machine this copy belongs to, so numbering can start. */
export async function rememberDevice(deviceId: string, deviceCode: string): Promise<void> {
  await withDb((db) => {
    db.exec({
      sql: 'UPDATE local_state SET device_id = ?, device_code = ? WHERE id = 1',
      bind: [deviceId, deviceCode],
    });
  });
}

/**
 * Queues one command, and moves everything the counter shows with it, in a
 * single transaction.
 *
 * All of it or none of it: the outbox row, the local document, the stock the
 * sale took off the shelf and the money the customer now owes. A commit that
 * wrote the queue but not the stock would leave the next cashier selling goods
 * that are already in a bag by the door.
 */
export async function queueOperation(op: QueuedOperation): Promise<QueuedResult> {
  return withDb((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = db.selectObject('SELECT * FROM local_state WHERE id = 1');
      if (state === undefined) throw new Error('this machine has no local copy to write into');

      const localSeq = Number(state['next_local_seq']);
      /*
       * The moment the cashier pressed the button, as the caller recorded it.
       * Deliberately not "now": a queued operation's own time is the counter's
       * time, and re-stamping it here would make the queue's order depend on
       * when the write happened to reach the disk.
       */
      const now = op.context.deviceCreatedAt;

      db.exec({
        sql: `INSERT INTO outbox
                (operation_id, local_seq, op_type, payload, context, depends_on, digest,
                 doc_number, status, created_at, business_date, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        bind: [
          op.operationId,
          localSeq,
          op.type,
          JSON.stringify(op.payload),
          JSON.stringify(op.context),
          JSON.stringify(op.dependsOn ?? []),
          op.digest === undefined ? null : JSON.stringify(op.digest),
          op.documentNumber ?? null,
          now,
          op.context.businessDate,
          now,
        ],
      });

      if (op.document !== undefined) {
        db.exec({
          sql: `INSERT INTO documents
                  (operation_id, doc_type, doc_number, business_date, party_id, party_name,
                   total_minor, paid_minor, due_minor, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bind: [
            op.operationId,
            op.type,
            op.documentNumber ?? null,
            op.context.businessDate,
            op.document.partyId,
            op.document.partyName,
            op.document.totalMinor,
            op.document.paidMinor,
            op.document.dueMinor,
            JSON.stringify(op.document.view),
            now,
          ],
        });
      }

      /*
       * The counter's own figures include what the counter has done (§11).
       * `stock_qty` and `balance` are the numbers the offline screens read, and
       * a cashier who has just sold the last three of something must not be
       * shown twelve.
       */
      for (const [productId, delta] of Object.entries(op.stockDelta ?? {})) {
        db.exec({
          sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?',
          bind: [delta, productId],
        });
      }
      if (op.balanceDelta !== undefined) {
        db.exec({
          sql: 'UPDATE parties SET balance = balance + ? WHERE id = ?',
          bind: [op.balanceDelta.amountMinor, op.balanceDelta.partyId],
        });
      }

      const nextSaleSeq =
        op.type === 'SALE_CREATE' ? Number(state['next_sale_seq']) + 1 : Number(state['next_sale_seq']);
      const openSessionOp =
        op.type === 'CASH_DAY_OPEN'
          ? op.operationId
          : op.type === 'CASH_DAY_CLOSE'
            ? null
            : str(state['open_session_op']);

      db.exec({
        sql: `UPDATE local_state
                 SET next_local_seq = ?, next_sale_seq = ?, open_session_op = ?
               WHERE id = 1`,
        bind: [localSeq + 1, nextSaleSeq, openSessionOp],
      });

      db.exec('COMMIT');
      return { operationId: op.operationId, localSeq, documentNumber: op.documentNumber ?? null };
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  });
}

/**
 * The next sale number this machine will print — `S-2026-A-000123`.
 *
 * Read without consuming: the number goes onto the slip only when the sale is
 * actually queued, and `queueOperation` moves the counter in the same
 * transaction. Peeking and committing separately would burn a number every time
 * a cashier opened the till and changed their mind, and a shop reading its own
 * invoice book would find gaps nobody could explain.
 */
export async function peekSaleNumber(year: number): Promise<string | null> {
  const state = await readLocalState();
  if (state === null || state.deviceCode === null) return null;
  return `S-${String(year)}-${state.deviceCode}-${String(state.nextSaleSeq).padStart(6, '0')}`;
}

export interface OutboxRow {
  readonly operationId: string;
  readonly localSeq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly context: {
    readonly userId: string;
    readonly businessDate: string;
    readonly deviceCreatedAt: string;
  };
  readonly dependsOn: readonly number[];
  readonly digest: Record<string, number> | null;
  readonly documentNumber: string | null;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly businessDate: string;
}

/** Everything still waiting to be sent, oldest first — which is dependency order. */
export async function pendingOperations(limit = 200): Promise<readonly OutboxRow[]> {
  return withDb((db) => {
    const rows = db.selectObjects(
      `SELECT * FROM outbox
        WHERE status IN ('PENDING', 'SENT')
        ORDER BY local_seq
        LIMIT ?`,
      [limit],
    );
    return rows.map(toOutboxRow);
  });
}

export interface OutboxCounts {
  readonly pending: number;
  readonly refused: number;
  readonly oldestPendingAt: string | null;
}

export async function outboxCounts(): Promise<OutboxCounts> {
  return withDb((db) => {
    const row = db.selectObject(`
      SELECT
        (SELECT count(*) FROM outbox WHERE status IN ('PENDING', 'SENT'))  AS pending,
        (SELECT count(*) FROM outbox WHERE status = 'REFUSED')             AS refused,
        (SELECT min(created_at) FROM outbox WHERE status IN ('PENDING', 'SENT')) AS oldest
    `);
    return {
      pending: Number(row?.['pending'] ?? 0),
      refused: Number(row?.['refused'] ?? 0),
      oldestPendingAt: str(row?.['oldest']),
    };
  });
}

/**
 * What the server said about one operation.
 *
 * `ACCEPTED` clears it from the queue for good. A refusal keeps it exactly
 * where it is with the reason on it, because the Sync Issues screen resolves it
 * against the server and the device must not decide anything by itself.
 */
export async function settleOperation(settlement: {
  readonly operationId: string;
  readonly status: 'ACCEPTED' | 'REFUSED' | 'SETTLED' | 'PENDING';
  readonly serverId?: string | null;
  readonly serverNumber?: string | null;
  readonly reasonCode?: string | null;
  readonly reason?: string | null;
  readonly at: string;
}): Promise<void> {
  await withDb((db) => {
    db.exec({
      sql: `UPDATE outbox
               SET status = ?, server_id = ?, server_number = ?,
                   reason_code = ?, reason = ?, attempts = attempts + 1, updated_at = ?
             WHERE operation_id = ?`,
      bind: [
        settlement.status,
        settlement.serverId ?? null,
        settlement.serverNumber ?? null,
        settlement.reasonCode ?? null,
        settlement.reason ?? null,
        settlement.at,
        settlement.operationId,
      ],
    });
  });
}

/** Marks a batch as in flight, so a second tab cannot send it twice. */
export async function markSent(operationIds: readonly string[], at: string): Promise<void> {
  if (operationIds.length === 0) return;
  await withDb((db) => {
    for (const id of operationIds) {
      db.exec({
        sql: `UPDATE outbox SET status = 'SENT', updated_at = ? WHERE operation_id = ? AND status = 'PENDING'`,
        bind: [at, id],
      });
    }
  });
}

export async function recordCursor(cursor: string | null, at: string, pushed: boolean): Promise<void> {
  await withDb((db) => {
    db.exec({
      sql: pushed
        ? 'UPDATE local_state SET last_push_at = ? WHERE id = 1'
        : 'UPDATE local_state SET sync_cursor = COALESCE(?, sync_cursor), last_pull_at = ? WHERE id = 1',
      bind: pushed ? [at] : [cursor, at],
    });
  });
}

/** Who may sign in here, as the snapshot left them (§9). */
export interface LocalUser {
  readonly id: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly pinHash: string;
  readonly permissions: readonly string[];
}

export async function localUsers(): Promise<readonly LocalUser[]> {
  return withDb((db) => {
    const rows = db.selectObjects('SELECT * FROM users ORDER BY display_name');
    return rows.map((row) => ({
      id: String(row['id']),
      displayName: String(row['display_name']),
      username: str(row['username']),
      pinHash: String(row['pin_hash']),
      permissions: JSON.parse(String(row['permissions'])) as string[],
    }));
  });
}

/** Applies one pulled master-data change to the copy. */
export async function applyChange(change: {
  readonly entity: 'PRODUCT' | 'PARTY';
  readonly id: string;
  readonly kind: 'UPSERT' | 'TOMBSTONE';
  readonly payload: unknown;
}): Promise<void> {
  await withDb((db) => {
    if (change.kind === 'TOMBSTONE') {
      db.exec({
        sql: change.entity === 'PRODUCT' ? 'DELETE FROM products WHERE id = ?' : 'DELETE FROM parties WHERE id = ?',
        bind: [change.id],
      });
      return;
    }
    if (change.payload === null) return;

    if (change.entity === 'PRODUCT') {
      const product = change.payload as Record<string, unknown>;
      db.exec({
        sql: `INSERT INTO products
                (id, name, search, sku, barcode, brand_id, brand_name, category_id, status,
                 stock_qty, selling_price, payload)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET
                name = excluded.name, search = excluded.search, sku = excluded.sku,
                barcode = excluded.barcode, brand_id = excluded.brand_id,
                brand_name = excluded.brand_name, category_id = excluded.category_id,
                status = excluded.status, stock_qty = excluded.stock_qty,
                selling_price = excluded.selling_price, payload = excluded.payload`,
        bind: [
          String(product['id']),
          String(product['name']),
          searchable(product['name'], product['sku'], product['barcode'], product['brandName']),
          nullable(product['sku']),
          nullable(product['barcode']),
          nullable(product['brandId']),
          nullable(product['brandName']),
          nullable(product['categoryId']),
          String(product['status']),
          Number(product['stockQty'] ?? 0),
          Number(product['sellingPriceMinor'] ?? 0),
          JSON.stringify(product),
        ],
      });
      return;
    }

    const party = change.payload as Record<string, unknown>;
    const balance = (party['balance'] as { netMinor?: number } | undefined)?.netMinor ?? 0;
    const roles = Array.isArray(party['roles']) ? (party['roles'] as string[]) : ['CUSTOMER'];
    for (const role of roles) {
      db.exec({
        sql: `INSERT INTO parties
                (id, role, name, search, phone, group_id, status, balance, credit_limit, payload)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (id, role) DO UPDATE SET
                name = excluded.name, search = excluded.search, phone = excluded.phone,
                group_id = excluded.group_id, status = excluded.status,
                balance = excluded.balance, credit_limit = excluded.credit_limit,
                payload = excluded.payload`,
        bind: [
          String(party['id']),
          role,
          String(party['name']),
          searchable(party['name'], party['phone']),
          nullable(party['phone']),
          nullable(party['customerGroupId']),
          String(party['status']),
          balance,
          party['creditLimitMinor'] === null || party['creditLimitMinor'] === undefined
            ? null
            : Number(party['creditLimitMinor']),
          JSON.stringify(party),
        ],
      });
    }
  });
}

function toOutboxRow(row: Record<string, unknown>): OutboxRow {
  return {
    operationId: String(row['operation_id']),
    localSeq: Number(row['local_seq']),
    type: String(row['op_type']),
    payload: JSON.parse(String(row['payload'])),
    context: JSON.parse(String(row['context'])) as OutboxRow['context'],
    dependsOn: JSON.parse(String(row['depends_on'])) as number[],
    digest: row['digest'] === null ? null : (JSON.parse(String(row['digest'])) as Record<string, number>),
    documentNumber: str(row['doc_number']),
    status: String(row['status']),
    reasonCode: str(row['reason_code']),
    reason: str(row['reason']),
    attempts: Number(row['attempts']),
    createdAt: String(row['created_at']),
    businessDate: String(row['business_date']),
  };
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function searchable(...parts: readonly unknown[]): string {
  return parts
    .filter((part) => part !== null && part !== undefined && part !== '')
    .map(String)
    .join(' ')
    .toLowerCase();
}
