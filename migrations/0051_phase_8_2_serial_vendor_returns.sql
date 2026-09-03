-- Phase 8.2 hardening: a consignment serial handed back to its vendor keeps
-- its receipt/lot provenance but must no longer appear as sellable stock.

ALTER TABLE inventory_units
  DROP CONSTRAINT IF EXISTS inventory_units_status_known;

ALTER TABLE inventory_units
  ADD CONSTRAINT inventory_units_status_known
  CHECK (status IN (
    'IN_STOCK',
    'SOLD',
    'WITH_SUPPLIER',
    'WRITTEN_OFF',
    'RETURNED_TO_VENDOR'
  )) NOT VALID;

ALTER TABLE inventory_units
  VALIDATE CONSTRAINT inventory_units_status_known;
