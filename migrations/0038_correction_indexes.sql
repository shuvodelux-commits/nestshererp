-- Phase 9.2 — making room for a document to be corrected more than once, and
-- fixing a constraint that would have refused the first correction of a bill.
--
-- **What was wrong.** `journal_entries_source_unique` (migration 0012) says a
-- document may have exactly one journal entry, which is the right rule for the
-- posting that *creates* it: a bill posted twice is a bill counted twice. But a
-- correction posts a second entry for the same document, and a cancellation a
-- third, so the constraint refused every one of them. Phase 7's purchase
-- correction (§2.5) was written against this and would have failed the first
-- time a shopkeeper used it; it is fixed here rather than worked around.
--
-- **The rule that replaces it** keeps the guarantee and drops the accident: a
-- document still has at most one **original** posting, and may have any number
-- of reversals and corrections after it. Those are additive facts about a
-- document's life, and a document can be corrected on Monday and again on
-- Friday without the ledger objecting.
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_source_unique;
DROP INDEX IF EXISTS journal_entries_source_unique;

CREATE UNIQUE INDEX journal_entries_original_unique
  ON journal_entries (tenant_id, source_document_type, source_document_id)
  WHERE source_document_type NOT LIKE '%\_REVERSAL'
    AND source_document_type NOT LIKE '%\_CORRECTION';

-- **A number belongs to the document that is standing.** Phase 7 gives a
-- corrected bill the number it is correcting — "a shopkeeper holding a bill and
-- the shop holding two different numbers for it is the confusion this avoids" —
-- and then a unique index on the number refused exactly that. Cancelled
-- documents keep their number for the record; only live ones must be unique.
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_number_unique;
CREATE UNIQUE INDEX purchases_number_live_unique
  ON purchases (tenant_id, purchase_number)
  WHERE status <> 'VOIDED';

ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_number_unique;
CREATE UNIQUE INDEX supplier_payments_number_live_unique
  ON supplier_payments (tenant_id, payment_number)
  WHERE status <> 'VOIDED';

DROP INDEX IF EXISTS expenses_number_unique;
CREATE UNIQUE INDEX expenses_number_live_unique
  ON expenses (tenant_id, expense_number)
  WHERE status <> 'VOIDED';
