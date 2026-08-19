-- Phase 2, path 2.1 — the catalog vocabulary a product is described with:
-- units of measure (D-10), brands and categories (§5.5).
--
-- Forward-only and additive (SRS 3.10). No column is dropped or renamed.
--
-- All three are Class A (§3.4): mutable master data. Not Class B — none of them
-- carries a business date, is posted, numbered or voided; and not Class C —
-- renaming a brand is exactly the kind of correction these tables exist to
-- allow.
--
-- **Names are unique per tenant, case-insensitively.** The unique index is on
-- `lower(name)` rather than `name`, because `Coca Cola` and `coca cola` are one
-- brand: a case-sensitive constraint would let the second one in, and every
-- product filed under it would be invisible when filtering by the first. The
-- application normalises whitespace before storing (`normalizeCatalogName`), so
-- `lower(name)` and the domain's comparison key are the same string.
--
-- The predicate `WHERE deleted_at IS NULL` is what lets a shop re-create a
-- brand it archived (§3.6: master data is soft-deleted when referenced).

-- ------------------------------------------------------------------- units
-- Units of measure (D-10: Carton, Box, Piece, Pipe, Feet, Kg, Litre …). A
-- tenant-level list, seeded with every new business, and extensible — a shop
-- selling rope needs "Gaz" and no fixed enum can know that.
CREATE TABLE units (
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

CREATE UNIQUE INDEX units_tenant_name_unique
  ON units (tenant_id, lower(name))
  WHERE deleted_at IS NULL;

-- ------------------------------------------------------------------ brands
-- §5.5: "Brand and Product Name are separate fields." Display name is
-- `Brand + Product Name` when a brand exists, which is why this is a real row
-- and not a text column — renaming the brand must rename it everywhere at once.
CREATE TABLE brands (
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

CREATE UNIQUE INDEX brands_tenant_name_unique
  ON brands (tenant_id, lower(name))
  WHERE deleted_at IS NULL;

-- -------------------------------------------------------------- categories
-- Category and product group/subcategory in one self-referencing table
-- (§5.5 "category/group/subcategory", §5.7 filters "Category" and "Product
-- Group/Subcategory"). Exactly two levels: a category with `parent_id IS NULL`,
-- and a subcategory pointing at one. The depth limit is enforced in the use
-- case, where it can be explained to the person who tried to nest deeper — a
-- CHECK constraint here could not see the parent's own parent.
CREATE TABLE categories (
  id          CHAR(26)    PRIMARY KEY,
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  parent_id   CHAR(26)    NULL REFERENCES categories (id),
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  updated_by  CHAR(26)    NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  CHAR(26)    NULL
);

-- `coalesce(parent_id, '')` rather than `parent_id`: PostgreSQL treats two NULLs
-- as distinct in a unique index, so without it two top-level categories could
-- both be called "Drinks". Sibling names are unique; the same subcategory name
-- under two different parents is allowed, because "Small" under Shirts and
-- "Small" under Pants are different things.
CREATE UNIQUE INDEX categories_tenant_sibling_name_unique
  ON categories (tenant_id, coalesce(parent_id, ''), lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX categories_tenant_parent_idx ON categories (tenant_id, parent_id);

-- ----------------------------------------------------------- row security
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON units
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON brands
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON categories
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));
