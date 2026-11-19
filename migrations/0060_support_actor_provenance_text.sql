-- MOD-002 #344: canonical actor provenance can be a 'support:' + ULID principal.
-- A CHAR(26) column cannot store the 34-character signed support actor.
-- CHAR(34), unlike TEXT, retains the PostgreSQL bpchar type used by legacy
-- parameter-reusing SQL (e.g. user.id and users.created_by share $1).
-- CAREFUL: bpchar pads 26-character shop actors to 34; consumers must be
-- verified for trailing-padding display/serialization before merge.
-- Forward-only, audited PostgreSQL16 migration. Change ONLY actor-attribution
-- created_by / updated_by / deleted_by columns; IDs and RLS are untouched.
--
-- This is a schema-wide compatibility correction: 207 actor columns on 98
-- tables after existing migrations 0001-0059, inventoried in disposable PG16.
-- Table changes are grouped so each table is rewritten at most once.
-- All changes are one migration transaction (migrator.ts); rollback on failure.
-- IMPORTANT PRODUCTION GATE: ALTER COLUMN TYPE takes ACCESS EXCLUSIVE locks,
-- may rewrite large tables/indexes and need extra disk. Preflight a real-size
-- backup, space, lock contention and a maintenance window before deployment.
-- Do not merge/deploy on CI alone. No user/tenant/role keys are modified.
-- PostgreSQL16 docs: https://www.postgresql.org/docs/16/sql-altertable.html
-- This 5s lock budget and 180s whole-migration budget fail closed when busy.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

ALTER TABLE public.account_openings ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.account_reconciliations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.accounts ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.audit_events ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.backup_runs ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.bank_statement_files ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.brands ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.cash_movements ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.cash_session_closes ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.cash_sessions ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.categories ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.cost_adjustments ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.customer_groups ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.customer_receipts ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.daybook_review_marks ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.device_authorizations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.device_user_access ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.expense_categories ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.expenses ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.idempotency_keys ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.import_operations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.inventory_locations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.inventory_lots ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.inventory_units ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.invoice_line_presentation ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.invoice_presentation ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.invoice_settings ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.journal_entries ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.journal_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.lot_consumptions ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.notes ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.numbering_counters ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.otp_codes ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.outbox ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.parties ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.party_openings ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.party_roles ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.payment_allocations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.period_locks ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.product_cost_state ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.product_group_prices ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.product_unit_conversions ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.products ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.profit_targets ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.purchase_drafts ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.purchase_landed_cost_allocations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.purchase_landed_costs ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.purchase_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.purchase_plan_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.purchase_plans ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.purchase_return_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.purchase_returns ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.purchases ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.quotation_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.quotations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.receipt_allocations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.reconciliation_matches ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.refresh_tokens ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.restore_events ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.role_permissions ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.roles ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.sale_draft_create_operations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.sale_drafts ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.sale_line_source_allocations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.sale_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.sale_payments ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.sale_source_allocation_reversals ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.sales ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.sales_order_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.sales_orders ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.sales_return_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.sales_returns ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.settings ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.statement_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.stock_adjustments ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.stock_count_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.stock_counts ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.stock_movements ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.stock_openings ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.supplier_payments ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.supplier_purchase_order_lines ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.supplier_purchase_orders ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.sync_conflicts ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.sync_operations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.tenants ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.units ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.user_identifiers ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.users ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);
ALTER TABLE public.vendor_payments ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.vendor_product_issue_lots ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.vendor_product_issue_returns ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.vendor_product_issues ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.vendor_product_settlements ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.vendor_receipts ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.vendor_receivable_settlement_allocations ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34);
ALTER TABLE public.vendor_stock_receipts ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.vendor_stock_returns ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34);
ALTER TABLE public.warranty_claims ALTER COLUMN created_by TYPE CHAR(34) USING created_by::CHAR(34), ALTER COLUMN updated_by TYPE CHAR(34) USING updated_by::CHAR(34), ALTER COLUMN deleted_by TYPE CHAR(34) USING deleted_by::CHAR(34);

-- Fail closed if any fixed-width actor field remains in the migrated schema.
DO $mod002_actor_width$
DECLARE remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND column_name IN ('created_by', 'updated_by', 'deleted_by')
    AND data_type = 'character' AND character_maximum_length = 26;
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'MOD-002 #344: % unconverted CHAR(26) actor fields', remaining;
  END IF;
END
$mod002_actor_width$;
