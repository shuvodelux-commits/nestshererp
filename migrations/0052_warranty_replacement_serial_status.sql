-- Phase 8.2 hardening: a unit handed to a customer to settle a warranty claim
-- has left the shop, but it was not sold.
--
-- §5.19 is binding on the accounting: a replacement out of own stock posts
-- `DR WARRANTY_EXPENSE / CR INVENTORY` and no warranty receivable is ever
-- created. There is no sale, no invoice and no revenue, which is why the
-- service cannot mark the unit `SOLD` — `inventory_units_sold_has_sale`
-- (migration 0033) insists a sold unit names the sale that took it and the day
-- it went, and there is neither. Faking a sale id to satisfy the check would
-- put a sale in the serial history that never happened.
--
-- `WARRANTY_REPLACEMENT` is the honest state, and like `SOLD` it sits outside
-- `inventory_units_active_serial_unique`, so the number is released for a
-- manufacturer to reuse years later (D-18).
--
-- Forward-only and additive: no existing row changes status, so the rewrite of
-- the CHECK is `NOT VALID` then validated, exactly as 0051 did.

ALTER TABLE inventory_units
  DROP CONSTRAINT IF EXISTS inventory_units_status_known;

ALTER TABLE inventory_units
  ADD CONSTRAINT inventory_units_status_known
  CHECK (status IN (
    'IN_STOCK',
    'SOLD',
    'WITH_SUPPLIER',
    'WRITTEN_OFF',
    'RETURNED_TO_VENDOR',
    'WARRANTY_REPLACEMENT'
  )) NOT VALID;

ALTER TABLE inventory_units
  VALIDATE CONSTRAINT inventory_units_status_known;
