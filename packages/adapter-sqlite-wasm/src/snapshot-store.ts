import type {
  OfflineSale,
  OfflineSnapshotResponse,
  OfflineUser,
  PartyResponse,
  ProductResponse,
} from '@sher/core-contracts';

import {
  LIVE_FILE,
  localDbBytes,
  openLocalDb,
  promoteStaging,
  STAGING_FILE,
  unlinkLocal,
} from './local-database';
import { LOCAL_SCHEMA } from './local-schema';

/**
 * Writing a downloaded snapshot to disk, and reading back what is on it
 * (§5.23, Phase 12.3, owner decision 2026-08-31).
 *
 * **The whole file exists for one rule: the shop's machine is never left
 * holding half a shop.** A refresh that dies halfway — the line drops, the
 * machine fills up, the browser is closed — must leave yesterday's copy exactly
 * as it was, because an old catalogue is useful and a torn one is a screen
 * showing three of a shop's four hundred products with no way to tell.
 *
 * So the download is written into a staging database that nothing reads, and
 * the live file is replaced by it in one call at the very end. Every failure
 * before that call costs the shop nothing.
 */

/** The rows written per transaction. Large enough to be fast, small enough to hold. */
const BATCH = 500;

export interface StoredSnapshot {
  readonly schemaVersion: number;
  readonly takenAt: string;
  readonly takenByName: string;
  readonly tenantId: string;
  readonly includes: {
    readonly products: boolean;
    readonly customers: boolean;
    readonly suppliers: boolean;
    readonly vendors: boolean;
    readonly cost: boolean;
  };
}

/**
 * Writes a downloaded snapshot and makes it the live copy.
 *
 * `tenantId` is stored and checked on every later read. A machine that signs
 * into a second shop must not be shown the first shop's customers — and the
 * snapshot itself has no tenant on it, because every row in it was already
 * scoped to one by the server.
 *
 * Returns the bytes the stored database occupies, which is the number the O-6
 * report sends home.
 */
export async function storeSnapshot(
  snapshot: OfflineSnapshotResponse,
  tenantId: string,
): Promise<number> {
  // A staging file from an abandoned attempt is not data — it is debris, and
  // reusing it would mix two downloads into one database.
  await unlinkLocal(STAGING_FILE);

  const db = await openLocalDb(STAGING_FILE);
  try {
    db.exec(LOCAL_SCHEMA);

    db.exec({
      sql: `INSERT INTO meta (id, schema_version, taken_at, taken_by_name, tenant_id,
                              includes_products, includes_customers, includes_suppliers,
                              includes_vendors, includes_cost)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        snapshot.schemaVersion,
        snapshot.takenAt,
        snapshot.takenByName,
        tenantId,
        flag(snapshot.includes.products),
        flag(snapshot.includes.customers),
        flag(snapshot.includes.suppliers),
        flag(snapshot.includes.vendors),
        flag(snapshot.includes.cost),
      ],
    });

    writeProducts(db, snapshot.products);
    writeParties(db, 'CUSTOMER', snapshot.customers);
    writeParties(db, 'SUPPLIER', snapshot.suppliers);
    writeParties(db, 'VENDOR', snapshot.vendors);
    // Phase 12.4: who may open this counter without the line, and the sales
    // they can look up while it is down.
    writeUsers(db, snapshot.users);
    writeSales(db, snapshot.sales);
    await carryOverLocalWork(db);
  } finally {
    db.close();
  }

  await promoteStaging();
  return (await localDbBytes()) ?? 0;
}

type Db = Awaited<ReturnType<typeof openLocalDb>>;

/**
 * Carries this machine's own work across a snapshot refresh (Phase 12.4).
 *
 * A refresh replaces the live database whole — that is what makes a failed
 * download cost the shop nothing — and the outbox lives in that same database.
 * Without this, pressing Refresh with six sales still queued would throw the
 * day away, silently, at the moment the shopkeeper was trying to be careful.
 *
 * So the queue, the documents behind it and the machine's own counters are read
 * out of the live copy and written into the staged one before the swap. The
 * snapshot brings new master data; the machine keeps everything it made.
 *
 * Missing or unreadable live copy is not a failure: it means this is the first
 * download on this machine, and there is nothing to carry.
 */
async function carryOverLocalWork(staging: Db): Promise<void> {
  let live: Db;
  try {
    live = await openLocalDb(LIVE_FILE);
  } catch {
    return;
  }

  try {
    const outbox = readAll(live, 'outbox');
    const documents = readAll(live, 'documents');
    const state = live.selectObject('SELECT * FROM local_state WHERE id = 1');

    staging.exec('BEGIN');
    try {
      for (const row of outbox) insertRow(staging, 'outbox', row);
      for (const row of documents) insertRow(staging, 'documents', row);
      if (state !== undefined) {
        staging.exec({
          sql: `UPDATE local_state
                   SET next_local_seq = ?, next_sale_seq = ?, device_code = ?, device_id = ?,
                       sync_cursor = ?, last_push_at = ?, last_pull_at = ?, open_session_op = ?
                 WHERE id = 1`,
          bind: [
            Number(state['next_local_seq'] ?? 1),
            Number(state['next_sale_seq'] ?? 1),
            (state['device_code'] ?? null) as string | null,
            (state['device_id'] ?? null) as string | null,
            (state['sync_cursor'] ?? null) as string | null,
            (state['last_push_at'] ?? null) as string | null,
            (state['last_pull_at'] ?? null) as string | null,
            (state['open_session_op'] ?? null) as string | null,
          ],
        });
      }
      staging.exec('COMMIT');
    } catch (cause) {
      staging.exec('ROLLBACK');
      throw cause;
    }
  } catch {
    /*
     * A live copy written by an older build has no outbox to read. That is the
     * upgrade path, not an error — there was nothing queued, because the build
     * that wrote it could not queue anything.
     */
  } finally {
    live.close();
  }
}

function readAll(db: Db, table: string): readonly Record<string, unknown>[] {
  return db.selectObjects(`SELECT * FROM ${table}`);
}

function insertRow(db: Db, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.exec({
    sql: `INSERT INTO ${table} (${columns.join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})`,
    bind: columns.map((column) => row[column] as never),
  });
}

function writeProducts(db: Db, rows: readonly ProductResponse[]): void {
  inBatches(db, rows, (product) => {
    db.exec({
      sql: `INSERT INTO products (id, name, search, sku, barcode, brand_id, brand_name,
                                  category_id, status, stock_qty, selling_price, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        product.id,
        product.name,
        // Brand and SKU join the searchable text because the counter's own
        // search already ranks on them — a shopkeeper who learns that "walton
        // fan" finds the thing online must find it offline too.
        searchable(product.name, product.sku, product.barcode, product.brandName),
        product.sku,
        product.barcode,
        product.brandId,
        product.brandName,
        product.categoryId,
        product.status,
        product.stockQty,
        product.sellingPriceMinor,
        JSON.stringify(product),
      ],
    });
  });
}

function writeParties(db: Db, role: string, rows: readonly PartyResponse[]): void {
  inBatches(db, rows, (party) => {
    db.exec({
      sql: `INSERT INTO parties (id, role, name, search, phone, group_id, status, balance,
                                 credit_limit, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        party.id,
        role,
        party.name,
        searchable(party.name, party.phone),
        party.phone,
        party.customerGroupId,
        party.status,
        // The signed net, so a list can be ordered by who owes the most
        // without the offline copy having to know what the sign means.
        party.balance.netMinor,
        party.creditLimitMinor,
        JSON.stringify(party),
      ],
    });
  });
}

function writeUsers(db: Db, rows: readonly OfflineUser[]): void {
  inBatches(db, rows, (user) => {
    db.exec({
      sql: `INSERT INTO users (id, display_name, username, pin_hash, permissions)
            VALUES (?, ?, ?, ?, ?)`,
      bind: [
        user.id,
        user.displayName,
        user.username,
        user.pinHash,
        JSON.stringify(user.permissions),
      ],
    });
  });
}

function writeSales(db: Db, rows: readonly OfflineSale[]): void {
  inBatches(db, rows, (sale) => {
    db.exec({
      sql: `INSERT INTO sales
              (id, number, business_date, party_id, customer_name, customer_phone,
               grand_total_minor, paid_minor, due_minor, status, search)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        sale.id,
        sale.number,
        sale.businessDate,
        sale.partyId,
        sale.customerName,
        sale.customerPhone,
        sale.grandTotalMinor,
        sale.paidMinor,
        sale.dueMinor,
        sale.status,
        // The counter's one search box takes an invoice number or a phone, so
        // both go in — the same rule the online lookup follows.
        searchable(sale.number, sale.customerName, sale.customerPhone),
      ],
    });
  });
}

function inBatches<T>(db: Db, rows: readonly T[], write: (row: T) => void): void {
  for (let start = 0; start < rows.length; start += BATCH) {
    db.exec('BEGIN');
    try {
      for (const row of rows.slice(start, start + BATCH)) write(row);
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  }
}

function searchable(...parts: readonly (string | null)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== '')
    .join(' ')
    .toLowerCase();
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * What the live copy says about itself, or null when there is none.
 *
 * Also null when the copy belongs to a different shop, or was written by a
 * build whose row shape has since changed: both are answered here rather than
 * by every caller, because "there is no usable copy" is one fact and a screen
 * that had to distinguish three flavours of it would show three messages
 * where one is true.
 */
export async function readStoredSnapshot(
  tenantId: string,
  schemaVersion: number,
): Promise<StoredSnapshot | null> {
  try {
    const db = await openLocalDb(LIVE_FILE);
    try {
      const row = db.selectObject('SELECT * FROM meta WHERE id = 1');
      if (row === undefined) return null;

      const stored: StoredSnapshot = {
        schemaVersion: Number(row['schema_version']),
        takenAt: String(row['taken_at']),
        takenByName: String(row['taken_by_name']),
        tenantId: String(row['tenant_id']),
        includes: {
          products: row['includes_products'] === 1,
          customers: row['includes_customers'] === 1,
          suppliers: row['includes_suppliers'] === 1,
          vendors: row['includes_vendors'] === 1,
          cost: row['includes_cost'] === 1,
        },
      };

      if (stored.tenantId !== tenantId) return null;
      if (stored.schemaVersion !== schemaVersion) return null;
      return stored;
    } finally {
      db.close();
    }
  } catch {
    // An unreadable copy is the same as no copy: the screens say there is
    // nothing stored and offer Refresh, rather than failing over a file the
    // shopkeeper cannot do anything about.
    return null;
  }
}

/**
 * Destroys the local copy.
 *
 * Called when the machine learns its authority is gone — revoked, force
 * revoked, or handed to another computer (owner decision 2026-08-31). In this
 * slice there is nothing unsent to lose, so the erase is immediate and
 * complete. When offline writing exists, the drain and the quarantine come
 * first and this stays the last step.
 */
export async function eraseLocalCopy(): Promise<void> {
  await unlinkLocal(LIVE_FILE);
  await unlinkLocal(STAGING_FILE);
}
