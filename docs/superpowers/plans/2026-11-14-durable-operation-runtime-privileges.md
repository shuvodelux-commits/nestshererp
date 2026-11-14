# Durable Operation Role Least Privilege Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove application-role TRUNCATE capability from real PostgreSQL integration tests without losing repeatable admin-only fixture reset or tenant RLS assertions.

**Architecture:** Keep the existing real unprivileged Nest API connection for all test business operations. Perform test schema migrations and fixture reset only through `ADMIN_DATABASE_URL`; grant a minimal DML surface to `sher_app` with explicit revocation for append-only durable operation identities. Do not modify any production migration or runtime code.

**Tech Stack:** Node 20, TypeScript, NestJS Vitest, `pg`, disposable PostgreSQL 16, Super Build.

**Spec:** `docs/superpowers/specs/2026-11-14-durable-operation-runtime-privileges-design.md` (and backend issue #225).

## Global Constraints
- Base branch `chore/hisabiq-adoption-runtime-a01`, exact pinned SHA verified before build; no backend `main`.
- Touch only `apps/api/test/support/database.ts`, new `apps/api/test/hisabiq-security-durable-ops-permissions.spec.ts`, and these two design/plan Markdown files.
- `import_operations` needs `UPDATE` to finalize an import; its `DELETE` and `TRUNCATE` must be denied.
- `sale_draft_create_operations` (only if migration 0058 is present) is immutable after insert; no `UPDATE`, `DELETE` or `TRUNCATE`.
- Never use existing development/production databases, real credentials or other workers' PostgreSQL containers.
- Mandatory ChatGPT-assisted Super Build prepare/install/build/typecheck/lint/boundaries/finalize after GitHub-authored code.
- Approval and independent QA gates remain; never merge automatically.

## Review Focus
- A stale test DB once had `TRUNCATE` granted: new provisioning must explicitly revoke it.
- Ordinary test role must still `SELECT`/`INSERT`, and update `import_operations`, while cross-tenant SELECT stays empty.
- Direct SQL `TRUNCATE` as runtime principal must fail with PostgreSQL 42501 even under FORCE RLS.
- Fixture reset must succeed through a distinct admin URL while preserving the existing `resetDatabase(pool)` signature.
- Future migration 0058 must not silently grant runtime `UPDATE`/`DELETE` on immutable `sale_draft_create_operations`.

---

### Task 1: RED-first least-privilege regression

**Files:** Create `apps/api/test/hisabiq-security-durable-ops-permissions.spec.ts`.

**Interfaces:** Consume `prepareTestDatabase(): Promise<void>`, `testPool(): pg.Pool`, `resetDatabase(pool): Promise<void>`, `asTenant(pool,tenantId,callback)`, `seedTenant(pool, opts)`; produce no new app API.

- [ ] Add tests for effective `has_table_privilege`, explicit 42501 on runtime `TRUNCATE` and `DELETE FROM import_operations`, allowed `SELECT/INSERT/UPDATE`, tenant A/B isolation, repeated provisioning, and admin-only reset.
- [ ] Run focused test against a new disposable PG16 / Node20 environment with `TEST_DATABASE_URL` + `ADMIN_DATABASE_URL`.
- [ ] Verify RED due to existing runtime `TRUNCATE` grant (not missing DB setup).

### Task 2: Minimal test fixture privilege fix

**Files:** Modify `apps/api/test/support/database.ts`.

**Interfaces:** Keep all existing exported functions/callers intact; `resetDatabase(_pool: pg.Pool): Promise<void>` remains compatible. No deployment-migration new interface.

- [ ] Replace the test provisioning grant with `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` plus `REVOKE TRUNCATE ON ALL TABLES` for `sher_app`; explicitly revoke `DELETE` on `import_operations`; if `sale_draft_create_operations` exists, revoke `UPDATE, DELETE` from it.
- [ ] Change `resetDatabase(pool)` to call `asPlatform` with the existing isolated admin URL for the TRUNCATE statement. Do not use tenant runtime pool for reset.
- [ ] Rerun focused tests GREEN against same disposable database; rerun adjacent `hisabiq-mod007-draft-versioning`, `import_operations`/imports and `purchase-drafts` tests where feasible, and full API integration suite if resource capacity permits.
- [ ] Verify the fix has no general production application-code changes, no malformed imports, and no source changes outside allowlist.

### Task 3: Exact-head Super Build, QA and PR

**Files:** No further application paths beyond Task 1/2; update PR body with source-pinned evidence.

- [ ] Push GitHub-authored branch with RED and GREEN commits (no backend main or other module changes).
- [ ] Run the installed `.agents/bin/super-build-chatgpt.py prepare → verify install,build,typecheck,lint,boundaries → finalize` with clean allowed files and exact source SHA; record receipt outside worktree.
- [ ] Record test case→result, environment, package versions, paired PR #221 head, missing future-table test and production grants as unverified.
- [ ] Open draft PR linked to #225; request independent security QA and head-specific trusted human merge approval. Do not merge.
