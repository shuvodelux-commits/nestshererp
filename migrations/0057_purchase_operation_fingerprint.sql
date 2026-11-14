-- MOD-008 P6C #199: permanent, immutable purchase-create operation identity.
-- Additive and forward-only. Historical purchase rows intentionally retain NULL
-- identity because their complete original command cannot be reconstructed.
ALTER TABLE purchases
  ADD COLUMN create_fingerprint_version TEXT,
  ADD COLUMN create_fingerprint CHAR(64);

ALTER TABLE purchases
  ADD CONSTRAINT purchases_create_fingerprint_valid CHECK (
    (create_fingerprint_version IS NULL AND create_fingerprint IS NULL)
    OR (
      create_fingerprint_version = 'purchase.create/v1'
      AND create_fingerprint IS NOT NULL
      AND create_fingerprint ~ '^[0-9a-f]{64}$'
    )
  );

-- Neither a correction, void, payment, nor soft delete may change the original
-- request identity. Do not backfill guessed fingerprints on legacy documents.
CREATE FUNCTION purchases_guard_operation_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
     OR OLD.create_fingerprint_version IS DISTINCT FROM NEW.create_fingerprint_version
     OR OLD.create_fingerprint IS DISTINCT FROM NEW.create_fingerprint THEN
    RAISE EXCEPTION 'Purchase create operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchases_immutable_operation_identity
BEFORE UPDATE ON purchases
FOR EACH ROW
EXECUTE FUNCTION purchases_guard_operation_identity();
