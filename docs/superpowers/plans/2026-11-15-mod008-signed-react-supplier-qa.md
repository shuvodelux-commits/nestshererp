# MOD-008 P-SEC-S02 — opt-in live React Supplier transport to signed Nest/PG16

**Issue:** #289. Source-pins: backend adoption `7ad296aff677d55dff9b23cc42df8c1974f7cda4`; React main `6f57a05d343c040d9dc24346aa8b516af4ef9dd6` after merged #593.

## REUSE
Existing tenant RLS test support (`prepareTestDatabase`, `seedTenant`, `asTenant`, signed `signToken`), `AppModule`, real Nest HTTP server, historical Supplier opening source writer from `parties-v2-security.spec.ts`. Import actual, unmodified React `src/integration/purchase-suppliers.ts` from a separately checked-out pinned React source root; do not duplicate its decoding logic.

## ADAPT
One backend test-only file, opt-in with `HISABIQ_REACT_SOURCE_DIR`. When configured, run real Node fetch to a loopback Nest port, with actual bearer JWT and non-owner PG16. Test withheld private fields, Supplier-only role projection, signed AP balance, `ungrouped:null`, denial after permission revocation, second-tenant isolation and no V1 fallback. No product or payment reads, no UI component mounting. Any failures represent QA evidence and must not be claimed as frontend code defect without diagnosis.

## RED → GREEN QA sequence
- Run the initial test file against a fresh task-owned PostgreSQL16 DB, validate test harness and fixture assumptions rather than faking a passing result.
- Fix only QA test setup and assertions where necessary; no production app code in this issue.
- Run the exact test with `HISABIQ_REACT_SOURCE_DIR` pinned to checked-out frontend ref and `TEST_DATABASE_URL`, `ADMIN_DATABASE_URL` pinned to disposable DB. Preserve truthful failure and rerun logs.
- Super Build required for test-code PR: prepare → dependency install/build/typecheck/lint/boundaries → finalize; GitHub CI exact head.
- Draft PR only. Independent human review and separate owner merge approval required.

## Security guard
Explicitly assert signed non-owner DB, local disposable container, no production DB, no Vue, no role auto-grants, no opening postings outside tests. Because HTTP uses Node native fetch, this is **not** a Playwright/Chromium browser click test; browser adoption remains gated.

**Exact allowed paths:** `apps/api/test/hisabiq-purchase-supplier-live.spec.ts` and this plan.