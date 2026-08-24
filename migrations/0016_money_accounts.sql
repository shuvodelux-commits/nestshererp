-- Phase 4 — money accounts, the business day, and what moves between them
-- (§5.16, §5.17, §2.4, INV-07). Forward-only and additive (SRS 3.10).
--
-- Four tables, and the reason there are four rather than one:
--
--   `accounts`             where money sits — the drawer, the safe, a bank, bKash
--   `account_openings`     the balance a migrating shop starts each one with
--   `cash_sessions`        one trading day at the drawer
--   `cash_session_closes`  each attempt to close that day, including a mistaken one
--   `cash_movements`       money crossing between accounts, or in and out of the owner
--
-- **There is no `balance` column anywhere in here.** INV-06 and INV-07 define an
-- account's balance as the sum of its journal lines, exactly as a party's is
-- (see `0015_party_openings.sql` for the full argument). A stored balance is a
-- second answer to "how much cash is there", and the first time a posting path
-- forgets to update it the drawer screen and the ledger disagree — which is the
-- one disagreement §5.16 exists to make impossible.

-- ----------------------------------------------------------------- accounts
-- Class A (§3.4): mutable master data. An account is not a document — it is
-- never posted, numbered or voided; the movements against it are.
--
-- One table for CASH, BANK and MFS rather than three (§2.4). bKash and Nagad
-- are not drawer cash — you cannot count them at night — so they post to
-- `BANK:{id}` and differ from a bank only in the label the shop reads. Three
-- tables would mean three repositories, three statement queries and a transfer
-- use case that branches on which pair of tables it is joining.
CREATE TABLE accounts (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  -- Whose name the account is in, and its number — a bank account number, an
  -- MFS phone. Both optional: the drawer at the counter has neither.
  holder_name TEXT,
  reference TEXT,
  -- The one drawer the day is counted against (owner decision 2026-08-24: one
  -- counted drawer per day). A safe or a second cash box is a real account that
  -- holds real money, but it is not counted every night — money reaches it as a
  -- recorded transfer, which is what keeps it provable without a nightly count.
  is_drawer BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT accounts_type_check CHECK (type IN ('CASH','BANK','MFS')),
  CONSTRAINT accounts_status_check CHECK (status IN ('ACTIVE','INACTIVE')),
  -- Only cash can be the drawer. A bank account cannot be physically counted at
  -- the end of the day, so flagging one would produce a session whose "counted"
  -- figure nobody could ever have counted.
  CONSTRAINT accounts_drawer_is_cash CHECK (NOT is_drawer OR type = 'CASH')
);

-- Two accounts a shopkeeper cannot tell apart are two accounts they will post
-- to at random. Case-insensitive because `Cash Drawer` and `cash drawer` are the
-- same box. Live rows only — a deactivated account keeps its name in history.
CREATE UNIQUE INDEX accounts_tenant_name_unique
  ON accounts (tenant_id, LOWER(name)) WHERE deleted_at IS NULL;

-- One drawer per tenant, enforced here rather than in code: the whole of §5.16
-- rests on "one counted drawer per business day", and a second drawer would
-- make `cash_sessions` ambiguous about which box the count belongs to.
CREATE UNIQUE INDEX accounts_tenant_drawer_unique
  ON accounts (tenant_id) WHERE is_drawer AND deleted_at IS NULL;

CREATE INDEX accounts_tenant_type_idx ON accounts (tenant_id, type, status, id);

-- -------------------------------------------------------- account_openings
-- Class B (§3.4): a posted document, with the reserved columns every one of
-- them carries. The twin of `party_openings` and `stock_openings` — a shop
-- joining SherERP already has money in the till and in the bank, and that
-- figure enters the same way every other opening does: as a posted entry
-- against `OPENING_EQUITY`, never as a typed column on `accounts`.
--
-- Owner decision 2026-08-24: these are typed on the account form, not imported.
-- A shop has a handful of accounts, and building a CSV to enter three numbers
-- is work the shopkeeper does not need. The CSV importer keeps parties and
-- stock, where the lists are genuinely long.
CREATE TABLE account_openings (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  opening_number TEXT NOT NULL,
  account_id CHAR(26) NOT NULL REFERENCES accounts (id),
  -- Positive only. An account opening has no direction to carry a sign: money
  -- in an account is money in an account, and a negative drawer is not a thing
  -- a shopkeeper can count. An overdrawn bank account arrives as a movement.
  amount_minor BIGINT NOT NULL,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  -- R-C9 reserved columns (§3.4). An opening balance carries no price and so no
  -- tax; NULL in V1 so a later phase never migrates them onto posted history.
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  pack_size BIGINT, device_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT account_openings_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT account_openings_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT account_openings_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  -- One opening per account. A second is not a correction but a doubled
  -- balance; a correction posts an audited delta against the same document
  -- (§2.5), exactly as a party opening does.
  CONSTRAINT account_openings_account_unique UNIQUE (tenant_id, account_id),
  CONSTRAINT account_openings_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT account_openings_number_unique UNIQUE (tenant_id, opening_number)
);

-- ------------------------------------------------------------ cash_sessions
-- One trading day at the drawer (§5.16.1). One row per tenant per business
-- date — the uniqueness below is what makes "one Start Day, one count" true in
-- the database rather than only in the use case.
--
-- The row holds what was *declared at Start Day*. What was counted at End Day
-- lives on `cash_session_closes`, because a day can be closed more than once
-- when it was closed by mistake, and each of those counts is a fact that
-- happened.
CREATE TABLE cash_sessions (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  session_number TEXT NOT NULL,
  -- Denormalised from `accounts.is_drawer` at Start Day on purpose: the flag
  -- can move to a different box later, and a session must keep saying which
  -- box was actually counted that night.
  account_id CHAR(26) NOT NULL REFERENCES accounts (id),
  business_date DATE NOT NULL,
  status TEXT NOT NULL,
  -- The counted physical opening (§5.16.2) — never computed, never suggested
  -- into the row without someone confirming it.
  opening_amount_minor BIGINT NOT NULL,
  -- What the previous day actually closed at, frozen as at Start Day. Kept so
  -- the day can explain its own opening difference years later without
  -- re-deriving it from a session that may since have been reopened.
  previous_closing_minor BIGINT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT cash_sessions_status_check CHECK (status IN ('OPEN','CLOSED')),
  -- Zero is legitimate: a shop can open the day with an empty drawer. Negative
  -- is not — you cannot count minus five hundred taka.
  CONSTRAINT cash_sessions_opening_not_negative CHECK (opening_amount_minor >= 0),
  CONSTRAINT cash_sessions_date_unique UNIQUE (tenant_id, business_date),
  CONSTRAINT cash_sessions_number_unique UNIQUE (tenant_id, session_number)
);

CREATE INDEX cash_sessions_tenant_date_idx ON cash_sessions (tenant_id, business_date DESC, id);
-- "Is a day open right now" is asked on every cash-affecting posting (§5.16.1
-- rejects one with no open session), so it must not be a scan of the history.
CREATE UNIQUE INDEX cash_sessions_tenant_open_unique
  ON cash_sessions (tenant_id) WHERE status = 'OPEN' AND deleted_at IS NULL;

-- ------------------------------------------------------ cash_session_closes
-- One row per attempt to close a day (§5.16.4, and the 2026-08-24 reopen
-- amendment). A day closed by mistake and reopened has two rows: the first
-- `SUPERSEDED`, the second `ACTIVE`.
--
-- **Why a child table rather than columns on the session.** §5.16.4 makes the
-- stored expected amount immutable, and §5.16.7 requires expected, counted and
-- difference to stay distinguishable forever. Overwriting three columns on the
-- session at the second close would destroy the first count — the very number
-- the owner needs in order to see that a mistake was made and what it said.
-- Both closes stay readable, each with its actor, its time and its reason.
CREATE TABLE cash_session_closes (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  session_id CHAR(26) NOT NULL REFERENCES cash_sessions (id),
  status TEXT NOT NULL,
  -- The five figures of §5.16.4, stored, never recomputed on read. `cash_in`
  -- and `cash_out` are the day's posted movements as they stood at this close;
  -- `expected` is opening + in − out, computed once by the system.
  opening_amount_minor BIGINT NOT NULL,
  cash_in_minor BIGINT NOT NULL,
  cash_out_minor BIGINT NOT NULL,
  expected_closing_minor BIGINT NOT NULL,
  counted_closing_minor BIGINT NOT NULL,
  difference_minor BIGINT NOT NULL,
  -- Required by the use case whenever the difference is non-zero (§5.16.4).
  -- Free text on purpose: a shortage's cause is not a closed list, and the
  -- Start Day counterpart — which *does* need a posted other side — is a
  -- structured account instead (see `cash_movements`).
  difference_reason TEXT,
  -- Why this close was undone, and by whom. NULL while the close stands.
  reopen_reason TEXT,
  superseded_at TIMESTAMPTZ, superseded_by CHAR(26),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT cash_session_closes_status_check CHECK (status IN ('ACTIVE','SUPERSEDED')),
  CONSTRAINT cash_session_closes_counted_not_negative CHECK (counted_closing_minor >= 0),
  -- The arithmetic of §5.16.4, enforced where it cannot be argued with. If a
  -- future posting path ever computes these differently, it fails here rather
  -- than storing a difference that does not equal what it claims to be.
  CONSTRAINT cash_session_closes_expected_arithmetic
    CHECK (expected_closing_minor = opening_amount_minor + cash_in_minor - cash_out_minor),
  CONSTRAINT cash_session_closes_difference_arithmetic
    CHECK (difference_minor = counted_closing_minor - expected_closing_minor),
  CONSTRAINT cash_session_closes_reason_when_different
    CHECK (difference_minor = 0 OR difference_reason IS NOT NULL),
  -- A superseded close says who undid it and when; a standing one cannot.
  CONSTRAINT cash_session_closes_superseded_fields
    CHECK ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL AND superseded_by IS NOT NULL))
);

-- At most one standing close per session. This is the constraint that makes
-- "the day is closed" a single fact rather than a race between two cashiers.
CREATE UNIQUE INDEX cash_session_closes_active_unique
  ON cash_session_closes (session_id) WHERE status = 'ACTIVE' AND deleted_at IS NULL;
CREATE INDEX cash_session_closes_tenant_session_idx
  ON cash_session_closes (tenant_id, session_id, created_at, id);

-- ----------------------------------------------------------- cash_movements
-- Class B: money crossing between two named places (§5.16.3, §5.16.5).
--
-- Owner injection and withdrawal, transfers between accounts, bank deposits and
-- withdrawals, and the Start Day opening adjustment are **one table with two
-- account sides**, not five document types. Every one of them is the same
-- event — value leaves one named place and arrives at another — and §5.16.5's
-- rule that cash always has a named destination is exactly the constraint that
-- both sides are NOT NULL.
--
-- `kind` is display and reporting, never accounting: the journal is built from
-- `from_account_code` and `to_account_code`, so a mislabelled kind cannot
-- misplace money.
CREATE TABLE cash_movements (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  movement_number TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- Validated account codes (§2.4): `CASH:01J…`, `BANK:01J…`,
  -- `OWNER_CURRENT_ACCOUNT`. Stored as the code rather than an account id
  -- because one side is frequently not an account row at all — the owner is
  -- not an account, and a nullable id plus a discriminator would be the same
  -- thing with more ways to be wrong.
  from_account_code TEXT NOT NULL,
  to_account_code TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  note TEXT,
  -- The day this movement was recorded against, when it belongs to one. A
  -- Start Day adjustment names its session; an owner withdrawal at 3pm names
  -- the open session so it lands in that day's cash out.
  session_id CHAR(26) REFERENCES cash_sessions (id),
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  -- R-C9 reserved columns (§3.4).
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  pack_size BIGINT, device_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT cash_movements_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT cash_movements_kind_check
    CHECK (kind IN ('OWNER_INJECTION','OWNER_WITHDRAWAL','TRANSFER','OPENING_ADJUSTMENT')),
  CONSTRAINT cash_movements_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT cash_movements_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  -- Money that leaves an account and arrives at the same account has not moved;
  -- it is a typo that would post a zero-sum entry and pad the day's cash in and
  -- cash out with a movement that never happened.
  CONSTRAINT cash_movements_sides_differ CHECK (from_account_code <> to_account_code),
  CONSTRAINT cash_movements_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT cash_movements_number_unique UNIQUE (tenant_id, movement_number)
);

CREATE INDEX cash_movements_tenant_session_idx ON cash_movements (tenant_id, session_id, created_at, id);
CREATE INDEX cash_movements_tenant_date_idx ON cash_movements (tenant_id, business_date, created_at, id);

-- No new journal index is needed: an account statement is `SUM`/`ORDER BY` over
-- the lines carrying that account code, which is exactly what
-- `journal_lines_tenant_account_idx` (migration 0012) already covers.

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE account_openings ENABLE ROW LEVEL SECURITY; ALTER TABLE account_openings FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_session_closes ENABLE ROW LEVEL SECURITY; ALTER TABLE cash_session_closes FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY; ALTER TABLE cash_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounts USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON account_openings USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON cash_sessions USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON cash_session_closes USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON cash_movements USING (tenant_id = current_setting('app.tenant_id')::char(26));
