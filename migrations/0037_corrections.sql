-- Phase 9.2 — correcting and cancelling what was already posted (§2.5, owner
-- decisions 2026-08-30). Forward-only and additive (SRS 3.10).
--
-- **No document is ever edited in place and none is ever deleted.** An "edit"
-- reverses the original posting and re-posts the corrected figures under the
-- **same number**, in one transaction; a "delete" posts one reversing entry and
-- leaves the document standing, marked `VOIDED`. Both facts stay in the ledger,
-- which is the only way a shopkeeper can be shown what a figure used to be,
-- that it was corrected, and what it became.
--
-- Every table below already carries `status`, `entry_mode` and `version`, so
-- what is missing is only the *why* and the *when it really belonged to*:
--
--   `void_reason`             required on every cancellation (owner rule)
--   `correction_reason`       required on a backdated or prior-period fix
--   `original_business_date`  the day the money actually moved, kept when a
--                             correction cannot post on that day
--
-- **The closed-period rule** (owner decision, binding on every correction path
-- including Phase 7's purchase correction): a correction to a month that is
-- still open carries the original business date. A correction to a **closed**
-- month posts into the current open period with `entry_mode = 'PRIOR_PERIOD'`
-- and the original date kept in `original_business_date`, so a screen can say
-- "correction for 14 July, posted 30 August" and last month's closed totals are
-- never rewritten. A cancellation always carries the day it was cancelled.

ALTER TABLE expenses
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

ALTER TABLE customer_receipts
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

ALTER TABLE supplier_payments
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

ALTER TABLE cash_movements
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

ALTER TABLE stock_adjustments
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

ALTER TABLE sales_returns
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

ALTER TABLE purchase_returns
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

-- Sales and purchases already had their void and correction paths; they gain
-- the same three columns so one rule covers every document type and no screen
-- has to ask which kind it is looking at.
ALTER TABLE sales
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

ALTER TABLE purchases
  ADD COLUMN void_reason TEXT,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN original_business_date DATE;

-- `cash_movements` had no status check; the others already constrain theirs.
-- A cancelled movement must be as visible as a cancelled bill (DR4), so the
-- status is written rather than the row being removed.
UPDATE cash_movements SET status = 'POSTED' WHERE status IS NULL;
