-- Phase 6 — a phone number belongs to a person (§5.8, owner's final invoice
-- design 2026-08-25). Forward-only and additive (SRS 3.10).
--
-- The printed header reads `মহিউদ্দিন – ০১৭২৬-২২৪৪১১` and `বেলাল – ০১৭৭২-৩৩৫৫৭৭`:
-- a customer ringing the shop needs to know who answers. 0022 stored bare
-- strings, so each becomes `{ "label": "", "number": "…" }` and the shopkeeper
-- fills the names in — no number is lost and nothing has to be retyped.
UPDATE invoice_settings
   SET contact_phones = (
     SELECT COALESCE(jsonb_agg(jsonb_build_object('label', '', 'number', value)), '[]'::jsonb)
       FROM jsonb_array_elements_text(contact_phones) AS value
   )
 WHERE jsonb_array_length(contact_phones) > 0
   AND jsonb_typeof(contact_phones -> 0) = 'string';
