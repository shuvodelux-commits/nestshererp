import type { OfflineSnapshotResponse, PartyResponse, ProductResponse } from '@sher/core-contracts';

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
  } finally {
    db.close();
  }

  await promoteStaging();
  return (await localDbBytes()) ?? 0;
}

type Db = Awaited<ReturnType<typeof openLocalDb>>;

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
