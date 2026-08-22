-- Party ledgers: the opening receivable/payable a migrating shop starts with,
-- and the index every balance and statement query reads (§5.0, §5.6, INV-06).
--
-- There is deliberately no `balance` column on `parties`. INV-06 defines a
-- party's balance as the sum of their journal lines, and a stored copy is a
-- second source of truth that drifts the first time a posting path forgets to
-- update it. The list column, the ledger header and the receivables report all
-- read the same rollup over `journal_lines` instead — which is what the new
-- index below exists to make fast.

CREATE TABLE party_openings (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, opening_number TEXT NOT NULL,
  party_id CHAR(26) NOT NULL,
  -- The role the opening was entered against. A party may hold several (D-04),
  -- and which one this is decides the account the party side posted to, so it
  -- has to survive on the document rather than be re-guessed from the party's
  -- current roles — which can change after the opening is posted.
  role TEXT NOT NULL,
  direction TEXT NOT NULL, amount_minor BIGINT NOT NULL,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  -- R-C9 reserved columns, as on every transaction table (§3.4). An opening
  -- balance carries no price and therefore no tax; these stay NULL in V1 so a
  -- later phase never migrates them onto posted history.
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  pack_size BIGINT, device_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  -- Positive only: `direction` carries the sign, and a zero opening is a
  -- document that moves nothing, refused here as `stock_openings` refuses it.
  CONSTRAINT party_openings_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT party_openings_role_check CHECK (role IN ('CUSTOMER','SUPPLIER','VENDOR')),
  CONSTRAINT party_openings_direction_check CHECK (direction IN ('RECEIVABLE','PAYABLE')),
  -- Mirrors `rejectOpeningBalance`: a vendor is someone the shop pays, so a
  -- vendor opening that points the other way is a mistyped direction.
  CONSTRAINT party_openings_vendor_is_payable CHECK (role <> 'VENDOR' OR direction = 'PAYABLE'),
  CONSTRAINT party_openings_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT party_openings_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  -- One opening per party per role. A second one is not a correction — it is a
  -- doubled balance, and the shopkeeper who typed it would have no way to see
  -- which of the two figures the list is showing.
  CONSTRAINT party_openings_party_role_unique UNIQUE (tenant_id, party_id, role),
  -- C10: the permanent guarantee, not the 30-day fast path.
  CONSTRAINT party_openings_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT party_openings_number_unique UNIQUE (tenant_id, opening_number)
);

CREATE INDEX party_openings_tenant_party_idx ON party_openings (tenant_id, party_id, id);

-- The index the whole ledger rests on.
--
-- Every party balance is `SUM(amount_minor) WHERE party_id = ?`, and every
-- statement is those same lines in business-date order. Without this the
-- parties list — which needs a balance for each of up to 200 rows — degrades
-- into a scan of the journal per page, which is exactly the query that gets
-- slow first as a real shop accumulates history.
CREATE INDEX journal_lines_tenant_party_idx
  ON journal_lines (tenant_id, party_id, created_at, id)
  WHERE party_id IS NOT NULL;

ALTER TABLE party_openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_openings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON party_openings
  USING (tenant_id = current_setting('app.tenant_id')::char(26));
