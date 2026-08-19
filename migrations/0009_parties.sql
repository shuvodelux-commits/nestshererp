-- Phase 2, path 2.3 — parties: customers, suppliers and vendors (§5.6, D-02,
-- D-04), and the customer groups they are sorted into.
--
-- Forward-only and additive (SRS 3.10). No column is dropped or renamed.
--
-- Class A (§3.4): master data, exactly like products. No `business_date`, no
-- posted status, no numbering, none of the R-C9 reserved transaction columns —
-- §3.9 says as much: "Master data (products, parties) has neither
-- `business_date` nor `status` transitions". A party's balance is not stored
-- here either: §5.0 and INV-06 make a ledger balance the sum of journal lines,
-- so an opening receivable is a posted opening entry (Phase 4), never a column
-- somebody can type over.
--
-- **One table with roles, not three tables** (D-04): "One internal `parties`
-- table with role flags (CUSTOMER, SUPPLIER, VENDOR, EXPENSE, EMPLOYEE). UI
-- shows separate Customer / Supplier / Vendor / Expense ledgers as views over
-- the same journal." §5.6 names the shape precisely — "One `parties` table +
-- `party_roles`" — so the flags are rows, which is what lets a party gain the
-- SUPPLIER role later without rewriting the row every ledger points at.

-- --------------------------------------------------------- customer_groups
-- §5.6's "Customer Group", and the classification dealer pricing will read in
-- Phase 6. Its own table rather than free text, because a group has to be
-- renameable in one place once prices hang off it.
CREATE TABLE customer_groups (
  id          CHAR(26)    PRIMARY KEY,
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  updated_by  CHAR(26)    NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  CHAR(26)    NULL
);

-- Case-insensitive, like every other name in the system: `Dealer` and `dealer`
-- are one group, and two of them would split a price list in half.
CREATE UNIQUE INDEX customer_groups_tenant_name_unique
  ON customer_groups (tenant_id, lower(name))
  WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------- parties
CREATE TABLE parties (
  id                 CHAR(26)    PRIMARY KEY,
  tenant_id          CHAR(26)    NOT NULL REFERENCES tenants (id),

  name               TEXT        NOT NULL,

  -- Mandatory for a CUSTOMER (D-02), optional for a supplier or a vendor, and
  -- NULL for the walk-in party. The column is therefore nullable and the rule
  -- is enforced where it can be explained — a NOT NULL here would make it
  -- impossible to save the supplier whose number nobody has yet.
  phone              TEXT        NULL,

  -- §5.6's optional customer fields. Settings may hide them from the form
  -- (§5.21, `customer_field_*_visible`) "while preserving stored historical
  -- data", which is why hiding one never clears a column.
  address            TEXT        NULL,
  guardian_name      TEXT        NULL,
  nid                TEXT        NULL,
  email              TEXT        NULL,
  notes              TEXT        NULL,

  customer_group_id  CHAR(26)    NULL REFERENCES customer_groups (id),

  -- §3.4: "`credit_limit` belongs on the **party**, not on transactions."
  -- Poisha, scale 2. NULL means no limit, which is not the same as a limit of
  -- zero — zero means this customer may not take goods on credit at all.
  -- Nothing enforces it until sales exist (Phase 6); it is stored now because
  -- it is a customer field §5.6 lists, and importing it later would mean
  -- re-entering it for every customer.
  credit_limit_minor BIGINT      NULL,

  status             TEXT        NOT NULL DEFAULT 'ACTIVE',

  -- D-02: "The walk-in customer is one real, `system_reserved` party exempt
  -- from the constraint." Exempt from the phone rule, and refused to every
  -- edit, deactivation and delete path — a shop that renamed or removed it
  -- would have every fully-paid guest sale pointing at nothing.
  is_system_reserved BOOLEAN     NOT NULL DEFAULT FALSE,

  /*
   * D-02's uniqueness rule, made enforceable by the database.
   *
   * "A registered customer's phone is mandatory and unique per `(tenant_id,
   * phone)` **within the CUSTOMER role only**. Other roles may share a number."
   * The role lives in `party_roles`, so a partial unique index over this table
   * has nothing to test the role with — and an application-only check loses to
   * two cashiers saving the same new customer at the same moment.
   *
   * So the repository writes the customer's phone into this column and NULL
   * into it for every party that is not a live CUSTOMER, and the unique index
   * below does the rest. It is a **uniqueness key, not a second role store**:
   * it is derived from the roles being written in the same statement, in one
   * place, and nothing reads it to decide what a party is.
   */
  customer_phone_key TEXT        NULL,

  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL,
  created_by         CHAR(26)    NOT NULL,
  updated_by         CHAR(26)    NOT NULL,
  version            INTEGER     NOT NULL DEFAULT 1,
  deleted_at         TIMESTAMPTZ NULL,
  deleted_by         CHAR(26)    NULL,

  CONSTRAINT parties_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT parties_credit_limit_not_negative_check
    CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0)
);

-- D-02, enforced rather than hoped for. Partial, so the suppliers and vendors
-- with no customer role do not collide with each other on NULL.
CREATE UNIQUE INDEX parties_tenant_customer_phone_unique
  ON parties (tenant_id, customer_phone_key)
  WHERE customer_phone_key IS NOT NULL AND deleted_at IS NULL;

-- §3.9: master data is indexed on `(tenant_id, name)` and its lookup keys, and
-- names "Registered customer lookup by phone → `(tenant_id, phone)` on parties"
-- explicitly. The phone index is not unique — a supplier and a customer may
-- share a number, which is precisely what D-02 allows.
CREATE INDEX parties_tenant_name_idx ON parties (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX parties_tenant_phone_idx ON parties (tenant_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX parties_tenant_status_idx ON parties (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX parties_tenant_group_idx
  ON parties (tenant_id, customer_group_id)
  WHERE deleted_at IS NULL;

-- Counter search: a shopkeeper types three letters of a name. `pg_trgm` is
-- already installed by migration 0008; the index cannot carry `tenant_id`
-- without `btree_gin`, so tenant scoping stays in the query predicate and in
-- RLS, exactly as it does for products.
CREATE INDEX parties_name_trgm_idx ON parties USING GIN (name gin_trgm_ops);

-- ------------------------------------------------------------ party_roles
-- D-04's role flags as rows. Soft-deleted rather than removed when a role is
-- taken away, so re-adding it revives the row instead of colliding with the
-- unique index — the same shape `role_permissions` has carried since Phase 0.
--
-- The CHECK admits all five roles D-04 names. `EXPENSE` and `EMPLOYEE` are not
-- offered by any API in this module because no module defines what they mean
-- yet; admitting them here means the module that does is a use case rather than
-- a constraint change on a table holding every party in the business.
CREATE TABLE party_roles (
  id          CHAR(26)    PRIMARY KEY,
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  party_id    CHAR(26)    NOT NULL REFERENCES parties (id),
  role        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  updated_by  CHAR(26)    NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  CHAR(26)    NULL,

  CONSTRAINT party_roles_role_check
    CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'VENDOR', 'EXPENSE', 'EMPLOYEE'))
);

CREATE UNIQUE INDEX party_roles_unique
  ON party_roles (tenant_id, party_id, role)
  WHERE deleted_at IS NULL;

-- "Show me the customers" is the commonest read in the module.
CREATE INDEX party_roles_tenant_role_idx
  ON party_roles (tenant_id, role)
  WHERE deleted_at IS NULL;

-- ----------------------------------------------------------- row security
ALTER TABLE customer_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_groups
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parties
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE party_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON party_roles
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));
