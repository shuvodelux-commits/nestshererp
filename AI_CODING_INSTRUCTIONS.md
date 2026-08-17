# SherERP — AI Coding Agent Instructions

**Status: BINDING.** A change violating any rule below is rejected in full, regardless of how much of it works.

Requirements and decisions live in `SRS_AND_BUILD_GUIDE.md`. This file is *how to build*, not *what to build*. It does not repeat requirements.

These rules exist because SherERP is built almost entirely by AI agents for an owner who is not a programmer and cannot reliably spot an architectural violation in a diff. Rules are enforced by CI where practical and by a short owner/reviewer check where automation would be misleading. The delivery target is the online V1 scope (Phases 0–11) in one month. Work is therefore organised as four large weekly **module increments**, with focused tests while each module is built and full regression at its module gate.

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

**A5 matters most.** An agent that silently "corrects" a business rule produces software that passes its own tests and computes wrong money. This is the single most dangerous failure mode in this project.

---

## R-S — Module-Scale Vertical Workflow

**SherERP is built one complete business module at a time, top to bottom.** A module increment is larger than the former one-screen slices: it contains the related actions needed to make one business area genuinely usable, such as product create/edit/list/search, or purchase create/list/detail/payment/void.

Inside a module, implement one usable path at a time so integration problems remain local. Do not wait until the end to connect the layers or UI. The module is the acceptance and full-regression boundary.

Every module increment follows this order:

```
 1  Acceptance criteria + expected numbers   ← given in the task block, never invented
 2  Domain logic            packages/core-domain
 3  Application use cases   packages/core-application
 4  Migration               this module's schema only
 5  Repository/adapter      packages/adapter-postgres
 6  API + contract          packages/core-contracts, apps/api
 7  Frontend screens        apps/web, using the shared design system
 8  Focused tests           only the changed rules and critical paths
 9  Internal UI checkpoints while the module is assembled
10  Module regression       lint · typecheck · test:boundaries · test
11  End-to-end module scenario in the real UI
12  Update the status ledger and report for owner acceptance
```

| # | Rule |
|---|---|
| S1 | **Never** build all backend, then all database, then all frontend. Each internal path is connected domain → application → database → API → UI before the next path begins. |
| S2 | A module is not complete because the backend compiles or endpoints return 200. It is complete when all listed module actions work **in the UI**, focused tests pass, full regression passes once at the module gate, and the owner confirms the pre-written numbers. |
| S3 | If a module has no user-visible outcome, say so before starting — it is either Phase 0 foundation work or it is mis-scoped. |
| S4 | Do not start a second module while the current module is incomplete. Internal checkpoint commits are allowed and encouraged, but they are not accepted module releases. |
| S4b | At module completion, update the status ledger (`SRS_AND_BUILD_GUIDE.md` §6.1.1). Set `CODE COMPLETE`; **only the owner sets `DONE`** after manual acceptance. The owner may record the accepted code commit in a small follow-up ledger commit; a commit is not required to contain its own hash. |
| S5 | **Foundation exception:** infrastructure may be built without UI only in Phase 0, and only for the items listed in `SRS_AND_BUILD_GUIDE.md` §6.0. Outside Phase 0, any proposed foundation work must name the specific current module path that is blocked without it. "We will need it later" is not that. |
| S6 | Write migrations for **this module only**. Do not create tables for a later module. |
| S7 | Every module UI must be real and reachable, reuse the shared shell/tokens/components, and include loading, empty, error and permission-denied behaviour. A stub or disconnected mock is not delivery. |
| S8 | Full regression is run once when the complete module is ready for acceptance. During implementation run only the smallest relevant checks after each internal path. A failing focused check blocks further work just as a failing full suite would. |

If a proposed module cannot be completed and accepted within roughly 3–5 working days, split it into two cohesive module increments before writing code. Do not return to one-screen micro-slices.

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
| B7 | Do not create `BaseRepository`, `GenericRepository`, `RepositoryFactory` or similar. Business-specific interfaces only. |
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

## R-E — Tests

| # | Rule |
|---|---|
| E1 | Tests ship with the module. During implementation run focused tests for the changed rule/path; run the complete suite once at the module gate. |
| E2 | Never skip, disable, weaken, or delete an existing test. No `.skip`, no `.only`, no commented assertions. |
| E3 | A module touching money or stock must run the applicable golden invariants at its module gate. While implementing, run the directly affected invariant tests only. |
| E4 | Domain tests are pure and fast — no database, no HTTP. |
| E5 | Cross-tenant tests are required once per new repository/query pattern and for every endpoint that bypasses that shared pattern. Do not repeat the identical isolation assertion for endpoints that use the already-proven path. Denial of a specific inaccessible record remains **404**, not 403. |
| E6 | Every Class T creation has an idempotency test: same `operation_id` twice ⇒ one record. Class M creation needs one only when retry could duplicate data. Class S credential/token operations use their security replay/rotation tests instead. |
| E7 | Assert **exact expected numbers** from the task block — never "greater than zero", never snapshot output. |
| E8 | Test the permission matrix once per module: one allowed role, every materially different denied role group, step-up rejection for sensitive actions, and cost visibility against the serialized response body. Do not repeat identical role assertions on every endpoint when one shared application permission path is already proven. |
| E9 | A module touching the journal asserts INV-01 and INV-09; stock asserts INV-02..INV-05; cash asserts INV-07 a/b/c; reports assert INV-10 against the equivalent journal/movement query. |
| E10 | The completed Cash module runs the §5.16.6 worked example with the exact numbers, including all three Day-2 outcomes and proof that Day 1's shortage is unchanged. It is not rerun after unrelated internal cash-screen edits. |
| E11 | UI tests are one smoke test per module workflow plus tests for any new shared state component. Reusing an already-tested loading/error/empty shell does not require repeating the same component test on every page. |
| E12 | Do not test framework behaviour, trivial getters, DTO field copies or visual token values in multiple places. Test business rules, security boundaries, transaction rollback, serialization secrecy, and the user's critical workflow. |

E8's cost-visibility check is what catches the leak where Vue hides a cost column while the API still sends it. Reducing repetition never means reducing accounting, inventory, security or tenant-isolation coverage.

---

## R-F — Reporting Back

When finished, report in exactly this format. Do not narrate outside it.

```
## Module increment
## Acceptance criteria and the numbers I verified
## Assumptions
## Files changed
## Files intentionally NOT touched
## Database (PostgreSQL migration)
## UI (route, screen, what the owner should click)
## Tests (paste the real runner output)
## Not implemented
## Risks I noticed
```

| # | Rule |
|---|---|
| F1 | Paste **real** test runner output. Never describe, summarise, or fabricate results. |
| F2 | If any of `lint`, `typecheck`, `test:boundaries`, `test` fails, the task is **not complete**. Say so. |
| F3 | State every assumption. An unstated assumption in an accounting system becomes a wrong number nobody can trace. |
| F4 | Report risks you noticed even if outside the current module. |
| F5 | The UI section must tell the owner exactly what to click to accept the module workflow. A module they cannot find or complete is not accepted. |

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

Stopping is always correct. A half-correct accounting system is worse than an unfinished one.

---

## Definition of Done

Four gates. **A module is not done because the code runs.** Focused checks protect work in progress; these full gates run once when the complete module increment is ready for acceptance.

### Gate 1 — Automated (CI blocks the merge)

- [ ] `pnpm lint` passes, zero warnings
- [ ] `pnpm typecheck` passes, zero `any` introduced
- [ ] `pnpm test:boundaries` passes, no layering violation
- [ ] `pnpm test` passes, **no skipped tests**
- [ ] Golden invariants relevant to the module pass (R-E9)
- [ ] New repository/query patterns have cross-tenant proof; exceptional endpoints have their own isolation test
- [ ] Class T creations and duplicate-prone Class M creations have idempotency proof
- [ ] Module permission matrix passes; cost-visibility is checked on the serialized body
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
- [ ] The screen is usable — loading state, error state, no console errors

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
- [ ] Full regression green, including previous phases
- [ ] The baseline scenario still passes end to end

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
You are implementing ONE MODULE-SCALE VERTICAL INCREMENT of SherERP. You are not redesigning the product.

MANDATORY READING before writing any code:
- AI_CODING_INSTRUCTIONS.md          <- binding rules; violations reject the whole change
- SRS_AND_BUILD_GUIDE.md, only the sections named in the task block

WHAT A MODULE INCREMENT IS
One coherent business area containing all related user actions needed to make it usable,
built through every layer. Connect each internal path domain -> application -> database ->
API -> Vue before starting the next path. Run focused tests while building. When the whole
module is ready, run full regression once and perform the pre-written scenario in the real UI.
If the module cannot be completed in 3-5 working days, propose two cohesive increments.

NON-NEGOTIABLE RULES:
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
8. Add only risk-based tests required by R-E. Never skip, disable or weaken an existing test.
   Assert exact expected business numbers. Run focused tests during work and full regression
   once when the module is complete.
9. Do not modify anything outside the ALLOWED FILES list. If you believe you must, STOP and report.
10. Do not change any requirement or decision. If one seems wrong or contradictory, STOP and
    report it - do not improvise a fix.

SIMPLICITY IS MANDATORY
Choose the simplest implementation that satisfies the requirements. Before adding any
abstraction, pattern, helper, config option or dependency, ask: is it required by the SRS?
does it solve a real current problem? does something existing already solve it? can it be
done more simply? does it have a real second use case today? If no - do not add it.
No BaseRepository, GenericRepository, RepositoryFactory, generic CRUD, manager classes,
event buses, single-implementation strategies or interfaces, factories, or plugin systems.
Never use SOLID, DRY, KISS or YAGNI to override a finalized business requirement.

BEFORE YOU CODE: write a short plan (files to add/change, migration, API, UI, tests) and wait
for approval if the task block says PLAN FIRST.

WHEN DONE, report in exactly this format:
## Module increment / ## Acceptance criteria and the numbers I verified / ## Assumptions /
## Files changed / ## Files intentionally NOT touched / ## Database (PostgreSQL migration) /
## UI (route, screen, what the owner should click) / ## Tests (paste the real runner output) /
## Not implemented / ## Risks I noticed
```

### Agent-specific wrappers

**Claude Code** — prepend:

```
Work autonomously but incrementally. State your plan first, then implement the full module
through every layer. Run focused tests while building. At the module gate run
`pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test` and paste the real output.
Do not mark the module complete if any gate fails or if its UI workflow is missing.
If you disagree with the spec, say so instead of improvising.
```

**Codex / IDE agent** — prepend:

```
Implement only the files listed. Follow the existing file next to each new file as a style
template. Do not reorganise folders. Do not add libraries. After each file, show a diff summary.
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

Do not write code. List the problems only.
```

The agent that wrote the bug cannot catch it — its own tests will agree with its own mistake. A different model sees different things. This is the cheapest defence available.

---

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

Do NOT create adapter-sqlite-wasm, apps/mcp or apps/web in this slice. There is no apps/desktop -
Tauri is rejected (D-20); offline runs inside the PWA on SQLite WASM + OPFS (D-23).

BOUNDARY CHECK (tools/boundaries)
Write `pnpm test:boundaries` that FAILS the build if:
- core-domain imports @nestjs/*, drizzle-orm, pg, better-sqlite3, express, or DOM libs
- core-domain or core-application imports a Node built-in (fs, path, crypto, os, child_process)
  - these packages are bundled for the browser in Phase 12 (D-20/D-23), so Node APIs are banned now
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
pnpm install && pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test all pass,
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

> Run `pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test` and paste the real output with pass/fail counts. If any command fails, the task is not complete.

**Never say** "make sure tests pass" — that is what an agent says back when it has not run them.

| Agent says | You say |
|---|---|
| "I need to install library X" | "No. How do you do it without a new dependency?" |
| "I improved the business rule to…" | "Stop. Decisions are final in SRS_AND_BUILD_GUIDE.md. Revert it." |
| "Tests should pass now" | "Paste the actual output." |
| "I also refactored some other files" | "Revert everything outside the ALLOWED FILES list." |
| "I'll add the UI after this module" | "Then the module isn't complete. Finish its real workflow." |
| "I added a base class to reduce duplication" | "Remove it. Show me the two real call sites first." |
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
