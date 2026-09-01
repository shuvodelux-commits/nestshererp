/**
 * What the local copy stores (§5.23, Phase 12.3).
 *
 * **Each row keeps the server's own response object whole, in `payload`.**
 * The indexed columns beside it exist only to find and order rows; every field
 * the screen renders is read back out of the payload. That is a deliberate
 * choice against the obvious alternative of a column per field:
 *
 * - A product response carries around forty fields, several of them nested and
 *   several of them conditional on permission. Spreading those across columns
 *   would be a second definition of a product, kept in step by hand, and the
 *   first time it drifted the offline screen would render a subtly different
 *   product from the online one — the exact failure the offline module cannot
 *   afford, because nobody is watching when it happens.
 * - The rows are written once per refresh and read by search and sort. SQLite
 *   indexes the columns that do the finding; the payload is never queried into.
 * - A field added to the contract next month lands in the copy with no schema
 *   change here at all.
 *
 * Money stays integer minor units inside the payload exactly as it arrived
 * (§3.4). Nothing here parses, rounds or recomputes a figure — this file
 * stores what the server said and hands it back unchanged.
 */

/**
 * The one row of `meta`, which is what the offline bar reads.
 *
 * `schema_version` is checked before anything is read: a copy written by an
 * older build is discarded and downloaded again rather than read into columns
 * that have moved since.
 */
export const LOCAL_SCHEMA = `
CREATE TABLE meta (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version    INTEGER NOT NULL,
  taken_at          TEXT    NOT NULL,
  taken_by_name     TEXT    NOT NULL,
  tenant_id         TEXT    NOT NULL,
  includes_products INTEGER NOT NULL,
  includes_customers INTEGER NOT NULL,
  includes_suppliers INTEGER NOT NULL,
  includes_vendors  INTEGER NOT NULL,
  includes_cost     INTEGER NOT NULL
);

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- Lower-cased once at write time. A shopkeeper types "sam a15" in whatever
  -- case the keyboard is in, and LIKE on a lower-cased column uses the index
  -- while LOWER(name) LIKE would scan every row.
  search        TEXT NOT NULL,
  sku           TEXT,
  barcode       TEXT,
  brand_id      TEXT,
  brand_name    TEXT,
  category_id   TEXT,
  status        TEXT NOT NULL,
  stock_qty     INTEGER NOT NULL,
  selling_price INTEGER NOT NULL,
  payload       TEXT NOT NULL
);

CREATE INDEX products_name ON products (name);
CREATE INDEX products_search ON products (search);
CREATE INDEX products_barcode ON products (barcode);
CREATE INDEX products_brand ON products (brand_id);
CREATE INDEX products_category ON products (category_id);

CREATE TABLE parties (
  id         TEXT NOT NULL,
  -- A party may hold more than one role (D-04), and the screens ask by role,
  -- so the row is stored once per role it has. The primary key is the pair.
  role       TEXT NOT NULL,
  name       TEXT NOT NULL,
  search     TEXT NOT NULL,
  phone      TEXT,
  group_id   TEXT,
  status     TEXT NOT NULL,
  balance    INTEGER NOT NULL,
  -- NULL means no limit, never zero — the tile counts only parties who have
  -- one and are past it, exactly as the server's FILTER does.
  credit_limit INTEGER,
  payload    TEXT NOT NULL,
  PRIMARY KEY (id, role)
);

CREATE INDEX parties_role_name ON parties (role, name);
CREATE INDEX parties_search ON parties (role, search);
CREATE INDEX parties_phone ON parties (phone);
`;
