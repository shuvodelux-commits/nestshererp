-- Phase 2, path 2.2 — products and their unit conversions (§5.5, D-10).
--
-- Forward-only and additive (SRS 3.10). No column is dropped or renamed.
--
-- Class A (§3.4): master data. **Not** Class B, and this is a deliberate
-- decision rather than an oversight — a product carries no business date, is
-- never posted, numbered or voided, and §3.9 says as much: "Master data
-- (products, parties) has neither `business_date` nor `status` transitions".
-- The R-C9 reserved columns (`location_id`, tax fields, `pack_size`,
-- `device_prefix`) belong to **transaction** tables and are deliberately absent
-- here; stock lives on movements and lots (Phase 3), not on the product row.
--
-- Money is `BIGINT` in integer minor units, scale 2 (§3.3). Quantity is `BIGINT`
-- at scale 3. Nothing in this schema is `NUMERIC` or `FLOAT`, in either dialect
-- (D-23), so the browser copy in Phase 12 cannot diverge numerically.

-- ---------------------------------------------------------------- products
CREATE TABLE products (
  id                       CHAR(26)    PRIMARY KEY,
  tenant_id                CHAR(26)    NOT NULL REFERENCES tenants (id),

  -- §5.5 mandatory: name, base unit, both prices, reorder level.
  name                     TEXT        NOT NULL,
  base_unit_id             CHAR(26)    NOT NULL REFERENCES units (id),
  purchase_price_minor     BIGINT      NOT NULL,
  selling_price_minor      BIGINT      NOT NULL,
  -- "Minimum Stock / Reorder Level", a quantity at scale 3.
  min_stock_qty            BIGINT      NOT NULL DEFAULT 0,

  -- §5.5 optional. Brand is separate from the name on purpose: display name is
  -- `Brand + Product Name`, derived on read so renaming a brand renames it
  -- everywhere at once.
  brand_id                 CHAR(26)    NULL REFERENCES brands (id),
  category_id              CHAR(26)    NULL REFERENCES categories (id),
  sku                      TEXT        NULL,
  barcode                  TEXT        NULL,
  description              TEXT        NULL,

  -- §5.5: ACTIVE or INACTIVE, and G2.3 — independent of stock quantity. An
  -- ACTIVE product with zero or negative stock stays visible and selectable;
  -- only INACTIVE removes it from new selection.
  status                   TEXT        NOT NULL DEFAULT 'ACTIVE',

  -- §5.5 pricing, discount and product offers. The normal selling price above is
  -- never overwritten by any of these — that is the rule these columns exist to
  -- keep. `default_discount_value` is minor units of whatever the type says:
  -- poisha for FIXED_AMOUNT, hundredths of a percent for PERCENTAGE.
  default_discount_type    TEXT        NULL,
  default_discount_value   BIGINT      NULL,
  offer_enabled            BOOLEAN     NOT NULL DEFAULT FALSE,
  offer_price_minor        BIGINT      NULL,
  offer_start_at           TIMESTAMPTZ NULL,
  offer_end_at             TIMESTAMPTZ NULL,

  -- Which products the tenant's expiry and serial features apply to. Shown only
  -- while the matching setting is on (§5.21), and read by Inventory (Phase 3)
  -- and Serial/Warranty (Phase 8). §5.19 needs to know that a product is
  -- serial-tracked: "a serial-tracked product cannot be sold without the
  -- required serial information", and that is a property of the product.
  tracks_expiry            BOOLEAN     NOT NULL DEFAULT FALSE,
  tracks_serial            BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at               TIMESTAMPTZ NOT NULL,
  updated_at               TIMESTAMPTZ NOT NULL,
  created_by               CHAR(26)    NOT NULL,
  updated_by               CHAR(26)    NOT NULL,
  version                  INTEGER     NOT NULL DEFAULT 1,
  deleted_at               TIMESTAMPTZ NULL,
  deleted_by               CHAR(26)    NULL,

  CONSTRAINT products_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT products_discount_type_check
    CHECK (default_discount_type IS NULL OR default_discount_type IN ('FIXED_AMOUNT', 'PERCENTAGE')),
  -- A type without a value, or a value without a type, is a half-written rule
  -- that some later screen would have to guess at.
  CONSTRAINT products_discount_pair_check
    CHECK ((default_discount_type IS NULL) = (default_discount_value IS NULL)),
  CONSTRAINT products_prices_not_negative_check
    CHECK (purchase_price_minor >= 0 AND selling_price_minor >= 0 AND min_stock_qty >= 0)
);

-- §3.9 for barcode scanning: "unique `(tenant_id, barcode)`". Partial, so the
-- many products without a barcode do not collide with each other.
CREATE UNIQUE INDEX products_tenant_barcode_unique
  ON products (tenant_id, barcode)
  WHERE barcode IS NOT NULL AND deleted_at IS NULL;

-- SKU is compared case-insensitively, like every other catalog code: `ABC-1` and
-- `abc-1` are one product code, and two products holding both is how a stock
-- count goes wrong without anything looking wrong.
CREATE UNIQUE INDEX products_tenant_sku_unique
  ON products (tenant_id, lower(sku))
  WHERE sku IS NOT NULL AND deleted_at IS NULL;

-- §3.9: master data is indexed on `(tenant_id, name)` and its lookup keys.
CREATE INDEX products_tenant_name_idx ON products (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX products_tenant_status_idx ON products (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX products_tenant_brand_idx ON products (tenant_id, brand_id) WHERE deleted_at IS NULL;
CREATE INDEX products_tenant_category_idx
  ON products (tenant_id, category_id)
  WHERE deleted_at IS NULL;

-- §3.9's POS product search: a trigram index, so `ILIKE '%cola%'` does not
-- become a full scan as a shop's catalog grows. `pg_trgm` is a trusted
-- extension, creatable by the database owner that runs migrations without
-- superuser rights (PostgreSQL 13+, and §6.4 pins 16).
--
-- The index cannot include `tenant_id` without `btree_gin`, so tenant scoping
-- stays where it always is — in the query's own predicate and in RLS. This index
-- only narrows candidates.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm_idx ON products USING GIN (name gin_trgm_ops);
CREATE INDEX brands_name_trgm_idx ON brands USING GIN (name gin_trgm_ops);

-- ------------------------------------------------ product_unit_conversions
-- D-10: "per-product conversion rules defined by the user, e.g. `1 Carton = 24
-- Pieces`, `1 Pipe = 20 Feet`."
--
-- `factor_qty` is how many **base units** one row's unit contains, as a scale-3
-- integer: 1 Carton = 24 Pieces is 24000. Positive by constraint — a zero factor
-- would make a purchase in cartons add no stock at all.
CREATE TABLE product_unit_conversions (
  id          CHAR(26)    PRIMARY KEY,
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  product_id  CHAR(26)    NOT NULL REFERENCES products (id),
  unit_id     CHAR(26)    NOT NULL REFERENCES units (id),
  factor_qty  BIGINT      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  updated_by  CHAR(26)    NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  CHAR(26)    NULL,

  CONSTRAINT product_unit_conversions_factor_positive_check CHECK (factor_qty > 0)
);

-- One factor per unit per product. Two rows saying a carton is 24 pieces and
-- also 12 would make every stock figure depend on which row was read.
CREATE UNIQUE INDEX product_unit_conversions_unique
  ON product_unit_conversions (tenant_id, product_id, unit_id)
  WHERE deleted_at IS NULL;

CREATE INDEX product_unit_conversions_product_idx
  ON product_unit_conversions (tenant_id, product_id);

-- ----------------------------------------------------------- row security
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE product_unit_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_unit_conversions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_unit_conversions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));
