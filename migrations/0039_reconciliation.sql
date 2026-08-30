-- Phase 11 — account reconciliation against the bank's own statement (§5.17,
-- UI-70, D-43, owner decisions 2026-08-30). Forward-only and additive (SRS 3.10).
--
--   `bank_statement_files`      the PDF the bank produced, kept as evidence
--   `statement_lines`           that PDF parsed into rows, working data
--   `account_reconciliations`   the shop's sign-off: range, balances, result
--   `reconciliation_matches`    which of our rows is which of theirs
--
-- **Four tables, and not one of them posts anything.** Reconciliation compares
-- and links; it never creates, corrects or cancels a transaction. Every
-- accounting change starts in the module that owns the document — expense,
-- receipt, supplier payment, transfer, correction, cancellation — and this
-- module's own service holds no journal writer at all, which is why the rule
-- cannot be broken by accident later.
--
-- The ERP side of a reconciliation is **not stored**. It is a projection of
-- `journal_lines` re-read on every request (INV-07, INV-10): a copied ledger
-- row is a second version of a figure, and the first thing to disagree with
-- the ledger after a correction.

-- ------------------------------------------------------- bank_statement_files
-- The original PDF, kept whole. §5.17's evidence rule: parsed lines are working
-- data and the file is the proof, so nothing here is ever overwritten or
-- discarded once a statement has been read — a reconciliation whose evidence
-- was replaced afterwards proves nothing.
--
-- `parse_status` records what the parser could do, including when it could do
-- nothing: an image scan is stored and reconciled by hand rather than refused,
-- because the shop still has the paper in front of them (owner decision).
CREATE TABLE bank_statement_files (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  account_id CHAR(26) NOT NULL REFERENCES accounts (id),
  reconciliation_id CHAR(26),
  file_name TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  content BYTEA NOT NULL,
  parse_status TEXT NOT NULL,
  parsed_from_date DATE,
  parsed_to_date DATE,
  parsed_opening_minor BIGINT,
  parsed_closing_minor BIGINT,
  problems_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT bank_statement_files_status_known
    CHECK (parse_status IN ('PARSED', 'PARTIAL', 'UNREADABLE')),
  CONSTRAINT bank_statement_files_size_positive CHECK (byte_size > 0)
);

CREATE INDEX bank_statement_files_by_reconciliation
  ON bank_statement_files (tenant_id, reconciliation_id);

ALTER TABLE bank_statement_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_statement_files USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------------ statement_lines
-- The bank's rows, normalized: one signed amount in poisha, money in positive
-- and money out negative, exactly the convention `journal_lines` uses for these
-- accounts so the two sides of the screen can be compared without a sign rule
-- in the middle.
--
-- `edited_by_user` marks a row the owner repaired in the verification preview.
-- A parser that read a column wrong is a fact worth keeping: it is the
-- difference between "the bank said this" and "we decided the bank meant this".
CREATE TABLE statement_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  file_id CHAR(26) NOT NULL REFERENCES bank_statement_files (id),
  reconciliation_id CHAR(26) NOT NULL,
  line_no INTEGER NOT NULL,
  business_date DATE NOT NULL,
  description TEXT NOT NULL,
  reference TEXT,
  amount_minor BIGINT NOT NULL,
  balance_minor BIGINT,
  edited_by_user BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT statement_lines_amount_not_zero CHECK (amount_minor <> 0)
);

CREATE INDEX statement_lines_by_reconciliation ON statement_lines (tenant_id, reconciliation_id, line_no);

ALTER TABLE statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON statement_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- --------------------------------------------------- account_reconciliations
-- The result, and the only place a reconciliation figure is stored.
--
-- The balances are written **at completion**, on purpose: a completed
-- reconciliation is historical control data (§5.17), so what it certified must
-- stay readable years later even though the ledger under it has moved on. That
-- is the same reason a cash session's expected closing is immutable (§5.16.4)
-- — evidence that recalculates itself is not evidence.
--
-- `REVIEW_REQUIRED` is not written by a correction reaching in here. It is what
-- the screen reads back when a matched document's version no longer matches the
-- one that was signed off — see `reconciliation_matches`.
CREATE TABLE account_reconciliations (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  account_id CHAR(26) NOT NULL REFERENCES accounts (id),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  status TEXT NOT NULL,
  statement_opening_minor BIGINT,
  statement_closing_minor BIGINT,
  book_opening_minor BIGINT,
  reconciled_balance_minor BIGINT,
  difference_minor BIGINT,
  note TEXT,
  completed_at TIMESTAMPTZ,
  completed_by CHAR(26),
  reopened_reason TEXT,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT account_reconciliations_status_known
    CHECK (status IN ('DRAFT', 'COMPLETED', 'REVIEW_REQUIRED')),
  CONSTRAINT account_reconciliations_range_ordered CHECK (from_date <= to_date)
);

-- One draft per account at a time. Two half-finished reconciliations of the
-- same bank account are two people about to certify different answers.
CREATE UNIQUE INDEX account_reconciliations_one_draft
  ON account_reconciliations (tenant_id, account_id)
  WHERE status = 'DRAFT';

CREATE INDEX account_reconciliations_by_account
  ON account_reconciliations (tenant_id, account_id, to_date DESC);

ALTER TABLE account_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_reconciliations USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------ reconciliation_matches
-- A link, and only ever a link.
--
-- One row may hold both sides (our row is their row), or one side alone: a
-- statement line nobody has posted yet, or one of ours the bank has not cleared.
-- `state` says how the link came to exist —
--
--   AUTO           the engine was certain: same amount, same direction, and
--                  either the same reference or the same date, with no second
--                  candidate competing. Recomputed on every re-run.
--   CONFIRMED      a person accepted a suggestion.
--   MANUAL         a person picked both sides themselves.
--   REJECTED       a person said no; stored so the suggestion stays gone.
--   NEEDS_REVIEW   a person parked it as needing a look.
--   OUTSTANDING    ours, correctly not on the statement yet (an uncleared
--                  cheque). Excluded from the reconciled balance by design.
--
-- `document_type/id/version` is a **snapshot of what was signed off**, and the
-- whole of the later-edit rule (R-22): if that document is afterwards corrected,
-- voided or re-dated, its version moves and the reconciliation reads back
-- REVIEW_REQUIRED. Nothing writes into a completed reconciliation to say so,
-- because nothing may.
CREATE TABLE reconciliation_matches (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  reconciliation_id CHAR(26) NOT NULL REFERENCES account_reconciliations (id),
  statement_line_id CHAR(26) REFERENCES statement_lines (id),
  journal_line_id CHAR(26),
  state TEXT NOT NULL,
  score INTEGER,
  reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  document_type TEXT,
  document_id CHAR(26),
  document_version INTEGER,
  matched_at TIMESTAMPTZ NOT NULL,
  matched_by CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT reconciliation_matches_state_known
    CHECK (state IN ('AUTO', 'CONFIRMED', 'MANUAL', 'REJECTED', 'NEEDS_REVIEW', 'OUTSTANDING')),
  CONSTRAINT reconciliation_matches_has_a_side
    CHECK (statement_line_id IS NOT NULL OR journal_line_id IS NOT NULL)
);

-- A row belongs to at most one live link. A rejected pair is not a link, so it
-- is excluded — the same two rows may be rejected once and matched later.
CREATE UNIQUE INDEX reconciliation_matches_one_per_statement_line
  ON reconciliation_matches (tenant_id, statement_line_id)
  WHERE statement_line_id IS NOT NULL AND state <> 'REJECTED';

CREATE UNIQUE INDEX reconciliation_matches_one_per_journal_line
  ON reconciliation_matches (tenant_id, reconciliation_id, journal_line_id)
  WHERE journal_line_id IS NOT NULL AND state <> 'REJECTED';

CREATE INDEX reconciliation_matches_by_reconciliation
  ON reconciliation_matches (tenant_id, reconciliation_id);

ALTER TABLE reconciliation_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_matches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reconciliation_matches USING (tenant_id = current_setting('app.tenant_id')::char(26));
