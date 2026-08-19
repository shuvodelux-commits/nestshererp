-- 0011 — indexes for tap-to-sort list columns (UI-46, §3.9).
--
-- Every column header in every list now sorts when it is tapped, and §3.9
-- requires each sortable column to be indexed. An unindexed sort is a full sort
-- of the tenant's whole catalogue on the busiest screen in the shop — fine on
-- the fifty products a demo has, painful on the eight thousand a wholesaler has,
-- and it degrades exactly as the customer grows.
--
-- Each index carries `id` as its last column because the query orders by
-- `(sort_column, id)` in one direction: without the id in the index, Postgres
-- can use it for the ordering but still has to sort the ties, which is most of
-- the work on a column like `status` where there are only two distinct values.
--
-- The `WHERE deleted_at IS NULL` predicate matches the list query's own filter,
-- so these stay partial indexes over live rows only — soft-deleted rows are
-- never listed and should not be paid for on every insert.
--
-- Three existing indexes already cover their sort: `products_tenant_name_idx`,
-- `parties_tenant_name_idx` and `parties_tenant_phone_idx`. They are left alone
-- rather than recreated with `id` appended: name is selective enough that the
-- residual tie sort is negligible, and rewriting a live index to save that is
-- not worth the deploy risk. Status is the opposite case and does get one.

-- Products -------------------------------------------------------------------

CREATE INDEX products_tenant_selling_price_idx
  ON products (tenant_id, selling_price_minor, id)
  WHERE deleted_at IS NULL;

-- Sorting by this column is refused without `inventory.cost.view`, but the index
-- is unconditional: permission decides who may ask, not how the database answers.
CREATE INDEX products_tenant_purchase_price_idx
  ON products (tenant_id, purchase_price_minor, id)
  WHERE deleted_at IS NULL;

CREATE INDEX products_tenant_min_stock_idx
  ON products (tenant_id, min_stock_qty, id)
  WHERE deleted_at IS NULL;

CREATE INDEX products_tenant_status_sort_idx
  ON products (tenant_id, status, id)
  WHERE deleted_at IS NULL;

-- `COALESCE(barcode, '')`, matching the sort expression exactly. A plain index on
-- `barcode` would not be used: the query sorts the coalesced value so that a
-- product without a barcode still has somewhere to sit, and an index on the raw
-- column does not describe that ordering.
CREATE INDEX products_tenant_barcode_sort_idx
  ON products (tenant_id, (COALESCE(barcode, '')), id)
  WHERE deleted_at IS NULL;

-- Parties --------------------------------------------------------------------

CREATE INDEX parties_tenant_status_sort_idx
  ON parties (tenant_id, status, id)
  WHERE deleted_at IS NULL;

-- `-1` is the sentinel for "no credit limit", which is not a limit of zero — it
-- sorts below every real limit rather than being dropped from the page.
CREATE INDEX parties_tenant_credit_limit_idx
  ON parties (tenant_id, (COALESCE(credit_limit_minor, -1)), id)
  WHERE deleted_at IS NULL;

CREATE INDEX parties_tenant_phone_sort_idx
  ON parties (tenant_id, (COALESCE(phone, '')), id)
  WHERE deleted_at IS NULL;

-- Sorting by category, unit or customer group orders by a name fetched with a
-- scalar subquery, so no index here would help: the plan is a sort over the
-- filtered set either way. That is acceptable because these are master-data
-- names bounded by the size of the catalogue, not by transaction volume, and
-- adding a materialised sort key would mean keeping a denormalised copy of a
-- name in step with its source — a defect waiting for the first rename.
