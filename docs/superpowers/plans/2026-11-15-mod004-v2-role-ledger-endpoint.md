# MOD-004 T13-N — Role-required V2 trading Party ledger (additive)

> **Execution:** Superpowers TDD RED→GREEN, exact-head ChatGPT-assisted Super Build, signed real isolated PostgreSQL 16 RLS tests, Node20 CI. Independent accounting/security review and owner merge approval required. See issue #257.

**Base** `d847f096510a6cc1e92114c6adc99060d9646109` on `chore/hisabiq-adoption-runtime-a01`; **branch** `feat/mod004-t13n-v2-ledger-role-257-20261115`. No React UI changes, no Vue deliverables, no connected-workspace activation.

**REUSE:** Existing single authoritative journal-derived `PartyLedgerService` and `partyLedgerResponseSchema`. A new V2 handler is a strict authorization/serialization boundary, not another accounting engine. Role-specific ledger net, sourceDocumentType/sourceDocumentId/amountMinor, cursor and openingBalance semantics are unchanged.

**ADAPT:** V2 requires explicit CUSTOMER/SUPPLIER/VENDOR role; unknown query keys and invalid limits/cursors fail closed. V2 handler serializes via strict `partyLedgerResponseSchema.parse`. V2 service mode must prevent an authorized CUSTOMER role from distinguishing a Supplier-only Party ID from a nonexistent ID, and must enforce Vendor Management feature OFF inside the same UoW after role authorization but *before* identity lookup. Existing V1 endpoint/wire behavior remains unchanged.

**BLOCKED:** Raw V1 profile response policy #245, four finance relationships, Party writer contract redesign, historical opening correction, payments/cash policy, React route activation, Vue client migration.

**Allowed paths:**
1. `apps/api/test/parties-v2-security.spec.ts` — signed role/RLS/feature tests.
2. `apps/api/src/parties/parties-v2.controller.ts` — selected-role V2 GET only.
3. `apps/api/src/parties/parties.module.ts` — inject existing ledger service.
4. `packages/core-application/src/parties/party-ledger-service.ts` — optional `SCOPED_V2` mode/vendor gate, no changed V1 code-path behavior.
5. This plan.
6. `docs/testing/inventory.json` — generator-produced new endpoint inventory.
7. `docs/testing/ERP-TEST-MATRIX.md` — generator-produced endpoint coverage matrix.
8. `docs/testing/COVERAGE.md` — generator-produced coverage counts.

**Generator-required amendment:** CI runs `pnpm test:inventory -- --check` and rejects any uncommitted changes under `docs/testing/`. For this new endpoint, only the three deterministic output files listed above were generated (27 insertions, 2 deletions), and the signed HTTP test includes the explicit `@covers endpoint:GET /api/v2/parties/:id/ledger` claim. These are required CI artifacts, not a Vue source change or scope expansion into the old frontend.

## Task 1 — Write RED signed API tests

- [ ] Append a new `describe('MOD-004 T13-N — versioned selected-role ledger')` to `parties-v2-security.spec.ts`, reusing test-only `createShared()`, `restrict()`, `seedTenant()`, `signToken()` and `asTenant()`.
- [ ] Authorized Customer-only view against dual-role identity with 315000 Supplier payable: CUSTOMER ledger `200`, `closingBalance.netMinor=0`, no Supplier rows; requested Supplier role is `403`; Supplier viewer sees `-315000`, `AP` source-linked `OPENING_BALANCE` line and no NID/private notes. Validate strict `partyLedgerResponseSchema`.
- [ ] No role/invalid role/unknown query field/invalid cursor or limit must yield `400`, not fallback.
- [ ] Selected-role unauthorized existing/missing ID both `403` identical; Supplier-only hidden identity and absent ID under granted CUSTOMER_VIEW both `404` identical, including public error message.
- [ ] Cross-tenant authorized Supplier viewer sees 404; vendor feature OFF with VENDOR_VIEW results in `403 FEATURE_DISABLED` for existing and missing IDs; vendor ON with VENDOR_VIEW works. Audit/journal counts unchanged by GET.
- [ ] Run focused tests on unique task-owned disposable PG16 using signed HTTP and non-owner RLS. Expected RED because V2 route is absent.

## Task 2 — GREEN minimal implementation

- [ ] `PartiesV2Controller` injects existing `PARTY_LEDGER_SERVICE` and adds `@Get(':id/ledger')`; validates `partyLedgerQuerySchema.required({role:true})` with strict unknown keys and parses returned `partyLedgerResponseSchema`.
- [ ] `PartyLedgerService.ledger()` optional `readMode:'SCOPED_V2'`, default remains legacy. In selected V2 mode check mandatory role and VENDOR feature via `SettingsRepository` (new constructor injected by module). Inside tenant UoW check role VIEW first, then feature, then identity. For V2, a selected role not held by an existing Party must produce identical 404 as unknown Party. Retain V1 error order/wire shape and all journal math.
- [ ] Run same focused PG16 suite GREEN. Full backend `pnpm test` / CI and upstream role regressions mandatory, not only 2-3 tests.
- [ ] `/super-build` source-pinned adapter: `prepare`, fixed checks `install`, `build`, `typecheck`, `lint`, `boundaries`, `finalize`. Open DRAFT GitHub PR and evidence. No merge/deploy.

## QA matrix

- Authorization existing/nonexistent, with/without role; role membership, dual identity and cross-tenant RLS
- Vendor feature off/on; grant revoked
- 315000 exact poisha, AP journal link, no cross-role netting, no writes, pagination/filter validation
- Dynamic request error paths; strict response shape, no raw PII
- Not applicable: cash sessions, idempotent writes, concurrent posting, offline UI, POS keyboard, e-commerce routing — no mutation/UI added

**Risk:** this adds an API surface; do not claim raw V1 PII risk is remediated. V2 ledger endpoint alone does not make seven-role Party workspace production-ready.
