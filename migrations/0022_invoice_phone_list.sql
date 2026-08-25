-- Phase 6 — a shop has as many numbers as it has (§5.8, owner decision
-- 2026-08-25). Forward-only and additive (SRS 3.10).
--
-- 0020 gave the invoice two phone columns because the owner's reference sheet
-- showed two. A shop with a landline, two mobiles and a delivery number cannot
-- print them, and a shop with one prints an empty field — so the numbers become
-- an ordered list, like the MFS numbers and the terms beside them.
--
-- The two columns keep their values and stop being written (§3.10: stop
-- writing, deploy, verify, drop in a later release). Whatever is in them is
-- carried into the list here, so no shop loses a number it had typed.
ALTER TABLE invoice_settings ADD COLUMN contact_phones JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE invoice_settings
   SET contact_phones = (
     SELECT COALESCE(jsonb_agg(phone), '[]'::jsonb)
       FROM (
         SELECT business_phone AS phone WHERE business_phone IS NOT NULL AND business_phone <> ''
         UNION ALL
         SELECT business_phone_2 WHERE business_phone_2 IS NOT NULL AND business_phone_2 <> ''
       ) AS numbers
   )
 WHERE business_phone IS NOT NULL OR business_phone_2 IS NOT NULL;

ALTER TABLE invoice_settings ADD CONSTRAINT invoice_settings_phones_is_array
  CHECK (jsonb_typeof(contact_phones) = 'array');
