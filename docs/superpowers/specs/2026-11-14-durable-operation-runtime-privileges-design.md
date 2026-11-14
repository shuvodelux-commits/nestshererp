# Durable operation runtime permissions — design (2026-11-14)

**Source and owner scope:** [P0 security issue #225](https://github.com/shuvodelux-commits/nestshererp/issues/225). Backend base `chore/hisabiq-adoption-runtime-a01@105d4bef196d6a632a6b6cb9dee45e6667031743`; independent from open Sales Draft PR #221 and its migration 0058.

## Why and intended outcome
The test harness currently grants the low-privilege application principal `sher_app` `TRUNCATE` on every table, then calls `resetDatabase(pool)` through that runtime principal. PostgreSQL does not apply RLS to `TRUNCATE`. This invalidates the assumption that permanent tenant-scoped operation identities cannot be destroyed across tenants by a compromised runtime database credential. This is a **test-harness permission defect**; production grants have not been established.

## Alternatives
1. **Keep blanket test grants and rely on FORCE RLS — rejected:** RLS does not constrain `TRUNCATE`.
2. **Use a separate restricted runtime role and a test-admin-only reset — selected:** existing real API tests continue to connect as `sher_app`, but only `ADMIN_DATABASE_URL` may reset fixtures; repeatable provisioning explicitly revokes TRUNCATE even for pre-existing test-role privileges.
3. **Remove test resets — rejected:** existing integration tests need clean, isolated fixtures to verify tenant invariants and avoid cross-test coupling.

## Contracts
- `prepareTestDatabase()` runs migrations as test admin, grants only the ordinary read/write DML needed by existing tests, explicitly revokes runtime TRUNCATE on **all** public tables even if an old test DB had the grant. Restrict permanent `import_operations` to SELECT/INSERT/UPDATE (never DELETE/TRUNCATE); if future `sale_draft_create_operations` exists, restrict to SELECT/INSERT (no UPDATE/DELETE/TRUNCATE). Do not infer a production role name from this test fixture.
- `resetDatabase(pool)` retains its existing call signature for all current specs, but performs the destructive fixture reset using the **explicit test-admin pool** and no tenant B2B session. No production data or persistent test fixture is touched.
- New focused real PG16 tests assert both effective SQL privileges and actual privilege failures; tenant isolation and successful allowed DML must still work through `sher_app`. Repeated `prepareTestDatabase` must stay least-privilege.
- Test admin database is disposable and distinct; database URLs are asserted before connecting by the invocation harness. No migration or product code changed.
- Source pin and independent Super Build exact-head checks; record RED on original grant, GREEN after fix. Full integration regression should be executed only with enough isolated resources. PR remains draft until independent security/accounting review and human merge gate.

## Non-goals and risk boundary
No PR #221 merge; no product UI/API change; no production deployment role adjustment, cash journal, inventory, POS activation, business data or schema migration. The fixture change **cannot** prove production runtime grants; a separate deployment audit is required before activation.