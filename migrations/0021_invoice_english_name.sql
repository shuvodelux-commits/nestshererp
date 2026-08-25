-- Phase 6 — the shop's name in both scripts (§5.8, owner reference invoice
-- 2026-08-25). Forward-only and additive (SRS 3.10).
--
-- The printed invoice carries the trading name twice: শের মোহাম্মাদ স্যানিটারি
-- হাউস large, and SHER MOHAMMAD SANITARY HOUSE beneath it in letter-spaced
-- capitals. It is not a translation the system can derive — it is the shop's own
-- transliteration, and only they know how they spell it.
ALTER TABLE invoice_settings ADD COLUMN business_name_en TEXT;
