# MOD-004 T15-N — Strict selected-role V2 historical opening GET

**Current task pin**: Nest adoption `64aea31c3010c911dacb1f2930600a326be57a08` (moved forward from prior merged backend #261 during issue creation), frontend React `a918a7a18e10a602b4cc7d70a24a473469ca80c6` (V2 ledger client merged). Issue #267; branch `feat/mod004-t15n-v2-opening-read-267-20261115`.

**REUSE:** ManagePartiesService.getOpening and tenant UoW, strict `partyOpeningResponseSchema`, existing role grants, Vendor feature helper. No changes to document writer, journal balance, cash session or money account contracts.

**ADAPT:** Add versioned selected-role route `GET /api/v2/parties/:id/opening?role=...`. V2 query must be strict and require CUSTOMER/SUPPLIER/VENDOR. Non-null opening passes strict output schema; `null` stays true absence. V2-only opt-in `readMode:'SCOPED_V2'` to getOpening applies `assertVendorsOn(tx,ctx)` after VENDOR_VIEW, before identity lookup. Legacy V1 behavior remains byte-for-byte and feature policy remains unchanged.

## RED signed PostgreSQL16 tests

1. Add `@covers endpoint:GET /api/v2/parties/:id/opening` and focused `describe('MOD-004 T15-N — versioned historical opening read')` to existing signed API test suite.
2. RED: an authorized dual-role Supplier source opening is missing V2 route (404 rather than expected 200); require Supplier PAYABLE amount 315000 integer poisha and valid strict output, Customer no-opening returns `{data:null}` with no source leakage.
3. 400 missing, invalid and extraneous role keys; 403 existing/nonexistent without selected role VIEW, identical stable public fields; hidden Supplier-only party vs missing under Customer VIEW both 404; foreign tenant 404.
4. VENDOR_VIEW with feature OFF denies existing and missing 403 FEATURE_DISABLED, feature ON returns 200 `{data:null}` for existing Vendor without opening; nonowner signed PG16 RLS.
5. GET does not create/alter journal lines, opening source or audit/outbox records; historical opening GET does not require active cash session.

## GREEN implementation

6. `GetPartyOpeningCommand` optional scoped V2 read mode, no default behavior change; check role before identity, feature before lookup.
7. Versioned controller uses `partyQuerySchema.pick({role:true})` strict query + `partyOpeningResponseSchema` parse only if non-null. Never return raw PartyResponse.
8. Same focused PG16 suite GREEN, full Node20 GH CI verify and acceptance. Generated endpoint inventory via `pnpm test:inventory -- --check` and deterministic 3 docs, not manual edits.
9. `/super-build` ChatGPT-assisted source-pinned prepare/verify install/build/typecheck/lint/boundaries/finalize with only task changes, immutable receipt. Draft PR for independent QA and explicit owner merge.

**Allowed 7 paths:** `apps/api/src/parties/parties-v2.controller.ts`, `packages/core-application/src/parties/manage-parties-service.ts`, `apps/api/test/parties-v2-security.spec.ts`, this plan, and three generated `docs/testing/{inventory.json,ERP-TEST-MATRIX.md,COVERAGE.md}` outputs. No React UI, Vue, DB migration, writes, seven-role activation or V1 raw privacy policy cutover.

**Not applicable:** cash session ON/OFF for historical noncash GET, concurrent journal writer, idempotent payment, numeric rounding, stock, POS offline/keyboard/mobile and frontend accessibility — these paths do not mutate or render. Test read isolation and no-posting instead.