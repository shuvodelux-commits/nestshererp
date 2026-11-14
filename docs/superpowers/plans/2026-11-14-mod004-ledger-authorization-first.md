# MOD-004 T11-N — Party Ledger Role-First Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a role-limited caller from distinguishing an existing Party identity from a nonexistent one when they request a ledger for an unauthorized trading role.

**Architecture:** Keep the original NestJS PartyLedgerService, role-scoped financial projection, transaction, REST response and all existing controller routes. Perform one early existing `AccessControl.require` check for an explicitly requested role, inside `UnitOfWork.run` and before `PartyRepository.findById`, then retain every later authorization/membership and accounting control.

**Tech Stack:** NestJS, TypeScript, PostgreSQL16, Vitest, Supertest, pnpm.

**Spec:** GitHub issue #246, HisabIQ React+Nest-only design frontend PR #569, backend PartyLedgerService source; independent of V1 raw profile policy #245.

## Global Constraints

- Backend base `chore/hisabiq-adoption-runtime-a01@f6fcb690629de14ccfa07466f157d0c6218d1ba7`; before verification recheck this is still the reviewed head or document changed base.
- Only modify `packages/core-application/src/parties/party-ledger-service.ts`, `apps/api/test/parties.spec.ts`, this plan file. No Vue/UI/gate/finance writer, migrations or permission registry changes.
- Intentionally retain optional legacy `?role` behavior. A selected-role-only endpoint belongs in a separate API contract change.
- No cross-role netting; journal lines, opening postings, idempotency, audit/outbox and cash-session settings remain unchanged.
- Real signed disposable PostgreSQL16 DB test, exact-head ChatGPT-assisted Super Build, Node 20 CI and independent review before human merge.

## Review Focus

1. Existing Party versus nonexistent Party under unauthorized Supplier role must produce the same HTTP status/code/message.
2. Valid Customer role must still return only Customer ledger/net of a Customer+Supplier identity.
3. Properly authorized other-tenant role cannot enumerate a different tenant's Party.
4. Invalid controller role fails validation before service; legacy role-omitted single-role behavior remains unchanged.
5. No permission check should invoke a query outside the tenant UoW or transform a GET into a financial write.

---

### Task 1 — Write failing signed-API regression (RED)

**Files:**
- Modify: `apps/api/test/parties.spec.ts`

**Interfaces:** Existing `createParty`, `minimalCustomer`, `seedTenant`, `asTenant`, `signToken`, `Permission`, `Ulid`, `clock`, `request`, `app`, `pool`, `tenant`.

- [ ] **Step 1:** Add a test named `denies an explicit ungranted ledger role before looking up existing or nonexistent Party`. Create dual-role Party, revoke `Permission.SUPPLIER_VIEW` from same tenant role, request Supplier ledger for existing and fresh valid ULID, assert both `403 PERMISSION_DENIED` and identical public error messages. Assert Customer ledger is still `200` with no Supplier lines.
- [ ] **Step 2:** Add a second test named `authorized selected-role ledger still hides a different tenant identity`. Sign another tenant with Supplier VIEW, request first tenant's Party and nonexistent ID, assert both `404`, no Party data.
- [ ] **Step 3:** Test first on new disposable PostgreSQL16 container with non-owner RLS context, `pnpm --filter @sher/api test -- ...` or exact repository-supported Vitest invocation. Expected RED only for unauthorized role's missing identity (old code returns 404).
- [ ] **Step 4:** Push/record RED test SHA; no weakening of assertions.

### Task 2 — Minimal permission-first implementation (GREEN)

**Files:**
- Modify: `packages/core-application/src/parties/party-ledger-service.ts`

**Interfaces:** Existing `async ledger(command: PartyLedgerCommand): Promise<PartyLedgerResponse>`, `VIEW_PERMISSIONS: Record<PartyRole,string>`, `this.accessControl.require(tx,ctx,permission)`; no new public exports.

- [ ] **Step 1:** Immediately after entering `this.uow.run(ctx, async tx => ...)`, when `command.role !== undefined` require `VIEW_PERMISSIONS[command.role]` via existing transaction access control **before** reading `parties.findById`. Keep the rest of the method unchanged.
- [ ] **Step 2:** Run focused real PostgreSQL16 suite, expected GREEN for the new regression and old tests.
- [ ] **Step 3:** Run full affected Party/ledger regression suites and check exact signed poisha/account role provenance; no new mutation.
- [ ] **Step 4:** Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:boundaries` under exact-head ChatGPT-assisted Super Build preset checks. Use a brand-new external receipt/worktree, clean HEAD and explicit 3-path allowlist.
- [ ] **Step 5:** Open DRAFT GitHub PR `Refs #246` with actual RED/GREEN receipts, DB URL safety proof, CI and independent reviewer handoff. No auto merge.

## Out of scope / dependency separation

This change prevents **one existence oracle on explicit-role ledger reads**. It does **not** remediate raw V1 PartyResponse private-field/global-history leakage (#245/#72/#93/#183), create V2 ledger endpoints, or activate the connected seven-role UI. Legacy Vue source is not touched or tested as a deliverable.

Any unavailable DB runner means status BLOCKED, not a false success.