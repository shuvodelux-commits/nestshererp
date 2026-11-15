-- MOD-002 P8b2a, issue #238. Reversible master selection state only.
--
-- ACTIVE / INACTIVE is independent of the existing deleted_at archive marker:
-- archived masters remain archived regardless of is_active.
-- No restore, hard-delete, legacy list filtering, product-status propagation,
-- journal, stock or cash behavior is changed by this migration.
--
-- Additive, forward-only PostgreSQL 16 change. The preexisting catalog rows
-- receive TRUE, including archived historical rows; archived state is derived
-- only from deleted_at. No guessed pre-archive status is backfilled.
--
-- 0058 is reserved by draft PR #221 at this slice's creation; do not reuse it.
-- Keep the existing tenant RLS policies, sibling/name unique indexes, metadata
-- and row versions untouched.
ALTER TABLE units
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE brands
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE categories
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
