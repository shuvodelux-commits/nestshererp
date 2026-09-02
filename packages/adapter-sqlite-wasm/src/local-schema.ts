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

-- ----------------------------------------------------------------- outbox
-- Phase 12.4. What the shop did while it could not reach its own books.
--
-- **A command, not a document.** Each row is the exact request body the online
-- endpoint takes, plus the operation id the cashier's button press generated.
-- Replay hands that body to the very service the online API calls, so there is
-- one posting implementation in the application and not two — which is the
-- whole architecture of this phase in one sentence.
--
-- The row is written and committed **before** the UI says the sale succeeded
-- and before anything is printed (§2, §19). A slip in a customer's hand that
-- this table never heard of is the one failure an offline till must not have.
CREATE TABLE outbox (
  -- The idempotency key, generated on this machine when the button was pressed.
  -- It never changes through any number of retries, and it is what makes a
  -- repeated push cost nothing.
  operation_id TEXT PRIMARY KEY,
  -- Strictly increasing, from local_state. Two operations can share a
  -- millisecond; they cannot share a sequence number, which is why ordering
  -- uses this and never a timestamp.
  local_seq    INTEGER NOT NULL UNIQUE,
  op_type      TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  context      TEXT    NOT NULL,
  -- local_seq values this one may not go before: the product a sale names, the
  -- day-opening a day-closing closes.
  depends_on   TEXT    NOT NULL DEFAULT '[]',
  -- What the customer was charged, as printed. Compared by the server and never
  -- replaced by it (§5).
  digest       TEXT,
  -- The number on the paper, where the document carries one.
  doc_number   TEXT,
  -- PENDING → SENT → ACCEPTED | REFUSED | SETTLED.
  -- REFUSED means the books would not take it and a person must decide;
  -- SETTLED means the shop decided it will never be posted.
  status       TEXT    NOT NULL DEFAULT 'PENDING',
  reason_code  TEXT,
  reason       TEXT,
  server_id    TEXT,
  server_number TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  business_date TEXT   NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE INDEX outbox_pending ON outbox (status, local_seq);

-- ---------------------------------------------------------------- documents
-- What the counter shows for work this machine did while disconnected.
--
-- Deliberately display-only, and deliberately not a second ledger. It holds the
-- money the slip showed and the words a list needs; it holds no cost, no lot,
-- no journal line and no balance, because the server computes those and the one
-- thing worse than no profit figure is a wrong one nobody knows is wrong (§4).
CREATE TABLE documents (
  operation_id TEXT PRIMARY KEY,
  doc_type     TEXT NOT NULL,
  doc_number   TEXT,
  business_date TEXT NOT NULL,
  party_id     TEXT,
  party_name   TEXT,
  total_minor  INTEGER NOT NULL DEFAULT 0,
  paid_minor   INTEGER NOT NULL DEFAULT 0,
  due_minor    INTEGER NOT NULL DEFAULT 0,
  -- The full local view of the document, for reprinting the slip offline.
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX documents_by_type ON documents (doc_type, created_at DESC);
CREATE INDEX documents_by_party ON documents (party_id, created_at DESC);

-- ------------------------------------------------------------------- sales
-- Twelve months of the shop's sales, plus every unpaid one however old (§13).
-- Summaries: enough to find a slip, read a customer's history and see what is
-- still owed while the line is down.
CREATE TABLE sales (
  id            TEXT PRIMARY KEY,
  number        TEXT NOT NULL,
  business_date TEXT NOT NULL,
  party_id      TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  grand_total_minor INTEGER NOT NULL,
  paid_minor    INTEGER NOT NULL,
  due_minor     INTEGER NOT NULL,
  status        TEXT NOT NULL,
  search        TEXT NOT NULL
);

CREATE INDEX sales_number ON sales (number);
CREATE INDEX sales_search ON sales (search);
CREATE INDEX sales_party ON sales (party_id, business_date DESC);

-- ------------------------------------------------------------------- users
-- Who may open this counter while it cannot reach the server (§9).
--
-- The PIN hash and nothing else. A password opens far more than a till, and
-- there is no reason for a copy of one to sit on a machine that can be stolen.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  username     TEXT,
  pin_hash     TEXT NOT NULL,
  permissions  TEXT NOT NULL
);

-- ------------------------------------------------------------- local_state
-- The one row of counters and cursors this machine keeps for itself.
CREATE TABLE local_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  -- The next local_seq to hand out, and the next sale sequence to print.
  next_local_seq INTEGER NOT NULL DEFAULT 1,
  next_sale_seq  INTEGER NOT NULL DEFAULT 1,
  -- This machine's permanent short code, from its device row. A sale is
  -- numbered S-2026-A-000123 with it, on paper, before the server has ever
  -- seen the document.
  device_code    TEXT,
  device_id      TEXT,
  -- Where the pull got to, so a reconnect resumes rather than re-downloads.
  sync_cursor    TEXT,
  last_push_at   TEXT,
  last_pull_at   TEXT,
  -- The cash day this machine opened offline, so the close can name it.
  open_session_op TEXT
);

INSERT INTO local_state (id) VALUES (1);
`;
