# AGENTS.md — SherERP

Multi-tenant ERP for Bangladeshi SME retail. Vue 3 + NestJS + Drizzle + PostgreSQL, modular monolith. Canonical delivery path: online-first → sync infrastructure → PWA Offline → Mobile → optional future Tauri packaging → MCP.

## Documentation — exactly four files

| File | Contains | Read it for |
|---|---|---|
| `SRS_AND_BUILD_GUIDE.md` | **SherERP Master SRS & Build Guide v4.2 (Reuse & UI Migration Reconciled)**: requirements, final decisions, architecture, UI workflow, data rules, module specs, module/phase plan, acceptance criteria, risks | **WHAT** to build |
| `AI_CODING_INSTRUCTIONS.md` | Module-scale vertical workflow, coding standards, anti-overengineering rules, layering, risk-based tests, Definition of Done, prompt kernel | **HOW** to build |
| `AGENTS.md` | This file | Orientation |
| `FUNCTION_MAP.md` | Reuse index: existing functions, services, endpoints, database methods, shared components and business rules, with file paths and when to call them | **WHAT already exists** — read before searching the codebase |

`docs/archive/` holds superseded planning documents. **Do not read them** — they contradict the current spec.

## Token efficiency — binding

- Read `AI_CODING_INSTRUCTIONS.md` in full before writing code.
- Before coding, verify `SRS_AND_BUILD_GUIDE.md` begins with **“SherERP — Master SRS & Build Guide v4.2 (Reuse & UI Migration Reconciled)”**. If it does not, STOP: the repo has a stale SRS.
- For every business module, read `§5.0` (cross-module consistency), `§5.0A` (binding AI module specification contract), the complete target module subsection, the task block sections, and direct dependencies. Do not rely on remembered requirements or old module documents.
- Do not re-read large sections you already know and that have not changed.
- **Do not create new `.md` files.** No task logs, decision logs, module docs, planning docs, READMEs or scratch notes. If information belongs somewhere, it belongs in one of the four files above — update the relevant section.
- **Read `FUNCTION_MAP.md` before searching the codebase, and update it at the end of every coding session** (owner decision 2026-08-22; rules in `AI_CODING_INSTRUCTIONS.md` R-T). It is an index of what exists and how to call it — never requirements, never a progress log.
- **Do not run the full test suite after every change.** Build the complete module, then run the existing `pnpm test` suite once (`AI_CODING_INSTRUCTIONS.md` R-E). Saving tokens never justifies skipping the real-UI verification or care about money, stock, permissions and tenant isolation.
- Decisions that change: edit the section **and** add one line to the change log at the end of `SRS_AND_BUILD_GUIDE.md`.
- Source code, tests, schema and migrations are the source of truth for implementation detail.

### Existing codebase — reuse first

- A meaningful portion of SherERP may already be implemented. **Search current code before creating a new function, use case, endpoint, composable, store action, dialog or page.**
- Existing code is authoritative for **implementation detail only when it conforms to v4.2**. The SRS remains authoritative for business/UI behaviour.
- Build a reuse map for changed workflows: `SRS action → existing module/interface → existing implementation/callers → REUSE / EXTEND / REPLACE / MISSING`.
- **Reference rule:** invoice edit/correction is one authoritative module/interface reused from Customer Ledger, Sales Invoice History, Invoice Detail and Daybook. Apply the same rule to every repeated business action.
- If the current implementation has duplicate writers, broken layering or final-SRS UI debt, **refactor/consolidate that current module first and complete its UI acceptance before starting the next module**. Refactor inside the affected seam; do not perform unrelated cleanup.
- Prefer **one deep owning module with many entry points**. Customer Hub, Supplier/Vendor Hub, Counter, Daybook, Invoice, Search and Reconciliation must reuse the same Receive/Pay/Return/Correct/Void use case where the business intent is the same.
- UI migration should keep working domain/application/API logic and reshape the Vue interaction layer around the final SRS. Do not create a parallel route or `V2` business function just because an older screen is arranged differently.

## Before building any module — questions first, `START` before code

No code is written for a module until the owner replies **`START`**. The flow (binding; full rules in `AI_CODING_INSTRUCTIONS.md` R-Q):

```
Questions → owner's answers → final module specification → what will be added/changed/reused →
exact UI/workflow the owner will receive → files/modules expected to be affected → WAIT for START
```

Ask **10–20 concise questions, only about unresolved decisions** — fewer for a simple module. Never ask what the SRS, these instructions, `FUNCTION_MAP.md`, existing code or a previously confirmed requirement already answers. Cover only real gaps: workflow, fields, business rules, permissions, edge cases, UI, mobile behaviour, integrations.

## Module-scale vertical increments — how work is organised

One coherent business module at a time, normally 3–5 working days. Inside it, connect each user path top to bottom before starting the next path:

```
questions → START → module acceptance criteria → reuse map + requirement/UI trace → domain/application delta →
module migration (if needed) → repositories/API/contracts delta → final-v4.2 Vue workflow →
one run of the existing `pnpm test` suite → manual checklist for the owner → owner UI acceptance → module-gate commit
```

Never all backend, then all database, then all frontend. Finish the module, then run the four gate commands once. **A module is not done because the backend compiles or the suite passes** — it is done when its whole workflow works in the UI and the owner confirms the numbers. Phase 0 is the only no-UI exception.

## Structure

```
packages/core-domain/         PURE TS — entities, invariants, costing, posting rules
packages/core-application/    authoritative use cases, repository interfaces, permissions, audit
packages/core-contracts/      zod schemas, DTOs, error codes
packages/adapter-postgres/    Drizzle + PostgreSQL implementations
packages/shared-utils/        Money, Qty, UnitCost, Ulid, Clock
apps/api/                     NestJS — controllers ≤20 lines
apps/web/                     Vue 3 + Vite (PWA)
```

Dependencies flow one way: `api → application → domain → shared-utils`. CI enforces it. `adapter-sqlite-wasm` (Phase 12, browser SQLite WASM + OPFS), optional future desktop packaging (Phase 14), and `apps/mcp` (Phase 15) are created only in their own phases, not now. **PWA Offline is the canonical offline runtime. Tauri is deferred until after Mobile and is optional, not rejected.** If Phase 14 is approved, it may add only a packaging/native-integration shell and must reuse the same domain/application services, repository contracts, sync protocol and acceptance tests. `core-domain` and `core-application` therefore stay browser-safe and free of Node built-ins (`fs`, `path`, `crypto`).

## Daily workflow orientation — v4.2

The first operational navigation category is **Daily**:

```
Daily
├── POS
├── Counter
├── Daybook
└── Daily Cash
```

- **Counter** is Quick Transactions: Receive Voucher, Payment Voucher, Expense Voucher. It is a UI/workflow module, not a second posting engine.
- **Daybook** is the universal daily review/notebook-reconciliation and source-action launcher. It never owns correction/posting logic.
- **Daily Cash** is expected-vs-physical cash-session reconciliation/history. Stored expected closing is immutable.
- **Customer/Supplier/Vendor ledgers are working hubs**, with relevant Receive/Pay/New Sale/New Purchase/Return/Correct actions in context.
- **Expense Category/Ledger is a classification**, not a Party role; Payee/Employee/Party is optional identity.
- **Transaction Date = `business_date`** and is the default ledger/Daybook/report basis. **Entry Date = immutable `created_at`** for audit.
- Many entry points must reuse one authoritative application use case.
- Bangla helper labels are subtle: prefer inline `English — বাংলা` with the Bangla part at shared 11px muted styling. Where visible Bangla would crowd a compact surface, use the shared accessible PrimeVue tooltip/help behavior instead.
- Party ledger overview lists are intentionally narrow: `Name · Phone · Address · Current role balance · ⋯`. Open the individual ledger for transaction details.

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

At a module gate, completion requires all four checks, pasted **real** output, and owner UI acceptance. If `pnpm test` fails only on unrelated pre-existing failures, report them briefly — do not investigate or modify unrelated modules without the owner's approval. Do not start the next module until the owner confirms the current one.

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
11. **Do not write new tests by default.** The only mandatory automated check is the existing full `pnpm test` suite, run once on the finished module, followed by a concise manual checklist for the owner. Never skip, weaken or delete an existing test. Extra tests for critical financial/stock logic require the owner's explicit permission, and only after their manual testing. Full policy: `AI_CODING_INSTRUCTIONS.md` R-E.
12. **Never change a requirement or decision.** If the spec seems wrong, contradictory, or silent on something that changes a stored number, workflow, permission, stock state, invoice output, serial/barcode behaviour or user-visible action — **STOP and report.**
13. **Implementation must be traceable to the v4.2 module contract.** Before coding a business module, map its Purpose → Fields → UI behaviour → Workflow → Business rules → Permissions → Feature dependencies → Accounting effects → Inventory effects → Correction/reversal rules → Search/filters → Edge cases → Acceptance tests. A capability is not complete merely because its database field or endpoint exists.
14. **Do not resurrect superseded requirements.** No LIFO. No current Loyalty/Premium feature. PWA Offline precedes Mobile; optional Tauri comes only later. Confirmed business/UI behaviours merged into v4.2 are binding even when older code or archived docs differ.
15. **Reuse before create.** Search for the existing authoritative function/use case before adding a new implementation. A new UI entry point does not justify duplicate business logic.
16. **UI migration preserves working core logic.** For already-built modules, classify current UI behavior `KEEP / MOVE / REWIRE / REPLACE / REMOVE`; keep conforming domain/application/API behavior and migrate the screen to final v4.2.
17. **Many entry points, one owning module interface.** Counter, Daybook, party hubs, source documents and search/history may launch the same action, but must converge on the same use case.
18. **Context is not business input.** Origin route/tab/filter/scroll state may control navigation after success, but never changes accounting, permission, stock or reversal rules.
19. **One repeated action = one authoritative module/interface.** Invoice edit/correction is the reference example: every ERP entry point reuses it.
20. **Fix the current module before the next.** Known duplicate functions, architecture violations or v4.2 UI defects in the module under work are blocking; consolidate/refactor and verify them before moving on.
21. **Compact bilingual UI.** English is primary; Bangla is small/muted inline where it fits and otherwise delivered through the shared accessible tooltip/help pattern. Do not let helper text distort page density.
22. **Match the UI surface to the work.** Full page for major or complex workflows · drawer/side panel for contextual work that preserves the current page · small modal only for short actions and confirmations. No nested modals, no unnecessary temporary layers. On mobile a drawer may go near-full-screen and must stay keyboard-friendly. Every surface preserves current form, filter, tab, search and page state, and calls the existing authoritative logic rather than a copy.
23. **Compact ledger overviews.** Party overview columns are Name, Phone, Address, Current Balance and `⋯`; transaction detail belongs inside the selected ledger hub.

Priority when rules conflict: SRS → security/tenant isolation → accounting/inventory correctness → architecture → transactions → tests → API compatibility → SOLID/KISS/YAGNI/DRY → preference. Never use a coding principle to override a business requirement.

## Scope discipline

Implement only the module increment in the task block. Do not touch files outside its ALLOWED FILES list, add dependencies, reorganise folders, refactor adjacent code, or build the next module's schema. If you think you must, stop and report.

For an existing-code UI migration, the task block's ALLOWED FILES should include the **current implementation files discovered by the reuse map**, not a guessed set of new files. If the authoritative use case sits outside the allowed set and must change, stop and propose that exact scope expansion instead of duplicating it locally. A necessary consolidation/refactor of the current owning module is valid work once its exact files are approved; unrelated refactoring remains out of scope.

Report as: Module increment · Acceptance criteria and numbers verified · Assumptions · Reused existing functions/modules · Files changed · Files intentionally NOT touched · Database · UI workflow (what to click) · Tests (existing `pnpm test` suite, real output) · Manual checklist for the owner · Not implemented · Risks noticed.

## Recording a finished module

The last step of every module gate is updating the **delivery status ledger** (`SRS_AND_BUILD_GUIDE.md` §6.1.1). Before marking `CODE COMPLETE`, verify every acceptance item in the target module against the real UI, including explicit filters, actions, print/share behaviour, stay-in-context behavior, reuse of one authoritative business function across repeated entry points, compact Bangla/tooltip treatment, compact ledger columns, date-basis behavior and edge states required by the v4.2 SRS. This is the only permanent record of what is built — do not create a status file, task log or progress README instead.

Set status to `CODE COMPLETE`. **Only the owner sets `DONE`**, after running the complete module workflow and confirming the numbers. The owner may fill the accepted code commit in a small follow-up ledger commit; a commit cannot contain its own final hash. Never delete or rewrite existing history.
