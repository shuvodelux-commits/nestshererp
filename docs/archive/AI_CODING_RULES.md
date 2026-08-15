# AI Coding Rules — Binding

**Status:** BINDING. A change that violates any R-rule is rejected in full, regardless of how much of it works.

These rules exist because SherERP is built almost entirely by AI coding agents for a product owner who is not a programmer. The owner cannot reliably spot an architectural violation by reading a diff. Therefore **the rules are enforced by CI, not by review.** If CI cannot check a rule, the rule is written so a human can check it in under one minute.

---

## R-A — Scope

| # | Rule |
|---|---|
| A1 | Implement **only** the slice described in the task block. |
| A2 | Do not modify files outside the task block's ALLOWED FILES list. If you must, **STOP and report**. |
| A3 | Do not add npm dependencies. If one is genuinely required, STOP and report with the reason and two alternatives. |
| A4 | Do not reorganise folders, rename packages, or "clean up" adjacent code. |
| A5 | Do not change any requirement or decision. If a spec appears wrong or contradictory, **STOP and report** — do not improvise a fix. |
| A6 | Do not build for imagined future needs. No plugin systems, no generic frameworks, no abstraction with one implementation. |

> **Why A5 matters most.** An agent that silently "corrects" a business rule produces software that passes its own tests and computes wrong money. This is the single most dangerous failure mode in this project.

---

## R-B — Layering (CI-enforced)

| # | Rule |
|---|---|
| B1 | Business logic lives in `packages/core-domain` and `packages/core-application`. Never in controllers, Vue components, SQL, or database triggers. |
| B2 | `core-domain` imports **only** `shared-utils` and `zod`. No `@nestjs/*`, no Drizzle, no `pg`, no SQLite, no `express`, no DOM types, no `Date.now()`. |
| B3 | `core-application` may import `core-domain`, `core-contracts`, `shared-utils`. No raw SQL, no framework decorators, no Drizzle types. |
| B4 | Repository **interfaces** live in `core-application`. Implementations live in `adapter-postgres`. Interfaces never expose Drizzle types. |
| B5 | A controller in `apps/api` is **≤ 20 lines**: validate DTO → build command → call use case → map result. Nothing else. |
| B6 | Repositories do not perform business calculations. No costing, no balance derivation, no validation of business meaning. |
| B7 | Do not create `BaseRepository`, `GenericRepository`, `RepositoryFactory` or similar. Business-specific interfaces only (D-14). |

**CI gate:** `pnpm test:boundaries` fails the build on any violation of B2–B4.

---

## R-C — Data (CI-enforced where possible)

| # | Rule |
|---|---|
| C1 | All primary keys are **ULIDs generated in application code**. No autoincrement, no DB-generated IDs. |
| C2 | All money is **integer minor units** via `Money`. All quantities are **scaled integers** via `Qty`. |
| C3 | **Floating-point arithmetic on money or stock is forbidden.** No `+ - * /` on raw numbers representing money or quantity — use the helpers. |
| C4 | Every table has `tenant_id`. Every query is tenant-scoped. `tenant_id` is read from `TenantContext`, **never from a request body, query string, or URL parameter**. |
| C5 | Every table has `created_at`, `updated_at`, `created_by`, `updated_by`, and `version` (optimistic lock). |
| C6 | Never hard-delete a posted financial or stock record. Void/reverse + soft delete only (D-03). |
| C7 | Movements and journal lines are **append-only**. Corrections are new rows, never `UPDATE`. |
| C8 | Time is injected via the `Clock` port. `new Date()` and `Date.now()` are banned outside the Clock implementation. |

**CI gate:** lint rule bans float arithmetic on `Money`/`Qty` types and bans `Date.now()` outside `shared-utils`.

---

## R-D — Write Path

Every mutating use case follows this order, inside **one** database transaction:

```
1. Resolve TenantContext
2. Permission check
3. Idempotency check (operation_id)
4. Period lock check (if the document carries a business date)
5. Load aggregates
6. Domain invariants
7. Persist changes
8. Post journal + stock movements
9. Write audit event
10. Commit
```

| # | Rule |
|---|---|
| D1 | All ten steps or the change is rejected. No partial write paths. |
| D2 | Permission check happens in `core-application`, not only in a controller guard. |
| D3 | Every mutation accepts `operation_id` and is idempotent — a repeat returns the original result, it does not create a second record. |
| D4 | Every mutation writes an audit event with before/after values for money and stock fields. |
| D5 | No business operation spans two transactions. If it seems to need to, STOP and report. |

---

## R-E — Tests

| # | Rule |
|---|---|
| E1 | Tests ship **in the same change** as the code. A change with no tests is incomplete. |
| E2 | Never skip, disable, weaken, or delete an existing test. No `.skip`, no `.only`, no commented assertions. |
| E3 | Any change touching money or stock must run the **golden invariants** (`INV-01..INV-10`) and they must pass. |
| E4 | Domain tests are pure and fast — no database, no HTTP. |
| E5 | Every use case has at least one cross-tenant isolation test proving tenant B cannot read or write tenant A's row. |
| E6 | Every mutation has an idempotency test: same `operation_id` twice ⇒ one record. |
| E7 | Assert **exact expected numbers** written in the spec, not "greater than zero" or snapshot output. |

---

## R-F — Reporting Back

When finished, report in exactly this format. Do not narrate outside it.

```
## Slice
## Assumptions
## Files changed
## Files intentionally NOT touched
## Database (V1 PostgreSQL migration)
## Tests (paste the real runner output)
## Not implemented
## Risks I noticed
```

| # | Rule |
|---|---|
| F1 | Paste **real** test runner output. Never describe, summarise, or fabricate results. |
| F2 | If any of `lint`, `typecheck`, `test:boundaries`, `test` fails, the task is **not complete**. Say so. |
| F3 | State every assumption you made. An unstated assumption in an accounting system becomes a wrong number nobody can trace. |
| F4 | Report risks you noticed even if outside your slice. |

---

## R-G — Forbidden Patterns

These appear constantly in AI-generated NestJS code and are all rejected here:

| Pattern | Why rejected |
|---|---|
| Business logic in a NestJS service with Drizzle calls inline | Kills the offline requirement silently (R-03) |
| `any` to escape a type error | Hides real bugs in money handling |
| `parseFloat` / `Number()` on money strings | Guaranteed cent drift (R-05) |
| Catch-and-log-and-continue | Half-written financial transactions |
| `SELECT *` in a repository | Breaks silently on schema change |
| Raw SQL string concatenation | Injection + tenant leak (R-08) |
| A migration that drops or renames a column | Forward-only migrations only |
| `if (isOnPrem)` outside the three provider implementations | Starts the fork (R-25) |
| Auto-generated CRUD for every entity | Most entities are not CRUD; posting rules matter |
| Adding a "just in case" config flag | Untested code path that rots |

---

## R-H — When to Stop

**STOP and report instead of proceeding** when:

1. The spec contradicts another document.
2. The spec is silent on something that changes a stored number.
3. You need a file outside ALLOWED FILES.
4. You need a new dependency.
5. A test fails and the fix would require changing the test's expected number.
6. You are about to write the same business rule in a second place.
7. You cannot satisfy the rule set without an exception.

Stopping is always correct. A half-correct accounting system is worse than an unfinished one.

---

## Owner Checklist (60 seconds, no programming knowledge needed)

Before accepting any AI-produced change:

- [ ] Did it paste **real** test output, with counts, and did everything pass?
- [ ] Does the "Files changed" list match what the task asked for — nothing extra?
- [ ] Is "Files intentionally NOT touched" filled in, not empty?
- [ ] Are there any new packages in `package.json` that you did not approve?
- [ ] Did it flag any assumption? If "none", be suspicious — there are always assumptions.
- [ ] Did you run the manual scenario from the module spec and get the **exact numbers** written there?

> The last box is the one that matters. Automated tests written by the same agent that wrote the bug will agree with the bug. Your manual scenario with pre-written expected numbers is the only independent check (R-19).
