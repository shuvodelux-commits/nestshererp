# MOD-004 T12-N — Historical Opening Authorization-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development. Do not modify implementation before observing RED.

**Goal:** For explicitly selected trading relationship, prevent direct NestJS opening-balance GET from revealing whether an unauthorized Party identity exists.

**Architecture:** Reuse `ManagePartiesService`, existing `ROLE_PERMISSIONS`, tenant-aware `UnitOfWork.run` and existing `requireOpeningRole`. Add the smallest role VIEW permission check before `requireParty` in *read-only* `getOpening`. Do not change existing write operations, response DTOs or journal/double entry.

**Tech Stack:** NestJS, PostgreSQL16/forced tenant RLS, Vitest + signed Supertest HTTP, pnpm + ChatGPT-assisted Super Build.

**Spec:** Owner-approved React+Nest-only MOD-004 design in frontend merged PR #569; tracking backend issue #251 and security issues #72/#93/#183. This task does not include the separate raw V1 privacy cutover #245.

## Exact constraints

- Backend base `chore/hisabiq-adoption-runtime-a01@2ede00bcd97786434690a8a50ce2658dabec7b44`, task branch `fix/mod004-t12n-opening-role-auth-251-20261115`. Independently releasable from backend PR #248; no touching `PartyLedgerService`.
- Allowed files: `apps/api/test/parties.spec.ts`, `packages/core-application/src/parties/manage-parties-service.ts` and this plan only.
- Preserve existing seven-role HisabIQ React Party UI and legacy API behavior other than explicitly unauthorized existence disclosure. No Vue, UI, migrations, grants, finance writers, production/test tenant reuse or cash-session changes.
- Request role must still be mandatory and validated in controller; do not change role defaults or disclosure DTO.
- All tests run with task-owned disposable PostgreSQL16 service, signed tenant tokens, RLS-enforced unprivileged `sher_app`; do not run real tests against production/dev/another worker DB.
- Original error envelope status and message for **already unauthorized existing** Party must match **unavailable/nonexistent** under same denied role after change.
- Exact-head TDD, `prepare → verify install/build/typecheck/lint/boundaries → finalize`, Node20 GitHub CI, independent security QA, owner merge gate.

### Task 1 — RED tests

**Modify:** `apps/api/test/parties.spec.ts` inside existing `describe('D08 P0-L03 — exact-role opening authorization')` block, before older tests. Avoid EOF because PR #248 independently appends a ledger test suite.

- [ ] Add test `denies missing and existing opening identity identically without selected-role view`: create a Customer+Supplier Party; revoke Supplier VIEW via `asTenant`; GET `/:id/opening?role=SUPPLIER` for existing and nonexistent ULID. Expect identical 403 `PERMISSION_DENIED` and message; GET `role=CUSTOMER` returns 200 `data:null`.
- [ ] Add test `authorized foreign-tenant opening lookup remains 404`: signed second tenant with Supplier VIEW asks Tenant A's Party and nonexistent ID, 404 both; no private Party values.
- [ ] RED on the **test-only SHA** against disposable PostgreSQL16, expected one failure (missing Party 404 vs expected 403), one control pass. Record actual command, exit and SHA.

### Task 2 — Minimal GREEN

**Modify:** `packages/core-application/src/parties/manage-parties-service.ts`, in `getOpening` only.

- [ ] Before `requireParty(tx, ctx, command.partyId)`, invoke `await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[command.role].view);` under same `UnitOfWork`.
- [ ] Leave subsequent `requireOpeningRole` unchanged to check role membership and any other existing guards.
- [ ] Run focused tests RED → GREEN, keep exact results, then full Party suite in CI signed PostgreSQL16. Existing Supplier correction and source-linked journal tests must continue passing.
- [ ] Exact-head clean GitHub branch with 3 changed files; Super Build and full Node20 GitHub CI; independent code/security review and draft PR. Never auto-merge.

## Review checklist

1. No identity lookup before selected-role view authorization.
2. No unauthorized GET returns Party presence, opening balance, global journal history or other-role membership.
3. No change to accounting writer, reversal/repost, idempotency, cash sessions, journal math, RLS or read DTO.
4. Same-tenant authenticated but missing VIEW: 403 even when Party ID does not exist. Authorized but unrelated tenant: 404.
5. No production activation; no Vue implementation.
