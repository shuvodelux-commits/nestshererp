# Phase 0 — Start Here

This is the first thing you paste into a coding agent. Nothing before it.

Phase 0 builds **no business features**. It builds the skeleton that makes every later phase safe: the packages, the boundary checks, the money types, and the tenant context. If Phase 0 is wrong, every module built on it inherits the fault.

**Expected duration:** the longest phase relative to visible output. Do not rush it and do not skip the CI gates — they are the only thing standing between you and an unmaintainable codebase.

---

## Before You Start

Install: Node 20 LTS, pnpm 9, Docker Desktop, PostgreSQL 16 (via Docker), Git.

Create the repo and commit these planning docs into `docs/` first. The agent reads them from there.

```
shererp/
└── docs/          ← all the .md files from this folder
```

---

## Prompt 0.1 — Monorepo Skeleton

> Paste `00_PROMPT_KERNEL.md` KERNEL block first, then this.

```
TASK: Phase 0, Slice 1 — monorepo skeleton and CI boundary enforcement.

PLAN FIRST. Show me the file list before writing code.

GOAL
Create the pnpm workspace, the six packages, the api app, and the CI checks that
enforce layering. NO business logic. NO database tables yet.

ALLOWED FILES
package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore,
.github/workflows/ci.yml, eslint.config.js,
packages/core-domain/**, packages/core-application/**, packages/core-contracts/**,
packages/shared-utils/**, packages/adapter-postgres/**,
apps/api/**, tools/boundaries/**

REQUIRED STRUCTURE (from docs/02_ARCHITECTURE_PLAN.md §2)
packages/core-domain        pure TS, imports only shared-utils + zod
packages/core-application   use cases + repository interfaces (ports)
packages/core-contracts     zod schemas, DTOs, error codes
packages/shared-utils       Money, Qty, Ulid, Clock
packages/adapter-postgres   Drizzle implementations (empty for now)
apps/api                    NestJS, /health only

BOUNDARY CHECK (tools/boundaries)
Write a script `pnpm test:boundaries` that FAILS the build if:
- core-domain imports @nestjs/*, drizzle-orm, pg, better-sqlite3, express, or DOM libs
- core-application imports drizzle-orm, pg, or @nestjs/*
- adapter-postgres is imported by core-domain or core-application
- any file outside shared-utils/clock uses Date.now() or new Date()
Use dependency-cruiser or a simple AST scan. Do not add a heavy framework for this.

CI (.github/workflows/ci.yml)
Run in order: lint, typecheck, test:boundaries, test. All must pass.

TESTS
- One test proving the boundary checker CATCHES a violation
  (add a deliberately bad fixture file under tools/boundaries/__fixtures__)
- One test proving it PASSES on the real source

DEFINITION OF DONE
- pnpm install && pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test all pass
- GET /health returns 200
- Paste the real output of all four commands
```

**Why the boundary checker comes first.** It is the only mechanical defence against R-03, the risk that quietly makes the offline requirement unachievable. Building it before any business code means it can never be "added later" — the point at which it would already be too late.

---

## Prompt 0.2 — Money, Quantity, ULID, Clock

```
TASK: Phase 0, Slice 2 — shared-utils primitives.

READ FIRST: docs/04_DATABASE_ARCHITECTURE.md §3, docs/OPEN_DECISIONS.md D-29, D-31

ALLOWED FILES
packages/shared-utils/**

IMPLEMENT
1. Money   — integer minor units, scale 2. add, subtract, multiply(qty), allocate(ratios),
             compare, isZero, isNegative, format. Half-up rounding, applied ONCE.
2. Qty     — scaled integer, scale 3. Same operation set.
3. UnitCost— scaled integer, scale 4 (see D-31 rationale).
4. Ulid    — generate(), isValid(), monotonic within a process.
5. Clock   — interface { now(): Date; businessDate(tz: string): string }
             SystemClock + FixedClock (for tests).

RULES
- No floating point ANYWHERE. No parseFloat. No Number() on money strings.
- Money.multiply(Qty) must not lose precision: compute at scale 4, round once at the end.
- allocate() uses the LARGEST REMAINDER METHOD, tie-broken by line index ascending
  (see docs/OPEN_DECISIONS.md D-31 "Allocation algorithm"). Parts must ALWAYS sum
  exactly to the whole, and the split must be deterministic — identical result on
  server and browser for identical input.
- businessDate() converts a UTC instant to a tenant-local YYYY-MM-DD (D-29).

TESTS (exact expected values, not approximations)
- Money(125075).format() === "1,250.75"
- Money(100).multiply(Qty(3333)) with scale-3 qty → assert the exact minor value
- allocate(Money(1000), [1,1,1])  → [334, 333, 333]   sums to 1000
- allocate(Money(1), [1,1,1])     → [1, 0, 0]         sums to 1
- allocate(Money(100), [3,1])     → [75, 25]          sums to 100
- allocate(Money(10), [1,1,1,1,1,1,1]) → [2,2,2,1,1,1,1]  sums to 10
- Property test: for ANY total and ANY weights, Σ parts === total, exactly
- Determinism test: same input called 100 times → identical output every time
- businessDate for 2026-08-15T18:30:00Z in Asia/Dhaka === "2026-08-16"
- Property test: for random a,b — a.add(b).subtract(b).equals(a)

DEFINITION OF DONE
- 100% branch coverage on Money and Qty. These are the two files where a bug
  corrupts every number in the system.
- Paste real test output.
```

The `allocate` remainder test is the one to check personally. Allocation that does not sum exactly to the whole is how landed cost and discounts silently leak a poisha per document until inventory valuation stops tying to the ledger.

---

## Prompt 0.3 — Tenant Context, Audit, Idempotency, Period Guard

```
TASK: Phase 0, Slice 3 — cross-cutting ports and the canonical write path.

READ FIRST: docs/AI_CODING_RULES.md R-D, docs/07_PERMISSION_ARCHITECTURE.md,
            docs/04_DATABASE_ARCHITECTURE.md §2 §4, docs/OPEN_DECISIONS.md D-25

ALLOWED FILES
packages/core-application/**, packages/core-contracts/**,
packages/adapter-postgres/**, apps/api/**, migrations/**

IMPLEMENT (interfaces in core-application, implementations in adapter-postgres)
- TenantContext        resolved from JWT, NEVER from request body
- AccessControl        require(ctx, permissionCode)
- PeriodGuard          assertOpen(ctx, businessDate)  → PERIOD_LOCKED
- AuditWriter          append-only, before/after for money and stock fields
- IdempotencyStore     operation_id based, 30-day retention
- UnitOfWork           ONE transaction per use case
- NumberingService     {PREFIX}-{YYYY}-{NNNNNN}, SELECT FOR UPDATE on counter (D-30)

MIGRATIONS
tenants, users, roles, role_permissions, audit_events,
idempotency_keys, numbering_counters, period_locks
All with: id CHAR(26), tenant_id, created_at, updated_at, created_by, updated_by, version
Enable PostgreSQL RLS on every tenant-scoped table.

REFERENCE USE CASE
Build ONE dummy use case (CreateNoteService) that exercises all ten steps of the
write path in docs/AI_CODING_RULES.md R-D. This is the golden template every
later module copies. Make it exemplary.

TESTS
- Cross-tenant: tenant B cannot read/write tenant A's note → 404
- RLS: a raw query without tenant scoping returns zero rows for the wrong tenant
- Idempotency: same operation_id twice → ONE record, same response
- Period lock: write into a locked month → PERIOD_LOCKED
- Numbering: 50 concurrent allocations → 50 unique sequential numbers, no gaps
- Audit: every mutation wrote an event with before/after

DEFINITION OF DONE
- All tests pass, real output pasted
- The dummy use case is documented as THE template for all modules
```

The concurrent numbering test is worth running twice. Duplicate invoice numbers are the kind of defect discovered by a customer, not by you.

---

## Phase 0 Exit Checklist

Do not start Phase 1 until every box is ticked.

- [ ] `pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test` all green
- [ ] Boundary checker **proven** to catch a violation (fixture test passes)
- [ ] Money `allocate()` sums exactly, verified by you personally
- [ ] `businessDate()` correct for the Dhaka midnight case (D-29)
- [ ] Cross-tenant test returns **404**, not 403
- [ ] RLS active — verified by a raw query test
- [ ] 50 concurrent document numbers: unique, no gaps
- [ ] Idempotency: duplicate `operation_id` creates one record
- [ ] Reference use case implements all 10 write-path steps
- [ ] CI runs on every push and blocks merge on failure

---

## Then Phase 1

Phase 1 is Tenant, Auth, Users, Roles, Settings, Audit — **plus** the deployment-mode providers (D-21/22/23/24) from `11_DEPLOYMENT_STRATEGY.md`. Build both SaaS and on-premise modes from the start; retrofitting them after M02 ships is surgery on live authentication.

---

## How to Work With the Agent

**One slice per conversation.** Do not ask for Phase 0 in a single prompt. Three prompts, three reviews.

**Always require PLAN FIRST on anything touching money, stock, or the write path.** Read the plan. If the file list looks wrong, stop there — it is far cheaper than reviewing the code.

**Never accept "tests should pass."** Require pasted runner output with counts. This is R-19, rated the top-tier risk in your register: the owner silently accepting wrong AI work.

**When the agent says it needs a new library, say no by default.** Ask what it would take to do it without one. The answer is usually "twenty lines."

**When the agent proposes improving a requirement, stop it.** All decisions are final in `OPEN_DECISIONS.md`. An agent that redesigns a business rule produces software that passes its own tests and computes wrong money.
