-- Phase 6 — the invoice's own header, made the shop's own (§5.8, owner
-- decision 2026-08-25). Forward-only and additive (SRS 3.10).
--
-- §5.8's invoice design settings already carried what is *shown*; this adds
-- what is *said*. A Bangladeshi shop's invoice opens with a line of its own —
-- `বিসমিল্লাহির রাহমানির রাহিম` on most of them — calls itself a Cash Memo
-- rather than an Invoice, and prints the trading name, address and phone the
-- shopkeeper wants on paper, which is not always the tenant's registered
-- profile. All five are per tenant and per template-independent, because they
-- are the same shop whichever paper it prints on.
--
-- Nullable throughout: a shop that sets none of them prints exactly what it
-- printed before, from its business profile.
ALTER TABLE invoice_settings ADD COLUMN header_text TEXT;
ALTER TABLE invoice_settings ADD COLUMN invoice_title TEXT;
ALTER TABLE invoice_settings ADD COLUMN business_name TEXT;
ALTER TABLE invoice_settings ADD COLUMN business_address TEXT;
ALTER TABLE invoice_settings ADD COLUMN business_phone TEXT;
