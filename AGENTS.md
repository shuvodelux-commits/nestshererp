# AGENTS.md — SherERP

Multi-tenant ERP for Bangladeshi SME retail. Vue 3 + NestJS + Drizzle + PostgreSQL, modular monolith, online-first with a future offline path.

## Documentation — exactly three files

| File | Contains | Read it for |
|---|---|---|
| `SRS_AND_BUILD_GUIDE.md` | Requirements, final decisions, architecture, data rules, module specs, module/phase plan, acceptance criteria, risks | **WHAT** to build |
| `AI_CODING_INSTRUCTIONS.md` | Module-scale vertical workflow, coding standards, anti-overengineering rules, layering, risk-based tests, Definition of Done, prompt kernel | **HOW** to build |
| `AGENTS.md` | This file | Orientation |

`docs/archive/` holds superseded planning documents. **Do not read them** — they contradict the current spec.

## Token efficiency — binding

- Read `AI_CODING_INSTRUCTIONS.md` in full before writing code.
- From `SRS_AND_BUILD_GUIDE.md`, read **only** the sections named in the task block, plus direct dependencies.
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

Dependencies flow one way: `api → application → domain → shared-utils`. CI enforces it. `adapter-sqlite-wasm` (Phase 12, browser SQLite WASM + OPFS) and `apps/mcp` (Phase 14) are created in their own later phases, not now. **There is no `apps/desktop` — Tauri is rejected (D-20)**; offline runs inside the PWA, so `core-domain` and `core-application` must also stay free of Node built-ins (`fs`, `path`, `crypto`) because they will be bundled for the browser.

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
12. **Never change a requirement or decision.** If the spec seems wrong, contradictory, or silent on something that changes a stored number — **STOP and report.**

Priority when rules conflict: SRS → security/tenant isolation → accounting/inventory correctness → architecture → transactions → tests → API compatibility → SOLID/KISS/YAGNI/DRY → preference. Never use a coding principle to override a business requirement.

## Scope discipline

Implement only the module increment in the task block. Do not touch files outside its ALLOWED FILES list, add dependencies, reorganise folders, refactor adjacent code, or build the next module's schema. If you think you must, stop and report.

Report as: Module increment · Acceptance criteria and numbers verified · Assumptions · Files changed · Files intentionally NOT touched · Database · UI workflow (what to click) · Tests (focused plus module-gate real output) · Not implemented · Risks noticed.

## Recording a finished module

The last step of every module gate is updating the **delivery status ledger** (`SRS_AND_BUILD_GUIDE.md` §6.1.1). This is the only permanent record of what is built — do not create a status file, task log or progress README instead.

Set status to `CODE COMPLETE`. **Only the owner sets `DONE`**, after running the complete module workflow and confirming the numbers. The owner may fill the accepted code commit in a small follow-up ledger commit; a commit cannot contain its own final hash. Never delete or rewrite existing history.
