-- Phase 6 — the invoice design a Bangladeshi shop actually needs (§5.8, owner
-- reference screen 2026-08-25). Forward-only and additive (SRS 3.10).
--
-- 0019 gave the header three lines. This is the rest of what a printed চালান
-- carries here: who the proprietor is, what the shop does, two phone numbers,
-- the bKash and Nagad numbers a customer pays into, the terms printed at the
-- bottom, the shop's logo, and whether the paper leaves room for signatures.
--
-- **Two of these are lists, and they are stored as JSONB.** MFS numbers and
-- terms are ordered, variable-length and belong to nothing but this one row —
-- a table each would buy referential integrity over data no other row will ever
-- point at, and cost a join on every invoice printed. They are never queried
-- into; they are read whole with the settings and printed.
ALTER TABLE invoice_settings ADD COLUMN proprietor_name TEXT;
ALTER TABLE invoice_settings ADD COLUMN proprietor_note TEXT;
ALTER TABLE invoice_settings ADD COLUMN business_description TEXT;
ALTER TABLE invoice_settings ADD COLUMN business_phone_2 TEXT;

-- The opening line becomes a pair: the words, and whether they are printed.
-- 0019's `header_text` carries the words, so nothing is migrated.
ALTER TABLE invoice_settings ADD COLUMN show_header_text BOOLEAN NOT NULL DEFAULT TRUE;

-- `[{ "label": "বিকাশ", "number": "01726-224411" }]`
ALTER TABLE invoice_settings ADD COLUMN mfs_numbers JSONB NOT NULL DEFAULT '[]'::jsonb;
-- `["বিক্রিত মাল গুনে বুঝে নিন।"]`
ALTER TABLE invoice_settings ADD COLUMN terms JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE invoice_settings ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_settings ADD COLUMN payment_terms_label TEXT;

-- 58mm and 80mm are the two rolls sold here; A4 is chosen per print, not here.
ALTER TABLE invoice_settings ADD COLUMN thermal_paper TEXT NOT NULL DEFAULT '80mm';
ALTER TABLE invoice_settings ADD COLUMN show_signature_lines BOOLEAN NOT NULL DEFAULT TRUE;

-- The logo lives with the tenant's own data, like a product thumbnail (0018):
-- a backup carries it and an on-prem install needs no object store.
ALTER TABLE invoice_settings ADD COLUMN logo_mime TEXT;
ALTER TABLE invoice_settings ADD COLUMN logo_bytes BYTEA;

ALTER TABLE invoice_settings ADD CONSTRAINT invoice_settings_thermal_check
  CHECK (thermal_paper IN ('58mm','80mm'));
ALTER TABLE invoice_settings ADD CONSTRAINT invoice_settings_terms_days_check
  CHECK (payment_terms_days BETWEEN 0 AND 365);
ALTER TABLE invoice_settings ADD CONSTRAINT invoice_settings_logo_pair
  CHECK ((logo_mime IS NULL) = (logo_bytes IS NULL));
ALTER TABLE invoice_settings ADD CONSTRAINT invoice_settings_logo_size
  CHECK (logo_bytes IS NULL OR octet_length(logo_bytes) <= 1572864);
ALTER TABLE invoice_settings ADD CONSTRAINT invoice_settings_logo_mime_check
  CHECK (logo_mime IS NULL OR logo_mime IN ('image/webp','image/jpeg','image/png','image/gif'));
ALTER TABLE invoice_settings ADD CONSTRAINT invoice_settings_lists_are_arrays
  CHECK (jsonb_typeof(mfs_numbers) = 'array' AND jsonb_typeof(terms) = 'array');
