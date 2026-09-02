-- Phase 12.4, immediately after 0047. `cash_movements` is the thirteenth
-- operational document the offline writer may create — moving money between
-- the drawer and the bank, an owner injection, a loan repaid — and it was left
-- out of 0047's list. Same five columns, same rules, same reasons (§18).
ALTER TABLE cash_movements
  ADD COLUMN origin_mode TEXT NOT NULL DEFAULT 'ONLINE',
  ADD COLUMN origin_device_id CHAR(26) REFERENCES device_authorizations (id),
  ADD COLUMN device_created_at TIMESTAMPTZ,
  ADD COLUMN synced_at TIMESTAMPTZ,
  ADD COLUMN device_seq BIGINT;

ALTER TABLE cash_movements
  ADD CONSTRAINT cash_movements_origin_mode_known CHECK (origin_mode IN ('ONLINE', 'OFFLINE')),
  ADD CONSTRAINT cash_movements_offline_has_origin
    CHECK (origin_mode <> 'OFFLINE'
           OR (origin_device_id IS NOT NULL AND device_created_at IS NOT NULL));

CREATE INDEX cash_movements_offline_origin_idx
  ON cash_movements (tenant_id, origin_mode) WHERE origin_mode = 'OFFLINE';
