-- Phase 12.4. Two document tables carried an `operation_id` without the unique
-- index that makes it mean anything.
--
-- R-C10's guarantee is not the 30-day idempotency cache — that table is pruned.
-- It is the index on the document's own table, which still catches a replay
-- that arrives months later, and an outage may last that long (§19: time alone
-- never stops the shop trading). A sales return and a purchase return are the
-- two operations an offline machine can queue that had only the cache behind
-- them, so a long outage could have posted either of them twice.
--
-- Verified before writing: no tenant holds a duplicate pair today.
CREATE UNIQUE INDEX sales_returns_operation_unique
  ON sales_returns (tenant_id, operation_id);
CREATE UNIQUE INDEX purchase_returns_operation_unique
  ON purchase_returns (tenant_id, operation_id);
