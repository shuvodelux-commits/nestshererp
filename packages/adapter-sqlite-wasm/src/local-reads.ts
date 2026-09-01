import type {
  PartyListResponse,
  PartyQuery,
  PartyResponse,
  ProductListResponse,
  ProductQuery,
  ProductResponse,
} from '@sher/core-contracts';

import { LIVE_FILE, openLocalDb } from './local-database';

/**
 * Reading the local copy in the shape the online screens already expect
 * (§5.23, Phase 12.3).
 *
 * These functions answer `ProductListResponse` and `PartyListResponse` — the
 * same objects the API returns — so `ProductsPage` and `PartiesPage` render one
 * screen from either source instead of growing a second rendering path for the
 * offline case. A screen that draws itself differently when offline is a screen
 * whose offline behaviour nobody checks.
 *
 * **The filters are the ones a shopkeeper standing at a counter uses**: type a
 * name, pick a brand, pick a category, sort by a column, load another page.
 *
 * Two filters are built from every query, and the difference matters. The rows
 * are fetched with the keyset seek applied; the summary counts are not. A tile
 * counts the whole filtered set, so a tile that inherited the cursor would
 * shrink as the shopkeeper paged — the count would quietly become "how many are
 * left", which is not what the word Total means (§2.7.I).
 */

/** The same default page the API uses, so a screen does not change size offline. */
const DEFAULT_LIMIT = 50;

interface Ordering {
  readonly column: string;
  readonly order: 'ASC' | 'DESC';
}

export async function localProducts(query: ProductQuery): Promise<ProductListResponse> {
  const db = await openLocalDb(LIVE_FILE);
  try {
    const where: string[] = [];
    const bind: (string | number)[] = [];

    if (query.search !== undefined && query.search.trim() !== '') {
      where.push('search LIKE ?');
      bind.push(`%${query.search.trim().toLowerCase()}%`);
    }
    if (query.brandId !== undefined) {
      where.push('brand_id = ?');
      bind.push(query.brandId);
    }
    if (query.categoryId !== undefined) {
      where.push('category_id = ?');
      bind.push(query.categoryId);
    }
    if (query.status !== undefined) {
      where.push('status = ?');
      bind.push(query.status);
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const sort = productOrder(query.sort, query.direction);
    const found = page(db, 'products', where, bind, sort, limit, query.cursor);

    const summary = db.selectObject(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status <> 'ACTIVE' THEN 1 ELSE 0 END) AS inactive,
              SUM(CASE WHEN barcode IS NULL OR barcode = '' THEN 1 ELSE 0 END) AS without_barcode
         FROM products ${clause(where)}`,
      bind,
    );

    return {
      data: found.rows.map((row) => JSON.parse(String(row['payload'])) as ProductResponse),
      page: { nextCursor: found.nextCursor, hasMore: found.hasMore },
      summary: {
        total: count(summary, 'total'),
        active: count(summary, 'active'),
        inactive: count(summary, 'inactive'),
        withoutBarcode: count(summary, 'without_barcode'),
      },
    };
  } finally {
    db.close();
  }
}

export async function localParties(query: PartyQuery): Promise<PartyListResponse> {
  const db = await openLocalDb(LIVE_FILE);
  try {
    const where: string[] = ['role = ?'];
    const bind: (string | number)[] = [query.role];

    if (query.search !== undefined && query.search.trim() !== '') {
      where.push('search LIKE ?');
      bind.push(`%${query.search.trim().toLowerCase()}%`);
    }
    if (query.groupId !== undefined) {
      where.push('group_id = ?');
      bind.push(query.groupId);
    }
    if (query.status !== undefined) {
      where.push('status = ?');
      bind.push(query.status);
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const sort = partyOrder(query.sort, query.direction);
    const found = page(db, 'parties', where, bind, sort, limit, query.cursor);

    const summary = db.selectObject(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END) AS inactive,
              SUM(CASE WHEN group_id IS NULL THEN 1 ELSE 0 END) AS ungrouped,
              -- Two one-sided totals, never one net: netting would hide a shop
              -- carrying large dues *and* large advances behind a small
              -- difference. The same sum the server takes (§2.7.I).
              COALESCE(SUM(MAX(balance, 0)), 0) AS outstanding,
              COALESCE(SUM(MAX(-balance, 0)), 0) AS advance,
              -- A NULL limit is no limit, not zero, and greater-than lets a
              -- customer sit exactly on their limit — the server's rule, kept.
              SUM(CASE WHEN credit_limit IS NOT NULL AND MAX(balance, 0) > credit_limit
                       THEN 1 ELSE 0 END) AS over_credit_limit
         FROM parties ${clause(where)}`,
      bind,
    );

    return {
      data: found.rows.map((row) => JSON.parse(String(row['payload'])) as PartyResponse),
      page: { nextCursor: found.nextCursor, hasMore: found.hasMore },
      summary: {
        total: count(summary, 'total'),
        active: count(summary, 'active'),
        inactive: count(summary, 'inactive'),
        ungrouped: count(summary, 'ungrouped'),
        totalOutstandingMinor: count(summary, 'outstanding'),
        totalAdvanceMinor: count(summary, 'advance'),
        overCreditLimit: count(summary, 'over_credit_limit'),
      },
    };
  } finally {
    db.close();
  }
}

type Db = Awaited<ReturnType<typeof openLocalDb>>;

interface Found {
  readonly rows: readonly Record<string, unknown>[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/**
 * One page of rows, with the seek applied and one row more than asked for.
 *
 * The extra row is how "is there another page" is answered here, exactly as the
 * server's keyset paging answers it (§3.9) — which is why the two agree about
 * when a list has ended instead of disagreeing by one row at every boundary.
 */
function page(
  db: Db,
  table: string,
  where: readonly string[],
  bind: readonly (string | number)[],
  sort: Ordering,
  limit: number,
  cursor: string | undefined,
): Found {
  const conditions = [...where];
  const values = [...bind];

  if (cursor !== undefined) {
    const from = seek(table, sort.column, sort.order, cursor);
    conditions.push(from.clause);
    values.push(...from.bind);
  }

  const rows = db.selectObjects(
    `SELECT id, payload FROM ${table} ${clause(conditions)}
      ORDER BY ${sort.column} ${sort.order}, id ASC
      LIMIT ?`,
    [...values, limit + 1],
  );

  const hasMore = rows.length > limit;
  const shown = hasMore ? rows.slice(0, limit) : rows;
  const last = shown[shown.length - 1];

  return {
    rows: shown,
    hasMore,
    nextCursor: hasMore && last !== undefined ? String(last['id']) : null,
  };
}

function clause(where: readonly string[]): string {
  return where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
}

/**
 * The keyset seek, as a row-value comparison.
 *
 * `cursor` is the id of the last row of the previous page — the same cursor the
 * server issues, so a screen that paged online and then lost the line keeps
 * asking with a cursor the local copy understands. The comparison is against
 * the pair `(sort column, id)` rather than the id alone: two products with the
 * same name would otherwise let the page boundary skip one or show it twice.
 *
 * SQLite has compared row values since 3.15; the bundled build is 3.53. Table
 * and column names come from the closed lists below and never from anything a
 * caller supplied — every value here is bound.
 */
function seek(
  table: string,
  column: string,
  order: 'ASC' | 'DESC',
  cursor: string,
): { clause: string; bind: string[] } {
  const compare = order === 'ASC' ? '>' : '<';
  return {
    clause: `(${column}, id) ${compare} (SELECT ${column}, id FROM ${table} WHERE id = ? LIMIT 1)`,
    bind: [cursor],
  };
}

/**
 * The sort, from the same closed allow-list the API uses (UI-46).
 *
 * Built by lookup, never by concatenating something a caller sent. A sort the
 * local copy cannot honour — cost, when the snapshot was taken by somebody
 * without permission to see it — falls back to name rather than failing,
 * because the screen has already hidden that column.
 */
function productOrder(sort: string | undefined, direction: string | undefined): Ordering {
  const column =
    sort === 'stock'
      ? 'stock_qty'
      : sort === 'sellingPrice'
        ? 'selling_price'
        : sort === 'createdAt'
          ? 'id'
          : 'name';
  return { column, order: way(direction, column) };
}

function partyOrder(sort: string | undefined, direction: string | undefined): Ordering {
  const column = sort === 'balance' ? 'balance' : sort === 'createdAt' ? 'id' : 'name';
  return { column, order: way(direction, column) };
}

/** A name reads A–Z by default; a number reads biggest-first, as it does online. */
function way(direction: string | undefined, column: string): 'ASC' | 'DESC' {
  if (direction === 'asc') return 'ASC';
  if (direction === 'desc') return 'DESC';
  return column === 'name' ? 'ASC' : 'DESC';
}

function count(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  return value === null || value === undefined ? 0 : Number(value);
}
