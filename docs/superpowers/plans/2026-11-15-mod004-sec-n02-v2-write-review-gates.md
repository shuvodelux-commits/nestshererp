# MOD-004 SEC-N02 — decision-gated implementation handoff for safe Party writes

**Date:** 2026-11-15. **Status:** owner/security review only — **DO NOT DISPATCH CODE**.  
**Tracking:** [SEC-N02 #298](https://github.com/shuvodelux-commits/nestshererp/issues/298), [SEC-N01 #245](https://github.com/shuvodelux-commits/nestshererp/issues/245), [HisabIQ React #568](https://github.com/shuvodelux-commits/hisabiq_ui/issues/568).  
**Design:** [selected-role write/replay decision spec](../specs/2026-11-15-mod004-sec-n02-selected-role-v2-party-writes.md).  
**Source pins:** Nest adoption `24dcd98c4d8cea75bb5a72ee63a6e4aacf9353ec`; React `main@7544cc0b93bc66933524e67ffc0ca159273de5a1`. Re-pin before dispatch. No production data or UI/DB change is authorized.

## Exact current API inventory and unresolved tension

- **V2 currently reads only.** `PartiesV2Controller` has selected-role GET list/detail/ledger/opening, strict V2 DTO parsing and role-scoped account reads; there is no approved V2 create/update/status route, response or adapter.
- **V1 writes produce raw `PartyResponse`:** `PartiesController` POST create, PATCH update, POST status. The raw object includes NID, guardian, address, email, notes and `hasLedgerEntries`; React masking would not stop a direct API caller.
- **Create replay:** `ManagePartiesService.create` requires CREATE per requested role then reads the idempotency record and returns the previously stored **raw `PartyResponse`** if the fingerprint matches. It saves that raw result inside the original tenant UoW. Any future V2 writer must have its own authorized replay representation; simply replacing the outgoing controller response after `create` is not sufficient proof of replay safety.
- **Edit:** `ManagePartiesService.update` is optimistic-versioned, preserves withheld null/blank private placeholders and permits shared name/phone corrections with any existing-role EDIT. Effective private-field change requires `PARTY_PROFILE_VIEW`, and role removals/customer-specific changes retain separate guards.
- **Status:** `ManagePartiesService.setStatus` changes the identity for all roles; checks every role's DEACTIVATE and writes audit/outbox. **Its existing V1 contract does not accept a version or idempotency key**. A future V2 contract must explicitly decide whether it adds version/retry guarantees, rather than claiming they already exist.

## Owner decision sheet — record explicit choices before code

| Decision | Choices / required response | Recommended review direction (not automatic approval) |
| --- | --- | --- |
| **SEC-1** — V1 disclosure | Require BOTH `PARTY_PROFILE_VIEW` and `PARTY_HISTORY_GLOBAL_VIEW` on the five raw V1 list/detail/create/update/status response paths, or specify a different independently reviewed policy | Dual grants for raw V1 after replacement routes and client compatibility are demonstrated |
| **SEC-2A** — safe V2 mutation response | **A**: authorized `PartyReadV2` projection for a selected trading role; **B**: strict minimal `{id, version, selectedRole, status}` receipt, with explicit GET for readers | Prefer **B for write-only actors**, because CREATE/EDIT grants must not silently give VIEW, financial balance or history access. If A is selected, approve the exact read grant/within-UoW projection |
| **SEC-2B** — daily rights | Confirm ordinary role CREATE/name/phone EDIT should work without profile/global-history grants; confirm effective private updates, customer credit/group, role changes and identity-wide status still require separate rights | Preserve current P3A behavior and existing destructive guards; do not auto-grant sensitive privileges |
| **SEC-2C** — retry/version API | Define whether V2 CREATE uses same key namespace or versioned idempotency fingerprint; define V2 status version/idempotency if required. Specify error semantics for denied replay and changed payload | Same-transaction authorization before replay, no privileged cached response, no lost-ACK duplicate/audit/outbox; no hidden post-commit permission failure |
| **SEC-4** — retained V1 clients | List active/deployed V1 consumers, their permissions and owners; choose staged retirement, protected compatibility tier or explicit hard cutover with rollback. Vue implementation remains excluded from HisabIQ | No immediate blanket V1 lockdown until runtime footprint is verified; no compatibility bypass or auto-grants |
| **SEC-5** — release | Independent privacy/accounting review, signed PG16 two-tenant verification, exact-head Super Build, CI and owner deployment approval | Separate approval for code PR, merge and activation, even if all tests pass |

**Approval evidence to append in issue #298:** SEC-1/2/4/5 selected choices, roles allowed to create/edit/status, V2 DTO choice and shape, exact routes, idempotency strategy, retained-client owner/date and rollback window. Until then this workstream is **BLOCKED FOR IMPLEMENTATION**. A design merge alone cannot approve these choices.

## Subsequent implementation slices — only after approvals

### Task 1 — contracts and RED tests, no service duplication
1. Confirm source SHAs, exclusive ownership of `packages/core-contracts/src/parties.ts`, `apps/api/src/parties/*`, `packages/core-application/src/parties/manage-parties-service.ts` and related signed PG16 test fixtures; coordinate adjacent MOD-005/006/008.
2. Add an explicitly approved V2 write schema and strictly typed response/receipt, without changing V1 wire shape. Write failing tests **before** production code: selected-role validation; role-only create/edit without disclosure grants; response redaction; multi-role role visibility; status all-role authority; vendor feature off; withheld private fields; stale versions; idempotent create retry under revoked grants; conflict and foreign tenant; no audit/outbox on denied write. Capture genuine RED test command/output.
3. Keep result projection and authorization inside a consistent transaction. Avoid calling V1 `create` and then doing a fresh V2 GET after commit; a post-commit 403 is a success/ambiguity bug. Avoid globally changing `toResponse` because other trusted callers and V1 depend on it.

### Task 2 — minimal GREEN
1. Adapt the **existing** domain/service UoW path; no second repository writer, finance engine, customer/supplier net, hidden permission elevation or new SQL migration unless separately approved. Existing opening journal, audit/outbox and idempotency invariants stay in place.
2. Implement approved selected-role authorization before record existence and replay. For denied callers return a fixed, non-oracle response without persisted side effects. Keep version-collision and role-removal semantics.
3. Parse exact contract at the V2 HTTP boundary; run service contract, test-specific Node20 typecheck/lint/build, signed non-owner two-tenant PostgreSQL16 (including concurrency/lost-ACK) and existing trading read/ledger/opening regression tests.

### Task 3 — React transport and activation remain separate
1. Add a **separately scoped** unmounted React V2 mutation adapter only after the server contract is proven and approved. Preserve seven-role preview UI, keyboard/touch, drafts and default connected-workspace gate; no new Vue client.
2. Do not activate the connected Party screen until all seven role relationships and necessary contextual actions are authorized/tested, including Lender/Borrower/Owner/Payee. A passing three-role V2 transport is not seven-role parity.

### Task 4 — independent V1 privacy cutover, not bundled with SEC-N02
1. After SEC-1/4 approvals and confirmed replacement routes, use a separate Nest-only TDD PR to protect exactly five raw V1 PartyResponse operations **before lookup, replay and mutation**, keeping legacy ledger/opening/delete/setup routes independently reviewed.
2. Prove direct signed HTTP denial with role-only and one-grant actors, success with both grants, no existence oracle, correct two-tenant RLS and zero mutations/outbox for denied writes. Run complete Super Build, CI, independent security/accounting QA and **separate** human release approval.

## Test ownership and non-applicable cases

| Domain | Future test evidence | Reason |
| --- | --- | --- |
| Core Zod & transport | Exact DTO (no private unexpected keys), wrong role, malformed version/key, no V1 fallback | Response confidentiality |
| Actual Nest service/PG16 | Two tenants, grants/revocation, multi-role identity, field masking on EDIT, status all-role permissions, idempotency/replay/lost ACK, concurrency, audit/outbox invariance | Same-UoW authorization |
| Historical source/journal regression | Existing no-session opening and balance tests unchanged | SEC-N02 must **not** post money |
| React browser/keyboard/touch | Only after separate UI activation decision | No React UI change in proposed backend contract task |
| Product stock, POS lots and split payment | **Not applicable** to Party identity metadata writes | No inventory or cash settlement changes |
| Legacy Vue screens | **Excluded** from HisabIQ scope | Runtime V1 compatibility still needs owner inventory |

**Verification rule:** Each future implementation PR must include RED and GREEN exact SHAs, actual test commands/exits, source-pinned `/super-build` prepare→verify→finalize receipt, signed disposable PG16 nonowner RLS evidence, CI, independent QA and human merge approval. **This Markdown-only task ran no tests and changes no code.** Roll back by reverting this plan.

**Release state:** V1 raw response privacy remains unresolved; SEC-N02 is not an executable build, and the seven-role React Party workspace remains gated.
