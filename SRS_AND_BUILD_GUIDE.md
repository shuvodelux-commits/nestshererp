# SherERP — SRS & Build Guide

**Single source of truth for requirements, decisions, architecture and build order.**
Supersedes SRS v3.0 and the entire former `docs/` planning package (archived under `docs/archive/`, do not read).

Companion files: `AI_CODING_INSTRUCTIONS.md` (how to write code), `AGENTS.md` (repo orientation). Nothing else.

**Rule for this document:** decisions here are final. An agent hitting a case not covered here **stops and reports** — it never improvises a business rule.

---

# PART 1 — PRODUCT

## 1.1 What SherERP is

Multi-tenant SaaS ERP for Bangladeshi SME retail/wholesale: POS, inventory with lots and costing, purchasing, parties, ledgers, cash/bank, expenses, returns, warranty, reports, audit. Sold as SaaS and as on-premise (one build, config-selected).

**Governing principle:** maximum legitimate business freedom, while security, tenant isolation, accounting correctness, inventory correctness, auditability, API quality, performance and reliability remain mandatory.

## 1.2 Delivery sequence

```
Online (PostgreSQL)  →  full browser offline (SQLite WASM + OPFS, single writer)  →  MCP
```

V1 is **online-first**. Full offline is a later phase, but every V1 schema and layering decision is made so it stays possible.

**Tauri is rejected (D-20).** Offline is delivered inside the PWA itself — SQLite WASM over OPFS, running the same domain and application code compiled to run in the browser. There is no desktop shell, no local Node/NestJS sidecar, and no second runtime to package or update.

## 1.3 Stack (final)

| Layer | V1 |
|---|---|
| Frontend | Vue 3 + Vite + TypeScript, installable PWA (D-21, D-28) |
| Backend | NestJS + TypeScript, modular monolith |
| ORM | Drizzle (D-14) |
| Database | PostgreSQL 16 |
| API | REST + OpenAPI 3.1, zod-generated |
| Offline storage | **SQLite WASM + OPFS** in the browser, via the same repository interfaces (D-23). Requires PWA install + `navigator.storage.persist()` before any local write (D-24) |
| Offline write authority | Single writer per tenant, bound to a registered browser profile (D-01) |
| Receipt printing | WebUSB ESC-POS primary, browser print dialog fallback (D-22) |
| Mobile | PWA. React Native deferred and likely dropped (D-28) |
| Rejected | Tauri desktop shell and local Node/NestJS sidecar (D-20) · T3 stack (D-21) |
| AI | MCP over the same application services (later phase) |

Do not substitute any of these.

---

# PART 2 — ARCHITECTURE

## 2.1 Repository layout

```
shererp/
├── packages/
│   ├── core-domain/         PURE TS. Entities, invariants, costing strategies, posting rules
│   ├── core-application/    Use cases, ports (repository interfaces), permission checks, audit emission
│   ├── core-contracts/      zod schemas, DTOs, error codes, OpenAPI types
│   ├── adapter-postgres/    Drizzle + PostgreSQL repository implementations (V1)
│   └── shared-utils/        Money, Qty, UnitCost, Ulid, Clock, rounding, allocation
├── apps/
│   ├── api/                 NestJS: HTTP, guards, DI wiring, OpenAPI, jobs
│   └── web/                 Vue 3 + Vite SPA/PWA
└── docs/archive/            Historical planning docs. DO NOT READ.
```

**Created later, in their own phase, not now:** `packages/adapter-sqlite-wasm` (Phase 12 — SQLite WASM over OPFS, loaded inside `apps/web`) and `apps/mcp` (Phase 14). Creating empty packages ahead of time is speculative scaffolding — the layering that makes them possible is what matters, not the folders.

**There is no `apps/desktop`.** Tauri is rejected (D-20); the offline adapter is a browser-side package consumed by `apps/web`, which means `core-domain` and `core-application` must stay free of Node built-ins (`fs`, `path`, `crypto`) as well as of NestJS and Drizzle — they will be bundled for the browser. The boundary checker enforces this from Phase 0.

**Dependency rule, one direction only, CI-enforced:**

```
web        → contracts
api        → application → domain → shared-utils
mcp        → application
adapter-*  → application
```

`core-domain` imports **only** `shared-utils` and `zod`.

## 2.2 Layer responsibilities

| Layer | Contains | Must NOT contain |
|---|---|---|
| `core-domain` | Entities, invariants, costing strategies, ledger posting rules, document state machines | SQL, HTTP, NestJS, `Date.now()` (clock injected) |
| `core-application` | One class per use case, `UnitOfWork` transaction boundary, permission check, audit emission, idempotency, repository **interfaces** | Raw SQL, framework decorators, Drizzle types |
| `adapter-postgres` | Repository/UnitOfWork implementations, dialect specifics, locking | Business rules, validation of business meaning |
| `apps/api` | Controllers (≤20 lines), guards, DTO→command mapping, OpenAPI, error mapping | Business rules |

Repository interfaces are **business-specific** (`SaleRepository`, `InventoryRepository`). No `BaseRepository`, `GenericRepository`, or `RepositoryFactory`.

## 2.3 Canonical write path

Identical online, offline, and via MCP:

```
Client (Web online / Web offline (SQLite WASM) / MCP)
  → command + operation_id + tenant/user context
  → Application Service
       1  resolve TenantContext
       2  permission check (entitlement → feature → setting → permission → access)
       3  idempotency check (operation_id)
       4  PeriodGuard.assertOpen(business_date)
       5  load aggregates
       6  domain invariants
       7  persist changes
       8  post journal + stock movements
       9  write audit event
      10  commit
  → ONE database transaction. All ten steps or reject.
```

Every financial/inventory command writes, in one transaction: the document, its stock movements, its journal lines, the audit event, and the outbox record.

**On the outbox.** Nothing reads `outbox` until Phase 12. It is written from Phase 0 anyway, deliberately: it is the explicit future-compatibility exception to YAGNI (`AI_CODING_INSTRUCTIONS.md` §YAGNI), because a sync engine built later against a partial change history cannot reconstruct what it missed. **An agent must not remove outbox writes as unused code.**

## 2.4 Posting kernel

```
Business Document (Sale / Purchase / Payment / Expense / Return / Adjustment)
   ├─► Stock Movements   (append-only, signed qty, lot-linked)
   ├─► Journal Entry     (balanced: Σ debit = Σ credit, internal)
   │      └─► Party ledger / Cash / Bank / Expense views are PROJECTIONS of journal lines
   └─► Audit Event
```

- Internal accounts are system-managed: `AR`, `AP`, `CASH:{id}`, `BANK:{id}`, `INVENTORY`, `COGS`, `SALES`, `EXPENSE:{cat}`, `VENDOR_PAYABLE`, `CUSTOMER_ADVANCE`, `WARRANTY_EXPENSE`, `CASH_SHORT_OVER`, `OWNER_CURRENT_ACCOUNT`, `ROUNDING`, `OPENING_EQUITY`. This list is closed — an agent needing an account not on it must **stop and report**, because a new account changes what every report means.
- **`CASH:{id}` is per cash account, not a single account.** A tenant has at least one (the drawer) and may add others (a safe, a second counter). This is why cash leaving the drawer always has a named destination (§5.16) rather than disappearing into an adjustment.
- `CASH_SHORT_OVER` is a P&L account: a drawer shortage debits it, an overage credits it. Its balance over time is the signal that a drawer or a person has a problem.
- `OWNER_CURRENT_ACCOUNT` is signed both ways — credit balance = the business owes the owner, debit balance = the owner owes the business. Journal lines carry `party_id` so an owner statement is still produced without splitting it into two accounts.
- **The user never sees a chart of accounts.** Ledgers and terminology (Debit/Credit, Cash In/Out, পাবো/দিব) are display mappings over the same signed journal lines. Changing a label never changes accounting semantics.
- Balances (`party_balance`, `stock_balance`, `account_balance`) are **derived, recomputable** tables, never the source of truth. A nightly + on-demand `verify` job recomputes and reports drift.

## 2.5 Freedom with integrity

| Authorized action | Implementation | Guarantee |
|---|---|---|
| Edit posted document | New version: reverse original postings + post new ones, same doc id, `version+1` | Old numbers reproducible |
| Delete posted document | Void (reverse) + soft delete. Hard delete only if never posted | No orphan money |
| Change transaction date | Allowed in an open period; `business_date` changes, `created_at` immutable; flags `BACKDATED` / `LATE_ENTRY` | Reports by business date, audit by created date |
| Correct / reverse / cancel | Explicit reversal documents linked by `reverses_document_id` | Full trail |
| Backdate into a closed period | Requires `finance.period.unlock` + step-up auth + mandatory reason; raises reconciliation review flag | No silent rewrite |

## 2.6 Rejected architectures

| Rejected | Reason |
|---|---|
| Microservices | Distributed transactions across stock + ledger + cash; no ops capacity |
| Event sourcing as primary store | Maintainability under AI agents; append-only movements + audit give most of the benefit |
| CRDT sync | Business documents need domain-aware conflict handling, not automatic merge |
| Logical DB replication PG↔SQLite | Bypasses all business rules, permissions and audit |
| Separate offline codebase | Two implementations of every rule |
| Separate on-premise fork | 31 modules maintained twice — project-ending |

## 2.7 Frontend conventions (UI/UX)

**Design goal:** a shopkeeper who uses Facebook and YouTube daily should recognise how to move around SherERP without training, while an experienced operator can run a counter on the keyboard alone. Where the two conflict, **the counter wins** — speed of data entry is a business requirement; familiarity is a means to adoption.

Rules are numbered `UI-nn` so a task block or a review can cite them. UI-14…UI-21 implement D-12; they do not change it.

### A. Familiarity — patterns, not appearance

| # | Rule |
|---|---|
| UI-01 | Borrow **interaction and navigation patterns** from the consumer apps users already know: persistent left sidebar, top bar with one global search, a bell for notifications, an avatar menu top-right, cards for summaries, paged lists, and a bottom bar or hamburger on small screens. |
| UI-02 | **Never copy their visual identity** — no imitation of the colours, logo, typeface or brand styling of Facebook, YouTube or any other product. SherERP has its own plain, professional look. This is a legal line as much as a design one. |
| UI-03 | **Component library: PrimeVue 4** (styled mode), self-hosted (D-37). No second UI library. |
| UI-04 | Icons come from one self-hosted set, and only for meanings a user already knows (search, bell, cart, print, filter, back, menu, user). An icon needing a legend gets a text label instead. |
| UI-05 | Every screen is understandable without a manual: visible labels, no icon-only primary actions, no hidden gestures, no hover-only affordances. |
| UI-06 | **All assets are self-hosted** — fonts, icons, images. §6.5 requires COOP/COEP for SQLite WASM in Phase 12; a CDN font breaks it. |
| UI-07 | The API base URL is read at runtime from `/config.json` (§6.5). `import.meta.env.VITE_API_URL` is banned — it forces a per-customer frontend build. |

### B. Shell and navigation

| # | Rule |
|---|---|
| UI-08 | One shell: left sidebar (modules) · top bar (global search, notifications, business date, cash-session state, avatar menu) · content area. POS runs full-screen without the sidebar. |
| UI-09 | Navigation is generated from the permission-filtered feature list, ordered entitlement → feature setting → permission (§5.21). **Never render a control that will 403.** |
| UI-10 | The sidebar is one level deep wherever possible; a second level only where a module genuinely has sub-areas. No third level. |
| UI-11 | Responsive navigation: sidebar on desktop, collapsible drawer on tablet, bottom bar with the 4–5 most-used destinations on phone. The same destinations, the same names, in the same order, on all three. |
| UI-12 | Global search in the top bar covers products, parties and documents, and is reachable by keyboard from anywhere. |
| UI-13 | Every screen has a route with a stable path and is reachable from navigation or from a parent record (R-S7). |

### C. Language — English UI, Bangla helper text (D-12)

| # | Rule |
|---|---|
| UI-14 | **The primary UI language is English.** Labels, buttons, menus, table headers and messages are English. The UI is not bilingual. |
| UI-15 | **Bangla helper text** sits beside or below an English label and explains the *business meaning* — a short natural sentence a shopkeeper would say, never a word-for-word translation. Example: `Due` → `যে টাকা কাস্টমারের কাছে এখনও পাওনা আছে`, not `বকেয়া`. |
| UI-16 | Bangla helper text is used **only where it removes real confusion**: accounting and inventory concepts (due, payable, COGS, valuation, lot, adjustment, void/reverse, period lock), consequential actions, and the first field of an unfamiliar flow. **Not** on obvious fields (Name, Phone, Address), not on every field, not on every screen. |
| UI-17 | Helper text is secondary in the visual hierarchy — smaller, muted — and never replaces the English label. |
| UI-18 | Every string, English and Bangla, is an i18n key from Phase 1 — `sales.invoice.due.label` and `sales.invoice.due.help_bn`. A helper key may be absent; that is the normal case. No hardcoded strings. |
| UI-19 | One helper string per business concept, reused everywhere. Two different Bangla explanations of "due" is a defect. |
| UI-20 | The same language approach applies identically to Web, POS and mobile layouts. **Printed documents follow D-12 and §5.24 instead** — invoices support full Bangla and English, which is a separate concern from UI helper text. |
| UI-21 | Terminology settings (§5.21) are display mappings — changing a label never changes accounting semantics, and no component branches on a label (§2.4). |

### D. The four screen patterns

| # | Rule |
|---|---|
| UI-22 | Every screen is one of: **List** (filter bar → table → paging), **Detail** (header facts → tabbed sections → actions), **Form** (single column, grouped fields, sticky save bar), **Dialog** (short confirmations, single-purpose input). A screen fitting none of the four is a design question — stop and ask. |
| UI-23 | Dashboard and summary figures use **cards**; transactional data uses **tables**. A card always carries the `Why?` drill-down where §5.20 requires one. |
| UI-24 | Lists use keyset pagination (§3.9), never offset. Lists that can exceed ~500 rows use virtual scroll. |
| UI-25 | Filters are visible on the screen, not hidden behind a menu, and the active filter set is readable at a glance. |
| UI-26 | Destructive or financial actions (void, reverse, unlock period) are explicit buttons opening a confirmation that names the document and the consequence, with Bangla helper text per UI-16. Never an inline toggle, never a swipe. |

### E. Four states, every screen

| # | Rule |
|---|---|
| UI-27 | Every screen implements **loading**, **empty**, **error** and **permission-denied** states. Tables use skeleton rows, not a bare spinner. |
| UI-28 | Errors show the server's error code and message plus a retry affordance. Never "Something went wrong", never a silent catch-and-log. |
| UI-29 | Empty states say what the screen would contain and link to the action that creates the first record. |
| UI-30 | Notifications are a bell with a list, not stacked toasts. A toast may confirm an action but is never the only record of it (UI-36). |

### F. Money, quantity, dates

| # | Rule |
|---|---|
| UI-31 | Money and quantity are **formatted by `shared-utils`**, never in a component. A component may not add, multiply, round or parse a monetary value (B8, R-C3). |
| UI-32 | Money is right-aligned, fixed 2 decimals, thousands-separated, `৳` where a currency mark is shown; negatives in parentheses **and** the negative colour — never colour alone. |
| UI-33 | Dates display the tenant-timezone business date (D-29). No screen renders a raw UTC instant. |

### G. Mutations and POS

| # | Rule |
|---|---|
| UI-34 | The client generates the `operation_id` (ULID) **once per user intent** and reuses it on retry — this is what makes R-D3 idempotency reachable from the UI. |
| UI-35 | Submit buttons disable while in flight; double-submit is impossible by construction, not by user discipline. |
| UI-36 | **No optimistic UI for anything touching money or stock.** The screen shows the server's result, and a successful mutation lands on the resulting document or a confirmation carrying its number. |
| UI-37 | POS is keyboard-first: the scan/search field holds focus by default and returns to it after every line. Every POS action has a keyboard shortcut; nothing requires a mouse. |
| UI-38 | Barcode input is treated as keyboard input terminated by Enter — no driver, no pairing. |
| UI-39 | Nothing blocks completing a sale — not a print failure (D-22), not a customer lookup, not an undismissable warning. Credit-limit excess warns only (D-11). |
| UI-40 | Cost is never rendered without `inventory.cost.view`, and the field must be **absent from the API response**, not hidden in CSS (§5.7, R-E8). |

### H. Devices and quality

| # | Rule |
|---|---|
| UI-41 | Back office targets desktop ≥1280px, usable at 1024px. POS and Daybook target tablet landscape. Phone is best-effort until Phase 13, but the navigation in UI-11 works from Phase 1. |
| UI-42 | Minimum accessibility: every input labelled, focus always visible, POS tap targets ≥40px, contrast ≥4.5:1. Full WCAG conformance is not claimed. |
| UI-43 | Zero console errors or warnings on an accepted screen (Gate 3). |
| UI-44 | Every slice's screen ships one component test: renders, shows loading, shows error. Business assertions stay in domain and integration tests, never in a component test. |

**Deliberately not decided here:** colour palette and logo · POS p95 performance numbers (open item O-5, Phase 6) · full Bangla UI (D-12, V1.1) · PWA install prompt and persistent-storage gate (D-24, Phase 12) · print stylesheets beyond D-22 and §5.27.

---

# PART 3 — DATA RULES

## 3.1 Identifiers

All primary keys are **ULIDs generated in application code**: `id CHAR(26) PRIMARY KEY`.

No autoincrement, no DB-generated IDs — an offline device must create valid IDs before reaching the server, and sequences do not survive sync. Never expose a sequential number as a public identifier.

## 3.2 Tenancy

Every business table has `tenant_id CHAR(26) NOT NULL`. **No exceptions, including single-tenant on-premise.**

1. `tenant_id` is resolved from `TenantContext` — never from a request body, query string, or URL.
2. Every index on a business table starts with `tenant_id`.
3. Every unique constraint includes `tenant_id`.
4. PostgreSQL **Row Level Security enabled** on all business tables as the net under the tightrope:

```sql
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales
  USING (tenant_id = current_setting('app.tenant_id')::char(26));
```

The API sets `app.tenant_id` at the start of every transaction. RLS is a second line of defence, not a substitute for scoped queries.

## 3.3 Money and quantity

| Concept | Storage | Scale | Example |
|---|---|---|---|
| Money | `BIGINT` | 2 (poisha) | ৳1,250.75 → `125075` |
| Quantity | `BIGINT` | 3 | 2.5 pcs → `2500` |
| Unit cost | `BIGINT` | 4 | ৳12.3456 → `123456` |

1. **No `FLOAT`, `REAL`, `DOUBLE` anywhere.** SQLite has no decimal type — float guarantees online/offline divergence.
2. `NUMERIC`/`DECIMAL` also banned — SQLite lacks it. Integers only.
3. All arithmetic goes through `Money` / `Qty` / `UnitCost` helpers in `shared-utils`.
4. Currency is BDT-only in V1. No per-row currency column yet.

**Unit cost carries 4 decimals** because FIFO consumption of fractional quantities against a 2-decimal cost accumulates error across thousands of movements until valuation no longer ties to the ledger.

### Rounding (D-31)

- Mode **half-up**, applied **once**, at the storage or display boundary. Never round intermediates.
- Line total = `round(qty × unit_price)`. Document total = **sum of already-rounded line totals** — the invoice must equal what the customer can add up by hand.

### Allocation algorithm (binding)

Splitting one amount across lines (landed cost, invoice discount, payment across dues, tax) uses the **largest remainder method**:

1. Each share = `floor(total × weight_i / Σweights)`.
2. Leftover = `total − Σ floor_shares`.
3. Distribute leftover **one minor unit at a time** to the largest fractional remainders.
4. **Tie-break by line index ascending.**

Guaranteed and CI-asserted: parts always sum exactly to the whole; the split is **deterministic** (identical on server, browser and future offline device); works when total < number of parts — `allocate(1, [1,1,1]) → [1,0,0]`.

Reference values: `allocate(1000,[1,1,1]) → [334,333,333]` · `allocate(100,[3,1]) → [75,25]` · `allocate(10,[1,1,1,1,1,1,1]) → [2,2,2,1,1,1,1]`.

## 3.4 Standard columns

Three table classes with different column sets. Applying the wrong set is a common and damaging mistake — an append-only table with `deleted_at` invites someone to soft-delete a journal line.

**Class A — mutable tables** (master data, documents, settings):

```sql
id          CHAR(26)     PRIMARY KEY,
tenant_id   CHAR(26)     NOT NULL,
created_at  TIMESTAMPTZ  NOT NULL,
updated_at  TIMESTAMPTZ  NOT NULL,
created_by  CHAR(26)     NOT NULL,
updated_by  CHAR(26)     NOT NULL,
version     INTEGER      NOT NULL DEFAULT 1,   -- optimistic lock
deleted_at  TIMESTAMPTZ  NULL,
deleted_by  CHAR(26)     NULL
```

**Class B — transactional documents** — Class A plus:

```sql
business_date  DATE      NOT NULL,   -- tenant-local date the transaction belongs to
entry_mode     TEXT      NOT NULL,   -- ON_TIME | LATE_ENTRY | BACKDATED | CORRECTED
status         TEXT      NOT NULL,   -- DRAFT | POSTED | VOIDED
operation_id   CHAR(26)  NOT NULL    -- idempotency key, UNIQUE (tenant_id, operation_id)
```

**Class C — append-only ledgers** (`stock_movements`, `journal_entries`, `journal_lines`, `audit_events`, `lot_consumptions`, `cost_adjustments`):

```sql
id          CHAR(26)     PRIMARY KEY,
tenant_id   CHAR(26)     NOT NULL,
created_at  TIMESTAMPTZ  NOT NULL,
created_by  CHAR(26)     NOT NULL
```

**No `updated_at`, `updated_by`, `version`, `deleted_at` or `deleted_by` on Class C** — these rows are never updated and never deleted, so those columns would be lies. Corrections are new rows referencing the original.

### entry_mode (binding rule)

Computed by the use case at write time from `business_date` versus the tenant-local date of `created_at`:

| Value | Condition |
|---|---|
| `ON_TIME` | `business_date` == today (tenant timezone) |
| `LATE_ENTRY` | `business_date` < today, **same calendar month**, period open |
| `BACKDATED` | `business_date` < today, **an earlier calendar month** |
| `CORRECTED` | Any document written as a correction or new version of an existing one, regardless of date |

`CORRECTED` wins over the others. A future `business_date` is rejected.

**Reserved-now columns** (adding these later would touch every transaction table): `location_id`, `tax_rate_id`, `tax_amount`, `is_tax_inclusive`, `pack_size`, `device_prefix`. Tax columns stay `NULL` in V1 (D-09 revised). `credit_limit` is a **party** column, not a transaction column.

## 3.5 Time and business date (D-29)

1. All timestamps stored `TIMESTAMPTZ` in **UTC**.
2. Each tenant has a timezone setting, default **`Asia/Dhaka`**.
3. `business_date` is a `DATE` computed in the **tenant's** timezone, and is what every report, ledger, Daybook view, and period lock uses.
4. `created_at` is audit only, never reporting.
5. Time is obtained through the injected `Clock` port. `new Date()` / `Date.now()` banned outside its implementation.

A sale at 00:30 Dhaka is 18:30 UTC the previous day. Getting this wrong moves a day's takings into the wrong report, and both numbers look plausible.

## 3.6 Soft delete and immutability

| Data class | Delete behaviour |
|---|---|
| Draft document | Hard delete permitted |
| Posted document | Void/reverse + `deleted_at`. **Never** hard-deleted |
| Stock movement | Append-only. Never updated, never deleted |
| Journal line | Append-only. Never updated, never deleted |
| Audit event | Append-only. No delete path exists in code |
| Master data (product, party) | Soft delete if referenced; hard delete only if never used |

Corrections create **new** rows referencing the original (`reverses_id`, `corrects_id`).

## 3.7 Document numbering (D-30)

Format `{PREFIX}-{YYYY}-{NNNNNN}`, e.g. `INV-2026-000123`.

- Sequence per `(tenant_id, doc_type, year)`, resetting annually.
- Allocated **inside** the document's transaction from a `numbering_counters` row held with `SELECT ... FOR UPDATE`. No gaps from concurrency, no duplicates.
- `device_prefix` column reserved, empty in V1. Future offline devices produce `INV-D2-2026-000123` with no schema change. Prefix is **mandatory** once offline write is enabled.
- **Voided numbers are never reused.** A gap is normal and auditable; reuse destroys the trail.
- Prefixes configurable per tenant; changing a prefix does not renumber history.

## 3.8 Concurrency (D-32)

| Scenario | Mechanism |
|---|---|
| Two users edit one document | Optimistic lock on `version` → `CONFLICT_STALE_VERSION` |
| Two sales consume the same lot | **Pessimistic** `SELECT ... FOR UPDATE`, lots ordered by `id` to avoid deadlock |
| Document number allocation | `SELECT ... FOR UPDATE` on the counter row |
| Cash session close during in-flight sale | Session state re-checked inside the same transaction |

Lot consumption **must** be pessimistic. Optimistic retry on stock produces oversell under POS load — a customer paying for goods not on the shelf.

## 3.9 Indexing and pagination

Every table carrying `business_date` (Class B and C — §3.4):

```sql
CREATE INDEX ON <table> (tenant_id, business_date DESC);
```

Every Class A and B table:

```sql
CREATE INDEX ON <table> (tenant_id, status) WHERE deleted_at IS NULL;   -- where status exists
```

Master data (products, parties) has neither `business_date` nor `status` transitions — index it on `(tenant_id, name)` and its lookup keys instead.

| Need | Index |
|---|---|
| POS product search | `pg_trgm` GIN on `(brand \|\| ' ' \|\| name)`, tenant-scoped |
| Barcode scan | unique `(tenant_id, barcode)` |
| Invoice lookup by phone | `(tenant_id, phone)` on parties |
| Ledger statement | `(tenant_id, party_id, business_date)` on journal_lines |
| Stock on hand | `(tenant_id, product_id, location_id, lot_id)` on movements |

Pagination is **keyset only**. `OFFSET` is banned — it degrades exactly as a shop's history grows.

## 3.10 Migrations

1. **Forward-only.** No down-migrations. Rollback is restore-from-backup.
2. **Additive by default.** Adding a nullable column is safe; dropping or renaming is not.
3. To remove a column: stop writing it → deploy → verify → drop in a later release.
4. Every migration runs inside a transaction.
5. Schema version stored in the DB; the application **refuses to start** if the DB schema is newer than the app.

## 3.11 Golden invariants (CI-enforced)

Asserted on every commit touching money or stock. A failure blocks the merge.

| ID | Invariant |
|---|---|
| INV-01 | Every journal entry sums to zero (Σ debit = Σ credit) |
| INV-02 | Stock on hand = Σ movements, per product/location/lot |
| INV-03 | No lot has negative remaining qty unless negative stock is enabled |
| INV-04 | Σ lot remaining qty = product on-hand qty per location |
| INV-05 | **Inventory valuation equals the `INVENTORY` account balance, computed method-aware (D-05):** under `FIFO`, valuation = Σ (lot remaining × lot `actual_unit_cost`); under `AVERAGE`, valuation = Σ (product qty on hand × `product_cost_state.avg_unit_cost`) and lots carry no independent value for reporting. **Both forms must equal the `INVENTORY` journal account balance to the poisha.** This is the invariant that catches a costing bug before it reaches a customer |
| INV-06 | Party ledger balance = Σ journal lines for that party |
| INV-07 | **(a)** For any session, `expected_closing = opening + Σ cash in − Σ cash out`. **(b)** For a *closed* session, the `CASH:{id}` account balance equals the **actual counted** cash — the short/over difference has been posted, so the ledger always agrees with the physical drawer. **(c)** Every difference between one session's actual closing cash and the next session's opening cash is explained by posted movements; no unexplained delta exists (§5.16) |
| INV-08 | Voided document has zero net effect on stock and journal |
| INV-09 | Every posted document has ≥ 1 journal entry |
| INV-10 | **Every monetary and quantity figure in a report is derived from journal lines or stock movements**, never recomputed from document fields. Descriptive dimensions used to group or label those figures — customer name, cashier, brand, category, payment method — are joined from documents and master data, which is expected and correct. The rule constrains *what the number is*, not *what it is labelled with* |

INV-10 prevents the classic ERP failure where the dashboard and the ledger disagree and nobody can say which is right. Test it by summing any report's monetary column and comparing to the equivalent journal query — they must match to the poisha.

---

# PART 4 — FINAL DECISIONS (D-01 … D-36)

All final. Not discussion points.

## 4.1 Product and business rules

| ID | Decision |
|---|---|
| **D-01** | **Offline write authority — REVISED 2026-08-16.** **Single writer per tenant, bound to a registered browser profile.** Exactly one browser profile holds `OFFLINE_RW`; every other profile and device is read-only offline. Authority is bound to the profile, not the machine — a different browser, a different OS user, or a cleared profile on the same PC is a **different** writer and must be re-registered. Transfer follows the device-authority state machine in §5.23 (drain → revoke → authorize → snapshot), always audited. IndexedDB is **not** the storage engine — see D-23. |
| **D-02** | **Customer phone.** Unique per `(tenant_id, phone)` **within the CUSTOMER role only** — POS searches invoices by phone. Other roles may share a number. Walk-in customer is a real, `system_reserved` record exempt from the constraint. |
| **D-03** | **Invoice deletion.** Posted invoices are reversed/voided with history retained; all related effects (stock, due, cash, expense) reverse. Draft invoices may be hard-deleted. |
| **D-04** | **Party system.** One internal `parties` table with role flags (CUSTOMER, SUPPLIER, VENDOR, EXPENSE, EMPLOYEE). UI shows separate Customer / Supplier / Vendor / Expense ledgers as **views over the same journal**. Selling to a supplier requires explicitly choosing the transaction type; the party then appears in both histories with full purchase and sale history. |
| **D-05** | **Costing method — REVISED 2026-08-16.** **One costing method per tenant: `FIFO` or `AVERAGE`.** It drives **both** the COGS posted to the journal **and** the valuation report, so the two can never disagree. **LIFO is removed from V1.** Physical issue order is always FIFO/FEFO (DR13.2) and is **not** configurable — the earlier "two independent settings" wording described a setting that had only one legal value and produced a valuation that drifted permanently from the INVENTORY account. See §3.11 INV-05 for the method-aware invariant. |
| **D-06** | **Profit reliability.** Profit is provisional while any unresolved provisional cost or open negative-stock lot exists in the range. Profit display is blocked/marked until costing is finalized. |
| **D-07** | **Authentication — REVISED 2026-08-16.** **OTP is for first-time verification and password recovery only, never for daily login.** Signup: one field accepting **mobile or email** → 6-digit OTP → verify → set username, password and PIN in the same flow. Daily login: **email + password**, **phone + password**, **PIN**, or **Google OAuth**. Forgot password: OTP to the registered email or phone → set a new password. OTP channel follows the identifier — email identifier sends email OTP, phone identifier sends SMS. Sensitive actions require step-up authentication. |
| **D-08** | **Backup restore.** Restore all compatible business data. Subscription and permissions always follow the current tenant/account. Data belonging to unavailable features is preserved but read-only until the required plan is activated. |
| **D-09** | **VAT/tax — REVISED 2026-08-16, owner override.** **VAT/tax is removed from V1.** The reserved columns (`tax_rate_id`, `tax_amount`, `is_tax_inclusive`) are still created on transaction lines and remain `NULL`; no tax is calculated, posted, or printed. Tax becomes a V2 feature. **Consequence to accept knowingly:** SherERP cannot issue a VAT-compliant invoice in V1, so a customer who requires one cannot be sold to until V2. This was chosen over implementing tax in Phase 6, which would have forced re-costing every lot created in Phase 5. |
| **D-10** | **Units.** V1 supports manual UOM conversion. Products may be purchased, stocked and sold in different units (Carton, Box, Piece, Pipe, Feet, Kg, Litre) with per-product conversion rules defined by the user, e.g. `1 Carton = 24 Pieces`, `1 Pipe = 20 Feet`. |
| **D-11** | **Credit limit.** Exceeding it shows a **warning only** — never blocks the sale. |
| **D-12** | **Language.** Default UI English with optional Bangla helper text; multilingual-ready from V1. Invoices and printed financial documents support Bangla and English from V1. Full Bangla UI may land in V1.1. |
| **D-13** | **Attachments.** Stored in online media storage, not inside `.sherdb`. DB stores metadata/references. Limits follow the subscription plan. Offline backup/sync excludes attachments; unavailable ones are clearly shown as online-only without affecting the related record. |
| **D-14** | **Repository architecture.** V1 = Drizzle + PostgreSQL. Business-specific repository interfaces from day one. Shared Domain/Application contains all business rules and imports no Drizzle/PostgreSQL/SQLite/NestJS. A future Drizzle + SQLite implementation must be addable without changing business logic. |
| **D-15** | **Backup encryption.** Customer-controlled backup password. Optional server-managed recovery, **OFF by default**, requires consent. Without either, the backup is permanently unrecoverable. |
| **D-16** | **Payment verification.** bKash and Nagad personal accounts, no merchant account. Customer submits Transaction ID; admin verifies manually. API-based auto-verification may be added later with manual as fallback. |
| **D-17** | **Inventory by location.** Quantity, lots, cost and valuation tracked by **Product + Location** from day one. V1 may expose a single auto-created default location; a single-warehouse business never creates one manually. Multiple warehouses each maintain their own stock. Inter-warehouse stock transfer is supported once multiple locations exist. |
| **D-18** | **Serial uniqueness.** The same **active** serial cannot be used for the same product within a tenant. After retirement it may be reused with a warning. |
| **D-19** | **Negative stock costing.** Negative-stock sales are allowed. Cost uses the product's last known cost as **provisional**; when actual cost arrives, affected COGS and profit are recalculated per the configured method. |
| **D-20** | **Tauri — REJECTED 2026-08-16.** No desktop shell, no local NestJS/Node sidecar, no Rust. Offline runs inside the PWA on SQLite WASM + OPFS (D-23). Reasons: a sidecar means packaging, signing, auto-update and a second runtime to support on shop PCs; the browser path reuses the same domain/application code with one deployment artefact. **Consequence to accept knowingly:** no OS-level integration (native printer drivers, filesystem paths, background service), and offline capacity is bounded by the browser storage quota — hence D-22 for printing and D-24 for eviction. |

## 4.2 Client platform, printing and offline storage (D-21 … D-24) — confirmed 2026-08-16

**These four IDs previously held the deployment-mode provider decisions.** Those are unchanged in substance and now live in §4.4 as **D-33 … D-36**. Any older document, prompt or agent transcript citing "D-21…D-24 providers" means D-33…D-36.

| ID | Decision |
|---|---|
| **D-21** | **Stack — Vue 3 + Vite PWA + NestJS.** One frontend artefact serves online and offline, SaaS and on-premise. **T3 (Next.js/tRPC/Prisma) is rejected:** it couples the client to a Node-rendered server and to a TypeScript-only RPC contract, which breaks the REST + OpenAPI contract (§2) the mobile PWA, on-prem installs and MCP all consume, and it has no path to running the domain layer inside the browser for offline. No SSR framework is introduced later without reopening this decision. |
| **D-22** | **Receipt printing — WebUSB ESC-POS primary, browser print dialog fallback.** Thermal receipts are driven directly over WebUSB with generated ESC-POS byte sequences, so a POS sale prints without an OS driver or a print dialog. **Fallback is mandatory, not optional:** any browser or device where WebUSB is unavailable, permission is refused, or the printer is not claimed must fall back to a styled HTML print dialog (80mm and A4 layouts) — printing must never be the reason a sale cannot be completed. Printer selection, vendor/product ID and the chosen path are stored per browser profile. A4 and business-pad documents always use the print dialog. Consequence of D-20: WebUSB works in Chromium browsers only; Firefox and iOS Safari get the fallback path. |
| **D-23** | **Offline storage engine — SQLite WASM + OPFS.** The offline database is SQLite compiled to WASM, persisted in the Origin Private File System, reached through the same business-specific repository interfaces as PostgreSQL (D-14). **IndexedDB is rejected as the engine** — it cannot express the relational integrity, transactional multi-table writes or the ten-step write path (§2.3) that stock and journal correctness depend on; it may be used only for small key/value client state. The OPFS handle must be opened in a worker with `SharedArrayBuffer`-capable COOP/COEP headers; the same no-`FLOAT`/no-`NUMERIC` integer rules (§3.3) apply to both dialects so online and offline can never diverge numerically. |
| **D-24** | **Eviction policy — PWA install + `navigator.storage.persist()` required before any offline write.** A browser may evict OPFS data under storage pressure without warning. Therefore the app **must not accept a single offline write** until the tenant's designated writer profile has (a) installed the PWA and (b) been granted persistent storage by `navigator.storage.persist()`. If persistence is refused or later revoked, the profile drops to read-only offline and the UI states plainly that offline writing is disabled — it never silently accepts writes into evictable storage. Before enabling offline the app checks `navigator.storage.estimate()` against the snapshot size and refuses if the quota is insufficient. Pending outbox depth and remaining quota are shown continuously, with a blocking warning once either crosses its threshold. |

**Why D-24 is a hard gate.** Every other risk in the offline design is recoverable through quarantine and replay. Evicted OPFS data that never reached the server is unrecoverable — the transactions simply cease to exist, and the shopkeeper's day is gone. Nothing in the offline path may be built before this gate works.

## 4.3 Implementation mechanics (D-25 … D-32, D-37 … D-38)

| ID | Decision |
|---|---|
| **D-25** | **Period lock is not a module.** It is a `PeriodGuard` service in `core-application`, configured through Settings, enforced inside every use case writing a `business_date`. Granularity: **calendar month per tenant**. States `OPEN` → `CLOSED`; a closed month rejects create/edit/void/backdate landing in it with `PERIOD_LOCKED`. Unlock requires `finance.period.unlock` **plus** step-up auth **plus** a mandatory reason, and writes an audit event. Re-costing true-ups **never** silently cross a closed period — they post in the current open month as a correction referencing the original. |
| **D-26** | **Invoice templates** are a saved set of line items (product, qty, optional price override) with a name. Not a document, no financial effect, no journal entry. Tables: `sale_templates`, `sale_template_lines`. Loading a template creates a **draft** sale; prices re-read live from the product unless an explicit override is stored. **Excluded from V1:** recurring/scheduled invoices, auto-send, subscription billing. |
| **D-27** | **Daybook is a real module (M32), Phase 9.** Read aggregator + action dispatcher. It owns no transactional tables and no edit logic. |
| **D-28** | **Mobile = PWA** for V1. React Native/Expo deferred and may be dropped. Accepted limits: no native barcode hardware (browser camera is adequate), no iOS push, and browser-storage eviction — the last of which is now governed by the hard gate in **D-24**, not merely accepted. |
| **D-29** | **Time and business date** — see §3.5. |
| **D-30** | **Document numbering** — see §3.7. |
| **D-31** | **Rounding and allocation** — see §3.3. |
| **D-32** | **Concurrency** — see §3.8. |
| **D-37** | **UI component library — PrimeVue 4, styled mode, self-hosted.** No CDN (COOP/COEP, §6.5), no second UI library. Chosen because an ERP is dense tables, forms and dialogs, and its DataTable ships lazy loading, virtual scroll, frozen columns and filters that Phases 3, 5, 6 and 9 would otherwise hand-write per screen. Rejected: **Vuetify** (Material look wrong for a shop counter, weaker data table) · **Tailwind + headless components** (every table and form becomes bespoke agent-written code, which is the code this project can least afford to review). |
| **D-38** | **UI/UX direction — familiar patterns, professional density.** Borrow navigation and interaction patterns from the consumer apps Bangladeshi users already know (sidebar, global search, notification bell, cards, lists, responsive bottom nav); **never** imitate their visual identity. Combine with ERP/POS needs: fast entry, tables, filters, keyboard operation, high information clarity. **English UI with selective Bangla helper text explaining business meaning, not literal translation** — implements D-12 and applies identically across Web, POS and mobile. Full rules in §2.7 (UI-01…UI-44). |

## 4.4 Deployment mode (D-33 … D-36) — Phase 1

**Renumbered 2026-08-16 from D-21 … D-24. The decisions themselves are unchanged.** Phase 1 slice 1.7 and M02 (§5.2) refer to this set.

**Governing rule: SaaS and on-premise are the same build.** Signup, OTP and subscription are disabled by configuration, never deleted. A separate on-premise fork is forbidden.

| ID | Was | Decision |
|---|---|---|
| **D-33** | D-21 | **Identity verification** is pluggable behind `IdentityVerifier`. `OtpIdentityVerifier` (SaaS, phone OTP) · `NoOpIdentityVerifier` (on-prem; installer seeds admin with forced password change). `sendOtp()` is called from exactly one place. No module outside M02 imports an SMS provider type. `NoOpIdentityVerifier` is **rejected at boot** if `SINGLE_TENANT_MODE=false`. |
| **D-34** | D-22 | **Tenant provisioning** is pluggable behind `TenantProvisioner`. `SignupTenantProvisioner` (SaaS) · `SeedTenantProvisioner` (on-prem, idempotent, refuses if a tenant exists, name/ID from the license key). When `SINGLE_TENANT_MODE=true`, registration routes return **404**, not 403. `tenant_id` remains on every table and in every query in both modes. |
| **D-35** | D-23 | **Entitlement source** is pluggable behind `EntitlementProvider`. `SubscriptionEntitlementProvider` (SaaS) · `LicenseKeyEntitlementProvider` (on-prem, signed key validated **offline** against an embedded public key, no phone-home). On-prem does **not** skip entitlement checks — it answers them from the license. `modules[]` in the license feeds the existing Settings module; no second feature-flag system. Missing/invalid license → `READ_ONLY`, never a crash, never data loss. |
| **D-36** | D-24 | **License term and expiry.** Contract-term based. States: `ACTIVE` → `EXPIRING` (30d before) → `GRACE` (30d after) → `READ_ONLY`; `RESTORED` on renewal with no data loss. **There is no state in which customer data is destroyed, hidden, or made un-exportable** — backup export works in every state including `READ_ONLY`. Sell license term separately from annual maintenance. |

### Configuration flags

| Flag | SaaS | On-premise |
|---|---|---|
| `SINGLE_TENANT_MODE` | `false` | `true` |
| `IDENTITY_VERIFIER` | `otp` | `none` |
| `ENTITLEMENT_SOURCE` | `subscription` | `license` |
| `LICENSE_KEY_PATH` | unset | `/etc/sher/license.key` |
| `SMS_PROVIDER` | provider id | `none` |
| `BILLING_ENABLED` | `true` | `false` |

**Boot-time validation is mandatory.** The app refuses to start on: `SINGLE_TENANT_MODE=false` + `IDENTITY_VERIFIER=none` · `ENTITLEMENT_SOURCE=license` with no readable license · `SINGLE_TENANT_MODE=true` + `BILLING_ENABLED=true`.

---

# PART 5 — MODULE REQUIREMENTS

32 modules. Cross-module rules in §5.0 apply to all and are not repeated per module.

## 5.0 Cross-module consistency rules

Every module supports, where applicable: search · filter · sort · add · edit · update · delete · audit · permissions · dashboard/view permission · `business_date` · `created_at` · export/print · API access · MCP readiness.

Financial and inventory integrity rules override generic CRUD freedom. Not every action applies to every entity.

**Opening balances** are required throughout: customers, suppliers, vendors, products/stock, cash, bank. Editable, with audit.

## 5.1 Module table

| # | Module | Hard depends on | Offline class |
|---|---|---|---|
| 01 | Business / Tenant Setup | — | Read + limited edit |
| 02 | Auth, Users, Roles, Permissions | 01 | Local login for cached users |
| 03 | Subscription & Entitlements | 01, 02 | Read-only (license) |
| 04 | Product & Catalog | 01, 02, 26 | Full |
| 05 | Customer | 01, 02 | Full |
| 06 | Supplier | 01, 02 | Full |
| 07 | Vendor / Consignment | 06, 03 | Full |
| 08 | Sales & POS | 04, 05, 12, 13, 19, posting kernel | Full |
| 09 | Sales Invoice & Payments | 08, 17, 19, 20 | Full |
| 10 | Purchase | 04, 06, 12, 13, 18, 19, 20 | Full |
| 11 | Purchase Orders | 10 | Full |
| 12 | Inventory & Stock | 04, posting kernel | Full |
| 13 | Inventory Lots & Costing | 12, 26 | Full |
| 14 | Landed Cost | 10, 13 | Full |
| 15 | Stock Reconciliation | 12, 13 | Full |
| 16 | Returns | 08, 09, 10, 12, 13, 17, 18 | Full |
| 17 | Customer Ledger | 05, posting kernel | Full |
| 18 | Vendor/Supplier Ledger | 06, 07, posting kernel | Full |
| 19 | Cash & POS Sessions | 02, posting kernel | Full |
| 20 | Bank Accounts | posting kernel | Full |
| 21 | Bank Reconciliation | 20, 27 | Deferred (online-first) |
| 22 | Expenses | 19, 20, party, posting kernel | Full |
| 23 | Warranty & Serial | 04, 08, 10, 16 | Full |
| 24 | Reports | all transactional | Full (local scope) |
| 25 | Dashboard | 24, 02 | Full |
| 26 | Settings & Feature Controls | 01, 02, 03 | Read + limited |
| 27 | Audit | 02 | Full (append-only) |
| 28 | Offline & Sync | all transactional | Future |
| 29 | Documents, Notifications, SMS | 08, 09, 03 | Print full; SMS online-only |
| 30 | SaaS, Multi-tenancy, Backup | 01, 02, 03, 27 | Local backup/restore only |
| 31 | Technical Quality, API, AI Readiness | cross-cutting | — |
| 32 | Daybook | 08,09,10,16,17,18,19,22,24,27 | Full (read-derived) |

**No true circular dependencies exist, provided Entitlement, Audit, Settings, Outbox and Posting are Phase-0 interfaces.** That is the single most important sequencing fact in this plan. Ledgers (17, 18) are read-model projections delivered with Purchase and Sales, not separate build steps.

## 5.2 M01 Business / Tenant Setup
Business profile: name, phone, address, currency, timezone (default `Asia/Dhaka`), status, identity, tenant configuration, business-level settings. Tenant data isolated.

## 5.3 M02 Auth, Users, Roles, Permissions
Login, logout, OTP, user/role/permission management, session and token handling, password security, session expiry, auth failure handling. Implements D-33/D-34/D-35/D-36 providers (renumbered from D-21…D-24).

**Tokens:** access 15 min (`sub`, `tenant_id`, `roles[]`, `session_id`); refresh 30 days, rotating, revocable, server-stored. **Permissions are not in the token** — resolved server-side per request so changes take effect immediately.

**Step-up** (fresh credential within 5 minutes, asserted in the use case, not a UI dialog): void/delete a posted document · unlock a closed period · change costing method · change financial terminology or accounting settings · export/restore a backup · create/disable/re-privilege a user · transfer offline write authority.

### Signup and login flows (D-07)

```
SIGNUP / FIRST LOGIN
  one field: mobile OR email
    → 6-digit OTP to that channel   (email identifier ⇒ email OTP, phone ⇒ SMS)
    → verify OTP
    → set username + password + PIN
    → tenant created, logged in

DAILY LOGIN                          FORGOT PASSWORD
  email + password                     enter email or phone
  phone + password                       → 6-digit OTP to that channel
  PIN (returning session, same device)   → verify
  Google OAuth                           → set new password
```

**OTP is never a daily-login method.** It verifies identity once at signup and again at password recovery. This keeps SMS cost proportional to new accounts and recovery events, not to daily usage.

**Identifier rules.** The single login field is classified as email or phone by format, and resolved against the user record; an unrecognised identifier returns the same generic failure as a wrong password, never "no such user". Phone uniqueness for *users* is per tenant and independent of the customer-phone rule in D-02.

**Username** is set at signup, unique per tenant, and is a display/audit identity — it is not a login identifier in V1. Login always uses email, phone, PIN or Google.

**Google OAuth.** A Google account is linked to an existing user by verified email. If the email is unknown, signup still requires the OTP flow — Google alone never creates a tenant.

**OTP rules.** 6 digits · 5-minute expiry · single use · invalidated on a new request · maximum 5 verification attempts then the code dies · per-identifier and per-IP rate limits · code is stored hashed, never logged, never returned in a response body. Every send, failure and lockout is audited (R-13, SIM-swap).

**Password and PIN.** Both are set at signup and changeable in Settings; changing either requires the current credential, and changing a password invalidates all other sessions. PIN is a convenience credential for a returning session on a known device — it never substitutes for a password on a new device and never satisfies step-up.

## 5.4 M03 Subscription & Entitlements
Trial, monthly/yearly plans, feature entitlements, package restrictions, renewal, expiry, offline licensing period. Full implementation is Phase 10; the `EntitlementService` interface with a permissive stub exists from Phase 0.

Indicative tiers (exact matrix is open item O-1): **Basic** — core POS, products, customers, purchases, basic inventory · **Medium** — expanded finance, reconciliation, reporting · **Advanced** — vendor/consignment, advanced inventory, serial/warranty, advanced reporting.

**Vendor/consignment is Advanced-tier functionality.**

**On expiry:** restricted new actions are blocked per policy, **historical data is retained**, and upgrading restores access. Entitlement is enforced server-side. Expiry never destroys or hides data (consistent with D-36).

## 5.5 M04 Product & Catalog
Product, brand, category/group, SKU/code, barcode, unit, selling price, reorder level, status, description, image, expiry config, warranty config, serial tracking.

- **Brand and Product Name are separate fields.** Display name = `Brand + Product Name` when a brand exists.
- **Different purchase prices create inventory lots, not duplicate products.**
- Operations: add/edit/update/delete-where-permitted, search, filter, brand filter, category filter, barcode search, barcode scan, barcode generation.
- Unit conversion per D-10 with `pack_size`.

## 5.6 M05 / M06 / M07 Parties (unified — D-04)
One `parties` table + `party_roles`. Customer: phone mandatory, unique within the CUSTOMER role (D-02), group, loyalty/premium classification, notes, status, history, ledger, credit limit (warning-only). Supplier: contact info, purchase history, payable, payments, purchase returns, statement, ledger. Vendor/consignment (entitlement-gated): vendor-owned stock, vendor cost, vendor payable, vendor payment, vendor return, source transaction history.

**Inventory must distinguish Owned Stock from Vendor-Owned Stock.** While held, vendor stock is excluded from valuation and COGS. On sale it is converted to owned stock at vendor cost inside the sale transaction (deemed purchase — DR13.10), which is what creates the vendor payable.

**Party selection defaults:** Sales/POS shows customers by default; Purchase screens show suppliers by default. Selling to a supplier is possible but must be an explicit user choice — never show every party type by default.

## 5.7 M08 Sales & POS
Fast product search, grid/list, barcode scan, brand/category filters, customer selection, walk-in customer, quantity editing, permission-gated price editing, discount, grand total, multiple payment methods, cash paid, due, invoice generation, printing, reprint, cancellation/correction, permission-controlled transaction editing.

Source selection: Own Stock · Vendor/Consignment. Vendor/consignment requires vendor, quantity and vendor cost, and posts via the deemed-purchase rule (DR13.10). Sale templates per D-26.

**Negative stock policy** is a setting with three values: `BLOCK` · `WARN` · `ALLOW`. Default `WARN`. When `ALLOW`, costing follows D-19 provisional cost.

**Cost visibility in POS** is behind a protected control (eye icon) requiring `inventory.cost.view`. Where the temporary-reveal behaviour is used, the cost displays for ~2000 ms then hides. Product search must never return purchase cost to a user lacking the permission — the field is absent from the response, not blanked.

## 5.8 M09 Sales Invoice & Payments
Invoice creation, numbering, payment allocation, multiple payment methods, cash, bank, due, customer balance, invoice search (by phone), reprint, cancellation/correction, payment history.

**Payment allocation:** select the invoice(s) being paid → apply → overpayment is retained as an **advance**, applicable later against due. Auto-FIFO allocation is an option; unallocated amounts sit as an on-account balance. Ledgers support current balance, due balance, advance balance, partial payments, sales returns, purchase returns, and cash refunds.

A sale transaction is atomic across: sale → items → inventory consumption → stock movement → payment → customer ledger → cash/bank → audit.

## 5.9 M10 / M11 Purchase and Purchase Orders
Purchase: supplier, date, reference/invoice, product, quantity, purchase price, discount, additional costs, payment, due, lot creation, inventory increase, supplier ledger, cash/bank movement, purchase return. Different purchase prices create separate lots.

Purchase orders: create, supplier, products, quantities, expected cost, status, approval where enabled, conversion to purchase, search/filter, edit, cancel, audit. **A purchase order must not increase physical stock.**

## 5.10 M12 Inventory & Stock
Current stock, search, filters, low stock, out of stock, stock movement, adjustment, reconciliation, history, source transaction, concurrency protection, inter-location transfer (once multiple locations exist).

Every stock movement identifies: product, lot where applicable, quantity, source transaction, business date, created timestamp, user, cost where applicable, location. **No silent stock mutation.**

```sql
stock_movements(id, tenant_id, product_id, location_id, lot_id,
                qty, direction, business_date, source_doc_id, unit_cost, ...)
```

## 5.11 M13 Inventory Lots & Costing — highest-risk module

**Tables**

| Table | Key columns |
|---|---|
| `inventory_lots` | `id`, `tenant_id`, `product_id`, `location_id`, `owner_type`(OWNED/VENDOR), `vendor_party_id?`, `supplier_party_id?`, `source_document_type`, `source_document_id`, `qty_received`, `qty_remaining`, `purchase_unit_cost`, `landed_cost_total`, `actual_unit_cost`, `business_date`, `created_at`, `expiry_date?`, `status`, `version` |
| `lot_consumptions` | `id`, `movement_id`, `lot_id`, `qty`, `unit_cost_used`, `document_type`, `document_id`, `business_date`, `superseded_by?` |
| `cost_adjustments` | `id`, `product_id`, `lot_id?`, `reason`(BACKDATE, EDIT, LANDED_COST, SYNC_TRUE_UP, NEGATIVE_STOCK_TRUE_UP), `document_ref`, `amount`, `business_date`, `created_at`, `created_by` |
| `product_cost_state` | `(tenant_id, product_id, location_id)`, `avg_unit_cost`, `qty_on_hand`, `last_recomputed_at` — derived cache for Average |

**Domain rules**

| ID | Rule |
|---|---|
| DR13.1 | `qty_remaining` = `qty_received` − Σ consumptions + Σ restorations. The cached column must always equal the computed value (INV-02) |
| DR13.2 | **Physical issue order** = expiry ASC (if tracked), then `business_date` ASC, `created_at` ASC, `id` ASC — FIFO/FEFO always. **This is not configurable** (D-05) |
| DR13.3 | The tenant's **costing method** (`FIFO` or `AVERAGE`, D-05) determines the unit cost recorded on the consumption. The same figure is posted to COGS **and** used by the valuation report — there is never a second costing basis |
| DR13.4 | `FIFO`: unit cost = the consumed lot's `actual_unit_cost`. `AVERAGE`: `product_cost_state.avg_unit_cost` at the moment of the movement. **Under `AVERAGE`, `lot.actual_unit_cost` is retained for traceability and landed-cost attribution but is never used for valuation or COGS** — otherwise INV-05 breaks |
| DR13.5 | AVG on receipt: `new_avg = (qty_on_hand×avg + qty_in×unit_cost) / (qty_on_hand + qty_in)`, integer minor units, half-up at scale 4, remainder to `ROUNDING` |
| DR13.6 | Changing the costing method requires `settings.manage` and is only allowed from the start of an open period. **Existing history is never retroactively revalued** |
| DR13.7 | Negative stock: consumption uses a provisional cost (last known → product default → 0) and creates a `NEGATIVE_STOCK_TRUE_UP` obligation. When a real lot arrives, the difference posts as a cost adjustment (D-19) |
| DR13.8 | Landed cost changes `actual_unit_cost`; already-consumed quantities get a `LANDED_COST` adjustment posted to COGS on the landed-cost document's date — never a silent rewrite of past COGS |
| DR13.9 | **Re-costing policy.** A backdated or edited stock-in document triggers **recompute-forward** for the affected `(product, location)` from the changed date to today, **within open periods only**. Differences post as `cost_adjustments`; original consumption rows are preserved with `superseded_by` links |
| DR13.10 | **Vendor/consignment = deemed purchase at the moment of sale.** A `owner_type=VENDOR` lot is excluded from valuation and COGS while held. When it is sold, the sale transaction first converts it to an `OWNED` lot at the agreed vendor cost — creating the `VENDOR_PAYABLE` credit exactly as a purchase would — and then consumes it through the normal path. **No special posting path exists**; consignment reuses `CreateLotService` + `ConsumeStockService`. Because the conversion happens inside the sale's single transaction, no valuation report ever observes vendor stock as owned |
| DR13.11 | A lot can never go negative. `qty_remaining=0` → `CLOSED`, retained forever |
| DR13.12 | **Cost values are never trusted from a client.** The server recomputes at replay |

**Services:** `CreateLotService`, `ConsumeStockService`, `RestoreStockService`, `RecomputeCostService` (idempotent, resumable, chunked), `ApplyLandedCostService`, `GetValuationService`, `VerifyLotIntegrityService`.

**Endpoints:** `GET /lots?product_id=&status=` · `GET /lots/{id}` · `GET /products/{id}/cost-state` · `GET /valuation?as_of=&method=` · `POST /admin/recompute-cost` · `GET /cost-adjustments`.

**Permissions:** `inventory.cost.view`, `inventory.cost.recompute`, `inventory.lot.view`, `settings.manage`, `finance.period.unlock`.

**Cost fields are masked without `inventory.cost.view` — including in exports, API responses and error messages. No cost values in logs.**

**Tests with hard-coded expected numbers:** FIFO across 3 lots · Average after 3 receipts + 2 issues (exact avg to scale 4, rounding remainder posted) · **INV-05 under both methods: valuation equals the `INVENTORY` account balance exactly** · backdated purchase inserted before existing sales (recompute-forward, closed periods untouched) · landed cost after partial sale · negative-stock sale then receipt (true-up equals the difference) · void of a sale (stock restored to the original lot, COGS reversed exactly) · consignment sale (deemed purchase creates payable, COGS correct, valuation never includes vendor stock) · concurrency: two sales consuming the last lot · INV-01..05 green after each.

**Manual scenarios:**
1. Buy 10 @ 100, then 10 @ 120. Sell 15. FIFO COGS = `10×100 + 5×120 = 1,600`; remaining lot = 5 @ 120; valuation = `600`; `INVENTORY` account = `2,200 − 1,600 = 600`. **The last two must match.**
2. On a fresh tenant set costing to `AVERAGE`. Buy 10 @ 100, buy 10 @ 120 → avg = `110.0000`. Sell 15 → COGS = `1,650`; qty on hand = 5; valuation = `5 × 110 = 550`; `INVENTORY` account = `2,200 − 1,650 = 550`. **Must match.**
3. Add 500 transport cost to the first purchase → actual unit cost rises → margin report changes and the cost-adjustment entry explains it.
4. Backdate a purchase to before an existing sale → Cost Adjustments screen explains every change.
5. Sell into negative stock, then receive stock → true-up posted, profit marked provisional until then.

**Edge cases:** zero-cost lots (free samples) · returns of goods whose lot was closed · past-dated expiry · rounding remainders across thousands of movements · product switched to serial tracking mid-life · vendor lot mixed with owned lot · recompute interrupted halfway (resumable, idempotent) · 100k-movement recompute during business hours (chunked, background).

**MCP:** read-only `stock_valuation` and `explain_cost(product, date)` returning the lot/consumption chain. **No AI write access to costs, ever.**

## 5.12 M14 Landed Cost
Allocation methods: Purchase Value, Quantity, Manual (largest-remainder allocation per §3.3). Categories: transport, loading/unloading, labour, other configurable. `actual_cost = purchase_cost + allocated_landed_cost`. **Original purchase cost remains traceable.**

## 5.13 M15 Stock Reconciliation
Physical count, system quantity, physical quantity, difference, adjustment reason, authorization, audit, stock movement. **No direct silent quantity manipulation.**

## 5.14 M16 Returns
Sales and purchase returns with original transaction reference, product, quantity, lot, reason, stock disposition, refund/credit, ledger adjustment, cash/bank adjustment, audit. **Returned inventory must have an explicit disposition.**

## 5.15 M17 / M18 Ledgers
Projections of journal lines — no independent writers. Statement columns: Date · Reference · Description · Debit · Credit · Running Balance. Default reporting uses `business_date`; `created_at` remains available for audit. Terminology configurable (Debit/Credit · Cash In/Cash Out · পাবো/দিব) **without changing accounting semantics**.

## 5.16 M19 Cash Drawer & Business Day Session

### 5.16.1 Model

**One cash drawer session per business day, per tenant.** One Start Day, one opening count, one End Day, one closing count.

```
Start Day → enter actual opening cash → Business Day Session
          → transactions (cash in / cash out)
          → End Day → count drawer → enter actual closing cash → Close
```

**A session belongs to exactly one `business_date` — the date it was opened on.** Every cash movement in it reports on that date, even if rung up after midnight. A shop trading 09:00 to 01:30 has one trading day, one drawer count, one Daybook page. Splitting a session at midnight would guarantee the physical count never matches any single day's report.

A document's own `business_date` still governs its journal entry, so a session cannot contain documents dated outside it — the use case rejects that.

When the cash-session setting is **off**, no drawer is tracked and none of §5.16 applies. When it is **on**, a cash-affecting transaction with no open session is rejected.

### 5.16.2 Start Day

The user enters the **actual physical cash placed in the drawer**. This is a counted number, not a computed one.

The screen shows:

| Field | Source |
|---|---|
| Previous actual closing cash | Previous session's counted close |
| Suggested opening cash | = previous actual closing |
| **Actual opening cash** | **User input — counted** |
| Difference from previous actual | Computed live |
| Reason / destination | **Required whenever the difference ≠ 0** |

**Opening cash is never a free number.** If it differs from the previous actual closing, the difference is posted as an explicit movement before the session opens — see §5.16.5. The system must never accept a new opening balance that silently absorbs a difference.

### 5.16.3 During the day

`Cash In` — cash sales, due collection, owner injection, transfer in from another cash account, bank withdrawal into the drawer.
`Cash Out` — expenses paid in cash, cash purchases, supplier payments, owner withdrawal, transfer out, bank deposit.

Only approved, posted movements count. Drafts do not.

### 5.16.4 End Day

```
Expected Closing Cash = Opening Cash + Cash In − Cash Out
Cash Difference       = Actual Closing Cash − Expected Closing Cash
```

1. Show Expected Closing Cash.
2. User physically counts the drawer.
3. User enters Actual Closing Cash.
4. Compute the difference.
5. **Store opening, cash in, cash out, expected, actual and difference permanently** on the session row and in audit history.
6. **The stored expected amount is immutable.** It is computed by the system and is never overwritten, recalculated on read, or adjusted to match the count.

The End Day screen shows: opening cash · total cash in · total cash out · expected closing · actual counted · difference · difference reason · **Close Day**.

**Posting on close.** A non-zero difference posts on the **closing session's own `business_date`**, so the day it belongs to carries it:

| Case | Posting |
|---|---|
| Shortage (actual < expected) | `DR CASH_SHORT_OVER / CR CASH:{id}` |
| Overage (actual > expected) | `DR CASH:{id} / CR CASH_SHORT_OVER` |

After this posting the `CASH:{id}` balance equals the counted cash (INV-07b). A shortage is a real cost and appears in the P&L; it is never hidden on the session row alone, because then the cash report and the ledger would disagree.

A closed session is immutable. Correcting a miscount is a new, audited adjustment, not an edit.

### 5.16.5 Next-day opening cash

**The next day's opening cash is whatever the business physically puts in the drawer. It is normally the previous actual closing, but is never forced to equal it.**

Any difference posts on the **new session's `business_date`** — it is declared at Start Day, so it belongs to the new day. This also keeps a Start Day adjustment from landing in a period that has since been closed.

| Case | Meaning | Posting |
|---|---|---|
| **A — more cash added** | Opening > previous actual | `DR CASH:{id}` and `CR` the declared source: `OWNER_CURRENT_ACCOUNT` (owner injection), another `CASH:{id}` (transfer from safe), or `BANK:{id}` (withdrawal) |
| **B — less carried forward** | Opening < previous actual | `CR CASH:{id}` and `DR` the declared destination: another `CASH:{id}` (moved to safe), `BANK:{id}` (deposited), or `OWNER_CURRENT_ACCOUNT` (owner withdrawal) |
| **C — previous day was short** | Previous actual < previous expected | **Nothing.** The shortage was already posted at that day's close and stays in that day's session. Starting the new day at the counted amount does not erase, recalculate, or offset it |

**Case B has no "unexplained" option.** Cash always has a named destination — that is why `CASH:{id}` is per account rather than a single `CASH` (§2.4). Cash cannot leave the system without saying where it went.

### 5.16.6 Worked example (binding — use these numbers as the acceptance test)

```
DAY 1
  Opening Cash            ৳20,000   (counted at Start Day)
  Cash Sales              +৳50,000
  Due Collection           +৳5,000
  Expense                  −৳3,000
  Cash Purchase            −৳7,000
  ─────────────────────────────────
  Expected Closing Cash    ৳65,000   (computed, immutable)
  Actual Closing Cash      ৳64,500   (counted at End Day)
  Difference                 −৳500   SHORTAGE

  Posts on Day 1: DR CASH_SHORT_OVER 500 / CR CASH:drawer 500
  CASH:drawer now = ৳64,500 = the physical drawer.

DAY 2 — three legitimate outcomes

  (i)  Carry the actual forward
       Opening = ৳64,500 · difference ৳0 · no posting, no reason required

  (ii) Business puts in ৳70,000
       Opening = ৳70,000 · difference from previous actual = +৳5,500
       Requires a declared source. If owner injection, posts on Day 2:
         DR CASH:drawer 5,500 / CR OWNER_CURRENT_ACCOUNT 5,500

  (iii) Business puts in only ৳60,000
       Opening = ৳60,000 · difference from previous actual = −৳4,500
       Requires a declared destination. If moved to the safe, posts on Day 2:
         DR CASH:safe 4,500 / CR CASH:drawer 4,500

  In all three, Day 1's −৳500 shortage remains recorded against Day 1 and is
  untouched by whatever Day 2 opens with.
```

### 5.16.7 The six quantities that must stay distinguishable

The system must never collapse these into one another:

1. Previous day's **expected** cash
2. Previous day's **actual counted** cash
3. Next day's **opening** cash
4. Cash **transferred / added / removed** between sessions
5. Cash **shortage / overage**
6. The **reason** recorded for 4

Every difference between (2) and (3) is explained by (4) with a posted, audited movement. There is no path in the system by which an opening balance changes without one (INV-07c).

## 5.17 M20 / M21 Bank and Reconciliation
Bank account, name, account name, reference/number, opening balance, transactions, payments, receipts, statement, balance, audit, source linkage.

Reconciliation: CSV/Excel import; states unmatched, matched, reconciled, bank-only, book-only, exception. Actions: match, create missing transaction, edit, correct transaction date, correct allowed fields, mark reconciled. Changes to reconciled transactions **trigger review and never silently rewrite reconciliation history**.

## 5.18 M22 Expenses
Category (configurable — Salary, Transport Cost, Other), amount, business date, payment method, description, reference, user. Add/edit/update/delete-where-permitted, search, filter, audit, cash/bank linkage, reporting by business date and created date.

Example: salary paid to Belal → Belal party ledger entry + salary expense + cash/bank movement + audit, all in one transaction.

## 5.19 M23 Warranty & Serial

Simple warranty claim tracking. **Must not become a service-management system** and must not duplicate Sales, Inventory, Party, Ledger, Product or Accounting logic.

**Claim record:** claim ID, party, product, serial (when applicable), invoice/reference, warranty card info, warranty start/end, method (Direct Shop | Courier), complaint, received date, status, notes, final result.

**Direct shop:** locate product/customer/transaction → check card and dates → check the problem → decide. If accepted, the shop may replace from own stock (recorded against the claim); if the supplier still owes a replacement/repair/adjustment, the claim stays linked to the supplier pending record. If refused, record the reason; history is retained.

**Courier:** create/locate claim → record courier and receive → check product, serial, card, dates → send to supplier → track response → accepted: receive repaired/replacement, record, send to customer; rejected: receive original back, return to customer → close after the customer-side result completes.

**Supplier Warranty Send** groups multiple claims/products sent to one supplier: supplier, send date, reference/challan, products, serials, quantities, related claims, notes, status. Example: `WB-001` to ABC Electronics, 17 sent → 8 replacements, 3 repaired, 2 rejected/returned, 4 pending.

**Customer replacement from own stock** must record simultaneously that the customer already received a replacement, that it came from own stock, and that supplier responsibility is still pending — the customer-side case can close while supplier-side recovery is open.

**Supplier settlement types:** A replacement product · B repaired product · C cash/account adjustment (posted through the existing Party/Supplier Ledger logic — warranty creates no separate accounting) · D rejection with reason, original returned, date received, customer return.

**Statuses:** Received · Checking Warranty · Sent to Supplier · Waiting for Supplier · Supplier Approved · Supplier Rejected · Repaired · Replacement Received · Customer Replacement Given · Returned to Customer · Completed.

**Serial tracking:** a serial-tracked product **cannot be sold without the required serial information**. Serial movement stays traceable across purchase → inventory → sale → customer → warranty → return.

**Accounting (binding).** A replacement issued from own stock posts `DR WARRANTY_EXPENSE / CR INVENTORY` at the consumed lot's cost, through the normal `ConsumeStockService` — it is a stock issue with no revenue, not a sale. When the supplier settles, the recovery **credits `WARRANTY_EXPENSE` back**:

| Settlement | Posting |
|---|---|
| Replacement product received | `DR INVENTORY / CR WARRANTY_EXPENSE` at the replacement's cost (creates a lot) |
| Repaired product received | `DR INVENTORY / CR WARRANTY_EXPENSE` at the original lot cost |
| Cash or supplier-account adjustment | `DR AP` (or `CASH:{id}`) `/ CR WARRANTY_EXPENSE` |
| Supplier rejects | No further posting; the expense stands |

Net warranty cost per period is therefore readable directly off `WARRANTY_EXPENSE`. **No warranty receivable is created** — a pending claim is tracked operationally in M23's status fields, not as a balance-sheet asset, because these claims are frequently never recovered and an uncollected receivable would quietly overstate assets.

**Integration:** all stock effects go through existing Inventory operations; all financial effects through the posting kernel and the Party/Supplier ledger. Warranty implements no accounting of its own. Serial linkage follows D-18. History must always make clear where the product is and what has happened.

## 5.20 M24 / M25 Reports & Dashboard

**Sales:** summary by date, product, customer, cashier, brand, category, payment method.
**Purchasing:** summary by supplier, product, date.
**Inventory:** current stock, low stock, out of stock, movement, lot, valuation, lot ageing/near expiry, cost adjustments, COGS by period, provisional-cost exposure, margin per product/sale.
**Finance:** customer due, vendor payable, vendor receivable, cash, bank, expenses, profit when reliable (D-06).
**Reconciliation:** unmatched, reconciled, late entries, corrections, cost adjustments after sync.

**Reports read from journal lines and stock movements only — never computed from documents directly (INV-10).**

Dashboard cards are configurable and permission-gated: today's sales, stock value, purchase orders, low stock, recent sales, due collection, payable, cash/bank balance. Profit is hidden unless costing is reliable (D-06) and the feature is enabled.

### Explainability — the "Why?" requirement

Every important total supports drill-down to its source transactions:

```
Stock: 127            [Why?] → the movements that produce 127
Customer Due: ৳80,000 [Why?] → the journal lines that produce ৳80,000
Vendor Payable: ৳65,000 [Why?]
Bank Difference: ৳11,500 [Why?]
```

This is a product requirement, not a nice-to-have. It is also the practical test of INV-10: if a figure cannot be traced to journal lines or stock movements, it was computed the wrong way.

## 5.21 M26 Settings & Feature Controls
Product settings (**costing method — `FIFO` or `AVERAGE`, D-05**; stock behaviour; product behaviour) · party settings · permission settings · module feature on/off per entitlement · terminology · tenant timezone · numbering prefixes · period lock configuration · negative stock policy (`BLOCK`/`WARN`/`ALLOW`) · backdating policy · cash session on/off.

There is no "lot consumption method" setting — physical issue is always FIFO/FEFO (DR13.2).

**Only enabled features appear in navigation and screens.** Navigation visibility is driven by entitlement → feature setting → permission, in that order. Never render a control that will 403.

**Feature dependencies must be validated — invalid combinations are prevented, not merely discouraged:**

```
Vendor/Consignment  →  requires Vendor Management + Vendor Ledger
Warranty            →  requires Serial Tracking where the product is serial-tracked
Bank Reconciliation →  requires Bank Accounts
```

Turning off a parent feature must either cascade or be refused with an explanation — never leave a dependent feature enabled and broken.

## 5.22 M27 Audit
Every audit event records: user, action, entity, entity ID, old value, new value, timestamp, reason where required, source transaction, and `source` (e.g. `DAYBOOK`, `SYNC`, `API`).

Authorized freedom — edit, update, delete where allowed, change transaction date, correct, reverse, cancel — is always auditable. Indicators: `ON_TIME` · `LATE_ENTRY` · `BACKDATED` · `CORRECTED`. **The system must never make a financially meaningful historical event disappear without an auditable trail.**

Permission **denials** on mutating actions are audit-logged with user, code, record, timestamp, trace ID. Read denials are logged in aggregate only.

## 5.23 M28 Offline & Sync — future phase

Offline runs **inside the PWA** on SQLite WASM + OPFS (D-23), under the single-writer rule bound to a registered browser profile (D-01). There is no Tauri shell and no local Node process (D-20). Everything below is the reason for the ULID, integer-money, outbox and idempotency decisions taken in V1.

**Preconditions before any offline write is accepted (D-24), enforced in this order:**

```
PWA installed
  → navigator.storage.persist() granted
  → navigator.storage.estimate() ≥ snapshot size + headroom
  → profile registered and holds OFFLINE_RW
  → snapshot downloaded and verified
  → offline writing ENABLED
```

Failure or later revocation of any step drops the profile to **read-only offline**, states so plainly in the UI, and leaves already-queued operations intact for push. The app never accepts a write into storage it has not been told is persistent.

**Browser-profile binding.** `OFFLINE_RW` is held by a profile, not a machine. A different browser, a different OS user, an incognito window, or a cleared profile on the same PC is a different writer and must be re-registered through the transfer flow. The registration record stores a profile-generated keypair; the server binds authority to the public key, so copying the OPFS files to another profile does not carry write authority with them.

**Device authority state machine**

```
Registered → ReadOnly → OfflineRW → Draining → ReadOnly
                              └────→ ForceRevoked → ReadOnly
```

Uniqueness enforced by `CREATE UNIQUE INDEX ON device_authorizations(tenant_id) WHERE capability='OFFLINE_RW' AND status='ACTIVE'`. Force revoke must be possible and loud — a revoked device that reconnects has its outbox imported into **quarantine**, never applied blindly. Every state change is audited with actor and reason.

**Data classification**

| Class | Examples | Direction | Conflict policy |
|---|---|---|---|
| Platform | plans, permission registry | Server → device | Server wins |
| Tenant master | products, parties, settings, roles, locations | Bidirectional, server authoritative | Field-level last-writer-wins with a change report; unique-key clashes quarantined |
| Transactional | sales, purchases, payments, returns, expenses, adjustments, sessions | Device → server, append-only | **No merge.** Documents are immutable facts; corrections are new documents |
| Derived | balances, report models | Not synced | Recomputed each side |
| Audit | audit events | Device → server, append-only | Never merged, never deleted |
| Sequences | invoice numbers | Device-prefixed ranges | Cannot collide |

**The server never trusts device-computed totals, costs or balances.** It re-executes the operation through the same application services and compares.

**Wire protocol.** Push batch: `device_id`, `schema_version`, `license_token`, and per operation `operation_id` (ULID), `local_seq`, `type` (= application service command name), `payload` (the exact zod-validated command DTO), `context` (`user_id`, `business_date`, `device_created_at`, `permissions_snapshot_hash`), `depends_on[]`, `client_result_digest`. Response per op: `APPLIED` (+ `server_seq`, `server_result_digest`, `divergence`) · `DUPLICATE` · `QUARANTINED` (+ `reason_code`, `conflict_id`) · `BLOCKED` · `IDEMPOTENCY_MISMATCH` · `SCHEMA_INCOMPATIBLE` · `AUTHORITY_REVOKED`. Pull: `GET /sync/pull?cursor=&limit=` returning `changes[]` (UPSERT/TOMBSTONE with `entity_version`), `next_cursor`, `has_more`, `server_time`.

**Server replay rules.** Set tenant context, actor = **original** user, record `device_id` → re-check entitlement → permission → settings → period **at replay time** (failure ⇒ quarantine, never force) → execute the same application service the online API would → recompute costs/totals and compare with `client_result_digest`; on difference apply server values and record a `COST_TRUE_UP` / `AMOUNT_DIVERGENCE` entry plus a report row → assign `server_seq`, write audit with `source='SYNC'`, preserve `device_created_at` → all in one transaction per operation.

**Costing under sync:** cost is computed at replay time on the server using server lot state ordered by `business_date, created_at, id`. The server's number is authoritative; divergence posts a true-up and appears in a "Cost adjustments after sync" report — never silently discarded. The device recomputes locally after each pull to converge.

**Conflict handling** — quarantine, never auto-discard. Records live in `sync_conflicts` with payload, reason, server state, suggested actions (`MERGE`, `KEEP_BOTH_EDIT`, `DISCARD_WITH_REASON`) and are resolved via `POST /sync/conflicts/{id}/resolve`, always audited. `DISCARD_WITH_REASON` requires a destructive permission.

**Bootstrap/transfer snapshot** contains: settings, users/roles/permissions, parties, products/brands/categories/units, locations, open lots + balances **as movements**, open documents, ledger opening positions as a carry-forward journal entry, and the last N months of transactions. The device receives an opening-position entry, not necessarily full history — restore stays bounded while balances stay exact.

**Backup/restore:** export the local SQLite WASM database out of OPFS, encrypt → `tenant_device.sherbak` (AES-256-GCM + manifest + schema version + last cursor), downloaded through the browser to a location the user controls. A clean profile imports the file, verifies manifest and tenant ownership, restores into OPFS, and **resumes sync from the stored cursor** with the pending outbox preserved. Because OPFS can be evicted, an automatic export is offered whenever the pending outbox is non-empty at session end.

**Observability:** `GET /sync/status` — last successful push/pull, pending ops, failed ops, quarantined count, cursor, schema versions, license status, estimated drift.

**Sync test matrix (all must pass before the offline phase exits):** SY-01 500 clean ops all APPLIED · SY-02 repeat batch all DUPLICATE, no data change · SY-03 network killed at op 250 → resume, no duplicates, no gaps · SY-04 server restart mid-batch · SY-05 op references deleted product → QUARANTINED with fix action · SY-06 period closed on server → QUARANTINED, not force-posted · SY-07 permission revoked while offline → QUARANTINED · SY-08 device cost differs → applied with true-up + report row · SY-09 revoked device reconnects with 200 ops → all quarantined · SY-10 schema too old → SCHEMA_INCOMPATIBLE, no partial writes · SY-11 master data edited both sides → field-level merge + review entry, no silent loss · SY-12 **a full offline business day produces identical stock, ledger, cash and report totals to the equivalent online day** · SY-13 `persist()` refused → offline writing never enables, UI states why, no data accepted · SY-14 persistence revoked mid-day with a pending outbox → profile drops to read-only, queued ops survive and push on reconnect, user is prompted to export · SY-15 quota exhausted mid-batch → writes stop cleanly with a blocking banner, no partial or corrupt transaction · SY-16 OPFS files copied to a second browser profile → that profile has no write authority and is refused at push.

## 5.24 M29 Documents, Notifications & SMS

Invoice printing (thermal, A4, business pad), PDF, image, Bangla/English invoices, multiple templates, reprint, document search.

**Printing transport (D-22).** Thermal receipts go over **WebUSB with generated ESC-POS** byte sequences — no OS driver, no print dialog, no per-shop printer setup beyond a one-time device permission. The **browser print dialog fallback is mandatory** and must be reachable at all times: WebUSB unavailable (Firefox, iOS Safari), permission refused, device not claimed, or printer offline all fall through to a styled HTML layout (80mm thermal variant and A4). **A sale is never blocked by a printing failure** — the document is posted first, printing is a separate action that can be retried or reprinted. Printer choice, vendor/product ID and the last successful transport are stored per browser profile; A4 and business-pad documents always use the print dialog. ESC-POS command generation lives in `apps/web`, not in the domain — the domain produces the document, never bytes for a device.

**Two distinct SMS concerns — do not merge them.**

| | **Platform OTP SMS** | **Tenant SMS wallet** |
|---|---|---|
| Who pays | SherERP | The tenant |
| Purpose | Account verification (D-07) | Business messages to the tenant's own customers |
| Metering | None | Prepaid credits, balance, usage |
| Phase | **Phase 1**, behind `IdentityVerifier` (D-33) | **Phase 10** |
| Scope | One send-only provider call, no wallet, no billing | Packages, top-up, verification, audit |

They share a transport and nothing else. Building the wallet to unblock login would drag bKash verification and credit metering into the auth phase.

**Wallet (Phase 10):** tenant purchases credits (e.g. 100 SMS = 70 BDT). Select package → pay via bKash/Nagad personal → enter number → enter transaction ID → admin verification → credits added. **No credit before verification**; transaction IDs unique; audited; rate-limited.

## 5.25 M30 SaaS, Multi-tenancy & Backup
Tenant isolation and lifecycle, subscription, entitlements, trial, upgrade, renewal, expiry, account closure, data export, data deletion (with a defined purge job and retention window), restore.

Encrypted export as `tenantname.sherdb` with encryption, integrity protection, versioning, import validation, restore, migration, tenant ownership validation. Supported lifecycle: download backup → close account → delete server data → return later → create/restore account → import backup → continue operating.

## 5.26 M31 Technical Quality, API & AI Readiness

### API conventions

```
/api/v1/{resource}                 GET (list) · POST (create)
/api/v1/{resource}/{id}            GET · PATCH
/api/v1/{resource}/{id}/{action}   POST   ← state transitions
```

**Tenant is never in the URL.** It comes from the token via `TenantContext`.

State changes are explicit actions, not PATCHes on a status field. `POST /sales/{id}/void`, not `PATCH /sales/{id} {status:"VOIDED"}` — voiding has reversal entries, stock return and ledger effects and must run its own use case.

**Idempotency.** The HTTP header `Idempotency-Key` and the command field `operation_id` are **the same value under two names** — the header is the transport, `operation_id` is what the application service and the document row store. There is one mechanism, serving network retries, POS double-click, offline replay and MCP.

Every mutating request carries `Idempotency-Key: <ULID>`, generated by the client before the first attempt and reused on retry. Same key + same tenant → returns the original result with `200`. Same key + different payload → `409 IDEMPOTENCY_KEY_REUSED`.

**Retention:** the `idempotency_keys` fast-path table is pruned after 30 days, but `operation_id` is stored **permanently** on the document row and is uniquely indexed per `(tenant_id, operation_id)`. After pruning, a replay is still caught by that unique constraint rather than creating a duplicate. This matters because an offline device may push an operation months after creating it — a 30-day-only mechanism would silently duplicate it.

**Edits do not reuse `operation_id`.** Each version of a document is a separate mutation with its own key; the document keeps the `operation_id` of the mutation that produced its current version, and prior values remain in the audit trail.

**Responses.** Success single `{ "data": {...} }`; list `{ "data": [...], "page": { "nextCursor", "hasMore" } }`; error `{ "error": { "code", "message", "details", "traceId" } }`.

Money and quantity cross the wire as **integer minor units** with a `Minor` suffix on the field name — never a float, never a formatted string. Clients switch on `code`, never on `message`.

| HTTP | Code |
|---|---|
| 400 | `VALIDATION_FAILED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `PERMISSION_DENIED` · `FEATURE_NOT_IN_PLAN` · `FEATURE_DISABLED` · `SETTING_FORBIDS` |
| 404 | `NOT_FOUND` — absent **or** belongs to another tenant |
| 409 | `CONFLICT_STALE_VERSION` · `IDEMPOTENCY_KEY_REUSED` · `PERIOD_LOCKED` |
| 422 | `INSUFFICIENT_STOCK` |
| 423 | `LICENSE_READ_ONLY` |
| 500 | `INTERNAL_ERROR` — never leaks a stack trace or SQL |

**Cross-tenant access returns 404, not 403.** Confirming a record exists in another tenant is itself a leak.

**Warnings** (credit limit, D-11) return `200` with `"warnings": [{ "code", "message" }]`. The client must display them.

**Pagination** keyset only; default limit 50, max 200; fixed sort per endpoint (`business_date DESC, id DESC`); filters use `business_date`, never `created_at`.

**Validation:** zod schemas in `core-contracts` shared by API and Vue client. Controllers validate **shape only**; business validation lives in the domain. OpenAPI is generated from zod — never hand-written, never edited.

**Versioning:** path-versioned `/api/v1`. Additive changes do not bump. Removing or renaming a response field **is** breaking — on-premise customers may run an older client against a newer server for months.

### Permission architecture

```
Plan → Feature → Setting → Permission → Access
```

All five must allow an action; any one may deny. Evaluated **server-side, every request** — never cached in a token, never trusted from a client. Order matters: cheapest and broadest first.

Permission codes are `{module}.{resource}.{action}` **static string constants** in `core-contracts`. Never built by concatenation at runtime. Examples: `sales.invoice.create`, `sales.invoice.void`, `sales.invoice.backdate`, `purchase.order.approve`, `inventory.reconciliation.post`, `inventory.cost.view`, `finance.expense.create`, `finance.period.unlock`, `report.profit.view`, `settings.module.toggle`, `daybook.transaction.edit`.

**Cost visibility is its own permission.** A cashier must be able to sell without seeing purchase cost or margin. Destructive and financially meaningful actions get their own codes — `void`, `backdate`, `unlock`, `delete` are never bundled into `edit`.

**Seed roles** (shipped per tenant, fully editable):

| Role | Intent |
|---|---|
| Owner | Everything including period unlock, settings, user management. Cannot be deleted or de-privileged |
| Manager | All operations, cost and profit visible; no settings/users, no period unlock |
| Cashier | POS sell, receive payment, view the day's cash position. **No cost, no profit, no purchase, no backdating, and neither `cash.day.start` nor `cash.day.end`** — the person counting the drawer should not be the only person who can sell from it |
| Storekeeper | Stock in/out, reconciliation, lots. No pricing, no financial ledgers |
| Accountant | Ledgers, payments, expenses, bank, reports, period lock. No stock movement, no selling |
| Viewer | Read-only, no cost, no profit |

The system must refuse to remove the last Owner.

**Checks live in the use case in `core-application`, not only in a controller guard** — MCP, future offline and background jobs bypass HTTP guards entirely, and a guard cannot see a record's business date. The guard remains as cheap early rejection, not the authority.

**Record-level scope:** tenant always · location when multi-location is enabled · some roles limited to records they created within the same business day. Denials return `404`.

There is no per-cashier session scope — the tenant has **one** drawer session per business day (§5.16). Opening and closing the day are their own permissions (`cash.day.start`, `cash.day.end`), not something every cashier holds.

**Permission-denied behaviour:** hide the control in the UI **and** enforce server-side. Cost not visible → the column is **absent from the API response**, not blank or zero. Profit not visible → the report endpoint omits the section. **Never send data the client is expected to hide** — hiding a column in Vue while the API returns it means anyone can read it in the network tab.

### AI / MCP

```
AI → MCP → auth → TenantContext → permission → application service → domain → DB
```

MCP tools call the **same application services** as HTTP controllers — never the database, never a parallel path. Every MCP mutation supplies an `operation_id`. If an MCP tool needs something the API cannot express, the API is missing a use case — fix that, do not add a shortcut. AI actions are auditable and permission-bound.

### Non-functional

Security: tenant isolation, server-side authorization, secure sessions, input validation, rate limiting, audit, secure secrets, encryption at rest where appropriate, encryption in transit, backup encryption. Audit logging cannot be disabled by configuration.

Performance budgets enforced in CI for POS, product search, inventory, large transaction history, reports, filters, API requests.

Reliability: no silent transaction loss. Observability: logs, errors, audit events, sync state. Compatibility: database and backup formats versioned.

## 5.27 M32 Daybook — Phase 9

The shop owner's day-end review screen: every transaction in a date range on one page, correctable in place. **Not a second transaction engine** — it creates no documents, computes no balances, and implements no edit logic.

**Requirements:** all transactions for a range (default today) · from/to date picker · sales, purchases, payments received and made, expenses, returns, cash movements, bank movements, stock adjustments · edit/update/void any listed transaction from this screen · print a physical day-end report showing opening state, the day's transactions and closing state · filter by type, party, user, payment method · running cash position · identical permissions, period locks and audit to the source modules.

**Cash drawer session history.** Daybook shows, for each business date in range: opening cash, cash in, cash out, expected closing, actual counted, difference, and any between-session movement (owner injection/withdrawal, transfer to or from another cash account, bank deposit) with its reason. A shortage or overage is shown on the day it was counted and is never netted against another day. These figures come from the session rows and the journal, not recomputed by Daybook.

**Tables — no new transactional tables.** Only `daybook_prints(id, tenant_id, from_date, to_date, printed_at, printed_by, opening_cash_minor, closing_cash_minor, transaction_count, totals_json, reprint_of_id)` and `daybook_review_marks(id, tenant_id, business_date, reviewed_at, reviewed_by, note)`. `daybook_prints` exists so a reprint can be proven identical to — or explicitly different from — the original physical copy.

**Reading model:** reads `journal_entries`/`journal_lines` ordered by `business_date, created_at, id`, unioned with `stock_movements` for stock-only events that produce no journal entry. Reading per-module document tables would let Daybook disagree with the ledger — exactly what INV-10 forbids.

**Domain rules**

| # | Rule |
|---|---|
| DR1 | Daybook contains **no** business logic. Every mutation delegates to the owning module's use case |
| DR2 | Rows ordered by `business_date`, `created_at`, `id` — stable and reproducible |
| DR3 | Filtering always on `business_date`, never `created_at` |
| DR4 | Voided documents are shown struck through with their reversal linked — not hidden |
| DR5 | A transaction in a locked period is read-only, with a lock icon and reason |
| DR6 | Opening cash = the closing cash of the previous **cash session** (§5.16), which belongs to the previous trading date. Where cash sessions are disabled, it is the previous business date's closing cash. Mismatch is shown as a visible discrepancy, never silently reconciled |
| DR7 | Backdated entries appear on their `business_date` tagged `BACKDATED`, **and** in an "entered today, belongs elsewhere" section |

DR7 is what makes Daybook trustworthy under this project's backdating freedom.

**Services:** `GetDaybookService`, `GetDaybookSummaryService`, `MarkDayReviewedService`, `PrintDaybookService`. **No edit services.** If `DaybookUpdateSaleService` ever appears, the module has become a back door.

**Endpoints:** `GET /daybook?from=&to=&type=&partyId=&userId=&cursor=` · `GET /daybook/summary` · `POST /daybook/review` · `POST /daybook/print` · `GET /daybook/prints`. Edits use the existing module endpoints.

**Permissions:** `daybook.view`, `daybook.view.all_users`, `daybook.review.mark`, `daybook.print`. **Editing from Daybook requires the source module's own permission.** Daybook concentrates visibility, never authority.

**Print layout, in order:** header (shop, address, range, printed at/by, print serial) → opening state (cash, bank, receivable, payable) → chronological transaction list → section totals → closing state → movement summary per account → **backdated section** (entries recorded in this range but dated outside it, and entries dated in this range but recorded outside it) → footer with signature lines, page numbers, `REPRINT` watermark. PDF, A4, with a condensed 80mm thermal variant.

Without the backdated section, a printed day-end report can be silently invalidated by a later backdated entry.

**Validation:** `to_date` before `from_date` rejected · range > 92 days rejected (use Reports) · future `to_date` allowed · printing a zero-transaction day allowed.

**Audit:** edits via Daybook are audited by the source module with `source: DAYBOOK` — distinguishing "corrected during day-end review" from "changed weeks later". Every print writes a `daybook_prints` row; reprints set `reprint_of_id`.

**Tests:** T1 range correctness · T2 **Daybook totals equal Reports totals** (INV-10) · T3 opening = previous closing · T4 voided struck through with reversal linked · T5 locked rows read-only, edit returns `PERIOD_LOCKED` · T6 backdated appears in both places · T7 audit identical to editing from Sales plus `source: DAYBOOK` · T8 cashier without `daybook.view.all_users` sees only own · T9 cashier response body has no cost or profit field · T10 cross-tenant invisible · T11 reprint records `reprint_of_id` and watermark · T12 a 00:30 Dhaka sale appears on that day.

**Manual scenarios**

```
S-DB-01  Opening ৳10,000 · Sale INV-001 ৳2,500 cash · Purchase PUR-001 ৳8,000 cash
         Expense EXP-001 ৳1,000 cash (salary to Belal) · Sale INV-002 ৳3,000 due
         Expect: 4 rows · cash in ৳2,500 · cash out ৳9,000 · closing ৳3,500 · receivable +৳3,000
         Daybook closing cash MUST equal Cash Report closing cash.

S-DB-02  Void INV-001 from Daybook → row struck through · closing ৳1,000 · stock returned
         · customer ledger cleared · audit source = DAYBOOK

S-DB-03  On 15 Aug enter a purchase dated 10 Aug → 15 Aug shows it in the backdated section
         only; 10 Aug shows it in the main list tagged BACKDATED; if July were locked and the
         date were 10 Jul → PERIOD_LOCKED

S-DB-04  Print 15 Aug · add a backdated 15 Aug entry · reprint → new entry present, REPRINT
         watermark, references the original print serial, totals differ visibly
```

**Edge cases:** zero-transaction day (opening = closing, printing allowed) · concurrent edit → `CONFLICT_STALE_VERSION` · range spanning a lock boundary (locked rows read-only, open rows editable, one list) · 500+ row day (keyset pagination, summary computed server-side never from the loaded page) · cash session still open at print time → marked `SESSION OPEN — provisional`.

**MCP:** `GetDaybookService` and `GetDaybookSummaryService` exposed read-only. No Daybook mutation tool.

---

# PART 6 — BUILD PLAN

## 6.0 Vertical slice development

**SherERP is built one business feature at a time, complete, top to bottom.**

A **slice** is one business feature a user can actually perform, built across every layer and verified end to end before the next slice starts:

```
Acceptance criteria (expected numbers written FIRST)
  → Domain logic            (core-domain)
  → Application use case    (core-application)
  → Migration               (schema for this feature only)
  → Repository/adapter      (adapter-postgres)
  → API + contract          (core-contracts, apps/api)
  → Frontend screen         (apps/web)
  → Unit tests              (domain, pure)
  → Integration/DB tests
  → Permission + tenant-isolation tests
  → Full automated verification (lint, typecheck, boundaries, test)
  → Manual UI acceptance     (owner, against the pre-written numbers)
  → Commit
  → Next slice
```

**This is forbidden:** all backend → all database → all frontend → tests at the end. It defers every integration risk to the point where fixing it is most expensive, and it produces nothing the owner can verify for months.

**A slice is not complete because the backend compiles, the tests pass, or the API returns 200.** It is complete when the feature works in the real UI and the owner has confirmed the numbers.

### How big is a slice?

One feature. Not one layer, not one module. Concretely:

| This is one slice | This is not |
|---|---|
| "Create a product and see it in the product list" | "The entire product module" |
| "Search and filter products by brand" | "All of the backend for products" |
| "Record a purchase that creates a lot and increases stock" | "All migrations for phase 3" |
| "Pay a supplier and see the payable fall" | "The repository layer" |

If a slice cannot be demonstrated in the UI in under a minute, it is probably two slices.

### Foundation exception

Infrastructure may be built without a UI **only** when it is genuinely foundational and every later slice depends on it:

- monorepo structure and dependency boundaries
- `Money` / `Qty` / `UnitCost`, `Ulid`, `Clock`
- `TenantContext`, `UnitOfWork` / transaction infrastructure
- audit, idempotency, permission, numbering, period-guard, outbox and posting **interfaces**
- migration infrastructure and the test harness

This is **Phase 0 only**. "Foundation" is not a licence to build large amounts of future functionality before delivering a working vertical slice. If an agent proposes foundation work outside Phase 0, it must name the specific slice in the current phase that is blocked without it.

## 6.1 Phases

Each phase is a list of slices. Every slice ends in a working screen and an owner acceptance, except in Phase 0.

| Phase | Name | Slices | Phase exit criteria |
|---|---|---|---|
| **0** | Foundation kernel *(no UI — the only exception)* | 0.1 monorepo + CI boundary checks · 0.2 Money/Qty/UnitCost/Ulid/Clock · 0.3 TenantContext, AccessControl, PeriodGuard, AuditWriter, IdempotencyStore, UnitOfWork, NumberingService, Outbox + one reference use case | `/health` returns 200; all CI gates green; boundary checker proven to catch a violation; cross-tenant, RLS, idempotency, period-lock and concurrent-numbering tests pass |
| **1** | Tenant, auth, settings, audit | 1.1 register tenant via OTP (mobile **or** email) → set username/password/PIN → land on an empty dashboard · 1.2 log in / log out (email+password, phone+password, PIN, Google) + forgot-password via OTP + change password/PIN in Settings · 1.3 create and edit users · 1.4 create roles and assign permissions · 1.5 change a setting and see it take effect · 1.6 view the audit trail of everything above · 1.7 deployment-mode providers (D-33…D-36) + boot validation + license states | Owner registers, creates a user, assigns a role, changes a setting — all in the UI, all audited. Both `saas-smoke` and `onprem-smoke` green; registration returns 404 in single-tenant mode |
| **2** | Master data | 2.1 create a product, see it listed · 2.2 brands and categories · 2.3 product search + brand/category filter · 2.4 barcode search and scan · 2.5 units and conversion (D-10) · 2.6 create a party and assign roles · 2.7 party search + role-filtered lists · 2.8 customer phone uniqueness + walk-in customer | Products and parties fully usable in the UI with permissions enforced |
| **3** | Inventory core *(Gate G2)* | 3.1 opening stock entry → movement + journal + lot · 3.2 stock list with on-hand quantities · 3.3 lot list and lot detail per product · 3.4 costing method setting (FIFO/AVERAGE) · 3.5 stock valuation report · 3.6 negative-stock policy · 3.7 stock movement history with drill-down | Opening stock posts movements and journal; **INV-01…INV-05 green under both costing methods**; valuation equals the `INVENTORY` account exactly |
| **4** | Money accounts | 4.1 create cash accounts (`CASH:{id}` — drawer, safe) with opening balances · 4.2 **Start Day** with counted opening cash + declared source/destination for any difference · 4.3 **End Day** with expected vs counted and short/over posting · 4.4 create a bank account with opening balance · 4.5 cash and bank statements · 4.6 owner injection / withdrawal | Cash and bank balances provable from journal; **the §5.16.6 worked example reproduces exactly**, including the Day-1 shortage surviving all three Day-2 outcomes; INV-07 a/b/c green |
| **5** | Purchase vertical *(first real milestone)* | 5.1 record a purchase → lot + stock + payable · 5.2 purchase list and detail · 5.3 pay a supplier → payable falls, cash falls · 5.4 supplier ledger statement · 5.5 edit and void a purchase with full reversal | Purchase → stock → lot → payable → payment → ledger → cash, verified manually with pre-written numbers |
| **6** | Sales vertical *(Gate G3)* | 6.1 POS sell from own stock → invoice + stock out + COGS · 6.2 customer selection and walk-in · 6.3 multi-method payment and due · 6.4 print and reprint an invoice · 6.5 customer ledger statement · 6.6 receive a payment with allocation and advance · 6.7 sale templates (D-26) · 6.8 void a sale with full reversal | Full core business cycle passes manually; POS performance budget met |
| **7** | Corrections & adjustments | 7.1 sales return · 7.2 purchase return · 7.3 stock reconciliation · 7.4 record an expense (incl. salary to a party) · 7.5 backdate a transaction · 7.6 close a period and prove `PERIOD_LOCKED` · 7.7 unlock with step-up auth and reason | Correction scenarios pass; locked-period write returns `PERIOD_LOCKED`; every correction auditable |
| **8** | Purchasing extras | 8.1 purchase order → approve → convert · 8.2 landed cost allocation · 8.3 consignment sale (deemed purchase, DR13.10) · 8.4 serial capture on purchase and sale · 8.5 warranty claim lifecycle incl. supplier send | Consignment, landed-cost and warranty scenarios pass with correct journals |
| **9** | Reporting *(Gate G4)* | 9.1 sales reports · 9.2 purchase reports · 9.3 inventory reports · 9.4 finance reports · 9.5 "Why?" drill-down on every total · 9.6 dashboard cards · 9.7 Daybook view · 9.8 Daybook day-end print | Report figures reconcile to journal and movements (INV-10); **Daybook totals equal Reports totals**; day-end print verified on A4 and 80mm |
| **10** | SaaS layer | 10.1 subscription plans and entitlement gating · 10.2 tenant lifecycle · 10.3 `.sherdb` export · 10.4 `.sherdb` import/restore · 10.5 SMS wallet + bKash top-up | Entitlement gating verified per feature; backup → wipe → restore matches exactly |
| **11** | Bank reconciliation | 11.1 import a statement · 11.2 match transactions · 11.3 create missing transactions · 11.4 mark reconciled · 11.5 review flag on later edits | Reconciliation scenarios pass |
| **12** | Offline *(Gate G5)* | Sliced at the start of the phase: **persistence gate (D-24) first** · profile registration + device authority · SQLite WASM/OPFS adapter · outbox push · pull · conflict quarantine · local backup export/import | SY-01…SY-16 pass; an offline day equals the online result exactly; no write is ever accepted without granted persistent storage |
| **13** | PWA polish | Sliced at the start of the phase | Core POS and reports usable on a tablet |
| **14** | AI/MCP + on-prem packaging | Sliced at the start of the phase; read tools before any write tool | AI actions audited, permission-bound, explainable; on-prem install and upgrade verified on a clean VM |
| **15** | Reusable core extraction | Package hardening | Core packages published internally, one sample reuse |

## 6.1.1 Slice status ledger

**The only record of what is built.** The agent appends or updates its own row as the final step of a slice, in the same commit as the code. Nothing else tracks progress — do not create a status file, a task log, or a README for this.

Rules:

- A row is added when a slice **starts** (status `IN PROGRESS`), and completed when it ends.
- `DONE` requires all four gates green **and** owner acceptance. An agent may set `CODE COMPLETE`; **only the owner sets `DONE`.**
- Commit hash is the merge commit of the slice.
- Never delete or rewrite a row. A slice reopened later gets a new row with the same number and a note.
- Each phase exit is tagged in git: `git tag phase-3-complete`.

| Slice | Name | Status | Commit | Owner accepted | Note |
|---|---|---|---|---|---|
| 0.1 | Monorepo skeleton + CI boundary checks | DONE | ef3482f | 2026-08-16 | No UI (Phase 0 foundation exception, §6.0). Owner accepted on the four green commands; no UI check applicable. |
| 0.2 | Money / Qty / UnitCost / Ulid / Clock | CODE COMPLETE | 75b498e | — | No UI (Phase 0 foundation exception, §6.0). 100% branch coverage on money.ts and qty.ts enforced as a build gate. |
| 0.3 | TenantContext, AccessControl, PeriodGuard, AuditWriter, IdempotencyStore, UnitOfWork, NumberingService, Outbox + reference use case | CODE COMPLETE | — | — | No UI (Phase 0 foundation exception, §6.0). CreateNoteService is the R-D template. CI still has no PostgreSQL service — see the slice report. |
| 1.1 | Register tenant via OTP → username/password/PIN → empty dashboard | TODO | — | — | |
| 1.2 | Login / logout + forgot password + change password/PIN | TODO | — | — | |
| 1.3 | Create and edit users | TODO | — | — | |
| 1.4 | Create roles and assign permissions | TODO | — | — | |
| 1.5 | Change a setting and see it take effect | TODO | — | — | |
| 1.6 | Audit trail of everything above | TODO | — | — | |
| 1.7 | Deployment-mode providers (D-33…D-36) + boot validation + license states | TODO | — | — | |

Rows for Phase 2 onward are added as each phase begins, from the slice lists in §6.1.

**Critical path:** `0 → 1 → 2 → 3 → 5 → 6 → 7 → 9 → 12`. Phases 4, 8, 10, 11 can absorb slippage. 13/14 come strictly after 12.

**Slice lists for phases 0–11 are fixed above.** Phases 12–15 are sliced at the start of the phase, because slicing them now would encode decisions that have not been made. Adding, splitting or reordering a slice within a phase is fine and expected; skipping the manual acceptance at the end of one is not.

## 6.2 Why this order differs from the module numbering

| Change | Reason |
|---|---|
| Settings (26) + Audit (27) in Phase 1 | Retrofitting audit and a settings registry into posted transactions means rewriting every service |
| Cash (19) + Bank (20) **before** purchase/sales payments | A payment must credit/debit a real account, otherwise payments get rebuilt twice |
| Purchase (10) **before** Sales/POS (08) | Stock must exist before it can be sold; purchase exercises lots + costing + supplier ledger + cash first, giving earlier end-to-end proof |
| Ledgers (17, 18) are not separate build steps | They are projections delivered with Purchase and Sales |
| Subscription (03) full build later, interface earlier | Avoids blocking core ERP work on billing decisions |
| Bank reconciliation (21) after Reports | Depends on stable bank transactions and a correction/audit story |
| Daybook (32) in Phase 9 | Reads from every transactional module, so it cannot precede them; must not be deferred past Reports because it is the owner's primary daily verification tool |
| Platform OTP SMS in Phase 1, SMS wallet (29) in Phase 10 | Phase 1 cannot exit without a working OTP. They are separate concerns sharing a transport (§5.24) |
| No phase for tax | D-09 revised — VAT removed from V1. Columns reserved and `NULL` |

## 6.2.1 Acceptance criteria — what "done" means at each level

| Level | Complete when |
|---|---|
| **Slice** | All four gates in `AI_CODING_INSTRUCTIONS.md` pass, including manual UI acceptance against numbers written before the code existed |
| **Phase** | Every slice in the phase is complete · the phase exit criteria in §6.1 are met · full regression green including earlier phases · the baseline scenario still passes end to end |
| **Gate** | Owner has personally run the gate's scenarios and signed off (§6.3) |
| **V1** | Phases 0–11 complete; offline (12) and MCP (14) are post-V1 |

## 6.3 Gate reviews (owner sign-off required)

| Gate | After | Question answered |
|---|---|---|
| G1 | Phase 0 | Is the skeleton safe for AI agents to build on? |
| G2 | Phase 3 | Is inventory + costing correct on real data? |
| G3 | Phase 6 | Is the core business cycle correct end to end? |
| G4 | Phase 9 | Do reports match reality? |
| G5 | Phase 12 | Does offline produce identical results to online? |

## 6.4 Environment

Debian on WSL2. Code lives at `~/projects/shererp` — **never** under `/mnt/c/`, which is ~10× slower for `node_modules`.

```bash
# Node 20 LTS via nvm, pnpm 9, Docker Engine (not Docker Desktop)
docker run --name sher-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=sher_dev -p 5432:5432 --restart unless-stopped -d postgres:16
docker exec -it sher-pg psql -U postgres -c "CREATE DATABASE sher_test;"
```

Two databases: `sher_dev` for manual testing, `sher_test` for automated tests. Sharing one means test runs wipe your hand-entered data at the worst possible moment. Pin `postgres:16` — the production server runs 16.

## 6.5 On-premise deployment

Four containers via Docker Compose: `nginx`, `api`, `db`, `backup`. PostgreSQL bound to the internal Docker network only, never `0.0.0.0`.

**The Vue app must read its API base URL at runtime**, from `/config.json` served by nginx — not from `import.meta.env.VITE_API_URL`. A baked-in URL forces a per-customer frontend build and collapses the one-artifact rule.

**Prerequisites (state in the sales agreement):** Ubuntu 22.04 LTS + Docker, 2 core / 4 GB minimum (4 core / 8 GB recommended), 60 GB SSD, static LAN IP, and a **UPS — not optional**. Repeated hard shutdowns during electricity instability will eventually corrupt something and the customer will blame the software.

**`install.sh` order:** verify prerequisites → validate license signature (**abort if invalid, before touching anything**) → TLS cert → start `db`, wait healthy → migrations → `SeedTenantProvisioner` → admin user with `must_change_password` → start `api`, `nginx`, `backup` → health check, print LAN URL and one-time credentials → **immediately take a baseline backup and verify it restores**.

**`upgrade.sh`:** validate license active → `pg_dump` (abort on failure) → pull → migrate → health check → auto-rollback to the dump on failure. Forward-only migrations. Support the current major and one previous; publish the window.

**License key:** signed JWT (Ed25519), validated offline against an embedded public key. Private signing key lives only on the release machine. `term.expires` and `support_until` are separate fields. `limits.users` warns first, then blocks. Sell license term separately from annual maintenance (~18–22% of license value).

**Diagnostic bundle export** (Phase 14): one-click zip with 7 days of logs, app/schema versions, license state, configuration with secrets redacted, row counts, DB size, slow-query summary, health-check results. Without it every support ticket becomes a phone call with a non-technical shopkeeper.

**Sales constraint: cap on-premise customers at 2–3 until V1 is stable.** Each install multiplies support surface with no remote visibility. Take the first customers close to home.

**Standalone single-PC offline is not available until Phase 12 completes.** Do not sell it. When it arrives it is the installed PWA on SQLite WASM + OPFS — **not** a desktop application (D-20), so do not describe it to a customer as one. On-premise LAN solves the connectivity problem today: the server sits inside the shop and an internet outage is irrelevant.

**COOP/COEP headers are required** on the app origin for `SharedArrayBuffer`, which SQLite WASM needs for OPFS synchronous access. nginx must set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the frontend, in both SaaS and on-premise. Any third-party asset that cannot be served with `Cross-Origin-Resource-Policy` must be self-hosted — verify this before Phase 12, not during it.

## 6.6 Working rhythm

One slice at a time, one slice per agent conversation:

```
1  Pick the next slice from §6.1
2  Write the acceptance criteria and expected numbers  ← BEFORE any code
3  Paste the kernel + slice task block
4  Agent replies with a PLAN                           ← cheapest checkpoint; if it looks wrong, stop here
5  Approve → agent implements the full vertical: domain → use case → migration →
   repository → API → UI → tests
6  Agent pastes REAL output of lint, typecheck, boundaries, test
7  Review the diff against the owner checklist
8  Run the slice in the real UI yourself and check the numbers
9  Commit
10 Next slice
```

Never skip step 8. Automated tests written by the agent that wrote the bug will happily agree with the bug — the numbers you wrote at step 2 are the only independent check in the system.

Before each phase: read the phase row · confirm the previous phase's exit criteria are met · **write the manual scenarios with expected numbers before any code exists.**

## 6.7 Honest expectations

- Phases 0–2 will feel disproportionately slow. You are building the foundations and machinery. Phase 0 produces nothing you can show anyone — just `/health` returning OK. That is correct.
- **Phase 5 is the first real milestone.** Buy stock, see it in inventory, pay the supplier, watch the ledger and cash agree — the architecture is proven and everything after is repetition of a working pattern.
- Something will be wrong in the money math at least once. The invariants and manual scenarios will catch it — if you actually run them.
- You will be tempted to skip Phase 0's boundary checker to reach visible features. Don't. It is the one thing that cannot be retrofitted, and it is what keeps the offline plan alive.
- **The biggest risk is not bad AI code. It is accepting good-looking AI code without verifying the numbers.**

---

# PART 7 — RISK REGISTER

Priority = Likelihood × Impact (1–5 each).

| ID | Risk | P | Mitigation | Escalate when |
|---|---|---|---|---|
| R-01 | **Retroactive re-costing** — editing/backdating purchases silently changes COGS of already-reported sales | 25 | DR13.9 recompute policy + `COST_TRUE_UP` postings + period lock + cost adjustments report | Any margin report mismatch |
| R-03 | **Business logic leaks into NestJS/Drizzle**, making offline a second implementation | 25 | Package boundaries + CI dependency check + rule set R-B | One boundary violation merged |
| R-02 | Sub-ledgers without a posting kernel drift; profit unprovable | 20 | Journal backbone from Phase 3 + INV-01..06 on every write test | First unexplained balance difference |
| R-05 | Float/decimal money errors | 20 | Integer minor units frozen in Phase 0 + lint ban on floats in money paths | Any `number` money field found |
| R-07 | **AI agent scope creep** — refactors unrelated modules, changes confirmed rules | 20 | Scoped prompts, ALLOWED FILES lists, small PRs, review by a second agent | Any PR touching >1 module |
| R-19 | **Owner is not a programmer ⇒ silent acceptance of wrong AI work** | 20 | Manual scenarios with pre-written expected numbers; invariant dashboards; review agent | Any module accepted without manual scenarios |
| R-25 | On-premise build forked from SaaS build ⇒ 31 modules maintained twice | 20 | Mode is configuration only; both modes smoke-tested in CI | Any `if (onPrem)` outside the three providers |
| R-06 | Duplicate invoice numbers online vs offline | 16 | Device-prefixed numbering, mandatory when offline enabled | Any duplicate observed |
| R-10 | Backup passphrase loss ⇒ permanent data loss | 16 | Explicit warning UX, optional escrow, export verification | First support case |
| R-13 | OTP cost + SIM-swap takeover | 16 | Rate limits, PIN/password for elevated actions, device binding | Abnormal OTP volume |
| R-21 | Period never closed ⇒ unlimited retroactive edits | 16 | Soft period lock + unlock permission + audit | First reopened month |
| R-26 | On-premise support load stalls module development | 16 | Cap at 2–3 customers until V1 stable; diagnostic bundle; published support window | 4th on-prem contract before Phase 12 |
| R-04 | Dual-writer conflicts if single-writer is relaxed | 15 | Single-writer V1; quarantine, never auto-merge financial docs | Any request to relax D-01 |
| R-08 | Cross-tenant leak through a forgotten `WHERE tenant_id` | 15 | Scoped repositories + PostgreSQL RLS + per-module isolation tests | Any raw SQL in a module |
| R-15 | Report numbers disagree with ledger | 15 | Reports read journal/movements only; INV-10 test | Any disagreement |
| R-27 | On-prem upgrade bricks a customer's live database | 15 | Mandatory pre-migration `pg_dump` with abort-on-failure, forward-only migrations, schema-version boot gate, auto-rollback | Any upgrade needing manual DB repair |
| R-09 | Offline device theft exposes tenant data | 12 | Encrypted local DB, OS keychain, license expiry, revocation, remote-wipe flag | Reported loss |
| R-12 | SMS top-up fraud via fake transaction IDs | 12 | No credit before verification, unique trx id, audit, rate limit | >2 disputed top-ups |
| R-14 | POS performance degradation as catalogue/history grows | 12 | Keyset pagination, trigram index, derived balances, CI perf budgets | p95 > budget |
| R-16 | Schema migration bricks an offline device | 12 | Auto-backup before migration, transactional migration, rollback path, version window | Any failed device migration |
| R-18 | Scope explosion (payroll, multi-currency requested mid-build) | 12 | Reserved fields now, explicit V1 boundary, decision gate | Any mid-phase scope request |
| R-20 | Vendor/consignment accounting modelled wrong | 12 | Vendor stock excluded from owned valuation; separate payable account | Valuation includes vendor stock |
| R-23 | Test suite slowness ⇒ agents skip tests | 12 | Fast domain tests, parallel integration, required CI checks, ban on skipping | Any `.skip` in main |
| R-24 | Sync quarantine backlog nobody resolves | 12 | Visible counter, blocking banner, weekly review, alerting | Backlog > 20 |
| R-28 | Frontend API URL baked in at build time | 12 | Runtime `/config.json`; CI asserts no `VITE_API_URL` in bundle | Any customer-specific frontend build |
| R-29 | SaaS deployed with `IDENTITY_VERIFIER=none` | 10 | Boot-time config validation; CI `invalid-config` gate | Any environment starting without verification |
| R-11 | Restore used to bypass plan limits | 9 | Entitlement re-evaluation on restore (D-08) | — |
| R-17 | **Browser evicts OPFS data holding un-pushed transactions** | 20 | D-24 hard gate: no write without PWA install + granted `persist()`; continuous quota + outbox-depth display; export prompt whenever the outbox is non-empty at session end | Any eviction observed, or any write path reachable without the gate |
| R-30 | WebUSB printing unavailable or refused mid-sale | 9 | Mandatory print-dialog fallback (D-22); posting is never coupled to printing | Any sale blocked by a printer |
| R-31 | COOP/COEP headers missing ⇒ SQLite WASM cannot use OPFS | 9 | Headers set in nginx for both modes; CI asserts them; assets self-hosted | Offline fails to initialise on a customer origin |
| R-22 | Bank reconciliation invalidated by later edits | 9 | Reconciled rows flagged; edits raise review, never silent | — |

---

# PART 8 — OPEN ITEMS

Everything the owner needed to decide is decided. These remain to be resolved **during** the relevant phase — they change implementation detail, not confirmed business rules. Record the answer by editing the relevant section above, not by creating a new file.

| # | Item | Resolve by |
|---|---|---|
| O-1 | Exact subscription package/feature matrix | Phase 10 |
| O-2 | Data retention window and purge job SLA for "delete server data" | Phase 10 |
| O-4 | Stock transfer document design between locations (D-17 confirms the requirement) | After multi-location UI |
| O-5 | POS performance budget numbers (p95 targets) to encode in CI | Phase 6 |
| O-6 | SQLite WASM + OPFS spike result — bundle size, cold-start time, snapshot import time, realistic quota on a low-end shop PC, and behaviour when `persist()` is refused (R-17) | Before Phase 12 |
| O-9 | WebUSB ESC-POS spike on the actual thermal printer models sold in Bangladesh — which respond to generic ESC-POS, which need a vendor quirk (D-22) | Before Phase 6 |
| O-7 | Who closes a period and when — manual close only, or auto-close after N days? Nobody closing anything is risk R-21 | Phase 7 |
| O-8 | Whether a *future* calendar month counts as OPEN (can a user post a forward-dated document?). Current rule rejects future `business_date`; confirm that is right for post-dated cheques | Phase 7 |

*O-3 (VAT field set) is closed — D-09 was revised on 2026-08-16 to remove tax from V1 entirely.*

---

# CHANGE LOG

Only decisions that changed after first finalisation. Update the relevant section above **and** add a line here — do not create a separate decision file.

| Date | Change |
|---|---|
| 2026-08-16 | **D-05 revised.** LIFO removed. One costing method per tenant (`FIFO`/`AVERAGE`) drives both journal COGS and valuation. The "lot consumption method" setting is removed — physical issue is always FIFO/FEFO. Reason: INV-05 was mathematically unsatisfiable under AVG and LIFO; valuation drifted permanently from the `INVENTORY` account |
| 2026-08-16 | **D-09 revised (owner override).** VAT/tax removed from V1; columns reserved and `NULL`. Accepted consequence: no VAT-compliant invoice until V2 |
| 2026-08-16 | **DR13.10 defined.** Consignment sale posts as a deemed purchase at the moment of sale, reusing the standard path. Previously the balancing entry was undefined |
| 2026-08-16 | **M23 accounting defined.** Warranty replacement from own stock posts `DR WARRANTY_EXPENSE / CR INVENTORY`; supplier recovery credits it back. No warranty receivable |
| 2026-08-16 | **Cash session bound to its opening business date** (§5.16), resolving a conflict with Daybook DR6 for shops trading past midnight |
| 2026-08-16 | **Platform OTP split from the tenant SMS wallet** (§5.24). OTP is Phase 1; the wallet stays Phase 10. Phase 1 previously could not exit |
| 2026-08-16 | **Idempotency clarified.** `Idempotency-Key` and `operation_id` are one value; `operation_id` is retained permanently and uniquely indexed, so a sync replay after the 30-day prune cannot duplicate |
| 2026-08-16 | **Build plan restructured around vertical slices** (§6.0). Every slice ships UI and ends in owner acceptance |
| 2026-08-16 | **Cash drawer / business day session fully specified** (§5.16). Start Day counted opening, immutable computed expected, End Day counted closing, permanent storage of expected/actual/difference, and next-day opening never forced to equal the previous close |
| 2026-08-16 | **`CASH` → `CASH:{id}`.** Cash is per account (drawer, safe), so cash leaving the drawer always has a named destination instead of vanishing into an adjustment |
| 2026-08-16 | **`CASH_SHORT_OVER` added** to the closed account list. Drawer shortage debits it, overage credits it, on the closing session's own business date. Without this the `CASH` balance would permanently disagree with the physical drawer and INV-07 could not hold |
| 2026-08-16 | **`OWNER_CURRENT_ACCOUNT` added**, signed both ways, `party_id` on the journal lines. Counterpart for owner cash injections and withdrawals |
| 2026-08-16 | **One drawer session per business day per tenant.** The former per-cashier session scope is removed; `cash.day.start` and `cash.day.end` become their own permissions and are not held by the Cashier role |
| 2026-08-16 | **INV-07 restated** in three parts: expected formula, closed-session ledger equals counted cash, and no unexplained opening-balance delta |
| 2026-08-16 | **D-21…D-24 renumbered to D-33…D-36.** The deployment-mode provider decisions (`IdentityVerifier`, `TenantProvisioner`, `EntitlementProvider`, license term) are unchanged in substance and moved to §4.4. References updated in §5.2 M02, §5.24 SMS table and Phase 1 slice 1.7. **Any prompt or transcript citing "D-21…D-24 providers" means D-33…D-36** |
| 2026-08-16 | **D-21 (new) — stack confirmed:** Vue 3 + Vite PWA + NestJS. T3 rejected: it breaks the REST/OpenAPI contract shared by mobile, on-prem and MCP, and has no path to running the domain in the browser |
| 2026-08-16 | **D-22 (new) — receipt printing:** WebUSB ESC-POS primary with a **mandatory** browser print-dialog fallback. Posting a sale is never coupled to printing. New risk R-30, new open item O-9 |
| 2026-08-16 | **D-23 (new) — offline storage engine: SQLite WASM + OPFS.** Replaces the IndexedDB wording in D-01 and §5.23. IndexedDB cannot express transactional multi-table writes or the ten-step write path, so it is rejected as the engine. Requires COOP/COEP headers — new risk R-31 |
| 2026-08-16 | **D-24 (new) — eviction policy:** PWA install + granted `navigator.storage.persist()` before any offline write. R-17 repurposed from Tauri packaging to OPFS eviction and raised to score 20 — it is the only unrecoverable failure mode in the offline design |
| 2026-08-16 | **D-20 revised — Tauri REJECTED.** No desktop shell, no local Node/NestJS sidecar, no Rust. Offline lives inside the PWA. §1.2 delivery sequence, §1.3 stack table, §2.1 layout (`apps/desktop` removed, `adapter-sqlite` → `adapter-sqlite-wasm`), §2.3 write path, §5.23, Phase 12 slices and §6.5 updated. Consequence accepted: no OS-level integration, offline capacity bounded by browser quota |
| 2026-08-16 | **D-07 revised.** OTP is for signup verification and password recovery only — **never daily login**. Signup takes one field (mobile or email), sends a 6-digit OTP to that channel, then sets username + password + PIN. Daily login is email/phone + password, PIN, or Google. Forgot password sends OTP to the registered email or phone. Full flows, OTP rules and identifier rules added to §5.3 M02; Phase 1 slices 1.1/1.2 updated. Reason: OTP-per-login makes SMS cost scale with daily usage |
| 2026-08-16 | **§2.7 added — frontend conventions UI-01…UI-44; D-37 and D-38 added.** Familiar consumer-app navigation patterns without visual imitation, English UI with selective Bangla helper text explaining business meaning (implements D-12, unchanged), four screen patterns, four required states, mutation and POS rules, PrimeVue 4 as the component library. No business rule changed. Reason: the spec required every slice to ship a real UI and be accepted in the UI, but specified nothing about what a screen should look like or how it should behave — leaving each slice to invent its own, which is expensive to unwind at thirty screens |
| 2026-08-16 | **D-01 revised.** Single writer per tenant now bound to a **registered browser profile**, not a device — a different browser or cleared profile on the same PC is a different writer. Authority bound to a profile keypair, so copying OPFS files does not carry write authority. Sync matrix extended with SY-13…SY-16 |
