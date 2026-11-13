# AGENTS.md — SherERP

## Mandatory test-workspace reuse and disk safety (owner directive 2026-11-13)

Before dispatching a module worker or running integration tests on the CachyOS runner, inspect existing Git worktrees and test checkouts. **Reuse an existing module/worker-scoped environment** whenever its repository, branch, commit, tests, dependencies, ownership and isolation can be verified. Do not create a new full checkout or separate `node_modules` for every PR check or QA retry. Record the workspace path and paired repo SHAs in the module issue/PR.

- Run `df -h /` first. Aim to retain **at least 23 GB free**. If below that threshold, stop multiplying checkouts and reclaim only verified disposable artifacts or report the blocker.
- Never reuse a workspace currently owned by another agent/job or repurpose one containing uncommitted work. Preserve source, Git history, branch refs, secrets, databases, user data and running tests. Avoid `git clean -fdx` and mass `rm -rf` of project directories.
- Reuse the content-addressed pnpm store. Install with `pnpm install --frozen-lockfile --prefer-offline` only when needed and consistent with the lockfile. Keep test databases/schemas disposable and isolated per run/tenant, with cleanup, especially for finance/accounting.
- After the owning job exits and changes are pushed or backed up, remove only ignored, reinstallable `node_modules`, `dist`, coverage and Playwright outputs in inactive QA checkouts. Remove Git worktrees only when verified clean and no longer needed, using `git worktree remove`; never manually break their registrations.
- If fresh isolation really is required, justify it in the handoff, set a single bounded path, share dependency caches and specify cleanup ownership. CI may still require a clean ephemeral checkout; this policy does not authorize sharing mutable cross-tenant state or skipping tests.

Owner direction and supporting evidence: [frontend integration queue #294](https://github.com/shuvodelux-commits/hisabiq_ui/issues/294#issuecomment-6858246372) and [backend workflow issue #3](https://github.com/shuvodelux-commits/nestshererp/issues/3#issuecomment-6858247045). This is operational hygiene, not permission to change module scope, merge, deploy or alter production data.


Multi-tenant ERP for Bangladeshi SME retail. Vue 3 + NestJS + Drizzle + PostgreSQL, modular monolith. Canonical delivery path: online-first → sync infrastructure → PWA Offline → Mobile → optional future Tauri packaging → MCP.

## Documentation — exactly three files

| File | Contains | Read it for |
|---|---|---|
| `SRS_AND_BUILD_GUIDE.md` | **SherERP Master SRS & Build Guide v4.0 (Merged Canonical)**: requirements, final decisions, architecture, data rules, module specs, module/phase plan, acceptance criteria, risks | **WHAT** to build |
| `AI_CODING_INSTRUCTIONS.md` | Module-scale vertical workflow, coding standards, anti-overengineering rules, layering, risk-based tests, Definition of Done, prompt kernel | **HOW** to build |
| `AGENTS.md` | This file | Orientation |

`docs/archive/` holds superseded planning documents. **Do not read them** — they contradict the current spec.

## Token efficiency — binding

- Read `AI_CODING_INSTRUCTIONS.md` in full before writing code.
- Before coding, verify `SRS_AND_BUILD_GUIDE.md` begins with **“SherERP — Master SRS & Build Guide v4.0 (Merged Canonical)”**. If it does not, STOP: the repo has a stale SRS.
- For every business module, read `§5.0` (cross-module consistency), `§5.0A` (binding AI module specification contract), the complete target module subsection, the task block sections, and direct dependencies. Do not rely on remembered requirements or old module documents.
- Do not re-read large sections you already know and that have not changed.
- **Do not create new `.md` files.** No task logs, decision logs, module docs, planning docs, READMEs or scratch notes. If information belongs somewhere, it belongs in one of the three files above — update the relevant section.
- Decisions that change: edit the section **and** add one line to the change log at the end of `SRS_AND_BUILD_GUIDE.md`.
- Source code, tests, schema and migrations are the source of truth for implementation detail.

## Module-scale vertical increments — how work is organised

One coherent business module at a time, normally 3–5 working days. Inside it, connect each user path top to bottom before starting the next path:

```
module acceptance criteria → domain → use cases → module migration → repositories →
API/contracts → consistent Vue workflows → focused tests/checkpoints →
one full module regression → manual UI acceptance → module-gate commit
```

Never all backend, then all database, then all frontend. Run focused risk-based tests while building; run the full four-command regression once when the complete module is ready. **A module is not done because the backend compiles or focused tests pass** — it is done when its whole workflow works in the UI and the owner confirms the numbers. Phase 0 is the only no-UI exception.

## Structure

```
packages/core-domain/         PURE TS — entities, invariants, costing, posting rules
packages/core-application/    use cases, repository interfaces, permissions, audit
packages/core-contracts/      zod schemas, DTOs, error codes
packages/adapter-postgres/    Drizzle + PostgreSQL implementations
packages/shared-utils/        Money, Qty, UnitCost, Ulid, Clock
apps/api/                     NestJS — controllers ≤20 lines
apps/web/                     Vue 3 + Vite (PWA)
```

Dependencies flow one way: `api → application → domain → shared-utils`. CI enforces it. `adapter-sqlite-wasm` (Phase 12, browser SQLite WASM + OPFS), optional future desktop packaging (Phase 14), and `apps/mcp` (Phase 15) are created only in their own phases, not now. **PWA Offline is the canonical offline runtime. Tauri is deferred until after Mobile and is optional, not rejected.** If Phase 14 is approved, it may add only a packaging/native-integration shell and must reuse the same domain/application services, repository contracts, sync protocol and acceptance tests. `core-domain` and `core-application` therefore stay browser-safe and free of Node built-ins (`fs`, `path`, `crypto`).

## Commands

```bash
pnpm lint
pnpm typecheck
pnpm test:boundaries     # layering enforcement — never bypass
pnpm test
pnpm dev
pnpm db:migrate

docker start sher-pg     # PostgreSQL 16; sher_dev + sher_test
```

At a module gate, completion requires all four checks, pasted **real** output, and owner UI acceptance. Internal paths use the smallest relevant focused tests and checkpoint commits.

## Critical rules

1. **Business logic lives in `core-domain` / `core-application`** — never in controllers, Vue components, SQL, or triggers.
2. **`core-domain` imports only `shared-utils` and `zod`.** No NestJS, Drizzle, pg, SQLite, express, DOM types.
3. **All IDs are ULIDs generated in application code.** No autoincrement.
4. **Money and quantity are integers in minor units.** Money scale 2, quantity scale 3, unit cost scale 4. Float arithmetic on money or stock is forbidden.
5. **Every table has `tenant_id`, sourced from `TenantContext`** — never from a request body, query string, or URL. Cross-tenant denials return `404`, not `403`.
6. **Classify every mutation.** Class T financial/stock/document writes run the ten-step path in one transaction. Class S security/identity and Class M master/configuration writes use the smaller paths defined in `AI_CODING_INSTRUCTIONS.md` R-D; never invent fake period, journal or stock steps.
7. **Never hard-delete a posted financial or stock record.** Void/reverse + soft delete. Movements, journal lines and audit are append-only.
8. **Cash balances are moved, never assigned.** Opening cash differing from the previous counted close needs a posted movement with a declared source or destination. A stored expected amount is immutable — the drawer difference posts to `CASH_SHORT_OVER`, it never edits the expectation.
9. **Reports derive monetary figures from journal lines and stock movements**, never from document fields (INV-10).
10. **Choose the simplest thing that works.** No `BaseRepository`, `GenericRepository`, `RepositoryFactory`, generic CRUD, manager classes, single-implementation interfaces, or unrequested config flags.
11. **Risk-based tests ship with the module.** Never skip, weaken or delete an existing test. Keep exact-number, journal/stock/cash, tenant, security, idempotency, reversal and transaction tests; avoid repeating identical framework, permission and UI-state assertions.
12. **Never change a requirement or decision.** If the spec seems wrong, contradictory, or silent on something that changes a stored number, workflow, permission, stock state, invoice output, serial/barcode behaviour or user-visible action — **STOP and report.**
13. **Implementation must be traceable to the v4 module contract.** Before coding a business module, map its Purpose → Fields → UI behaviour → Workflow → Business rules → Permissions → Feature dependencies → Accounting effects → Inventory effects → Correction/reversal rules → Search/filters → Edge cases → Acceptance tests. A capability is not complete merely because its database field or endpoint exists.
14. **Do not resurrect superseded requirements.** No LIFO. No current Loyalty/Premium feature. PWA Offline precedes Mobile; optional Tauri comes only later. Confirmed business/UI behaviours merged into v4 are binding even when older code or archived docs differ.

Priority when rules conflict: SRS → security/tenant isolation → accounting/inventory correctness → architecture → transactions → tests → API compatibility → SOLID/KISS/YAGNI/DRY → preference. Never use a coding principle to override a business requirement.

## Scope discipline

Implement only the module increment in the task block. Do not touch files outside its ALLOWED FILES list, add dependencies, reorganise folders, refactor adjacent code, or build the next module's schema. If you think you must, stop and report.

Report as: Module increment · Acceptance criteria and numbers verified · Assumptions · Files changed · Files intentionally NOT touched · Database · UI workflow (what to click) · Tests (focused plus module-gate real output) · Not implemented · Risks noticed.

## Recording a finished module

The last step of every module gate is updating the **delivery status ledger** (`SRS_AND_BUILD_GUIDE.md` §6.1.1). Before marking `CODE COMPLETE`, verify every acceptance item in the target module against the real UI, including explicit filters, actions, print/share behaviour and edge states required by the v4 SRS. This is the only permanent record of what is built — do not create a status file, task log or progress README instead.

Set status to `CODE COMPLETE`. **Only the owner sets `DONE`**, after running the complete module workflow and confirming the numbers. The owner may fill the accepted code commit in a small follow-up ledger commit; a commit cannot contain its own final hash. Never delete or rewrite existing history.
