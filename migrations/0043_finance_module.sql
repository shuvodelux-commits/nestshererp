-- Phase 12.2 — the Finance module (§5.16, §5.17, owner decisions 2026-08-31).
-- Forward-only and additive (§3.10).
--
-- Three changes, and nothing else:
--
--   1. `LOAN` joins the account types. A loan is money the shop **owes**, so it
--      posts to its own `LOAN:{id}` family (§2.4) rather than into `BANK:{id}`.
--      Putting it in the bank family would have added every debt into Total
--      Bank and into the money reports the shop is judged on, overstating what
--      it holds by exactly what it owes — and no query could have separated
--      them afterwards, because the account code is all a journal line carries.
--
--   2. `cash_movements.reference` — the deposit slip, cheque or bKash
--      transaction number. Its own column and not a convention inside `note`,
--      because it is what a shopkeeper searches by and what a reconciliation
--      matches on; text buried in a sentence can be neither.
--
--   3. Two more movement kinds for loan money received and repaid. They are
--      kinds of the movement that already exists, not a second document: both
--      are still value leaving one named account and arriving at another, and a
--      separate table would have been a second posting path into the same
--      journal.
--
-- No table is created here. That is the point of the module: Finance is a way
-- into the money that is already recorded, not a second place to record it.

-- ------------------------------------------------------------------ accounts
ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_type_check CHECK (type IN ('CASH','BANK','MFS','LOAN'));

-- `accounts_drawer_is_cash` already refuses a loan as the drawer: it requires
-- `type = 'CASH'` for any drawer, so a loan can never be the box counted at the
-- end of the day. Nothing to change.

-- ------------------------------------------------------------ cash_movements
ALTER TABLE cash_movements ADD COLUMN reference text;

ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_kind_check;
ALTER TABLE cash_movements
  ADD CONSTRAINT cash_movements_kind_check
    CHECK (kind IN ('OWNER_INJECTION','OWNER_WITHDRAWAL','TRANSFER',
                    'OPENING_ADJUSTMENT','LOAN_RECEIVED','LOAN_REPAYMENT'));

ALTER TABLE cash_movements
  ADD CONSTRAINT cash_movements_reference_length CHECK (char_length(reference) <= 64);

-- The Transfer Money list and both Capital & Loans sections read the same way:
-- newest first, inside a date window, for one group of kinds.
CREATE INDEX cash_movements_tenant_kind_date_idx
  ON cash_movements (tenant_id, kind, business_date DESC, id DESC);

-- Searching by what was typed on the slip. `text_pattern_ops` because the
-- search is a prefix/contains match on a short code, not a language search.
CREATE INDEX cash_movements_tenant_reference_idx
  ON cash_movements (tenant_id, reference text_pattern_ops)
  WHERE reference IS NOT NULL;
