# HisabIQ integration entry point — current owner scope

Canonical documents live in `shuvodelux-commits/hisabiq_ui`, under `docs/integration/`; do not duplicate the whole package into this backend.
Documentation revision: `2cbfe253b5017d6a5b5096c480850b045d3d434b`.

Read in this order:

1. [Master blueprint](https://github.com/shuvodelux-commits/hisabiq_ui/blob/2cbfe253b5017d6a5b5096c480850b045d3d434b/docs/integration/HISABIQ_NESTSHERERP_MODULE_INTEGRATION_PLAN.md) and [integrate-then-extend sequence](https://github.com/shuvodelux-commits/hisabiq_ui/blob/2cbfe253b5017d6a5b5096c480850b045d3d434b/docs/integration/HISABIQ_INTEGRATE_THEN_EXTEND_PLAN.md).
2. [Critical review](https://github.com/shuvodelux-commits/hisabiq_ui/blob/2cbfe253b5017d6a5b5096c480850b045d3d434b/docs/integration/REVIEW.md) and [decision register](https://github.com/shuvodelux-commits/hisabiq_ui/blob/2cbfe253b5017d6a5b5096c480850b045d3d434b/docs/integration/DECISIONS.md). Several broad packets remain blocked; do not invent their missing contracts.
3. The assigned module packet, its contract/field mappings, source evidence and tasks, all from that same revision.
4. For approved work now: [MOD-000-A specification](https://github.com/shuvodelux-commits/hisabiq_ui/blob/2cbfe253b5017d6a5b5096c480850b045d3d434b/docs/integration/modules/MOD-000-FOUNDATION_EXECUTION_SPEC.md), [execution handoff](https://github.com/shuvodelux-commits/hisabiq_ui/blob/2cbfe253b5017d6a5b5096c480850b045d3d434b/docs/integration/MOD-000-EXECUTION-CONTRACT.md), [GitHub instructions](https://github.com/shuvodelux-commits/hisabiq_ui/blob/2cbfe253b5017d6a5b5096c480850b045d3d434b/docs/integration/tasks/GITHUB.md), and [issue 17 with current comments](https://github.com/shuvodelux-commits/nestshererp/issues/17).

The pinned package is published on a documentation branch; publication is not a merge or deployment. Verify current draft PRs and live board before dispatch.

For this integration, the owner's newer instructions explicitly authorize the external integration document set and the approved MOD-000-A tests. They are scoped exceptions to the older eight-file/no-new-Markdown and no-tests rules below. Existing Vue/PrimeVue/`--sher-*` UI instructions apply to the legacy backend web app; HisabIQ retains its React components and own design authority. Read backend SRS, AI_CODING_INSTRUCTIONS.md and FUNCTION_MAP.md for existing services and invariants; do not copy a conflicting legacy UI restriction into HisabIQ.


## HisabIQ × NestSherERP integration — owner instructions, 2026-11-11

These scoped instructions govern the HisabIQ React integration. Preserve all existing HisabIQ UI, functionality, routes, compact controls, Bangla/English helpers, carts, drafts and keyboard/touch workflows. Integrate compatible existing Nest APIs/services first; then extend the same backend for verified gaps. Do not replace HisabIQ with the Vue frontend or create a separate ERP engine.

Before each module: compare current frontend actions/fields with backend contracts, classify REUSE / ADAPT / EXTEND / BLOCKED, present a 10–15 sentence overview with exact scope and environment, then obtain approval for that revision. An existing approval remains valid for unchanged scope/environment; do not demand a second START. MOD-000-A is already approved as recorded in backend issue 17; this is not approval of all 23 modules.

Read source code and the critical review before treating a packet as executable. Inventory headings, lexical action counts and planned test vectors do not establish complete behavior or passing tests. Resolve engineering omissions against source rather than asking the owner to invent implementation details. Current explicit owner decisions take precedence over older conflicting drafts.

Historical opening party/customer/supplier/lender/borrower balances are non-cash historical journals against Opening Equity and require no active cash session. Actual tracked-drawer receipts/payments require an eligible open session when the feature is ON; OFF permits ordinary journaled cash without a session. Bank/MFS-only and unpaid/non-cash flows do not require one. Preserve journal/stock integrity, tenant isolation, permissions, idempotency and source-linked corrections.

Keep flexible multilevel units and independent pricing, split/partial payments and purchases, unpaid expenses, bundle versions, installments and COD visible in the gap register; never remove an existing UI capability to fit a narrower API. Reports/Analytics integration is excluded, existing report UI/navigation is preserved, and operational Dashboard remains in scope.

Use one scoped branch/draft PR per approved task, record paired repository SHAs, exact allowed paths and actual verification exits. **Owner override 2026-11-13:** **multiple** independent module chats may BUILD concurrently without an arbitrary fixed number. Each uses a unique approved issue/ChatGPT executor, GitHub branch/worktree and separate disposable DB; coordinator verifies actual resources/dependencies and exclusive ownership of shared contracts, schema/migrations, accounting/cash settings and human merge decisions. **The owner selected ChatGPT + GitHub + Remote Desktop Commander, not Codex or Claude**, for the tested workflow. Source/tests are authored directly in GitHub; ChatGPT uses Remote Desktop Commander for checkout/build/test and finalizes a draft GitHub PR (pilot #33). The installed native `/super-build` launcher still does not support ChatGPT as a host; read its skill and perform the Builder checklist under ChatGPT instead of launching Codex/Claude. See canonical `docs/integration/tasks/EXECUTION.md` in HisabIQ_UI for the tested procedure. Comments are not distributed locks. No merge, deployment, production data operation or destructive migration follows from plan approval. Documentation-only work does not start the application stack. MOD-000-A approval includes its named automated tests and disposable CI; older blanket no-test wording must not defeat that specific approval. Other modules need an explicit verification scope.

---

# AGENTS.md — SherERP

## Current owner approval rule — 2026-11-10

Before each module, present the 10–15 sentence overview and confirm the owner's
chosen environment; then wait for approval of that plan revision. An explicit
"Approved", "Start" or equivalent instruction is the approval event. Older
references to `START` below mean this same event, never a second approval or a
required password. Clarify only unresolved requirements before presenting the
overview. Material scope/environment changes require a revised overview and
approval. This current rule takes precedence over older literal-START wording.


Multi-tenant ERP for Bangladeshi SME retail. Vue 3 + NestJS + Drizzle + PostgreSQL, modular monolith. Canonical delivery path: online-first → sync infrastructure → PWA Offline → Mobile → optional future Tauri packaging → MCP.

---

# ⛔ R-0 — THE OWNER'S WORKING PROTOCOL — READ BEFORE ANYTHING ELSE

**This applies to EVERY agent on this repo — Codex CLI, Claude Code, and any
other.** Owner instruction of 2026-08-24, written down after it was broken
twice. It **outranks every other rule in every file**, including this one's own
token-efficiency and workflow sections. Work that breaks any of these
steps is rejected even when the code is correct. Full text:
`AI_CODING_INSTRUCTIONS.md` → **R-0**.

### 0. START THE DEV SERVER — interactive module sessions

**Mandatory when implementing or verifying an interactive module in the chosen
environment.** Postgres up, API built and running, web server running before
claiming UI readiness. Read-only, documentation/setup and connector-only sessions
do not start a local stack. Report unavailable runtime honestly; hand off UI
verification rather than pretending it ran. Use the selected environment's
isolated database/runtime, not machine-specific Docker commands elsewhere.

```bash
sudo service docker start && docker start sher-pg     # WSL2 does not start Docker itself
pnpm --filter "@sher/api..." build                    # the API runs from dist, not source
cd apps/api && node --env-file=.env dist/main.js &    # :3000 — .env is NOT auto-loaded
cd ../web && pnpm dev &                               # :5173
```

### 1. NEVER write test files — and NEVER run test suites

No `*.spec.ts`, no vitest suite, no test helper, no "quick verification"
script — **for any module, for any reason**. And **do not run `pnpm test`**
either. The owner tests the software himself, in the running UI, and reports
what is wrong. The only exception is the owner explicitly asking for tests **in
the current conversation**.

"It would catch bugs", "this is financial logic", "there are tests elsewhere in
this repo" and "a test would prove the fix" are **not** exceptions — each has
been used to justify breaking this rule.

What **is** still run every time: `pnpm build`, `pnpm typecheck`, `pnpm lint`,
`pnpm test:boundaries`. Those are static checks that make the app compile and
keep the layering honest, not test suites.

### 2. A new or cleared chat starts with orientation, not work

Find the last end position — git log, working tree, the SRS change log, the
unfinished module — then **say what it is in one short message and ask what to
do next** unless the owner already assigned an approved issue. For an assigned
issue, reconcile GitHub state and proceed within that approval. Never infer a
new task from a fresh context window.

### 3. A new module starts with the questions — ONE AT A TIME

Ask the unresolved requirements **one question per message**, up to about
**20** where the module needs them, fewer when it is already well defined.
Each question carries **3–4 suggested answers**:

```
**When X happens, what should the system do?**

1. **Option A (Recommended)** — short, practical effect.
2. **Option B** — short, practical effect.
3. **Option C** — short, practical effect.
4. **Type your own answer**
```

The owner picks one or writes his own. **Record the decision, then ask the next
question.** Never ask what the SRS, these files, a confirmed decision or an
earlier part of the conversation already answers. Aim at real workflow,
permissions, accounting behaviour, edge cases and UI/UX — and remember the
users may have **low literacy**, so prefer simple workflows, Bangla-friendly
labels, minimal steps and clear actions.

When every question is answered, show a short **Final Module Specification** —
confirmed workflow · permissions · accounting/business rules · UI behaviour ·
important edge cases · files and modules expected to change — then **wait for
`START`. No code before `START`.**

### 4. Then write the code — and only the code

Implement **only the confirmed module**: the full vertical slice (domain →
application → adapter → API → UI), reusing existing SherERP components,
patterns, APIs, functions and `--sher-*` tokens. **No new visual style. No
tests. No unrelated cleanup, no adjacent-module changes, no extra tooling
unless required and approved.**

### 5. Then build it, run it, and write the UI manual

Run `pnpm typecheck`, `pnpm lint`, `pnpm test:boundaries` — **not `pnpm
test`** — make the feature actually reachable, restart the app, and hand over a
**step-by-step manual for testing it in the UI**: what to click, in what order,
what should appear, which refusals to try.

### 6. The owner reports bugs; fix them narrowly

He reviews the running UI and says what is wrong. Then **inspect only the
implementation and dependencies needed to diagnose that bug**, fix it, rebuild
so he can verify again. No test to "prove" the fix, no refactor of code the bug
did not touch.

Making it reachable, or the owner opens the browser and sees nothing:

```bash
pnpm --filter "@sher/api..." build                  # the API runs from dist
cd apps/api && node --env-file=.env dist/migrate.js
node --env-file=.env dist/backfill-seed-roles.js    # NEW PERMISSIONS — easy to forget, hides the whole module
# restart node --env-file=.env dist/main.js
```

### ⛔ AND: USE THE UI DESIGN THAT ALREADY EXISTS — NEVER INVENT A NEW ONE

**This repo is built from more than one AI tool, and nothing wrecks a product
faster than each tool bringing its own design ideas.** Before writing any
screen, open two or three existing screens that do something similar and follow
them exactly.

- **Reuse the shared components** — `AppCard`, `StatCard`, `EmptyState`,
  `ErrorNotice`, `HelpTip`, `SortableHeader`, `DateOnlyPicker`, `SearchField`,
  `QuickAddSelect`, and the shared PrimeVue controls. Never re-implement one
  locally; extend the shared one where it lives.
- **Use the `--sher-*` design tokens** for every colour, space, radius and font
  size. A hardcoded hex or magic pixel value is a defect.
- **Do not invent an interaction pattern** the app already has — lists, hubs,
  dialogs, confirmations, row menus, filters and paging all have an established
  shape in §2.7 (UI-01…UI-75) and in the built screens.
- **Do not restyle a working screen** to match a new one. If the existing
  pattern truly cannot serve the requirement, **STOP and report**.
- **Language:** English-primary with Bangla helpers (UI-14…UI-21), **except
  counter surfaces, which are Bangla-first** (UI-74/UI-75). Digits always
  Western (UI-47).

A screen that is beautiful on its own and unlike every other SherERP screen is
a **rejected** screen.

---

## Documentation — exactly four files

| File | Contains | Read it for |
|---|---|---|
| `SRS_AND_BUILD_GUIDE.md` | **SherERP Master SRS & Build Guide v4.2 (Reuse & UI Migration Reconciled)**: requirements, final decisions, architecture, UI workflow, data rules, module specs, module/phase plan, acceptance criteria, risks | **WHAT** to build |
| `AI_CODING_INSTRUCTIONS.md` | **R-0 (the owner's working protocol — read first)**, module-scale vertical workflow, coding standards, anti-overengineering rules, layering, Definition of Done, prompt kernel | **HOW** to build |
| `AGENTS.md` | This file | Orientation |
| `FUNCTION_MAP.md` | Reuse index: existing functions, services, endpoints, database methods, shared components and business rules, with file paths and when to call them | **WHAT already exists** — read before searching the codebase |

`docs/archive/` holds superseded planning documents. **Do not read them** — they contradict the current spec.

### Plus the agent-handoff set in `docs/` — added 2026-09-02 by owner request

The four files above remain the canonical project documentation and the only
place a requirement, a decision or a delivery status may be recorded. The owner
additionally asked for a handoff set so another AI account, Codex or a new
developer can pick the project up without this repository's conversation
history. It is **exactly four more files, and no others**:

| File | Contains |
|---|---|
| `docs/AI_HANDOFF.md` | The cold-start briefing: purpose, stack, structure, conventions, invariants, commands, what must not be redesigned |
| `docs/CURRENT_STATE.md` | Where the project stands today — branch, commit, working tree, gate results, deployment readiness |
| `docs/NEXT_TASKS.md` | Remaining work, split into post-release / maintenance / future features / technical debt |
| `docs/DECISIONS.md` | Confirmed architectural, business, accounting, security and operational decisions, with the reason and the consequence of each |

`CLAUDE.md` at the repository root is a short pointer to this file for Claude
Code, plus the Claude-specific notes. It adds no requirement of its own.

**The "do not create new .md files" rule is otherwise unchanged.** These eight
files plus `CLAUDE.md` and `SKILL.md` are the complete set. Still no task logs,
no progress READMEs, no module notes, no scratch files.

## Token efficiency — binding

- Read `AI_CODING_INSTRUCTIONS.md` in full before writing code.
- Before coding, verify `SRS_AND_BUILD_GUIDE.md` begins with **“SherERP — Master SRS & Build Guide v4.2 (Reuse & UI Migration Reconciled)”**. If it does not, STOP: the repo has a stale SRS.
- For every business module, read `§5.0` (cross-module consistency), `§5.0A` (binding AI module specification contract), the complete target module subsection, the task block sections, and direct dependencies. Do not rely on remembered requirements or old module documents.
- Do not re-read large sections you already know and that have not changed.
- **Do not create new `.md` files.** No task logs, decision logs, module docs, planning docs, READMEs or scratch notes. If information belongs somewhere, it belongs in one of the four files above — update the relevant section.
- **Read `FUNCTION_MAP.md` before searching the codebase, and update it at the end of every coding session** (owner decision 2026-08-22; rules in `AI_CODING_INSTRUCTIONS.md` R-T). It is an index of what exists and how to call it — never requirements, never a progress log.
- **Never write tests and never run test suites (R-0 step 1, R-E1).** Build the complete module, build and start the app, and hand the owner a UI manual. `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test:boundaries` still run. Saving tokens never justifies skipping the real-UI verification or care about money, stock, permissions and tenant isolation.
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
build and start the app → step-by-step UI manual for the owner → owner UI acceptance → he reports bugs → narrow fixes → module-gate commit
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
pnpm test:boundaries     # layering enforcement — never bypass (a static check, not a suite)
# pnpm test              # DO NOT RUN unless the owner asks (R-0 step 1, R-E1)
pnpm dev
pnpm db:migrate

docker start sher-pg     # PostgreSQL 16; sher_dev + sher_test
```

At a module gate, completion requires those checks with pasted **real** output, the app running, and owner UI acceptance. If a check fails only for unrelated pre-existing reasons, report it briefly — do not investigate or modify unrelated modules without the owner's approval. Do not start the next module until the owner confirms the current one.

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
11. **Never write tests, and never run test suites** (R-0 step 1). The owner tests the finished module himself in the running UI, from the step-by-step manual the agent writes, and reports the bugs. Never skip, weaken or delete an existing test. Tests for critical financial/stock logic require his explicit permission, and only after he has manually tested the module. Full policy: `AI_CODING_INSTRUCTIONS.md` R-E.
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

Report as: Module increment · Acceptance criteria and numbers verified · Assumptions · Reused existing functions/modules · Files changed · Files intentionally NOT touched · Database · UI workflow (what to click) · How to test it in the UI (step by step) · Not implemented · Risks noticed.

## Recording a finished module

The last step of every module gate is updating the **delivery status ledger** (`SRS_AND_BUILD_GUIDE.md` §6.1.1). Before marking `CODE COMPLETE`, verify every acceptance item in the target module against the real UI, including explicit filters, actions, print/share behaviour, stay-in-context behavior, reuse of one authoritative business function across repeated entry points, compact Bangla/tooltip treatment, compact ledger columns, date-basis behavior and edge states required by the v4.2 SRS. This is the only permanent record of what is built — do not create a status file, task log or progress README instead.

Set status to `CODE COMPLETE`. **Only the owner sets `DONE`**, after running the complete module workflow and confirming the numbers. The owner may fill the accepted code commit in a small follow-up ledger commit; a commit cannot contain its own final hash. Never delete or rewrite existing history.


## HisabIQ adoption workflow setup — 2026-11-09

The current owner request authorizes Super Build setup and continuation of the
adoption baseline. This section scopes tooling only; it does not start a new
business module or replace the SRS business rules.

- Work from `chore/hisabiq-adoption-runtime-a01`, derived from `76421b0`.
- Use `.claude/super-board/configs/hisabiq-nest-adoption.json`: project 2,
  historical one-worker setting (not a cap on independent ChatGPT chats), human approval for every merge and no automatic migrations. A copy of the config was found in older local worktree `/home/shoaib/Projects/hisabiq-a01b-check` with `host:codex` and `max_workers:1`; it is not the chosen ChatGPT executor and remains unchanged. Never forge a ChatGPT host override to make its Codex runner appear valid.
- The setup exception to the Markdown-file rule permits the installed skill
  bundle and its references in `.agents/`, host links in `.claude/` and `.codex/`,
  `docs/agents/issue-tracker.md`, and board preflight/run evidence under
  `docs/super-board/`. Requirements and decisions remain in the canonical files.
- Preserve R-0's test restrictions. Workflow defaults requiring TDD or automated
  suites do not authorize them. Obtain explicit scope for existing test-file
  repairs before dispatching A01b; do not weaken ESLint or boundary rules.
- Select only one reviewed card. Never merge, deploy, enable entitlement stubs,
  modify a production database, or start another product module during setup.
- Development uses the existing isolated Podman/Postgres instance. API health
  is `http://127.0.0.1:3000/health`; reference Vue web is on port 5173.
- Node 24 with pnpm 9.15.9 is the recorded local compatibility probe. The
  manifest still pins Node 20; runtime/CI alignment is a separate task.
- Codex invocation: `$super-board status` and `$super-board run --codex`.
  `$super-build` is the build skill; standalone legacy dispatch requires Claude.
  Historic Codex runner setup only. **Current owner choice is ChatGPT** with GitHub connector + @Remote Desktop Commander, not this Codex board lane. Native slash host support is unimplemented; apply the Super Build skill procedure interactively in ChatGPT, and never claim the native launcher ran.
- The installed guard hooks are Claude hooks. They do not establish native
  Codex hook enforcement; Codex workers must obey these instructions and config.


## Shared module dispatch — owner-approved 2026-11-10

| Gate | Binding rule |
|---|---|
| Overview | ALWAYS give the owner a plain-English **10–15 sentence overview** of the result, scope and approach before every module build; wait for explicit approval. |
| Environment | Owner chooses **ChatGPT + Remote Desktop Commander**, **Codex Cloud**, or **ChatGPT + GitHub with an authorized runner** for that module. NEVER choose silently. |
| Product clarification | Retain R-Q's unresolved questions and final specification; current overview approval satisfies its start gate. Record approval evidence and plan revision on the issue; NEVER re-ask settled decisions. |
| Dispatch | For owner-selected **ChatGPT+GitHub+Remote Desktop Commander**, read the installed **Super Build** Builder skill as a checklist and execute GitHub test-first commits → exact isolated remote fetch → allowed tests/static gates → GitHub draft PR/QA **directly in ChatGPT**. Do not run native `claude -p`, `codex exec`, or unmodified `/super-build` launchers (unsupported ChatGPT host; exit 65 in pilot). Never present this as a completed native headless run. |
| GitHub contract | Before implementation, coordinator records the approved plan and distinct owner session using `docs/agents/issue-tracker.md`; reconcile issue, all comments, linked PR/head and board before resuming. |
| Concurrent chats | **No fixed chat/worker count:** independently approved nonoverlapping modules may build concurrently up to the true capacity of available ChatGPT sessions/PC resources, isolated test environments and dependency readiness. Coordinator serializes shared contracts, source ownership, cash policy, schema/migrations and merges. |
| Ownership | NEVER claim another session's module or recover its locks/worktree. A shared account assignee or issue comment is **not an atomic distributed lock**; coordinator confirms session ownership. |
| Worker boundary | Module chats NEVER drain Ready, run cross-chat recovery sweeps, or change shared runner configuration. A legacy one-worker Codex runner remains one worker; separate ChatGPT+Desktop Commander chats are not Codex workers. Each chat uses a verified executor, exact allowed files and nonoverlapping ownership. Independent QA and human merge remain mandatory. |
| Capability | Check repository read/write, shell execution, database, network and browser capabilities separately. A GitHub connector cannot execute a shell runner; hand off to a verified authorized executor or report blocked. |
| Handoff | EVERY completed module produces a draft PR with source/head SHA, actual command exits, blockers and resume steps. Requirements remain canonical; issue plans reference SRS sections, never replace them. |
| Integration | Owner reviews and **explicitly instructs each merge**; coordinator integrates serially through the merge gate. Overview approval NEVER permits merge, deployment, production data or destructive migration. |
| Scope change | Material plan/environment/ownership changes require a revised overview and fresh owner approval. NEVER act from stale conversation state. |
| Tests | NEVER create tests or run suites without explicit current-conversation permission; build, typecheck, lint and test:boundaries remain required. |
