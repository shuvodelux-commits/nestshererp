-- Phase 6 — the father's name on the printed invoice (§5.8, owner decision
-- 2026-08-25). Forward-only and additive (SRS 3.10).
--
-- `পিতাঃ` prints on every চালান here, and until now it could only come from the
-- customer's own record — so a counter that took the name at the till had no
-- way to put it on the sheet. It joins the other display-only overrides: this
-- table has no quantity, price, payment or account column, so a presentation
-- edit still cannot reach an accounting fact.
ALTER TABLE invoice_presentation ADD COLUMN customer_guardian_name TEXT;
