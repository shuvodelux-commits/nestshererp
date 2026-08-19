-- Phase 2, path 2.2 revised — one optional conversion unit per product
-- (D-10, D-41; owner decision 2026-08-19).
--
-- Forward-only and additive (SRS 3.10). No column is dropped or renamed, and
-- `product_unit_conversions` is **left in place** deliberately: §3.10's way to
-- remove something is stop writing it → deploy → verify → drop in a later
-- release, never a migration that destroys rows the moment it runs.
--
-- **What changed and why.** The first cut let a product carry a list of
-- conversion rules. The owner's specification is one: a product has a base unit,
-- and optionally one conversion unit with a factor — `1 Pipe = 20 Feet`. That is
-- not a simplification for its own sake. The behaviour it has to support is a
-- Purchase/POS line with **two** quantity boxes and a stock figure that reads
-- `5 Pipe + 5 Feet (105 Feet)`; with a list of conversion units, neither has a
-- single answer — "5 Pipe + 5 Feet" would not say which of three units it meant.
--
-- Everything is still stored and calculated in the **base unit**. These two
-- columns change how a quantity is typed and read, never what is stored, so no
-- stock figure, price or journal line means anything different than before.

ALTER TABLE products
  ADD COLUMN conversion_unit_id   CHAR(26) NULL REFERENCES units (id),
  -- Base units in one conversion unit, as a scale-3 quantity: 1 Pipe = 20 Feet
  -- is 20000. Not required to be whole — 0.5 kg bags exist — but positive: a
  -- zero factor would make a purchase in Pipes add no stock at all.
  ADD COLUMN conversion_factor_qty BIGINT  NULL;

-- Both or neither. A unit with no factor, or a factor with no unit, is half a
-- rule, and half a rule is what turns a purchase of 5 Pipes into 5 Feet of
-- stock. Enforced here as well as in the use case because it is the kind of
-- invariant a later import or repair script would otherwise walk straight past.
ALTER TABLE products
  ADD CONSTRAINT products_conversion_pair_check
    CHECK ((conversion_unit_id IS NULL) = (conversion_factor_qty IS NULL)),
  ADD CONSTRAINT products_conversion_factor_positive_check
    CHECK (conversion_factor_qty IS NULL OR conversion_factor_qty > 0),
  -- `1 Feet = 3 Feet` is not a conversion, it is a contradiction.
  ADD CONSTRAINT products_conversion_not_base_check
    CHECK (conversion_unit_id IS NULL OR conversion_unit_id <> base_unit_id);

-- Carry across the products that already have exactly one conversion rule, so
-- nothing a shop has entered is lost or has to be retyped.
--
-- A product with **more than one** rule is deliberately left with no conversion
-- rather than having one picked for it: choosing between `1 Carton = 24 Piece`
-- and `1 Box = 6 Piece` on the owner's behalf would put a guess where a business
-- decision belongs (R-A5). Its old rows stay in `product_unit_conversions`, so
-- the shop can see what it had and re-enter the one it wants.
UPDATE products p
   SET conversion_unit_id    = single.unit_id,
       conversion_factor_qty = single.factor_qty
  FROM (
    SELECT product_id, tenant_id, MIN(unit_id) AS unit_id, MIN(factor_qty) AS factor_qty
      FROM product_unit_conversions
     WHERE deleted_at IS NULL
     GROUP BY product_id, tenant_id
    HAVING COUNT(*) = 1
  ) AS single
 WHERE p.id = single.product_id
   AND p.tenant_id = single.tenant_id
   AND p.deleted_at IS NULL
   -- The self-conversion the old shape could not refuse must not be carried in.
   AND p.base_unit_id <> single.unit_id;

-- Products a shop can buy in one unit and sell in another are exactly the ones
-- Purchase and POS need to find quickly once those screens exist.
CREATE INDEX products_tenant_conversion_unit_idx
  ON products (tenant_id, conversion_unit_id)
  WHERE conversion_unit_id IS NOT NULL AND deleted_at IS NULL;
