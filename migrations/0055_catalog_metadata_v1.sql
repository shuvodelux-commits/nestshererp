-- MOD-002 T02A/P1b-B — additive catalog display metadata.
--
-- Existing units, brands, categories keep the same stable IDs, versions,
-- tenant RLS policies, and name uniqueness rules. No data backfill,
-- transliteration, posting change, or destructive operation is permitted.
--
-- This migration must be applied after 0054; SQL is the schema source of truth.
ALTER TABLE units
  ADD COLUMN name_bn TEXT NULL,
  ADD COLUMN symbol TEXT NULL;

ALTER TABLE brands
  ADD COLUMN name_bn TEXT NULL;

ALTER TABLE categories
  ADD COLUMN name_bn TEXT NULL;

-- PostgreSQL char_length(text) counts Unicode code points, matching the
-- metadata-v1 contract's Array.from(normalize('NFC')) length semantics after
-- the application has normalized the string. Nullable old rows are valid.
-- Keep validation at the HTTP/application boundary as well: database CHECKs
-- harden storage but do not implement normalization, authorization or audit.
ALTER TABLE units
  ADD CONSTRAINT units_name_bn_metadata_v1_check CHECK (
    name_bn IS NULL OR (char_length(name_bn) BETWEEN 1 AND 120 AND btrim(name_bn) <> '')
  ),
  ADD CONSTRAINT units_symbol_metadata_v1_check CHECK (
    symbol IS NULL OR (char_length(symbol) BETWEEN 1 AND 4 AND symbol !~ '[[:space:]]')
  );

ALTER TABLE brands
  ADD CONSTRAINT brands_name_bn_metadata_v1_check CHECK (
    name_bn IS NULL OR (char_length(name_bn) BETWEEN 1 AND 120 AND btrim(name_bn) <> '')
  );

ALTER TABLE categories
  ADD CONSTRAINT categories_name_bn_metadata_v1_check CHECK (
    name_bn IS NULL OR (char_length(name_bn) BETWEEN 1 AND 120 AND btrim(name_bn) <> '')
  );

-- Existing tenant name unique indexes, archived product references,
-- FORCE ROW LEVEL SECURITY, and policies remain untouched.
