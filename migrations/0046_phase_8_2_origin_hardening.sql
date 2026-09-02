-- Phase 8.2 forward hardening after the initial development application of
-- 0045. A serial may be sold again after an exact-source return, and every new
-- allocation must carry its real owned lot and unit cost.

DROP INDEX IF EXISTS sale_line_source_allocations_serial_unique;
CREATE INDEX IF NOT EXISTS sale_line_source_allocations_serial_idx
  ON sale_line_source_allocations (tenant_id, inventory_unit_id)
  WHERE inventory_unit_id IS NOT NULL;

ALTER TABLE sale_line_source_allocations
  DROP CONSTRAINT IF EXISTS sale_line_source_allocations_cost_known,
  ADD CONSTRAINT sale_line_source_allocations_cost_known
    CHECK (unit_cost_used IS NOT NULL AND unit_cost_used >= 0),
  DROP CONSTRAINT sale_line_source_allocations_origin_shape,
  ADD CONSTRAINT sale_line_source_allocations_origin_shape CHECK (
    (source_type = 'OWNED' AND owned_lot_id IS NOT NULL AND vendor_party_id IS NULL AND vendor_stock_receipt_id IS NULL AND vendor_lot_id IS NULL)
    OR
    (source_type = 'VENDOR' AND vendor_party_id IS NOT NULL AND vendor_stock_receipt_id IS NOT NULL AND vendor_lot_id IS NOT NULL AND owned_lot_id IS NULL)
    OR
    (source_type = 'NEGATIVE' AND owned_lot_id IS NULL AND vendor_party_id IS NULL AND vendor_stock_receipt_id IS NULL AND vendor_lot_id IS NULL AND inventory_unit_id IS NULL)
  );
