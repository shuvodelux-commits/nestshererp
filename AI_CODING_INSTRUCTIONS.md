# SherERP — AI Coding Agent Instructions

**Status: BINDING.** A change violating any rule below is rejected in full, regardless of how much of it works.

Requirements and decisions live in `SRS_AND_BUILD_GUIDE.md`, whose first heading must be **“SherERP — Master SRS & Build Guide v4.2 (Reuse & UI Migration Reconciled)”**. This file is *how to build*, not *what to build*. It does not repeat requirements. If the repo SRS has an older heading/version, **STOP before coding**: the instructions and requirements are out of sync.

> ## ⛔ READ THIS FIRST — R-0, THE OWNER'S WORKING PROTOCOL
>
> **Owner instruction, 2026-08-24, after it was broken twice. This overrides every
> habit, every convention in this file, and anything an agent believes is good
> practice.** Applies to **every** agent on this repo — Claude Code, Codex CLI,
> and any other. Violating any of the five steps means the work is rejected even
> if the code is perfect. The full text is [R-0 below](#r-0--the-owners-working-protocol-very-important).
>
> 0. **START THE DEV SERVER AT THE BEGINNING OF EVERY SESSION** — mandatory,
>    before anything else. Postgres, API, web. See Step 5 in practice for the
>    exact commands.
> 1. **NEVER write test files.** Not `*.spec.ts`, not a vitest suite, not a
>    "quick check" — **not for any reason** until the owner says, in that
>    conversation, that he wants tests. He verifies the work himself in the UI.
> 2. **On a new or cleared chat: do not start work.** Find the last end
>    position, state it in one short message, and **ask before continuing**.
> 3. **A new module starts with the questions asked ONE AT A TIME** — up to ~20,
>    each with 3–4 suggested answers, one marked **(Recommended)**, plus "type
>    your own". Record each answer, ask the next. Then the Final Module
>    Specification, then **wait for START**. No code until then.
> 4. **Then write the code** for that module — implementation only, **no tests**.
> 5. **Then**: build and start the app and hand over a **step-by-step manual for
>    testing it in the UI**. **Never run automated test suites either** unless
>    asked — the owner finds the bugs by using it, and reports them.
>
> **And: use the UI design that already exists. Never invent a new design rule,
> a new component style, or a new layout pattern.** Reuse the shared PrimeVue
> controls, the design tokens and the patterns the existing screens already use.

These rules exist because SherERP is built almost entirely by AI agents for an owner who is not a programmer and cannot reliably spot an architectural violation in a diff. Rules are enforced by CI where practical and by a short owner/reviewer check where automation would be misleading. The delivery target is the online V1 scope (Phases 0–11). A meaningful portion of SherERP may already exist when an agent receives a task. Work remains organised as **module-scale vertical increments**, but an increment may be a new workflow, a completion of an existing module, or an SRS-driven UI migration over working business logic. Every module starts at the R-0 step 0 dev server, runs the R-Q question round one question at a time, waits for the owner's `START`, and ends with the app built and running plus a step-by-step manual for the owner to test it in the UI (R-0, R-E). Automated test suites are neither written nor run unless the owner asks. `FUNCTION_MAP.md` records what already exists and is read before the codebase is searched (R-T).

---

## R-0 — The Owner's Working Protocol (**VERY IMPORTANT**)

**Status: BINDING, and above every other rule in this file.** Owner instruction
of 2026-08-24, written down because it was given verbally and then broken twice
in the same week — once by writing tests that were not asked for, once by
starting work in a fresh chat without checking where the last one stopped.

**This section outranks the Principle Priority list below.** No principle, no
convention, no "best practice" and no judgement about what would be helpful
overrides it. An agent that produces excellent code while breaking one of these
steps has produced work the owner will reject.

### Q0 — Why this exists

The owner is not a programmer. He verifies each module by **using the running
application himself**, click by click. That is the acceptance gate. Anything an
agent does that is not code he can run, or instructions he can follow, is not
help — it is unrequested work he then has to review, understand and clean up.

### The steps, in order

| # | Step | Rule |
|---|---|---|
| **0** | **Start the dev server, every session** | **Mandatory, at the beginning of every session, before anything else** (owner instruction 2026-08-24). Postgres up, the API built and running, the web server running — so the owner can open the app at any moment without asking, and so the agent never reports work it has not seen run. Do this on a fresh chat *before* reporting the last end position (step 1), and after any change that needs a rebuild (see **Step 5 in practice** below). If it will not start, say so in one line with the error before doing anything else — a session spent coding against a broken environment is a session wasted. |
| **1** | **No tests** | **NEVER write a test file.** No `*.spec.ts`, no vitest suite, no test helper, no "temporary" test script — **for any module, for any reason**, however useful it seems. The only exception is an explicit instruction from the owner **in the current conversation** saying he wants tests. "It would catch bugs", "it proves the accounting", "the codebase has tests elsewhere" and "it found a real defect" are **not** exceptions; the first two were the exact arguments used when this rule was broken. |
| **2** | **New chat = orient, then ask** | On a new or cleared conversation, **do not begin work.** First find where the last session stopped — the git log, the working tree, `SRS_AND_BUILD_GUIDE.md`'s changelog, the unfinished module. Then say, briefly, what the last end position is and what would come next, and **wait for the owner to tell you to start.** Do not assume the obvious next task is wanted. |
| **3** | **One question at a time** | A new module begins with the R-Q round asked **one question per message** — up to about **20** where the module needs them, fewer when it is already well defined. Each question carries **3–4 suggested answers**, the best marked **(Recommended)**, each option short and stated as its practical effect, plus a final **“Type your own answer”**. The owner picks one or writes his own; **record the decision, then ask the next question.** Never ask what the SRS, these instructions, an existing decision or an earlier part of the conversation already answers. Aim the questions at real workflow, permissions, accounting behaviour, edge cases and UI/UX — and remember the users may have **low literacy**, so prefer simple flows, Bangla-friendly labels, few steps and clear actions. When every question is answered, show the **Final Module Specification** (R-Q Q4) and **wait for `START`.** |
| **4** | **Code only** | Implement **only the confirmed module** — every layer, top to bottom (R-S), reusing existing SherERP components, patterns, APIs, functions and `--sher-*` tokens (R-A10…A15). **Do not invent a new visual style.** No tests (step 1), no unrelated cleanup, no adjacent-module changes, no extra tooling unless required **and approved**. |
| **5** | **Build it, then write the manual** | When the code is finished: **build and start the app** so the owner can use it, then hand over a **step-by-step manual for testing the module in the UI** — what to click, in what order, what should appear, which refusals to try. **Do not run automated test suites** (`pnpm test`) unless the owner asks. The gates that make the app runnable and enforce architecture — `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:boundaries` — are still run; they are static checks, not test suites. |
| **6** | **Bugs come from the owner, and are fixed narrowly** | The owner reviews the running UI and reports what is wrong. Then: **inspect only the implementation and dependencies needed to diagnose that bug**, fix it, rebuild so he can verify again. No test written to "prove" the fix, no opportunistic refactor of code the bug did not touch. |

### Steps 0 and 5 in practice — the app runs, and the change is reachable

**At the start of every session (step 0)** bring the whole stack up, in this
order. Full guide: `DEV_SERVER_START_GUIDE.md`.

```bash
sudo service docker start && docker start sher-pg     # WSL2 does not start Docker itself
pnpm --filter "@sher/api..." build                    # the API runs from dist, not from source
cd apps/api && node --env-file=.env dist/main.js &    # API on :3000 — .env is NOT auto-loaded
cd ../web && pnpm dev &                               # Vite on :5173
```

**After writing code (step 5)**, make the change actually reachable, or the
owner opens the browser and sees nothing — this happened on 2026-08-24:

```bash
pnpm --filter "@sher/api..." build                 # rebuild the packages, not just apps/api
cd apps/api
node --env-file=.env dist/migrate.js               # new tables
node --env-file=.env dist/backfill-seed-roles.js   # NEW PERMISSION CODES — the easy one to forget
# then restart: node --env-file=.env dist/main.js
```

**The backfill is the one that hides a finished module.** A new permission code
is not on any existing tenant's roles until it runs, and the sidebar hides every
entry whose permission is missing (UI-09) — so a correctly built module looks
like it was never built. Full guide: `DEV_SERVER_START_GUIDE.md`.

### The design rule — for every agent, Codex CLI included

**USE THE UI DESIGN THAT ALREADY EXISTS. NEVER INVENT A NEW ONE.**

This repo is worked on from more than one tool — Claude Code and **Codex CLI** —
and the fastest way to ruin a consistent product is for each of them to arrive
with its own idea of how a screen should look. So, before implementing any
screen:

| # | Rule |
|---|---|
| D1 | **Look at the existing screens first.** Open two or three that already do something similar and follow them — the same page header shape, the same card, the same table, the same dialog, the same empty state, the same row-action menu. |
| D2 | **Reuse the shared components**, never a local re-implementation: `AppCard`, `StatCard`, `EmptyState`, `ErrorNotice`, `HelpTip`, `SortableHeader`, `DateOnlyPicker`, `SearchField`, `QuickAddSelect`, and the shared PrimeVue controls. If one nearly fits, extend it where it lives — do not copy it into a new component. |
| D3 | **Use the design tokens** (`--sher-*`) for every colour, space, radius and font size. A hardcoded hex, a magic pixel value or a page-specific font scale is a defect. |
| D4 | **Do not invent a new interaction pattern** for something the app already does. Lists, hubs, dialogs, confirmations, row menus, filters and paging all have an established shape — §2.7 (UI-01…UI-75) states it and the built screens demonstrate it. |
| D5 | **Do not restyle a working screen** because the new one looks different. If the existing pattern genuinely cannot serve the requirement, **STOP and report** (R-H) rather than introducing a second visual language. |
| D6 | **Follow the language rules exactly**: English-primary with Bangla helpers everywhere (UI-14…UI-21), **except counter surfaces, which are Bangla-first** (UI-74/UI-75). Digits are always Western (UI-47). |

A screen that is individually beautiful and unlike every other screen in
SherERP is a **rejected** screen.

---

## Principle Priority

When two rules or principles conflict, the higher one wins. This ordering is itself binding.

```
1  Finalized SRS requirements and decisions
2  Security and tenant isolation
3  Accounting and inventory correctness
4  Architectural boundaries
5  Transaction and write-path integrity
6  Testing and verification
7  API and data compatibility
8  SOLID / KISS / YAGNI / DRY and other coding principles
9  Developer or agent preference
```

**Never invoke SOLID, DRY, KISS or YAGNI to override a finalized business requirement.** "This rule seemed redundant" is not a defence. If a requirement genuinely appears wrong, **stop and report** (R-H) — do not resolve it by applying a principle.

---

## R-A — Scope

| # | Rule |
|---|---|
| A1 | Implement **only** the module increment described in the task block. A module increment may contain several closely related user actions, but it must remain one coherent business area. |
| A2 | Do not modify files outside the task block's ALLOWED FILES list. If you must, **STOP and report**. |
| A3 | Do not add npm dependencies. If one is genuinely required, STOP and report with the reason and two alternatives. |
| A4 | Do not reorganise folders, rename packages, or "clean up" adjacent code. |
| A5 | **Do not change any requirement or decision.** If a spec appears wrong or contradictory, STOP and report — do not improvise a fix. |
| A6 | Do not build for imagined future needs. See YAGNI and Anti-Overengineering below. |
| A7 | Before implementing any business module, read SRS `§5.0`, `§5.0A`, the **entire target module subsection**, its referenced decisions/invariants, and the task block sections. Do not implement from memory, an old prompt, an archived module document, or existing legacy code alone. |
| A8 | Create a requirement trace **before writing code**: Purpose → Fields → UI behaviour → Workflow → Business rules → Permissions → Feature/entitlement dependencies → Accounting effects → Inventory effects → correction/reversal rules → Search/filters → Edge cases → Acceptance tests. Every applicable item must have an implementation location and verification method. |
| A9 | Existing code is evidence of current implementation, not authority over v4. If code, Google-Sheets-era behaviour, an archived document or an old test conflicts with v4, do not silently preserve it. Report the conflict and follow the finalized SRS after owner resolution. |
| A10 | **Existing code is the first reuse candidate.** Before adding a use case, repository method, contract, API endpoint, composable, store action, dialog, list/hub helper or formatter, find the existing implementation and its callers — **`FUNCTION_MAP.md` first (R-T)**, then the codebase for whatever it does not answer. Reuse or extend the authoritative implementation when it already owns the business meaning. |
| A11 | **Do not create a parallel implementation to make a new UI easier.** If Customer Hub, Counter, Daybook, Invoice, Search or another context needs Receive/Pay/Return/Correct/Void, route that UI into the existing owning use case. If the required owning use case is missing or materially wrong, change it once at its seam (within scope) rather than adding a context-specific copy. |
| A12 | **UI migration is not a rewrite license.** Preserve conforming domain/application/database/API behaviour and existing tests. Replace or reorganise the Vue interaction layer only as needed to satisfy the final SRS. Reuse current routes, contracts, stores/composables and shared components where they fit; remove or retire obsolete UI entry points only after every caller has a replacement. |
| A13 | Before changing existing code, build a **reuse map**, starting from `FUNCTION_MAP.md` (R-T2): required SRS action → existing module/interface → current implementation/callers → decision (`REUSE`, `EXTEND`, `REPLACE`, `MISSING`) → verification. A new implementation is allowed only for `MISSING`, or for `REPLACE` where the current implementation violates the SRS/architecture and cannot be safely extended. |
| A14 | **Function reuse means business-action reuse across the entire ERP.** If one authoritative function/use case updates/corrects a Sales Invoice, Customer Ledger, Sales Invoice History, Invoice Detail and Daybook all call it. The same rule applies to Receive/Pay/Return/Void/Change-Date. Never create a screen-specific business function for the same intent. |
| A15 | **Refactor the owning module first when necessary.** If the existing implementation is duplicated, structurally wrong, mixes business rules into Vue/controller code, or cannot support the final SRS safely, refactor/consolidate that affected module/seam before adding the next caller or starting the next business module. This is approved refactoring inside the current module scope, not permission for unrelated cleanup. |
| A16 | **Known UI debt blocks module progression.** A currently built module with known final-v4.2 UI conflicts is not considered complete merely because its backend works. Finish its UI migration, reuse wiring and acceptance checks before starting the next module. |

**A5 matters most.** An agent that silently changes a business rule can produce software that passes its own tests and computes wrong money. **A10–A13 are the next protection:** an agent that ignores working code and creates a second implementation can produce two individually-correct paths that later diverge. SherERP prefers one deep owning module with many UI entry points.

---

## R-Q — Pre-Build Clarification (mandatory, before any module)

**No code is written for a module until the owner replies `START`.** The flow is fixed:

```
Questions → owner's answers → final module specification →
what will be added / changed / reused → exact UI and workflow the owner will receive →
files and modules expected to be affected → WAIT for START
```

| # | Rule |
|---|---|
| Q1 | Ask **10–20 concise questions**, and only about decisions that are genuinely unresolved. For a simple module ask fewer — if the important decisions are already clear, say so instead of padding the list. |
| Q2 | **Never ask what is already answered** in the SRS, these instructions, `SKILL.md`, `FUNCTION_MAP.md`, existing code, or a previously confirmed requirement. Read first, then ask about the remainder. |
| Q3 | Cover only real gaps: workflow, fields, business rules, permissions, edge cases, UI surface, mobile behaviour, and integrations with existing modules. |
| Q4 | After the answers, restate the **final module specification**, then list added / changed / reused items, the exact UI and workflow the owner will get, and the files and modules expected to be affected. |
| Q5 | Then stop and wait. `START` is the only signal that authorises code. Fixes to an already-approved module, and owner-reported defects, do not need a new round. |
| Q6 | **ONE question per message, each with 3–4 suggested answers** (owner instruction 2026-08-24, final — R-0 step 3 is the authority; a briefly-tried "all questions in one message" variant is withdrawn). Ask up to about **20** where the module needs them, fewer when it is already well defined. Format: the question in bold, then **3–4 numbered options** — the best marked **(Recommended)**, each one short and stated as its practical effect on the shop's daily work rather than on the code — and a final option **“Type your own answer”**. The owner picks one or writes his own; **record the decision, then ask the next question.** Never send a question with no suggested answers, and never ask the owner to reply with a bare list of exception numbers. Write for users who may have **low literacy**: prefer simple workflows, Bangla-friendly labels, minimal steps and clear actions, and let the options reflect that. |
| Q7 | A question the SRS, the code or a shipped setting already answers is **not asked** — it is stated as settled, in one line, with where it is settled (Q2). Only genuinely open decisions reach the owner. |
| Q8 | **No test code is written and no test suite is run for the module** — not during the question round, not after `START`, not to prove an accounting rule, not to prove a bug fix. R-0 step 1, R-E1. Acceptance is the owner's own UI walkthrough (R-0 step 5), and the bugs he reports from it are diagnosed narrowly and fixed (R-0 step 6). |

This replaces any earlier "ask before generating" phrasing in `SKILL.md` §29 — that section now points here.

---

## R-S — Module-Scale Vertical Workflow

**SherERP is built one complete business module at a time, top to bottom.** A module increment is larger than the former one-screen slices: it contains the related actions needed to make one business area genuinely usable, such as product create/edit/list/search, or purchase create/list/detail/payment/void.

Inside a module, implement one usable path at a time so integration problems remain local. Do not wait until the end to connect the layers or UI. The module is the acceptance and full-regression boundary.

Every module increment follows this order:

```
 1  Acceptance criteria + expected numbers   ← from the SRS/task block, never invented
 2  Reuse map + requirement/UI trace         ← FUNCTION_MAP.md first, then the code it points at
 3  Domain/application delta                 ← reuse first; change only what the SRS requires
 4  Migration                               ← only if the module actually needs schema change
 5  Repository/adapter delta                ← reuse current business-specific seam
 6  API + contract delta                    ← reuse existing endpoint/use case when authoritative
 7  Frontend migration/workflow             ← final v4.2 hub/Counter/Daybook design
 8  Focused tests                           ← changed rules + reuse-path integration
 9  Real UI checkpoints                     ← desktop/tablet/phone for applicable daily paths
10  Module regression                       ← lint · typecheck · test:boundaries · test
11  End-to-end module scenario in the real UI
12  Update the status ledger and FUNCTION_MAP.md, then report for owner acceptance
```

| # | Rule |
|---|---|
| S1 | **Never** build all backend, then all database, then all frontend. Each internal path is connected domain → application → database → API → UI before the next path begins. |
| S2 | A module is not complete because the backend compiles, a field exists, or endpoints return 200. It is complete when all listed module actions and UI behaviours work **in the UI**, required print/share/search/filter states are present, the app builds and runs, and the owner confirms the numbers/workflow by testing it himself in the UI (R-E). |
| S3 | If a module has no user-visible outcome, say so before starting — it is either Phase 0 foundation work or it is mis-scoped. |
| S4 | Do not start a second module while the current module is incomplete. Internal checkpoint commits are allowed and encouraged, but they are not accepted module releases. |
| S4b | At module completion, update the status ledger (`SRS_AND_BUILD_GUIDE.md` §6.1.1). Set `CODE COMPLETE`; **only the owner sets `DONE`** after manual acceptance. The owner may record the accepted code commit in a small follow-up ledger commit; a commit is not required to contain its own hash. |
| S5 | **Foundation exception:** infrastructure may be built without UI only in Phase 0, and only for the items listed in `SRS_AND_BUILD_GUIDE.md` §6.0. Outside Phase 0, any proposed foundation work must name the specific current module path that is blocked without it. "We will need it later" is not that. |
| S6 | Write migrations for **this module only**. Do not create tables for a later module. |
| S7 | Every module UI must be real and reachable, reuse the shared shell/tokens/components, and include loading, empty, error and permission-denied behaviour. A stub or disconnected mock is not delivery. |
| S8 | **Build the whole module, then build and start the app for the owner** (R-0 step 5). Automated test suites are not run (R-E1) and no new tests are written (R-E2); `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test:boundaries` still run. |
| S9 | **Existing-path rule:** when the current code already supports part of the required workflow, start from that path and migrate it forward. Do not rebuild the same capability in a second route/module merely because the old screen layout differs from v4.2. |
| S10 | **Many entry points, one module interface:** Customer/Supplier/Vendor hubs, Counter, Daybook, source documents and search/history may launch the same action, but all callers cross the same owning module interface. The UI origin may be passed only as navigation/audit context; it must not change business rules. |
| S11 | **Context restoration is part of completion.** A contextual action launched from a hub/Daybook/reconciliation must save/cancel and return to the originating record, selected date basis/tab/filter/search and practical scroll/page position as required by UI-64. |
| S12 | **Current-module stabilization gate:** if the current codebase already contains the module being worked on, first make that module conform to v4.2 end to end. Consolidate duplicate business functions, repair architecture violations, migrate its UI, and pass focused + real-UI checks. Only then begin the next business module. |

If a proposed module cannot be completed and accepted within roughly 3–5 working days, split it into two cohesive module increments before writing code. Do not return to one-screen micro-slices.

---

## R-T — Context economy and the function map

**Owner decision, 2026-08-22.** An agent that re-reads the codebase to answer a question it answered last week spends the owner's budget re-learning what it already knew, and an agent that cannot find an existing function writes a second one. `FUNCTION_MAP.md` at the repository root exists so neither happens. It is a **reuse index, not a second architecture document**: what exists, where it lives, and when to call it.

These rules reduce reading and re-running. **They never reduce correctness, security, tenant isolation, accounting/inventory integrity or maintainability** — a cheaper wrong answer is not cheaper (Principle Priority 1–5 still outrank everything here, and T7 says so explicitly).

| # | Rule |
|---|---|
| T1 | **Read `FUNCTION_MAP.md` before searching the codebase.** It is the first lookup for every task, ahead of `grep`, directory listings and file reads. Search the source only for what the map does not answer, and then only in the area it points at. |
| T2 | **The map is the reuse map's starting point (A13).** An action already listed there is `REUSE` or `EXTEND` by default; deciding `MISSING` for something the map lists requires opening that file and saying why it does not fit. |
| T3 | **Do not run the full test suite after every change.** Finish the module, then run it once (R-E1). |
| T4 | **Do not write new tests to fill the gap.** The testing policy is R-E: the owner tests the running UI and reports what is wrong. |
| T5 | **The four gates run once, when the module is complete** (`lint`, `typecheck`, `test:boundaries`, `test`), with real output pasted. A module reported as complete without them is not complete (F2). |
| T6 | **Update `FUNCTION_MAP.md` at the end of every coding session**, in the same commit as the work. Record new and modified reusable functions, services, use cases, API endpoints, repository/database methods, shared UI components and the important business rules, each with its file path and one line on when to reuse it. Delete entries whose code is gone. A session that wrote no reusable code says so and changes nothing. |
| T7 | **Token economy never buys a shortcut through quality.** Not reading a file is fine; not reading the file you are about to change is not. Skipping a test run is fine; skipping the test is not. Never skip the SRS sections A7 requires, the security/tenant checks, or the real-UI verification because they are expensive. |
| T8 | **Do not restate architecture that is already written down.** Point at the section or the map entry instead of copying it into a report, a comment or a new document. Duplicated documentation drifts exactly like duplicated code. |

`FUNCTION_MAP.md` is the **fourth** permitted markdown file, alongside `SRS_AND_BUILD_GUIDE.md`, `AI_CODING_INSTRUCTIONS.md` and `AGENTS.md`. The ban on new `.md` files is otherwise unchanged: still no task logs, decision logs, module docs, planning docs or scratch notes. It records **where code is and how to call it**; requirements stay in the SRS, rules stay here, and the delivery record stays in §6.1.1. If the map and the code disagree, **the code is right and the map is stale** — fix the map in that session.

---

## R-B — Layering (CI-enforced)

| # | Rule |
|---|---|
| B1 | Business logic lives in `packages/core-domain` and `packages/core-application`. Never in controllers, Vue components, SQL, or database triggers. |
| B2 | `core-domain` imports **only** `shared-utils` and `zod`. No `@nestjs/*`, no Drizzle, no `pg`, no SQLite, no `express`, no DOM types, no `Date.now()`. |
| B3 | `core-application` may import `core-domain`, `core-contracts`, `shared-utils`. No raw SQL, no framework decorators, no Drizzle types. |
| B4 | Repository **interfaces** live in `core-application`. Implementations live in `adapter-postgres`. Interfaces never expose Drizzle types. |
| B5 | A controller in `apps/api` is **≤ 20 lines**: validate DTO → build command → call use case → map result. Nothing else. |
| B6 | Repositories perform no business calculations. No costing, no balance derivation, no validation of business meaning. |
| B7 | Do not create `BaseRepository`, `GenericRepository`, `RepositoryFactory` or similar. Business-specific repository interfaces are the intentional persistence seam because PostgreSQL exists now and the committed SQLite-WASM adapter arrives in Phase 12. Do not add extra interfaces for trivial one-implementation helpers merely to imitate this pattern. |
| B8 | Vue components contain no business rules. Formatting, layout and interaction only. A calculation in a component is a rejected change. |

**CI gate:** `pnpm test:boundaries` fails the build on any violation of B2–B4.

The boundary checker is built **first**, in Phase 0, before any business code. It is the only mechanical defence against the risk that quietly makes the offline requirement unachievable, and it cannot meaningfully be added later.

Reference controller shape:

```ts
@Post()
async create(@Body() dto: CreateSaleDto, @Ctx() ctx: RequestContext) {
  const result = await this.createSale.execute(toCreateSaleCommand(dto, ctx));
  return { data: toSaleResponse(result) };
}
```

A controller containing an `if` about business meaning, a calculation, or a repository call is a rejected change.

---

## R-C — Data (CI-enforced where possible)

| # | Rule |
|---|---|
| C1 | All primary keys are **ULIDs generated in application code**. No autoincrement, no DB-generated IDs. |
| C2 | All money is **integer minor units** via `Money`. Quantities are **scaled integers** via `Qty`. Unit cost uses `UnitCost` at scale 4. |
| C3 | **Floating-point arithmetic on money or stock is forbidden.** No `+ - * /` on raw numbers representing money or quantity. No `parseFloat`, no `Number()` on money strings. |
| C4 | Every table has `tenant_id`. Every query is tenant-scoped. `tenant_id` is read from `TenantContext`, **never** from a request body, query string, or URL parameter. |
| C5 | Use the correct column class from `SRS_AND_BUILD_GUIDE.md` §3.4. Class A mutable, Class B documents, Class C append-only. **Never put `deleted_at`, `updated_at` or `version` on an append-only table** — those columns invite someone to soft-delete a journal line. |
| C6 | Never hard-delete a posted financial or stock record. Void/reverse + soft delete only. |
| C7 | Movements, journal lines and audit events are **append-only**. Corrections are new rows, never `UPDATE`. |
| C8 | Time is injected via the `Clock` port. `new Date()` and `Date.now()` are banned outside the Clock implementation. |
| C9 | Include the reserved columns when creating transaction tables: `location_id`, `tax_rate_id`, `tax_amount`, `is_tax_inclusive`, `pack_size`, `device_prefix`. Tax columns stay `NULL` in V1 (D-09 revised). `credit_limit` belongs on the **party**, not on transactions. |
| C10 | `operation_id` is stored permanently on the document with a unique index on `(tenant_id, operation_id)`. The `idempotency_keys` table is a 30-day fast path, not the guarantee. |

**CI gate:** lint rules ban float arithmetic on `Money`/`Qty` types and ban `Date.now()` outside `shared-utils`.

---

## R-D — Write Paths by Mutation Class

The ten-step path is mandatory for **business documents that affect money, stock, balances, business dates or posted history**. It must not be imitated with meaningless no-op steps in authentication or simple configuration changes.

### Class T — transactional business writes

Follow this order inside **one** database transaction:

```
1  Resolve TenantContext
2  Permission check (entitlement → feature → setting → permission → access)
3  Idempotency check (operation_id)
4  PeriodGuard.assertOpen(business_date)
5  Load aggregates
6  Domain invariants
7  Persist changes
8  Post journal + stock movements
9  Write audit event + outbox record
10 Commit
```

| # | Rule |
|---|---|
| D1 | Every Class T write uses all ten steps. A missing applicable step rejects the change; a step may be explicitly marked `not applicable` only when the document has no stock or no journal effect by definition. |
| D2 | Business permission checks happen in `core-application`, not only in a controller guard. Self-service Class S actions authenticate the subject instead of inventing a role permission. |
| D3 | Every Class T creation accepts `operation_id` and is idempotent. Class M creation also does when a retry could duplicate a record. Credential and token operations never store secret-bearing request fingerprints. |
| D4 | Every accepted mutation writes an appropriate audit event. Money and stock changes include exact before/after values; secrets are always excluded. |
| D5 | No business operation spans two transactions. If it seems to need to, STOP and report. |
| D6 | Cost values are never trusted from a client. The server computes them. |
| D7 | The outbox write stays even though nothing reads it until Phase 12. It is the SRS-mandated future-compatibility exception. **Do not remove it as dead code.** |
| D8 | **Cash balances are never assigned, only moved.** An opening cash figure that differs from the previous session's counted close requires a posted movement with a declared source or destination. Never write an opening balance that absorbs a difference, and never compute a "starting balance" by carrying a number forward without a journal entry behind it (§5.16.5). |
| D9 | **A computed expected amount is immutable once stored.** Expected closing cash is written at End Day and never recalculated on read, never adjusted to match the count, never overwritten. The difference posts to `CASH_SHORT_OVER`; the expected figure itself stands as the record of what the system believed (§5.16.4). |

### Class S — security and identity writes

Signup, login, logout, OTP, password/PIN, session and identity-provider operations use: validated identity context → rate/attempt guard where applicable → load account/session → security invariant → persist → revoke/rotate sessions where applicable → security audit → commit. They do not use a period guard, numbering, journal or stock movement. Passwords, PINs, OTPs and tokens must never appear in audit before/after data or idempotency fingerprints.

### Class M — master-data and configuration writes

Products, parties, users, roles and settings use: tenant context → permission/step-up where required → idempotency when retry could create a duplicate → load → invariant/optimistic lock → persist → audit + outbox → commit. They do not use period guard, journal or stock movements unless the specific action creates an opening balance or another posted financial effect; that action is Class T.

Every task block must state `WRITE CLASS: T`, `S`, `M`, or `READ ONLY`. If one module contains more than one class, list the class beside each mutation.

---

## Coding Standards

### SOLID — pragmatically

Apply where it improves maintainability and separation of concerns. Enforce especially **Single Responsibility**, **Dependency Inversion** and **Interface Segregation** — they are what keep the domain free of the database.

**Do not create abstractions merely to demonstrate SOLID.** An interface with one trivial implementation and no second caller is not Dependency Inversion, it is indirection.

### KISS — strong rule

Prefer the simplest implementation that satisfies the finalized SRS. Do not use clever code, unnecessary design patterns, unnecessary abstraction layers, generic frameworks, deep inheritance, or metaprogramming without a real need.

**Readable and explicit beats short and clever.** The person reviewing this code cannot program. Code that requires cleverness to follow cannot be reviewed, and unreviewable code in an accounting system is a liability.

### YAGNI — strong rule

Do not implement hypothetical future requirements. No speculative features, unused configuration, unused extension points, generic frameworks "for later", unnecessary feature flags, or infrastructure without a current requirement.

**The one exception is future compatibility explicitly required by the SRS**, and it is a short, closed list:

- reserved columns (§3.4) — `location_id`, tax fields, `pack_size`, `device_prefix`
- outbox writes (D7)
- repository interfaces shaped so a SQLite adapter can be added later (D-14)

Anything not on that list and not required by the current module does not get built.

### DRY — carefully

**Never duplicate a business rule.** One costing rule, one posting rule, one permission rule, in one place.

**Do not over-abstract because code looks similar.** Two pieces of code representing different business concepts may stay separate even when they read alike today — they will diverge, and a premature shared abstraction makes that divergence expensive. DRY applies to duplicated *rules*, not to every repeated line.

### Reuse existing behaviour — strong rule

**Reuse the owning function/use case, not copied code.** Before writing a new function, search for the current function that already represents the business intent. Reuse at the module interface whenever possible.

Good reuse:
- **Sales Invoice edit/correction** from Customer Ledger, Sales Invoice History, Invoice Detail and Daybook → the same authoritative invoice edit/correction module/interface.
- Customer Ledger `Receive Payment` → existing receipt use case.
- Counter `Receive Voucher` → the same receipt use case.
- Daybook `Correct Sale` → the existing sale correction/versioning use case.
- Account Reconciliation `Add Missing Entry` → Counter/source creation use case with date/account context prefilled.
- Supplier Hub `Pay Supplier` and Counter `Payment Voucher` → the same supplier payment use case.

Rejected reuse:
- copying a Vue method into another page,
- a second `receiveCustomerPaymentV2`,
- Daybook-specific posting logic,
- Counter-specific journal calculations,
- a “shared generic transaction manager” that hides different business intents.

**Reuse can require extension.** If the existing module interface lacks a caller-neutral input needed by multiple real callers, deepen that module once: extend the smallest stable interface, keep caller-specific navigation state outside the business command, and update all callers/tests. Do not add a wrapper layer whose only job is forwarding parameters.

### Composition over inheritance

Prefer composition, dependency injection and small focused services. Avoid deep inheritance and giant base classes. No `BaseService` unless genuinely required and justified in the report.

### Explicit over implicit

Business-critical behaviour must be visible at the call site, not hidden in a decorator, a base class, or a convention. Make these explicit every time:

- permission checks
- transaction boundaries
- state transitions
- costing decisions
- accounting posting
- business dates
- reversal logic
- validation
- error handling

If a reader has to know a framework convention to see that money moved, the code is wrong.

### Strong TypeScript

- No `any`. No unsafe casts used only to silence an error.
- Prefer domain value objects (`Money`, `Qty`, `UnitCost`, `TenantId`) over primitives.
- Use discriminated unions for states and results; make illegal states unrepresentable.
- Prefer compile-time guarantees over runtime checks.

### Pure domain logic

Domain calculations are deterministic and side-effect free — same input, same output, no I/O, no clock, no randomness. This is mandatory for `Money`, `Qty`, `UnitCost`, costing, allocation and accounting logic.

Purity is what makes the golden invariants testable, and what lets the same rules run later on a device with a different database.

---

## Anti-Overengineering

**Do not overengineer SherERP.** Always choose the simplest architecture that satisfies the finalized requirements and the existing architectural constraints.

Before adding **any** abstraction, framework, pattern, helper, configuration option, generic system or dependency, answer these five:

1. Is it required by the SRS?
2. Does it solve a real, current problem?
3. Does an existing project mechanism already solve it?
4. Can the requirement be satisfied more simply?
5. Does the abstraction have a real second use case *today*?

**If the answer is no, do not add it.** If you are unsure, do not add it and say so in your report.

### Explicitly prohibited

Do not create:

- `BaseService` (unless genuinely required and justified) · `BaseRepository` · `GenericRepository` · `RepositoryFactory`
- generic CRUD engines · generic "manager" classes
- event buses that are not required
- strategy abstractions with one implementation
- factories that are not required
- interfaces with one trivial implementation
- plugin systems · microservices
- design patterns applied for their own sake
- dependencies that are not required

### Also rejected — patterns common in AI-generated NestJS

| Pattern | Why rejected |
|---|---|
| Business logic in a NestJS service with Drizzle calls inline | Kills the offline requirement silently |
| `any` to escape a type error | Hides real bugs in money handling |
| `parseFloat` / `Number()` on money strings | Guaranteed cent drift |
| Catch-and-log-and-continue | Half-written financial transactions |
| `SELECT *` in a repository | Breaks silently on schema change |
| Raw SQL string concatenation | Injection + tenant leak |
| A migration that drops or renames a column | Forward-only migrations only |
| `if (isOnPrem)` outside the three provider implementations | Starts the fork |
| Auto-generated CRUD for every entity | Most entities are not CRUD; posting rules matter |
| A "just in case" config flag | Untested code path that rots |
| `PATCH /sales/{id} {status:"VOIDED"}` | State changes are explicit action endpoints running their own use case |
| Sending cost/profit fields the client is expected to hide | Readable in the network tab |
| Building the next module's schema "while we're here" | Violates S6 |

Existing project-specific architectural rules (R-B, R-C, R-D) remain authoritative over any general principle.

---

## R-UI — Existing UI Migration to Final v4.2

The repository may contain working screens built before the final workflow decisions. **Do not judge them by visual similarity alone.** Preserve useful behaviour and migrate the interaction model to the final SRS.

### UI migration order

1. Read SRS §2.7 plus the complete target module section.
2. Open the current route in the real app and record what already works.
3. Search current Vue/routes/stores/composables/API calls and identify reusable behaviour.
4. Build the reuse map and the UI acceptance trace.
5. Keep conforming functions; change layout/navigation/action placement around them.
6. Route every contextual action into the authoritative use case.
7. Remove obsolete duplicate UI paths only after their callers are migrated.
8. Verify the final workflow in the running UI.

### Final v4.2 interaction rules that agents frequently miss

- `Daily` is the first operational category: **POS · Counter · Daybook · Daily Cash** when implemented/enabled/permitted.
- **Counter** is the user-facing Quick Transactions workspace with three primary intents: Receive Voucher, Payment Voucher, Expense Voucher. It owns no posting logic.
- **Party ledgers are working hubs.** Customer has Due/Advance + Receive Payment/New Sale + full source-linked ledger; Supplier/Vendor have their equivalent actions.
- **Expense Category/Ledger is not a Party.** Salary/Electricity/Transport/Rent are expense classifications; Payee/Employee/Party is optional identity.
- **Daybook is a review/correction launcher**, not a writer. Edit/Delete labels on posted rows route to correction/versioning and void/reversal.
- **Transaction Date = `business_date`** and is the default ledger/Daybook basis. **Entry Date = immutable `created_at`** and is an audit view.
- **Account Reconciliation** changes date/adds missing/corrects/reverses through owning use cases and preserves reconciliation history.
- **Daily Cash** shows immutable Expected vs Physical Count and links mismatches to filtered Daybook investigation.
- **Never ask for context already known** by the origin screen.
- **Preserve origin state** after save/cancel/drill-down return.
- **Progressive disclosure:** one or two primary actions visible; frequent views/actions nearby; rare/sensitive actions under More/row menu.
- **PrimeVue 4 first:** reuse existing shared PrimeVue controls/preset/tokens; do not replace a working shared control with page-specific CSS/native controls.
- **Bangla helper styling:** prefer compact inline `English — বাংলা`; English keeps normal label size/weight and Bangla uses the shared 11px muted helper style. Do not add a second full helper line under every control.
- **Counter surfaces are Bangla-first (UI-74/UI-75, owner decision 2026-08-24) — applies to every module from here on.** Decide first *who acts on this screen*. If it is the cashier doing a job at the counter — starting or ending the day, taking cash in or out, a POS payment, an owner's withdrawal — the **Bangla is the visible label** at normal size and weight, and the English is the subordinate helper or absent. If it is the Owner/Manager reading, configuring or reconciling, keep English-primary per UI-14…UI-21. The inversion is per surface, never per module: one module normally has both kinds of screen.
  - Write the label as the sentence spoken across the counter (`ড্রয়ারে এখন কত টাকা আছে?`), not a translated field name (`গণনাকৃত নগদ`).
  - One primary action per counter screen, large, with an icon that means the same thing as the words.
  - A choice from a known set is a row of large preset buttons, not a dropdown; typing is for the amount and a genuinely open note.
  - Accounting vocabulary — session, reversal, shortage/overage, reconciliation, journal, opening equity — stays in the spec, the schema, the API and the audit trail. The counter reads `টাকা কম` / `টাকা বেশি`. The **domain and API names do not change**: `cashSession`, `differenceMinor`, `REOPENED` stay exactly as they are, because the ledger and the screen are different languages on purpose.
  - UI-47 still holds: digits are Western inside Bangla labels — `৳64,500`, never `৬৪,৫০০`.
- **Tooltip-first where visible Bangla harms density:** icon actions, compact table headers/rows and narrow toolbars use the shared PrimeVue tooltip/help pattern for Bangla/secondary guidance. Tooltip behavior must remain accessible to keyboard and touch where the information matters.
- **Party ledger overview columns:** Name · Phone · Address · Current role balance · `⋯`. Put View Ledger/Edit/Delete-or-Deactivate/other permitted row actions in the menu. Do not reintroduce detail/configuration columns without an explicit SRS change.

### Choosing the UI surface — binding

| Surface | Use it for |
|---|---|
| **Full page** | Major or complex workflows. |
| **Drawer / side panel** | Contextual work that must preserve the current page. |
| **Small modal** | Short actions and confirmations only. |

- **Do not nest modals** and do not add unnecessary temporary layers.
- On mobile a drawer may become near-full-screen; it must stay keyboard-friendly.
- Every surface preserves the current form, filter, tab, search and other useful page state.
- Whatever the surface, it calls the existing authoritative business logic, API, service or function. A new UI entry point never justifies duplicated logic.

### UI reuse decision

For every changed screen, explicitly classify each current element:

`KEEP` — already satisfies v4.2  
`MOVE` — behaviour is correct, placement is wrong  
`REWIRE` — UI is useful but calls the wrong/duplicate path  
`REPLACE` — interaction or underlying implementation conflicts with v4.2 and must be replaced/consolidated at the owning seam before new module work  
`REMOVE` — obsolete duplicate/dead UI after replacement is proven

A UI migration report that only says “redesigned page” is incomplete. It must state which existing behaviour was reused and which duplicate path was removed.

### UI acceptance trace

Before code, map:

`SRS rule/action → current route/component → existing callable function/use case → planned UI surface → verification`

Before `CODE COMPLETE`, verify the real UI at the applicable desktop/tablet/phone widths. Source-code inspection alone is not UI acceptance.


---

## R-E — Tests

**The owner tests the software. The agent does not.** This section is the single project testing policy and replaces every earlier "tests ship with the module" and "run the suite once" instruction anywhere in this file. The required sequence is **R-0**'s: questions → final specification → `START` → code → build and run the app → **the owner reviews the UI** → he reports bugs → the agent inspects and fixes them.

**Arguments that are not exceptions:** "tests may catch bugs", "this is financial logic", "other modules already have tests", "a test would prove the fix". Each has been used to justify breaking this rule.

| # | Rule |
|---|---|
| E1 | **Do not run automated test suites** (owner instruction 2026-08-24, R-0 step 5). `pnpm test` is run **only when the owner asks for it in that conversation**. The gates that still run every time are the ones that make the app compile, run and stay architecturally sound: **`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:boundaries`** — static checks, not test suites, despite the name of the last one. |
| E2 | **Do not create new test code.** No new domain, API, UI, E2E, mock, fixture or diagnostic tests, and no throwaway verification script, unless the owner explicitly requests them. |
| E3 | Never skip, disable, weaken or delete an existing test. No `.skip`, no `.only`, no commented assertions, and never change an expected number to match the output. |
| E4 | If a gate command fails for unrelated pre-existing reasons, **report it briefly and stop there**. Do not investigate or modify unrelated modules without the owner's explicit approval. |
| E5 | When the code is finished, **build and start the app**, then give the owner a **step-by-step manual** for testing the real UI, the calculations, the data flow and the business workflow: what to click, in what order, what should appear, which refusals to try. This is the acceptance gate. |
| E6 | Additional permanent tests for critical logic — financial calculations, balances, FIFO/stock, payments, refunds, accounting, unit conversion, settlements and other data-critical rules — are **optional and need the owner's permission first**. Do not write or run them until the owner has manually tested the module and explicitly approved further testing. |
| E7 | **When the owner reports a bug: inspect only the implementation and dependencies needed to diagnose it**, fix it, rebuild so he can verify again, and say exactly what to retest. No test written to prove the fix (E2), no refactor of code the bug did not touch. |
| E8 | **Do not start the next module until the owner confirms the current one.** |
| E9 | If the owner does approve extra tests, they assert **exact expected numbers** from the module specification — never "greater than zero", never snapshot output — and domain tests stay pure and fast: no database, no HTTP. |

Manual owner acceptance in the real UI is this project's primary correctness gate. Writing fewer automated tests never means less care about money, stock, permissions or tenant isolation — it means the owner verifies them, and the agent does not spend the budget on tests nobody asked for.

---

## R-F — Reporting Back

When finished, report in exactly this format. Do not narrate outside it.

```
## Module increment
## Acceptance criteria and the numbers I verified
## Assumptions
## Reused existing functions/modules
## Files changed
## Files intentionally NOT touched
## Database (PostgreSQL migration)
## UI (route, screen, what the owner should click)
## How to test it in the UI (step by step: what to click, in what order, what should appear)
## Manual checklist for the owner (real UI, calculations, data flow, business workflow)
## FUNCTION_MAP.md updated (what was added, changed or removed)
## Not implemented
## Risks I noticed
```

| # | Rule |
|---|---|
| F1 | Paste **real** test runner output. Never describe, summarise, or fabricate results. |
| F2 | If any of `lint`, `typecheck`, `test:boundaries`, `test` fails, the task is **not complete**. Say so. |
| F3 | State every assumption. An unstated assumption in an accounting system becomes a wrong number nobody can trace. |
| F4 | Report risks you noticed even if outside the current module. |
| F5 | The UI section must tell the owner exactly what to click to accept the module workflow, including contextual entry and return path. A module they cannot find or complete is not accepted. |
| F6 | Report the authoritative existing functions/modules reused, any function extended once for multiple callers, and any duplicate path removed. If `Reused existing functions/modules` is `none`, explain why the reuse map found no suitable implementation. |
| F7 | Say what `FUNCTION_MAP.md` gained, lost or changed this session, or state plainly that no reusable code was written (R-T6). |

---

## R-H — When to Stop

**STOP and report instead of proceeding** when:

1. The spec contradicts another part of the spec.
2. The spec is silent on something that changes a stored number.
3. You need a file outside ALLOWED FILES.
4. You need a new dependency.
5. A test fails and the fix would require changing the test's expected number.
6. You are about to write the same business rule in a second place.
7. You need an internal account that is not on the closed list in §2.4.
8. The module cannot be delivered end to end within its agreed 3–5 day timebox; propose a cohesive split instead.
9. You cannot satisfy the rule set without an exception.
10. You are about to create a second implementation of a business action that already exists behind another UI entry point.
11. You are about to start the next module while the current built module still has known v4.2 UI/reuse/architecture defects.

Stopping is always correct. A half-correct accounting system is worse than an unfinished one.

---

## Definition of Done

Four gates. **A module is not done because the code runs.** Focused checks protect work in progress (R-T3/R-T4); these full gates run once when the complete module increment is ready for acceptance and are never skipped for cost (R-T5, R-T7).

### Browser handoff after every coding turn

After any turn that writes source code, tests, schema or migrations, the agent must prepare the
real application for owner testing **before handing control back**. This is automatic; the owner
must never have to ask for the servers to be started.

1. Start `sher-pg` if PostgreSQL is not already running.
2. Start or restart the API through the canonical `pnpm dev` path with the local `sher_dev`
   configuration, so current workspace packages are rebuilt rather than stale `dist` files used.
3. Start or restart the Vite web application and leave both processes running.
4. Verify `http://localhost:3000/health` succeeds and `http://localhost:5173/` returns HTTP 200.
5. Give the owner the browser URL and report any sign-in/session reset that may be needed.

If the environment prevents a server from starting, report the exact command and blocker instead
of claiming the application is ready. Documentation-only and read-only turns do not require a
restart. This browser handoff is required after focused increments as well as module gates; it does
not replace the four automated gates or owner UI acceptance.

### Gate 1 — Automated (CI blocks the merge)

- [ ] `pnpm lint` passes, zero warnings
- [ ] `pnpm typecheck` passes, zero `any` introduced
- [ ] `pnpm test:boundaries` passes, no layering violation
- [ ] The app **builds and runs**, and the owner has a step-by-step UI manual (R-0 step 5). No test suite was run and no test file was written without the owner's request (R-E1, R-E2)
- [ ] A concise manual checklist was handed to the owner for real-UI, calculation, data-flow and workflow testing (R-E5)
- [ ] v4.2 module trace checked: required fields, conditional fields, UI actions, search/filters, edge states, print/share behaviour (where applicable), accounting/stock effects, reversal/correction and acceptance tests are all implemented
- [ ] Migration runs clean on an empty DB **and** on a seeded DB
- [ ] OpenAPI regenerates with no manual edits
- [ ] `saas-smoke` and `onprem-smoke` green — *from Phase 1 onward; these gates do not exist in Phase 0*

### Gate 2 — Owner Review (60 seconds, no code reading)

- [ ] The agent pasted **real** test output with counts — not a description
- [ ] "Files changed" matches the module, nothing extra
- [ ] "Files intentionally NOT touched" is filled in, not empty
- [ ] No new dependency you did not approve
- [ ] At least one assumption is stated — if "none", be suspicious
- [ ] No `if (isOnPrem)` outside the three provider implementations
- [ ] Nothing in the diff puts business logic in a controller or a Vue file
- [ ] No new `Base*`, `Generic*`, or `*Factory` class appeared
- [ ] Migrations cover this module only

### Gate 3 — Manual UI Acceptance (the one that matters)

**Rule: the expected numbers are written before the code exists.** Computing them after seeing the result is not testing — it is agreeing.

- [ ] Executed **in the real UI**, not via API calls or curl
- [ ] Every figure matches exactly — stock, cost, profit, ledger, cash, report
- [ ] Reversal path tested where the module can reverse a posted action: void it, confirm everything returns to the prior state
- [ ] Backdated path tested where applicable
- [ ] Numbers still correct after a page refresh and a re-login
- [ ] The screen is usable — loading/empty/error/permission states, no console errors
- [ ] Final v4.2 workflow verified: Daily/Counter/Daybook/hub behavior where applicable
- [ ] Context already known by the origin was preselected, not asked again
- [ ] Save/cancel/drill-down returned to the required origin state
- [ ] Existing authoritative business functions were reused rather than duplicated
- [ ] Repeated actions from multiple screens were verified to hit the same owning module/interface
- [ ] Bangla helpers are subtle/inline or tooltip-based where density requires it; they do not distort the final layout
- [ ] Ledger overview shows only the SRS-approved compact columns and one row action menu

**Baseline scenario — run at every transactional module gate once the prerequisite Purchase and Sales modules exist:**

```
Create product → Purchase 10 @ ৳100 → stock = 10, valuation = ৳1,000
  → Sell 3 @ ৳150 → stock = 7, revenue = ৳450, COGS = ৳300, profit = ৳150
  → Receive ৳200 → customer due = ৳250, cash = +৳200
  → Customer ledger, cash report, stock report, profit report all agree
  → Void the sale → stock = 10, profit = 0, ledger clean
```

Any disagreement between two reports is a **blocking** defect, never a rounding excuse (INV-10).

### Gate 4 — Module-Specific

- [ ] Appropriate audit events written for every accepted mutation; money and stock changes include exact before/after values and secrets are absent
- [ ] New permissions registered in the seed role matrix
- [ ] Reports reconcile to journal and movements
- [ ] Reserved columns present on any new transaction table (R-C9)
- [ ] Period lock respected for any document carrying a business date
- [ ] Correct column class used (R-C5)

### Module/Roadmap Exit

- [ ] The weekly module increment passes Gates 1–4
- [ ] Every roadmap phase included in that module meets its exit criteria in `SRS_AND_BUILD_GUIDE.md` §6.1
- [ ] The app builds and runs, and the owner has confirmed the module in the UI
- [ ] The baseline scenario still passes end to end in the real UI

### Never Done If

| Condition | Why it is fatal |
|---|---|
| A test was skipped, weakened, or deleted to make CI pass | The suite is now lying |
| An expected number in a test was changed to match the output | The bug is now the specification |
| Money or stock computed with floating point | Guaranteed drift |
| A posted document can be hard-deleted | Breaks auditability |
| Two reports disagree | One is wrong and you cannot tell which |
| Business logic added to a controller or Vue component | Kills the future offline path silently |
| `tenant_id` read from a request payload | Cross-tenant vulnerability |
| The module has no working UI workflow | It is not delivered |
| The agent said "should work" without pasted output | Unverified |

---

## Prompt Kernel

Paste this at the top of every task, then the module task block.

```
You are implementing ONE MODULE-SCALE VERTICAL INCREMENT of SherERP against the final v4.2 SRS. You may be migrating an already-built module. You are not inventing a new product or rebuilding working business logic without cause.

MANDATORY READING before writing any code:
- AI_CODING_INSTRUCTIONS.md          <- binding rules; violations reject the whole change
- FUNCTION_MAP.md                    <- what already exists and how to call it; read BEFORE searching the code
- SRS_AND_BUILD_GUIDE.md, §2.7 + only the module/dependency/task sections named in the task block
- the existing code paths that currently implement the same business actions

WHAT A MODULE INCREMENT IS
One coherent business area containing all related user actions needed to make it usable,
built through every layer. Connect each internal path domain -> application -> database ->
API -> Vue before starting the next path. Write no new tests. When the whole module is ready,
build and start the app, and hand the owner a step-by-step manual for testing it in the real UI.
If the module cannot be completed in 3-5 working days, propose two cohesive increments.

BEFORE ANY CODE (R-Q): ask 10-20 concise questions about unresolved decisions only, then give the
final module specification, what is added/changed/reused, the exact UI and workflow, and the files
and modules affected. Then WAIT. Only the owner's `START` authorises code.

NON-NEGOTIABLE RULES:
0. REUSE FIRST. Read FUNCTION_MAP.md, then search the codebase only for what it does not answer, to find the authoritative function/use case before creating a new one. Customer/Counter/Daybook/Invoice/etc. are entry points, not permission to duplicate Receive/Pay/Return/Correct/Void logic. Invoice edit/correction is the reference example: every screen calls the same owning module/interface.
1. Business logic goes in packages/core-domain (pure TypeScript) and packages/core-application.
   NEVER in controllers, Vue components, SQL, or database triggers.
2. core-domain must not import @nestjs/*, Drizzle, PostgreSQL, SQLite, express, or DOM types.
3. All primary keys are ULIDs generated in application code. No autoincrement.
4. All money and quantity values are integers in minor units via the shared Money/Qty/UnitCost
   helpers. Floating point arithmetic on money or stock is forbidden.
5. Every table has tenant_id. Every query is tenant-scoped. tenant_id is never read from a
   request body, query string, or URL.
6. State WRITE CLASS T, S, M or READ ONLY for each mutation. Class T financial/stock writes
   follow the complete ten-step path in one transaction. Class S and M follow their defined paths.
7. Never hard-delete a posted financial or stock record.
8. Do NOT write new tests (R-E2). Never skip, disable or weaken an existing test. Finish the module,
   build and start the app; do not run automated test suites unless asked (R-E1)
   without touching those modules, and give the owner a manual checklist. Extra tests for critical
   financial/stock logic require the owner's permission first.
9. Do not modify anything outside the ALLOWED FILES list. If you believe you must, STOP and report.
10. Do not change any requirement or decision. If one seems wrong or contradictory, STOP and
    report it - do not improvise a fix.
11. For existing UI, classify current behavior KEEP/MOVE/REWIRE/REPLACE/REMOVE and migrate toward
    v4.2 while preserving conforming business logic and current callers.
12. If the current module needs structural refactoring/consolidation to establish one authoritative
    implementation or satisfy final UI rules, finish that refactor and acceptance FIRST. Do not start
    the next business module with known defects left behind.

SIMPLICITY IS MANDATORY
Choose the simplest implementation that satisfies the requirements. Before adding any
abstraction, pattern, helper, config option or dependency, ask: is it required by the SRS?
does it solve a real current problem? does something existing already solve it? can it be
done more simply? does it have a real second use case today? If no - do not add it.
No BaseRepository, GenericRepository, RepositoryFactory, generic CRUD, manager classes,
event buses, single-implementation strategies or interfaces, factories, or plugin systems.
Never use SOLID, DRY, KISS or YAGNI to override a finalized business requirement.

BEFORE YOU CODE: write the requirement/UI trace, reuse map, and a short plan (existing functions
reused, files to add/change, migration, API, UI, tests) and wait
for approval if the task block says PLAN FIRST.

WHEN DONE, update FUNCTION_MAP.md with the reusable functions, services, endpoints, database
methods, shared components and business rules this session added or changed, then report in
exactly this format:
## Module increment / ## Acceptance criteria and the numbers I verified / ## Assumptions /
## Reused existing functions/modules / ## Files changed / ## Files intentionally NOT touched / ## Database (PostgreSQL migration) /
## UI (route, screen, what the owner should click) / ## How to test it in the UI (step by step) /
## Manual checklist for the owner /
## FUNCTION_MAP.md updated / ## Not implemented / ## Risks I noticed
```

### Agent-specific wrappers

**Claude Code** — prepend:

```
Follow R-Q first: questions, then the specification, then WAIT for `START`. After that work
autonomously through every layer of the module, writing no new tests. When it is complete run
`pnpm lint && pnpm typecheck && pnpm test:boundaries` and paste the real output. Do **not** run `pnpm test` (R-E1).
Do not mark the module complete if any gate fails or if its UI workflow is missing.
If you disagree with the spec, say so instead of improvising.
```

**Codex / IDE agent** — prepend:

```
Start by reading the existing implementation of this workflow. Search before creating.
Name the authoritative functions/use cases you will REUSE, EXTEND, REPLACE or mark MISSING.
Use the **invoice edit/correction rule** as the model: if Customer Ledger, Sales Invoice History,
Invoice Detail and Daybook expose the same business action, they must call one owning module/interface.
If current code has duplicate functions or the existing module/UI is structurally wrong, refactor and
consolidate that current module first, migrate its real UI to v4.2, and verify it before starting the
next module. Do not create a parallel page/function just because the old layout differs.
Implement only the allowed files; if the correct refactor needs another file, STOP and propose that
specific scope expansion instead of copying logic locally. Follow neighboring code/style. Do not add
libraries or reorganise unrelated folders. After each internal path, show a concise diff summary and
run the smallest relevant check.
```

**Generic GPT agent** — prepend:

```
Produce complete file contents, one file per code block, with the full path as the first line
of each block. Do not abbreviate with "...". Do not invent APIs: if a helper you need does not
exist in the listed files, say so instead of assuming it.
```

### Review prompt (use a *different* model than the one that wrote the code)

```
Check this diff against AI_CODING_INSTRUCTIONS.md.

- Is this a complete module workflow, or did it stop at the backend? Is there a real UI?
- Did business logic get into a controller or a Vue file?
- Is float arithmetic used anywhere on money or stock?
- Is tenant_id read from a request body, query string, or URL?
- Was any test skipped, weakened, or had an expected number changed?
- Were files outside the ALLOWED FILES list modified?
- Are all ten write-path steps present, in one transaction?
- Was any unnecessary abstraction added - Base*, Generic*, *Factory, a single-implementation
  interface, an event bus, a config flag nobody asked for?
- Do migrations cover only this module?
- Does the implementation satisfy every applicable v4.2 module-contract item: fields, conditional fields,
  UI actions, filters/search, permissions, stock/accounting effects, correction/reversal, edge states,
  print/share behaviour, and acceptance criteria?
- Did any archived/legacy requirement (LIFO, Loyalty/Premium, Tauri-first) leak back into the code?
- Did the change reuse the existing authoritative use case, or create a second implementation for a new UI entry point?
- Does the UI match v4.2 stay-in-context behavior: Daily/Counter/Daybook/hubs, progressive disclosure, preselected known context, preserved return state, Transaction Date vs Entry Date?
- Were existing conforming functions/routes/contracts unnecessarily rewritten instead of reused?
- Does the same repeated business action resolve to one authoritative module/interface across every caller (especially invoice edit/correction)?
- Did the agent leave known current-module UI/refactor debt and start another module anyway?
- Was FUNCTION_MAP.md updated for the reusable code this change added or changed, and does every entry point at a file that exists?
- Are Bangla helpers subtle inline/tooltip guidance rather than layout-expanding duplicate labels?
- Are party ledger overview columns limited to Name, Phone, Address, Current Balance and one `⋯` menu?

Do not write code. List the problems only.
```

The agent that wrote the bug cannot catch it — its own tests will agree with its own mistake. A different model sees different things. This is the cheapest defence available.

---

## R-G2 — v4.2 Requirement-Fidelity Guardrails

These are implementation-process rules, not a duplicate SRS. The reconciled v4.2 carries detailed business/UI behaviour that an AI agent must not reduce to generic CRUD.

| # | Rule |
|---|---|
| G2.1 | **Do not collapse explicit UI behaviour into a generic capability.** If the SRS specifies repeated barcode scan behaviour, serialized-unit selection, active zero/negative-stock visibility, invoice actions, filters, print modes or sharing controls, implement and verify that exact behaviour. |
| G2.2 | **Conditional fields stay conditional.** Do not make optional master-data fields mandatory because a database column exists. Product creation requirements and feature-dependent fields follow the SRS exactly. |
| G2.3 | **Active/inactive status and stock quantity are independent.** Never infer inactive status from zero or negative stock. |
| G2.4 | **Serial/barcode identity stays reference-based.** Do not encode mutable business state in generated unit barcodes. Manufacturer serials are captured/scanned from the item; SherERP does not invent them. |
| G2.5 | **Cosmetic invoice edits must not rewrite posted accounting facts.** Presentation overrides and transaction corrections/reversals are separate paths. |
| G2.6 | **The two costing settings remain separate.** `inventory_issue_method` and `sale_costing_method` each allow only `FIFO` or `AVERAGE`; there is no LIFO. Follow the SRS invariants and never invent a physical “average lot”. |
| G2.7 | **Loyalty/Premium is out of current scope.** Do not resurrect it from archived docs, legacy fields or old prompts. |
| G2.8 | **Roadmap order is binding:** Online V1 → Sync/PWA Offline (12) → Mobile/PWA polish (13) → optional Tauri (14) → MCP (15). Do not scaffold later phases early. |
| G2.9 | **Existing Google Sheets/Apps Script SherERP is a migration/reference source, not the architectural source of truth.** Preserve required business behaviour and migratable data, but do not copy spreadsheet storage patterns into the new PostgreSQL/domain design unless v4 explicitly requires them. |
| G2.10 | **Existing new-codebase functions are implementation assets.** Reuse conforming domain/application/API functions during UI migration. Existing code does not override v4.2, but neither may an agent ignore it and create a duplicate implementation. |
| G2.11 | **Daily workflow is binding:** Daily = POS/Counter/Daybook/Daily Cash; Counter = Receive/Payment/Expense entry surface; Daybook = review/source-action launcher; party ledgers = working hubs; many entry points use one owning module interface. |
| G2.12 | **Dual date is binding:** `business_date` is Transaction Date/default; `created_at` is immutable Entry Date/audit. No UI or correction workflow may silently rewrite creation time. |

## Phase 0 Task Blocks

Phase 0 is the **only** phase without UI. Three prompts, three reviews.

### 0.1 — Monorepo skeleton and CI boundary enforcement

```
TASK: Phase 0, Slice 1 - monorepo skeleton and CI boundary enforcement.
PLAN FIRST. Show the file list before writing code.

GOAL
Create the pnpm workspace, the five packages, the api app, and the CI checks that enforce
layering. NO business logic. NO database tables yet.

ALLOWED FILES
package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore,
.github/workflows/ci.yml, eslint.config.js,
packages/core-domain/**, packages/core-application/**, packages/core-contracts/**,
packages/shared-utils/**, packages/adapter-postgres/**,
apps/api/**, tools/boundaries/**

REQUIRED STRUCTURE  (SRS_AND_BUILD_GUIDE.md 2.1)
packages/core-domain        pure TS, imports only shared-utils + zod
packages/core-application   use cases + repository interfaces (ports)
packages/core-contracts     zod schemas, DTOs, error codes
packages/shared-utils       Money, Qty, UnitCost, Ulid, Clock
packages/adapter-postgres   Drizzle implementations (empty for now)
apps/api                    NestJS, /health only

Do NOT create adapter-sqlite-wasm, apps/mcp, any Tauri/desktop shell, or apps/web in this slice.
PWA Offline is Phase 12 on SQLite WASM + OPFS. Mobile/PWA polish is Phase 13. Optional Tauri desktop packaging is deferred to Phase 14 and may be created only if the owner explicitly approves that phase after Mobile. MCP is Phase 15.

BOUNDARY CHECK (tools/boundaries)
Write `pnpm test:boundaries` that FAILS the build if:
- core-domain imports @nestjs/*, drizzle-orm, pg, better-sqlite3, express, or DOM libs
- core-domain or core-application imports a Node built-in (fs, path, crypto, os, child_process)
  - these packages are bundled for the browser in Phase 12, so Node APIs are banned now; a later optional Tauri shell must adapt to the same browser-safe core rather than making the core desktop-specific
- core-application imports drizzle-orm, pg, or @nestjs/*
- adapter-postgres is imported by core-domain or core-application
- any file outside shared-utils/clock uses Date.now() or new Date()
Use dependency-cruiser or a simple AST scan. Do not add a heavy framework for this.

CI: run lint, typecheck, test:boundaries, test - in that order. All must pass.

TESTS
- One test proving the boundary checker CATCHES a violation (deliberate bad fixture under
  tools/boundaries/__fixtures__)
- One test proving it PASSES on the real source

DONE WHEN
pnpm install && pnpm lint && pnpm typecheck && pnpm test:boundaries all pass,
GET /health returns 200, and the real output of all four commands is pasted.
```

### 0.2 — Money, Quantity, ULID, Clock

```
TASK: Phase 0, Slice 2 - shared-utils primitives.
READ FIRST: SRS_AND_BUILD_GUIDE.md 3.3 and 3.5

ALLOWED FILES: packages/shared-utils/**

IMPLEMENT
1. Money    - integer minor units, scale 2. add, subtract, multiply(qty), allocate(ratios),
              compare, isZero, isNegative, format. Half-up rounding, applied ONCE.
2. Qty      - scaled integer, scale 3. Same operation set.
3. UnitCost - scaled integer, scale 4.
4. Ulid     - generate(), isValid(), monotonic within a process.
5. Clock    - interface { now(): Date; businessDate(tz: string): string }
              SystemClock + FixedClock (for tests).

RULES
- No floating point ANYWHERE. No parseFloat. No Number() on money strings.
- All functions are PURE: same input, same output, no I/O, no ambient clock, no randomness
  except Ulid.generate().
- Money.multiply(Qty) must not lose precision: compute at scale 4, round once at the end.
- allocate() uses the LARGEST REMAINDER METHOD, tie-broken by line index ascending.
  Parts must ALWAYS sum exactly to the whole, and the split must be deterministic -
  identical result on server and browser for identical input.
- businessDate() converts a UTC instant to a tenant-local YYYY-MM-DD.

TESTS (exact expected values, not approximations)
- Money(125075).format() === "1,250.75"
- Money(100).multiply(Qty(3333)) with scale-3 qty -> assert the exact minor value
- allocate(1000, [1,1,1])         -> [334, 333, 333]        sums to 1000
- allocate(1, [1,1,1])            -> [1, 0, 0]              sums to 1
- allocate(100, [3,1])            -> [75, 25]               sums to 100
- allocate(10, [1,1,1,1,1,1,1])   -> [2,2,2,1,1,1,1]        sums to 10
- Property test: for ANY total and ANY weights, sum of parts === total, exactly
- Determinism: same input 100 times -> identical output every time
- businessDate("2026-08-15T18:30:00Z", "Asia/Dhaka") === "2026-08-16"
- Property test: for random a,b - a.add(b).subtract(b).equals(a)

DONE WHEN
100% branch coverage on Money and Qty - a bug in these two files corrupts every number in
the system. Real test output pasted.
```

Verify `allocate` and `businessDate` personally. Allocation that does not sum exactly is how landed cost and discounts leak a poisha per document until valuation stops tying to the ledger. A wrong `businessDate` moves a whole day's takings into the wrong report, and both numbers look plausible.

### 0.3 — Tenant context, audit, idempotency, period guard

```
TASK: Phase 0, Slice 3 - cross-cutting ports and the canonical write path.
READ FIRST: AI_CODING_INSTRUCTIONS.md R-D, SRS_AND_BUILD_GUIDE.md 3.2, 3.4, 3.7, 5.26

ALLOWED FILES
packages/core-application/**, packages/core-contracts/**,
packages/adapter-postgres/**, apps/api/**, migrations/**

IMPLEMENT (interfaces in core-application, implementations in adapter-postgres)
- TenantContext      resolved from JWT, NEVER from request body
- AccessControl      require(ctx, permissionCode)
- PeriodGuard        assertOpen(ctx, businessDate) -> PERIOD_LOCKED
- AuditWriter        append-only, before/after for money and stock fields
- IdempotencyStore   operation_id based, 30-day fast path
- Outbox             append-only change record written inside the same transaction
- UnitOfWork         ONE transaction per use case
- NumberingService   {PREFIX}-{YYYY}-{NNNNNN}, SELECT FOR UPDATE on the counter row

MIGRATIONS
tenants, users, roles, role_permissions, audit_events,
idempotency_keys, numbering_counters, period_locks, outbox
Use the correct column class per SRS 3.4 - audit_events and outbox are Class C
(append-only: no updated_at, no version, no deleted_at).
Enable PostgreSQL RLS on every tenant-scoped table.

REFERENCE USE CASE
Build ONE dummy use case (CreateNoteService) exercising all ten steps of the R-D write path.
This is the golden template every later slice copies. Make it exemplary and keep it simple -
no abstraction that a real use case would not need.

TESTS
- Cross-tenant: tenant B cannot read/write tenant A's note -> 404
- RLS: a raw query without tenant scoping returns zero rows for the wrong tenant
- Idempotency: same operation_id twice -> ONE record, same response
- Idempotency after prune: delete the idempotency_keys row, replay -> still ONE record
  (caught by the unique index on (tenant_id, operation_id))
- Period lock: write into a locked month -> PERIOD_LOCKED
- Numbering: 50 concurrent allocations -> 50 unique sequential numbers, no gaps
- Audit: every mutation wrote an event with before/after
- Outbox: every mutation wrote exactly one outbox row in the same transaction

DONE WHEN
All tests pass with real output pasted, and the dummy use case is documented in code comments
as THE template for all slices.
```

Run the concurrent numbering test twice. Duplicate invoice numbers are a defect discovered by a customer, not by you.

### Phase 0 exit checklist

**Environment**

- [ ] Docker Engine running (not Docker Desktop)
- [ ] PostgreSQL 16 container running
- [ ] Both `sher_dev` and `sher_test` exist
- [ ] Code at `~/projects/shererp`, not under `/mnt/c/`
- [ ] VS Code shows `WSL: Debian`
- [ ] Pushed to a **private** GitHub repo, Actions enabled

**Code**

- [ ] All four commands green
- [ ] Boundary checker **proven** to catch a violation via the fixture test
- [ ] `Money.allocate()` sums exactly — verified by you personally
- [ ] `businessDate()` correct for the Dhaka midnight case
- [ ] Cross-tenant test returns **404**, not 403
- [ ] RLS active, verified by a raw query test
- [ ] 50 concurrent document numbers: unique, no gaps
- [ ] Idempotency holds both with and without the fast-path row
- [ ] Reference use case implements all ten write-path steps
- [ ] CI runs on every push and blocks merge on failure

Do not start Phase 1 until every box is ticked.

---

## Working With the Agent

**At the module gate always say:**

> Run `pnpm lint && pnpm typecheck && pnpm test:boundaries` and paste the real output. **Do not run `pnpm test`** unless the owner asked for it (R-E1). If any command fails, the task is not complete. Then build and start the app and write the UI manual (R-0 step 5).

**Never say** "make sure tests pass" — that is what an agent says back when it has not run them.

| Agent says | You say |
|---|---|
| "I need to install library X" | "No. How do you do it without a new dependency?" |
| "I improved the business rule to…" | "Stop. Decisions are final in the v4 canonical SRS_AND_BUILD_GUIDE.md. Revert it." |
| "Tests should pass now" | "Paste the actual output." |
| "I also refactored some other files" | "Revert everything outside the ALLOWED FILES list." |
| "I'll add the UI after this module" | "Then the module isn't complete. Finish its real workflow." |
| "I added a base class to reduce duplication" | "Remove it. Show me the two real call sites first." |
| "I created a new payment/return function for this screen" | "Stop. Show me the existing owning use case and reuse it unless the reuse map proves it is missing." |
| "I rebuilt the page from scratch" | "Show which existing functions/components were reused and why replacement was necessary." |
| "The current module is messy, I will fix it later" | "No. Consolidate/refactor this module to the final SRS and verify its UI before starting the next module." |
| "Customer Ledger needs its own invoice-update function" | "No. Reuse the authoritative invoice edit/correction module used by Sales Invoice History/Invoice Detail." |
| "This is a bit unusual, normally you'd…" | "Follow the spec. If the spec is wrong, report it — don't change it." |

**One module increment per conversation.** Use internal checkpoints and compact summaries when the conversation grows; do not mix a second business module into the same context.

### When things go wrong

| Symptom | Do this |
|---|---|
| Tests fail and the agent wants to change an expected number | **Stop.** The number in the spec is right until you decide otherwise. Investigate the code |
| Two reports show different totals | Blocking defect (INV-10). Do not build further until resolved |
| Agent touched unrelated files outside the module | Reject those changes and re-prompt with a tighter ALLOWED FILES list |
| Agent delivered backend only | Reject. The module is not delivered until its UI workflow works |
| You don't understand the diff | Ask a second agent: "Explain what this change does and what could break" |
| Worked yesterday, broken today | `git log` — return to the last focused-test checkpoint or accepted module gate |
| You feel lost | Go back to the last green commit. Never build on something you don't trust |

**Commit internal checkpoints and every completed module.** Checkpoint commits are recovery points; only a module-gate commit is eligible for owner acceptance.
