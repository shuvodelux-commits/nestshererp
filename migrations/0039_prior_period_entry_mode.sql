-- Phase 9.2 — `PRIOR_PERIOD` joins the entry modes (§2.5, owner rule
-- 2026-08-30). Forward-only and additive (SRS 3.10).
--
-- **Why a fifth mode rather than reusing `CORRECTED`.** A correction to a month
-- that is still open is dated that day and reads as an ordinary correction. A
-- correction to a **closed** month cannot be: nothing may post into a closed
-- month, so it posts today and carries the date it belongs to. Those are two
-- different facts about a figure, and a reader who cannot tell them apart
-- cannot answer "why does August contain something that happened in July?" —
-- which is the first question anybody asks of a prior-period adjustment.
--
-- The check constraints are replaced rather than dropped: the closed list is
-- what stops a typo becoming a new entry mode nobody reports on (§2.4's
-- argument for the account list, applied to this column).

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_entry_mode_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_mode_check
  CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED', 'PRIOR_PERIOD'));

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_entry_mode_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_entry_mode_check
  CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED', 'PRIOR_PERIOD'));

ALTER TABLE customer_receipts DROP CONSTRAINT IF EXISTS customer_receipts_entry_mode_check;
ALTER TABLE customer_receipts ADD CONSTRAINT customer_receipts_entry_mode_check
  CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED', 'PRIOR_PERIOD'));

ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_entry_mode_check;
ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_entry_mode_check
  CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED', 'PRIOR_PERIOD'));

ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_entry_mode_check;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_entry_mode_check
  CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED', 'PRIOR_PERIOD'));

ALTER TABLE stock_adjustments DROP CONSTRAINT IF EXISTS stock_adjustments_entry_mode_check;
ALTER TABLE stock_adjustments ADD CONSTRAINT stock_adjustments_entry_mode_check
  CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED', 'PRIOR_PERIOD'));

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_entry_mode_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_entry_mode_check
  CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED', 'PRIOR_PERIOD'));

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_entry_mode_check;
ALTER TABLE sales ADD CONSTRAINT sales_entry_mode_check
  CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED', 'PRIOR_PERIOD'));
