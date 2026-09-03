# SherERP — Decisions

This file records **confirmed** decisions, not proposals or options under
discussion. Every entry below has already been made — by the owner directly,
or by the SRS's Part 4 final-decisions list — and is currently reflected in
the codebase or the authoritative documents. **A future agent must not reverse
any of these casually.** Where a decision changes a stored number, a
workflow, a permission, an account, or a security boundary, changing it is
governed by `AGENTS.md` critical rule 12: if the spec seems wrong or silent,
**stop and report** — do not decide it yourself.

**Authoritative sources**, in the order a future agent should read them:

1. `AGENTS.md` — R-0 (the owner's working protocol, outranks everything),
   critical rules, structure, scope discipline.
2. `SRS_AND_BUILD_GUIDE.md` — Part 4 "FINAL DECISIONS (D-01…D-43)", the golden
   invariants in §3.11, the closed account list in §2.4, and the CHANGE LOG at
   the end of the file, which records every decision later revised, with the
   date and the owner's reasoning.
3. `AI_CODING_INSTRUCTIONS.md` — how the decisions above translate into write
   paths, layering and Definition of Done.
4. `docs/AI_HANDOFF.md` — a synthesis of the same material for a cold start;
   this file must not contradict it.

Every entry below cites the decision id (`D-nn`), section (`§n.n`), invariant
(`INV-nn`), or change-log date it comes from. Nothing here is invented —
where a plausible-sounding rule could not be traced to one of the four
sources above, it was left out rather than guessed.

---

## 1. Product and business model

### 1.1 V1 ships as a single-business installed product, licence not subscription
**Decision** — V1 is one business, on-premise or a small VPS, entitled by an
offline Ed25519-signed licence key rather than a SaaS subscription.
**Reason** — Owner decision, config comment in `apps/api/src/config.ts`
(dated 2026-09-02): "V1 is a single-business installed product: an install
that lost a line from its environment file should be visibly READ_ONLY and
asking for a key, not quietly trading for ever on the permissive SaaS stub."
**Consequences** — `ENTITLEMENT_SOURCE` defaults to `license` (§4.4, D-35).
The subscription stub still exists in code but must be asked for by name.
**Reconsider when** — the owner decides to launch the SaaS multi-tenant
product; never as a side effect of another module's work.

### 1.2 SaaS and on-premise are the same build, config-selected
**Decision** — Signup, OTP and subscription billing are disabled by
configuration for on-premise, never deleted or forked into a separate
codebase. Multi-tenancy (`tenant_id`, RLS) is fully built and enforced in
both modes.
**Reason** — §4.4 governing rule; D-33…D-36 make `IdentityVerifier`,
`TenantProvisioner`, `EntitlementProvider` and licence term all pluggable
behind interfaces switched by `SINGLE_TENANT_MODE`, `IDENTITY_VERIFIER`,
`ENTITLEMENT_SOURCE`.
**Consequences** — Boot validation refuses unsafe combinations before
serving (e.g. `SINGLE_TENANT_MODE=false` + `IDENTITY_VERIFIER=none`;
`SINGLE_TENANT_MODE=true` + `BILLING_ENABLED=true`).
**Reconsider when** — never without the owner; a separate on-premise fork is
explicitly forbidden (§2.6, "31 modules maintained twice — project-ending").

### 1.3 VAT/tax removed from V1
**Decision** — Tax is not calculated, posted, or printed in V1. Reserved
columns (`tax_rate_id`, `tax_amount`, `is_tax_inclusive`) exist on
transaction lines and stay `NULL`.
**Reason** — D-09, owner override, 2026-08-16, chosen over implementing tax
in Phase 6, which would have forced re-costing every lot created in Phase 5.
**Consequences** — Accepted knowingly: SherERP cannot issue a VAT-compliant
invoice in V1; a customer requiring one cannot be sold to until V2.
**Reconsider when** — V2 tax module is scoped and questioned through the
normal module-start process; never inferred from a customer request alone.

### 1.4 Party system is unified; Expense is not a Party role
**Decision** — One `parties` table with role flags `CUSTOMER`, `SUPPLIER`,
`VENDOR`, plus optional `EMPLOYEE` identity. Expense categories (Salary,
Rent, Transport, …) are a separate classification, not a party role; an
expense may optionally reference a party as payee.
**Reason** — D-04, revised 2026-08-20.
**Consequences** — Selling to a supplier requires explicitly choosing the
transaction type; the party then appears in both histories. `EMPLOYEE` alone
creates no receivable/payable semantics.
**Reconsider when** — never without the owner; this was itself a revision of
an earlier design.

### 1.5 Guest sale identity: walk-in party, not a party-per-sale
**Decision** — A registered customer's phone is mandatory and unique per
`(tenant_id, phone)` **within the CUSTOMER role only**. A fully paid new
buyer uses one real, `system_reserved` walk-in party with immutable invoice
snapshots (name, phone, optional guardian/address) rather than creating an
individual party. A sale that leaves due must atomically create a real
customer.
**Reason** — D-02, revised 2026-08-17 (change-log entries 2026-08-17 and
2026-08-24 refine it further, including a first-day/return edge case).
**Consequences** — Snapshot phones are searchable but not unique; only a
due, advance or store credit forces a real party to be created.
**Reconsider when** — never without the owner; already revised twice to
reach this shape.

### 1.6 Credit limit is a warning, never a block
**Decision** — Exceeding a customer's credit limit shows a warning only; it
never blocks the sale.
**Reason** — D-11.
**Consequences** — Credit control is informational, not enforced by the
system. Credit Limit lives only on the customer detail form, not on
list/ledger columns (change-log 2026-08-20, entry 54) — it is configuration,
not a balance.
**Reconsider when** — never without the owner.

### 1.7 Quick-add from the point of use, system-wide
**Decision** — Any screen that picks an existing record (unit, brand,
category, supplier, customer, customer group, …) must also create that
record inline, asking only its mandatory fields, through the **same** use
case, permissions, validation and audit as the full form.
**Reason** — D-39, owner decision 2026-08-19: a shopkeeper entering a
delivery with the goods in front of them and a new supplier should not lose
the half-typed purchase by being sent to another screen.
**Consequences** — No relaxed second way to create anything exists; the
inline path is hidden from anyone without the create permission (UI-45).
**Reconsider when** — a later module introduces an equivalent picker — apply
the same rule, do not invent a new pattern.

### 1.8 Invoice templates are a saved line-item set, not a document
**Decision** — A template (`sale_templates`, `sale_template_lines`) is a
named set of product/qty/optional-price-override lines with no financial
effect and no journal entry. Loading one creates a **draft** sale; prices
re-read live from the product unless an explicit override was stored.
Recurring/scheduled invoices, auto-send and subscription billing are
excluded from V1.
**Reason** — D-26.
**Consequences** — A template can never be mistaken for a posted document in
a report or an audit trail — it has none of the columns that would let it
be.
**Reconsider when** — recurring/scheduled invoicing is scoped as its own
module, through the normal question-first process.

### 1.9 Mobile is the PWA for V1; native mobile is deferred and may be dropped
**Decision** — No React Native/Expo app ships in V1. The installed PWA is
the mobile client.
**Reason** — D-28.
**Consequences accepted** — no native barcode hardware (the browser camera
is judged adequate), no iOS push notifications, and browser-storage
eviction — the last of which is now governed by the hard gate in D-24
(§7.3 above), not merely accepted as a risk.
**Reconsider when** — never without the owner; native mobile may be dropped
entirely rather than merely delayed.

### 1.10 Payment verification is manual: bKash/Nagad personal accounts, Transaction ID checked by an admin
**Decision** — No merchant account. The customer submits a Transaction ID;
an admin verifies it manually before the payment is trusted.
**Reason** — D-16.
**Consequences** — API-based auto-verification may be added later, with
manual verification kept as the fallback — never replaced outright.
**Reconsider when** — a bKash/Nagad merchant API integration is scoped and
questioned through the normal module-start process.

---

## 2. Architecture and layering

### 2.1 Layered modular monolith, one-way dependency, CI-enforced
**Decision** — `api → application → domain → shared-utils`, one direction
only. `core-domain` imports only `shared-utils` and `zod`. Repository
interfaces are business-specific (`SaleRepository`, `InventoryRepository`) —
no `BaseRepository`, `GenericRepository`, `RepositoryFactory` or generic CRUD.
**Reason** — §2.1–2.2; `pnpm test:boundaries` enforces this on every commit.
**Consequences** — A contract change touches every layer above it; agents
working in parallel on the same layer conflict easily (per `CLAUDE.md`'s
subagent guidance).
**Reconsider when** — never without the owner; `test:boundaries` failing is
never bypassed (`AGENTS.md` Commands section, `AI_HANDOFF.md` §3).

### 2.2 `core-domain` and `core-application` stay browser-safe
**Decision** — No `fs`, `path`, `node:crypto`, NestJS, Drizzle, pg, or DOM
types in these two packages, even though they are not the browser bundle
today.
**Reason** — §2.1: "the same domain arithmetic runs in the till" — the
offline SQLite-WASM adapter (Phase 12+) and any future MCP/mobile client
reuse these packages unchanged.
**Consequences** — A convenient Node API cannot be reached for inside these
packages even when it would simplify one function.
**Reconsider when** — never without the owner; this is what makes the PWA
offline architecture (D-01, D-23) possible at all.

### 2.3 Canonical ten-step write path, one database transaction
**Decision** — Every Class T (financial/stock/document) write executes:
resolve tenant context → permission check → idempotency check → period-guard
assert-open → load aggregates → domain invariants → persist → post
journal + stock movements → audit event → commit, all in one transaction.
**Reason** — §2.3. Identical online, offline, and via future MCP.
**Consequences** — A partial write is never observable; a step cannot be
skipped or reordered without breaking the guarantee the whole posting kernel
relies on.
**Reconsider when** — never without the owner. Class S (security/identity)
and Class M (master/configuration) writes use explicitly smaller paths
instead — inventing fake period/journal/stock steps for them is itself a
rule violation (`AGENTS.md` critical rule 6).

### 2.4 `outbox` has been written since Phase 0; nothing read it until Phase 12
**Decision** — Every Class T write also writes an outbox record, deliberately
ahead of anything consuming it.
**Reason** — §2.3: "the explicit future-compatibility exception to YAGNI…
because a sync engine built later against a partial change history cannot
reconstruct what it missed."
**Consequences** — Looks like dead code to a linter or a cleanup pass; it is
not.
**Reconsider when** — never; `AI_HANDOFF.md` explicitly instructs "do not
remove outbox writes as unused code."

### 2.5 The shell mounts once, above the router
**Decision** — `AppLayout` holds the chrome (sidebar, top bar, footer) for
the whole session; only the page inside it changes on navigation. Page
spacing is owned by the shell, not by each page.
**Reason** — Change-log 2026-08-20 (two entries): every page previously
mounted its own copy of the shell, causing a blank frame and a sidebar that
forgot its collapsed state on every navigation; page-level spacing had
drifted to three different values across modules.
**Consequences** — A new page must not re-mount or restyle the shell, or the
same defect returns.
**Reconsider when** — never without the owner.

### 2.6 Daybook owns no business-transaction tables and no posting logic; `Daily` centralises entry points, not a second engine
**Decision** — Daybook (M32) is a read aggregator and source-action
dispatcher for day-end/notebook review — it owns no edit or posting logic of
its own. The `Daily` sidebar category (POS, Counter, Daybook, Daily Cash)
and party/expense/account ledger "working hubs" are multiple entry points
that must converge on the same underlying application use cases; Counter
(Quick Transactions) centralises manual Receive/Payment/Expense entry
without owning a posting path of its own.
**Reason** — D-27, D-42.
**Consequences** — A row action opened from Daybook, a party ledger, or
Counter must call the one authoritative service each transaction type
already has (`AGENTS.md` critical rule 17, "many entry points, one owning
module interface") — never a Daybook-local or Counter-local copy of posting
logic.
**Reconsider when** — never without the owner.

---

## 3. Data model and database conventions

### 3.1 All IDs are ULIDs generated in application code
**Decision** — No autoincrement, no DB-generated IDs, no id generated in SQL.
**Reason** — §3.1: "an offline device must create valid IDs before reaching
the server, and sequences do not survive sync." Also why new permission
codes are backfilled by a script rather than a migration (`AI_HANDOFF.md`
§11).
**Consequences** — A migration that seeds rows needing IDs must call
application code (a script), never `SERIAL`/`gen_random_uuid()` inline.
**Reconsider when** — never; this is load-bearing for offline sync.

### 3.2 `tenant_id` on every business table, sourced only from `TenantContext`
**Decision** — Every business table carries `tenant_id`, resolved from
`TenantContext` — never from a request body, query string or URL. Row-Level
Security is enabled on every business table as a second line of defence.
Cross-tenant denials return **404**, not 403.
**Reason** — §3.2, `AGENTS.md` critical rule 5, INV list in `AI_HANDOFF.md`
§5 item 7.
**Consequences** — RLS tests must connect as an **unprivileged** DB role — a
superuser bypasses RLS and would make isolation tests pass against nothing
(`AI_HANDOFF.md` §10).
**Reconsider when** — never; this is the tenant-isolation invariant.

### 3.3 Money and quantity are integers in minor units
**Decision** — Money: `BIGINT`, scale 2 (poisha). Quantity: `BIGINT`, scale
3. Unit cost: `BIGINT`, scale 4. No `FLOAT`/`REAL`/`DOUBLE`, no
`NUMERIC`/`DECIMAL` anywhere, in either the PostgreSQL or the future SQLite
dialect.
**Reason** — §3.3: SQLite has no decimal type, so float or numeric storage
guarantees online/offline divergence. Unit cost carries 4 decimals because
FIFO consumption of fractional quantities against a 2-decimal cost
accumulates error across thousands of movements.
**Consequences** — All arithmetic goes through `Money`/`Qty`/`UnitCost`
helpers in `@sher/shared-utils`; a component or use case computing totals by
hand is a defect regardless of whether it happens to agree.
**Reconsider when** — never; this is CI-enforced and cited in `AGENTS.md`
critical rule 4.

### 3.4 Rounding: half-up, once, at the boundary; largest-remainder allocation
**Decision** — Rounding mode is half-up, applied once at the storage or
display boundary, never on intermediates. Line total =
`round(qty × unit_price)`; document total = sum of already-rounded line
totals. Splitting one amount across lines (landed cost, discount, payment
allocation) uses the largest-remainder method with tie-break by ascending
line index.
**Reason** — D-31, §3.3. "The invoice must equal what the customer can add
up by hand." CI-asserted reference values: `allocate(1000,[1,1,1]) →
[334,333,333]`, `allocate(100,[3,1]) → [75,25]`.
**Consequences** — The split is deterministic across server, browser and any
future offline device; parts always sum exactly to the whole, even when
total < number of parts (`allocate(1,[1,1,1]) → [1,0,0]`).
**Reconsider when** — never; this is a shared, CI-tested algorithm, not a
per-module choice.

### 3.5 Three standard column classes (A/B/C) — never mix them
**Decision** — Class A (mutable master data/documents): id, tenant_id,
created/updated_at/by, `version`, `deleted_at`/`deleted_by`. Class B
(transactional documents): Class A plus `business_date`, `entry_mode`,
`status`, `operation_id`. Class C (append-only ledgers — `stock_movements`,
`journal_entries`, `journal_lines`, `audit_events`, `lot_consumptions`,
`cost_adjustments`): id, tenant_id, created_at, created_by only.
**Reason** — §3.4: "an append-only table with `deleted_at` invites someone
to soft-delete a journal line."
**Consequences** — A new table must be classified correctly before its first
migration; giving Class C a `deleted_at` is a defect even if nothing uses it
yet.
**Reconsider when** — never; the classes are fixed and CI/schema review
depends on them.

### 3.6 `entry_mode` is computed at write time, not chosen by the user
**Decision** — `ON_TIME` / `LATE_ENTRY` / `BACKDATED` / `CORRECTED`, derived
by the use case from `business_date` versus the tenant-local date of
`created_at`. `CORRECTED` always wins. A future `business_date` is rejected.
**Reason** — §3.4.
**Consequences** — No UI control sets this field directly.
**Reconsider when** — never without the owner.

### 3.7 Document numbering: `{PREFIX}-{YYYY}-{NNNNNN}`, per-tenant sequence, never reused
**Decision** — Sequence per `(tenant_id, doc_type, year)`, resetting
annually, allocated inside the document's own transaction from a
`numbering_counters` row held with `SELECT … FOR UPDATE`. Voided numbers are
never reused. `device_prefix` is reserved (empty in V1) for future offline
devices (`INV-D2-2026-000123`), and becomes mandatory once offline write is
enabled.
**Reason** — D-30, §3.7.
**Consequences** — A gap in the sequence is normal and auditable; filling
one destroys the trail.
**Reconsider when** — never; this is the same mechanism the offline sync
design already assumes will still work when devices exist.

### 3.8 Concurrency: optimistic on documents, pessimistic on lot consumption
**Decision** — Two users editing one document race on `version`
(`CONFLICT_STALE_VERSION`). Two sales consuming the same lot use
`SELECT … FOR UPDATE`, lots ordered by `id` to avoid deadlock. Document
numbering also uses `SELECT … FOR UPDATE` on the counter row.
**Reason** — D-32, §3.8: "Optimistic retry on stock produces oversell under
POS load — a customer paying for goods not on the shelf."
**Consequences** — Lot consumption code must never be converted to
optimistic locking for "simplicity" or performance.
**Reconsider when** — never; this is a correctness requirement under
concurrent POS load, not a performance tuning knob.

### 3.9 Keyset pagination only; `OFFSET` is banned
**Decision** — Every paginated endpoint pages by the ULID id (plus, per the
2026-08-19 change-log entry, the active sort key as a mandatory tiebreaker
alongside `id`).
**Reason** — §3.9: "it degrades exactly as a shop's history grows." Without
the `id` tiebreaker, rows on a page boundary shuffle and a shopkeeper paging
low stock sees one product twice and another never (change-log 2026-08-19).
**Consequences** — Sort options per endpoint come from a closed, indexed
allow-list, not an arbitrary column.
**Reconsider when** — never.

### 3.10 Migrations are forward-only and additive
**Decision** — No down-migrations; rollback is restore-from-backup. Adding a
nullable column is safe; dropping or renaming is not — remove a column by
stop-writing → deploy → verify → drop in a later release. Every migration
runs in its own transaction, recorded by full filename.
**Reason** — §3.10. Two files may share a numeric prefix; ordering between
them is then decided by the text after the underscore (`AI_HANDOFF.md` §11).
**Consequences** — Do not create a duplicate numeric prefix where order
matters.
**Reconsider when** — never.

### 3.11 Dual-date model: `business_date` drives every ledger/report/period-lock; `created_at` is audit-only and immutable
**Decision** — All timestamps are stored `TIMESTAMPTZ` in UTC. Each tenant
has a timezone (default `Asia/Dhaka`). `business_date` (the "Transaction
Date") is a `DATE` computed in the **tenant's** timezone via the injected
`Clock` port, and is what every ledger, report, Daybook view and period lock
uses by default. `created_at` (the "Entry Date") is audit-only, immutable,
and only ever selectable as an alternate view — never a reporting basis.
Correcting a document's transaction date never rewrites its entry date.
**Reason** — D-29 (§3.5), D-43 (owner decision 2026-08-20, "Dual-date ledger
and reconciliation model"). "A sale at 00:30 Dhaka is 18:30 UTC the previous
day. Getting this wrong moves a day's takings into the wrong report, and
both numbers look plausible" (§3.5).
**Consequences** — Tenant-local day boundaries are converted to instants in
the **use case**, never in SQL. Account reconciliation may change a
transaction's date, add missing entries, or correct/reverse through the
source use cases; reconciled history that is later changed becomes
review-required rather than silently re-accepted.
**Reconsider when** — never; this is CI-relevant (the `Clock` port
boundary check) and load-bearing for every report in the product.

---

## 4. Accounting and posting

### 4.1 The internal account list is closed
**Decision** — `AR`, `AP`, `CASH:{id}`, `BANK:{id}`, `LOAN:{id}`,
`INVENTORY`, `COGS`, `SALES`, `EXPENSE:{cat}`, `VENDOR_PAYABLE`,
`CUSTOMER_ADVANCE`, `SUPPLIER_ADVANCE`, `VENDOR_ADVANCE`,
`WARRANTY_EXPENSE`, `CASH_SHORT_OVER`, `STOCK_ADJUSTMENT`,
`OWNER_CURRENT_ACCOUNT`, `ROUNDING`, `OPENING_EQUITY`. Nothing else.
**Reason** — §2.4: "This list is closed — an agent needing an account not on
it must **stop and report**, because a new account changes what every report
means." `CASH_SHORT_OVER` and `OWNER_CURRENT_ACCOUNT` were added 2026-08-16;
`STOCK_ADJUSTMENT` was added 2026-08-20 as a P&L stock-shrinkage account for
the same reason `CASH_SHORT_OVER` exists (change-log entry 31); the
`SUPPLIER_ADVANCE`/`VENDOR_ADVANCE` current-asset accounts were added
2026-08-20 so advances are not misclassified as negative liabilities
(change-log entry 56).
**Consequences** — A physical stock count or a cash count always has
somewhere to balance to; without it `INVENTORY`/`CASH:{id}` would permanently
disagree with what is actually on the shelf/in the drawer.
**Reconsider when** — never without the owner; adding an account is
explicitly an owner-level decision, not an implementation detail.

### 4.2 Every journal entry balances; reports never recompute from documents
**Decision** — Σ debit = Σ credit on every journal entry (INV-01). Every
monetary/quantity figure in a report is derived from `journal_lines` or
`stock_movements`, never recomputed from a document field (INV-10);
descriptive dimensions (customer name, cashier, brand) may still be joined
from documents.
**Reason** — §3.11. "INV-10 prevents the classic ERP failure where the
dashboard and the ledger disagree and nobody can say which is right."
**Consequences** — A second profit or total figure computed from a document
is a defect even when it happens to agree with the ledger.
**Reconsider when** — never; CI-asserted on every commit touching money or
stock.

### 4.3 Nothing posted is ever mutated or hard-deleted
**Decision** — Posted documents are void/reversed, then re-posted for a
correction, same document id, `version + 1`. Movements, journal lines and
audit events are append-only with no delete path in code. Draft (never
posted) documents may still be hard-deleted.
**Reason** — §2.5, §3.6, `AGENTS.md` critical rule 7.
**Consequences** — "Edit posted document" always means reverse + re-post;
there is no direct `UPDATE` on a posted total anywhere in the codebase.
**Reconsider when** — never.

### 4.4 Cash is moved, never assigned; a stored expected close is immutable
**Decision** — An opening cash figure that differs from the previous
counted close needs a posted movement with a named source/destination. The
stored expected drawer amount never changes to match a count — the
difference posts to `CASH_SHORT_OVER` instead.
**Reason** — §2.4, INV-07 (three parts: expected formula; closed-session
ledger equals counted cash; every opening-to-close delta is explained by a
posted movement). `CASH:{id}` is per cash account (drawer, safe, second
counter), added 2026-08-16 for exactly this reason.
**Consequences** — A shop's first day is a documented edge case
(change-log 2026-08-24): the counted opening is compared against the
drawer's ledger balance, and on day one that whole difference needs a named
source.
**Reconsider when** — never; this is what keeps the ledger and the physical
drawer reconcilable.

### 4.5 `OWNER_CURRENT_ACCOUNT` is not equity, and `LOAN:{id}` is a separate liability
**Decision** — `OWNER_CURRENT_ACCOUNT` is signed both ways (credit = owed to
owner, debit = owner owes the business) and no screen may label its balance
"Equity". An owner *loan* to the shop is a different thing and posts to
`LOAN:{id}` with the owner as lender — never to the current account. Loan
principal and interest are posted separately (principal only moves
`LOAN:{id}`; interest posts to `EXPENSE:LOAN_INTEREST`). Loan accounts are
never a payment method and are never counted in Total Cash/Bank/MFS.
**Reason** — Owner decision 2026-08-31 (Finance module), §2.4.
**Consequences** — `LOAN:{id}` is deliberately not part of the `BANK:{id}`
family — putting it there would overstate what the shop holds by exactly
what it owes, with no way to separate them afterward since the account code
is all a journal line carries.
**Reconsider when** — never without the owner.

### 4.6 Period lock is a service, not a module; unlocking a closed month requires step-up
**Decision** — `PeriodGuard` in `core-application`, calendar-month
granularity per tenant, enforced inside every use case writing a
`business_date`. Unlocking requires `finance.period.unlock` **plus** step-up
auth **plus** a mandatory reason, and writes an audit event. Re-costing
true-ups never silently cross a closed period — they post in the current
open month as a correction referencing the original.
**Reason** — D-25.
**Consequences** — A closed month rejects create/edit/void/backdate into it
with `PERIOD_LOCKED` until explicitly unlocked.
**Reconsider when** — never without the owner.

### 4.7 Balances are derived, recomputable projections — never the source of truth
**Decision** — `party_balance`, `stock_balance`, `account_balance` are all
computed from journal lines / stock movements. A nightly + on-demand
`verify` job recomputes and reports drift.
**Reason** — §2.4, INV-06.
**Consequences** — No screen or table stores a balance as its own authority;
the user never sees a chart of accounts — ledgers and terminology (Debit/
Credit, পাবো/দিব) are display mappings over the same signed journal lines.
**Reconsider when** — never.

### 4.8 Consignment sale and warranty replacement have fixed posting shapes
**Decision** — A consignment sale posts as a **deemed purchase at the moment
of sale**, reusing the standard purchase posting path. A warranty
replacement from own stock posts `DR WARRANTY_EXPENSE / CR INVENTORY`;
supplier recovery credits it back. There is no warranty receivable account.
**Reason** — Change-log 2026-08-16: "DR13.10 defined… previously the
balancing entry was undefined" and "M23 accounting defined."
**Consequences** — A different posting shape for either case would be a
silent account-list violation (see 4.1).
**Reconsider when** — never without the owner.

---

## 5. Inventory and costing

### 5.1 Two separate FIFO/AVERAGE settings; LIFO removed; one valuation basis
**Decision** — `inventory_issue_method` (operational lot allocation) and
`sale_costing_method` (POS/sales COGS and inventory valuation) are two
independent tenant settings, each `FIFO` or `AVERAGE` only. They may differ
operationally, but the accounting valuation method for journal COGS and
inventory valuation must always be the single `sale_costing_method` — never
a second basis.
**Reason** — D-05, revised 2026-08-18 (LIFO removed 2026-08-16, then the two
settings were split out).
**Consequences** — INV-05 states the exact valuation formula per method
(FIFO: Σ lot remaining × lot actual cost; AVERAGE: qty on hand ×
`product_cost_state.avg_unit_cost`) and both forms must tie to the
`INVENTORY` journal balance to the poisha.
**Reconsider when** — never without the owner; this is described as the
highest-risk module in §5.11.

### 5.2 No lot ever carries a negative remaining quantity
**Decision** — INV-03: no lot has negative remaining qty unless negative
stock is explicitly enabled at the product/tenant level (D-19); INV-04
requires Σ lot remaining qty to equal product on-hand qty per location.
**Reason** — §3.11; change-log 2026-08-20 entry 33 calls out a reference
build that got exactly this wrong when specifying stock adjustment.
**Consequences** — A decrease beyond stock on hand follows the negative-stock
policy and its true-up, never a raw negative lot row.
**Reconsider when** — never; CI-asserted.

### 5.3 Negative-stock sales use provisional last-known cost, recalculated later
**Decision** — Negative-stock sales are allowed. Cost uses the product's
last known cost as provisional; when actual cost arrives, affected COGS and
profit are recalculated per the configured costing method.
**Reason** — D-19.
**Consequences** — Profit is provisional and its display is blocked/marked
while any unresolved provisional cost or open negative-stock lot exists in
the reporting range (D-06).
**Reconsider when** — never without the owner.

### 5.4 Inventory tracked by Product + Location from day one
**Decision** — Quantity, lots, cost and valuation are tracked by Product +
Location from day one, even though V1 may expose only a single
auto-created default location.
**Reason** — D-17.
**Consequences** — Multi-warehouse and inter-warehouse transfer are additive
once a second location exists — no schema migration needed to introduce
them.
**Reconsider when** — never; this is why the schema already carries a
location dimension everywhere stock is tracked.

### 5.5 Serial uniqueness is per active serial, reusable after retirement
**Decision** — The same **active** serial cannot be used twice for the same
product within a tenant. After retirement it may be reused, with a warning.
**Reason** — D-18.
**Consequences** — Serial lookups must filter on active status, not treat
the column as globally unique.
**Reconsider when** — never without the owner.

### 5.6 Per-product unit conversion is optional and singular — one conversion unit, never a list
**Decision** — A product keeps its normal base unit and, only if it needs
one, **exactly one** conversion unit plus factor (e.g. `Base = Feet,
Conversion = Pipe, 1 Pipe = 20 Feet`). **All stock is stored and calculated
in the base unit** — `5 Pipe + 5 Feet` normalises to `105 Feet`, one figure,
never two. Purchase and POS show two quantity boxes for a product that has a
conversion, so a delivery of 5 Pipes and 5 loose Feet is entered as it
arrives. Prices are stored per base unit; the entry/display unit may be
switched, converting by the factor (exact one direction, half-up rounded the
other, per D-31). Stock displays in mixed form: `105 Feet` reads as
`5 Pipe + 5 Feet (105 Feet)`. A product with no conversion behaves exactly
as a single-unit product always has.
**Reason** — D-10, refined by D-41 (owner specification 2026-08-19).
"With several conversion units, `5 Pipe + 5 Feet` would not say which of
them it meant, and a stock figure that cannot be read unambiguously is a
stock figure nobody can count against."
**Consequences** — A product form or import path that tries to attach more
than one conversion unit to a product is implementing a feature that was
explicitly rejected, not an enhancement of this one.
**Reconsider when** — never without the owner; the single-conversion-unit
constraint is deliberate, not an unfinished list.

---

## 6. Security, authentication and multi-tenancy

### 6.1 OTP is for signup verification and password recovery only — never daily login
**Decision** — Signup: mobile-or-email → 6-digit OTP → verify → set
username/password/PIN in one flow. Daily login: email/phone + password, PIN,
or Google OAuth. Forgot password: OTP to the registered email or phone.
**Reason** — D-07, revised 2026-08-16: "OTP-per-login makes SMS cost scale
with daily usage."
**Consequences** — A verified, unknown Google email may create a tenant
(2026-08-17 revision), leaving `password_hash`/`pin_hash` NULL until the
user sets a password via forgot-password.
**Reconsider when** — never without the owner; already revised twice to
reach this shape.

### 6.2 Password/PIN hashing is Node's own scrypt — no bcrypt/argon2
**Decision** — scrypt, N=32768 r=8 p=1, parameters stored inside the hash
string so cost can be raised without invalidating existing credentials.
**Reason** — `AI_HANDOFF.md` §10 (rejected dependency list).
**Consequences** — Only the **PIN** hash travels to an offline snapshot,
never the password hash — a password opens far more than a till.
**Reconsider when** — never without the owner.

### 6.3 Step-up authentication is the caller's own password — a PIN never satisfies it
**Decision** — Sensitive actions (backdating into a closed period, force
revoke of a device writer, etc.) require the caller to re-enter their own
password.
**Reason** — §2.5, `AI_HANDOFF.md` §10, and the 2026-08-31 device-authority
change-log entry ("force revoke is the Owner's alone, with the **password**
(not the PIN) re-entered").
**Consequences** — A PIN-only session cannot perform a step-up action even
if the same user's password would.
**Reconsider when** — never without the owner.

### 6.4 Refresh tokens are server-stored, rotating, and revocable
**Decision** — Not stateless JWTs with long expiry. A recovery password
reset revokes every session.
**Reason** — `AI_HANDOFF.md` §10.
**Consequences** — Session state lives in the database and must be checked,
not just the token signature.
**Reconsider when** — never without the owner.

### 6.5 Tokens live in `localStorage` — a documented trade-off
**Decision** — Access/refresh tokens are stored in `localStorage`, not an
httpOnly cookie.
**Reason** — `AI_HANDOFF.md` §10 states this explicitly as "a documented
trade-off, not an oversight."
**Consequences** — XSS risk is accepted in exchange for the simplicity this
gives the PWA/offline architecture.
**Reconsider when** — never without the owner; do not "fix" this
unilaterally as a security cleanup.

### 6.6 RLS tests must run as an unprivileged database role
**Decision** — The isolation test suite connects as a role RLS actually
applies to.
**Reason** — `AI_HANDOFF.md` §10: "a superuser bypasses RLS and would make
the isolation tests pass against nothing."
**Consequences** — A test connecting as the migration/admin role proves
nothing about tenant isolation.
**Reconsider when** — never.

---

## 7. Offline, sync and device authority

### 7.1 Single writer per tenant, bound to a registered browser profile
**Decision** — Exactly one browser profile holds `OFFLINE_RW`; every other
profile/device is read-only offline. Authority is bound to the profile
keypair, not the machine — a different browser, OS user, or a cleared
profile is a **different** writer and must be re-registered. Copying OPFS
files does not carry write authority.
**Reason** — D-01, revised 2026-08-16.
**Consequences** — Transfer follows the device-authority state machine
(drain → revoke → authorize → snapshot), always audited. A partial unique
index on `device_authorizations` makes `OFFLINE_RW` single-occupancy
(`AI_HANDOFF.md` §9). Registration itself (`offline.device.register`) is
held by every authenticated role including Cashier; approve/rename/revoke
require Owner or Manager; force revoke is Owner-only (2026-08-31 change-log).
**Reconsider when** — never without the owner.

### 7.2 Offline storage is SQLite WASM over OPFS, SAH-pool VFS — no COOP/COEP headers
**Decision** — The offline database is SQLite compiled to WASM, persisted in
OPFS, reached through the same repository interfaces as PostgreSQL. The
**SAH-pool** VFS variant is used specifically because it needs no COOP/COEP
headers.
**Reason** — D-23, superseded in wording by the 2026-09-01/`AI_HANDOFF.md`
§9 clarification: the original §6.5 instruction to set COOP/COEP headers is
superseded because those headers break the Google sign-in flow most
shopkeepers use.
**Consequences** — IndexedDB remains rejected as the engine (cannot express
transactional multi-table writes or the ten-step write path); it may only
hold small key/value client state. Verified: no COOP/COEP headers are set in
`apps/api/src/common/security-headers.ts` — consistent with this decision.
**Reconsider when** — never; `AI_HANDOFF.md` explicitly says "do not add
them back."

### 7.3 Eviction gate: PWA install + `navigator.storage.persist()` before any offline write
**Decision** — The app must not accept a single offline write until the
tenant's designated writer profile has installed the PWA and been granted
persistent storage. If persistence is refused or revoked, the profile drops
to read-only offline with a plain on-screen statement — never a silent
accept into evictable storage.
**Reason** — D-24. "Every other risk in the offline design is recoverable
through quarantine and replay. Evicted OPFS data that never reached the
server is unrecoverable."
**Consequences** — The space check is measured against a server-estimated
snapshot size for the tenant, not a fixed number; pending outbox depth and
remaining quota are shown continuously with a blocking warning at threshold.
**Reconsider when** — never; described as the one hard gate nothing in the
offline path may be built before.

### 7.4 Nothing under `sync/` posts — replay reuses the online services
**Decision** — `operation-registry.ts` maps the offline operation types onto
the same application services the online controllers call. Idempotency is
inherited; every business rule is re-checked at replay time.
**Reason** — `AI_HANDOFF.md` §9: "a replayed sale obeys the rules a counter
sale obeys because it *is* a counter sale arriving late."
**Consequences** — A synced offline sale is an ordinary posted sale in every
respect — same journal, same corrections, counted in every report without
qualification. Per-device sale numbering is `S-{YEAR}-{DEVICE}-{SEQ}`.
**Reconsider when** — never; this is the module's one architectural rule.

### 7.5 A refused offline operation is quarantined, never auto-discarded
**Decision** — A closed month, a revoked permission, or a deleted product
encountered on replay stops that operation and surfaces it to a person — it
is never silently dropped.
**Reason** — `AI_HANDOFF.md` §9.
**Consequences** — A queue of quarantined operations is a normal, expected
state, not an error condition to auto-resolve.
**Reconsider when** — never.

### 7.6 Phase 12.3 local snapshot holds master data only — no documents, ledgers or reports
**Decision** — The local device copy holds products, parties and prices;
not sales, purchases, ledgers or reports. Download is automatic once the
device is approved, plus a once-per-business-day background refresh while
online. A failed refresh keeps the old copy rather than swapping in a
partial one. No client-side encryption is added in this slice — OS/device
encryption is relied on for now.
**Reason** — Change-log 2026-09-01, "Phase 12.3 confirmed."
**Consequences** — A revoked/replaced device must erase its local copy as
soon as it learns of the revocation (draining/quarantining any unsynced
writes first, once offline writing exists). Saving actions are disabled
with "Needs internet," never hidden, while offline.
**Reconsider when** — the offline-write phase (`OFFLINE_READY`, distinct
from `OFFLINE_SETUP_READY`) is built and questioned through the normal
process; this snapshot-only scope is explicitly named as a boundary no
screen may claim to exceed.

---

## 8. Licensing and entitlements

### 8.1 Offline Ed25519 licence, no phone-home, anti-rollback outside the backup
**Decision** — The licence is Ed25519, signed over a **re-canonicalised**
payload (not the attacker-supplied text) with the format prefix inside the
signed bytes. Validation is fully offline against an embedded public key.
An anti-rollback high-water mark is stored **outside** the database and
outside the backup, so a restore cannot wind the licence clock back.
**Reason** — D-35, `AI_HANDOFF.md` §10.
**Consequences** — The private key never reaches a customer machine and
never this repository; it lives in `~/.sher/licence-keys/` mode 0600,
written only by `tools/licence` (operator-side tooling).
**Reconsider when** — never without the owner.

### 8.2 Missing/invalid entitlement degrades to `READ_ONLY`, never a crash or data loss
**Decision** — `EntitlementProvider` is pluggable (`SubscriptionEntitlement
Provider` for SaaS, `LicenseKeyEntitlementProvider` for on-prem). On-prem
does not skip entitlement checks — it answers them from the licence.
**Reason** — D-35.
**Consequences** — `modules[]` in the licence feeds the existing Settings
module; there is no second feature-flag system.
**Reconsider when** — never without the owner.

### 8.3 Licence term states never destroy or hide customer data
**Decision** — `ACTIVE → EXPIRING (30d before) → GRACE (30d after) →
READ_ONLY`, `RESTORED` on renewal with no data loss. Backup export works in
every state, including `READ_ONLY`.
**Reason** — D-36.
**Consequences** — A lapsed licence degrades functionality, never
data access; the shop's own data is never held hostage.
**Reconsider when** — never; this is a customer-trust guarantee, not an
implementation detail.

### 8.4 `ENTITLEMENT_SOURCE` defaults to `license`
**Decision** — Verified in `apps/api/src/config.ts`: `entitlementSource`
defaults to `'license'` if the env var is unset (matches D-35 and the
1.1 decision above).
**Reason** — Owner decision 2026-09-02 (config comment): a missing env line
must degrade to `READ_ONLY` asking for a key, never fall back to the
permissive subscription stub.
**Consequences** — An installer that forgets to set `ENTITLEMENT_SOURCE`
still fails safe.
**Reconsider when** — never without the owner.

### 8.5 Tenant provisioning is pluggable; on-premise seeding is idempotent and refuses a second tenant
**Decision** — `TenantProvisioner` is an interface. `SignupTenantProvisioner`
handles SaaS; `SeedTenantProvisioner` handles on-prem — idempotent, refuses
if a tenant already exists, and takes the tenant name/ID from the licence
key. When `SINGLE_TENANT_MODE=true`, registration routes return **404**, not
403. `tenant_id` remains on every table and in every query in both modes.
**Reason** — D-34.
**Consequences** — An on-premise install can never be talked into creating a
second tenant by hitting the signup route; it isn't there.
**Reconsider when** — never without the owner.

### 8.6 Backup restore preserves data behind a plan the tenant no longer holds
**Decision** — Restore brings back all compatible business data. Subscription
and permissions always follow the *current* tenant/account, not the backup's.
Data belonging to a feature the current plan does not include is preserved
but read-only until that plan is reactivated.
**Reason** — D-08.
**Consequences** — A downgrade or a restore onto a lesser plan never deletes
data — it only withholds the screen that would act on it.
**Reconsider when** — never without the owner.

### 8.7 Attachments live in online media storage, not inside the offline database; backup password is customer-controlled
**Decision** — Attachment files are stored in online media storage with only
metadata/references in the DB; limits follow the subscription plan. Offline
backup/sync excludes attachments — an unavailable one shows clearly as
online-only without affecting its related record. Backup encryption uses a
customer-controlled password; an optional server-managed recovery key is
**off by default** and requires consent. Without either, a lost backup
password makes the backup permanently unrecoverable.
**Reason** — D-13, D-15.
**Consequences** — There is no "recover my backup" path when the customer
declined the optional recovery key and lost their password — this is an
accepted, disclosed risk, not a bug to route around.
**Reconsider when** — never without the owner.

---

## 9. Frontend and UX

### 9.1 One modal for every one-task action
**Decision** — Edit, delete, receive payment, pay supplier, return, refund,
stock adjustment, owner withdrawal all use the same compact ~38rem
two-column dialog, opened from the list or document it acts on — never a
route of its own. `StockAdjustDialog.vue` is the house pattern. A full page
is reserved for a workflow genuinely too large for a modal (POS, a
multi-line purchase, a stock count sheet).
**Reason** — `AGENTS.md` §"USE THE UI DESIGN THAT ALREADY EXISTS", UI-50,
`CLAUDE.md`.
**Consequences** — A new one-task action that gets its own page/route is a
rejected screen regardless of how well it works.
**Reconsider when** — never without the owner.

### 9.2 Instant recalculation on every transaction screen
**Decision** — Every derived figure (line total, discount, grand total,
paid, due, change, stock effect, party balance) recomputes as the user
types, using the **same `@sher/core-domain` functions the server runs**. The
server response only confirms what the screen already showed.
**Reason** — `CLAUDE.md`, `AI_HANDOFF.md` §8.
**Consequences** — Waiting for a save/reload to see a total is treated as a
serious defect, not a nitpick.
**Reconsider when** — never without the owner.

### 9.3 Unpermitted actions are absent, not disabled
**Decision** — UI-09: a button/menu item a user cannot perform does not
render greyed-out — it does not render at all.
**Reason** — `AI_HANDOFF.md` §8.
**Consequences** — A missing permission backfill after adding a permission
code hides the whole feature from the sidebar, not just one button
(`AI_HANDOFF.md` §11 — "easy to forget").
**Reconsider when** — never.

### 9.4 PrimeVue 4, styled mode, self-hosted — no CDN, no second UI library
**Decision** — All UI components come from PrimeVue 4 in styled mode.
Rejected: Vuetify (Material look wrong for a shop counter, weaker
DataTable) and Tailwind + headless components ("every table and form
becomes bespoke agent-written code, which is the code this project can
least afford to review").
**Reason** — D-37.
**Consequences** — All assets — fonts, icons, images — are self-hosted; no
CDN dependency for the running app (external script CDNs are a different,
tooling-only concern).
**Reconsider when** — never without the owner.

### 9.5 `@primeuix/styles` is pinned to `1.0.3`
**Decision** — The root `pnpm.overrides` pins this package to exactly
`1.0.3`.
**Reason** — User memory note (`primeuix-styles-pin.md`): bumping it
reintroduces unstyled, chevron-only PrimeVue dropdowns. Also listed as a
"do not casually redesign" item in `AI_HANDOFF.md` §16.
**Consequences** — A routine dependency bump of this package breaks visible
UI across the app.
**Reconsider when** — a newer version is verified, outside a routine
dependency-update pass, to no longer strip the styling.

### 9.6 English primary label, Bangla helper — except a brief, reversed counter-surface episode
**Decision** — Default UI is English-primary with small, muted Bangla
helper text (`.label-bn`) explaining business meaning, not literal
translation (D-12). Counter surfaces (till/cashier screens) went
Bangla-first on 2026-08-24 (UI-74/UI-75), then were reverted back to the
same English-primary rule as everything else on 2026-08-31 — "the counter
is a workflow of several screens and one register across all of them beats
a stronger label on one of them."
**Reason** — D-12, change-log 2026-08-24 and 2026-08-31.
**Consequences** — Any code or design reference to "counter surfaces are
Bangla-first" is stale; the counter now follows the same English-primary/
Bangla-helper rule as the rest of the app. Digits are always Western
(UI-47), including inside Bangla text.
**Reconsider when** — never without the owner; already flip-flopped once
and settled.

### 9.7 API base URL is read at runtime from `/config.json`
**Decision** — `import.meta.env.VITE_API_URL` is banned.
**Reason** — `AI_HANDOFF.md` §8: "baking it in forces a per-customer
frontend build" — incompatible with shipping one on-premise installer image.
**Consequences** — The API origin is configurable per install without a
rebuild.
**Reconsider when** — never without the owner.

### 9.8 Receipt printing: WebUSB ESC-POS primary, browser print dialog mandatory as fallback
**Decision** — Thermal receipts print directly over WebUSB with generated
ESC-POS byte sequences — no OS driver, no print dialog, in the common case.
**Any** browser/device where WebUSB is unavailable, permission is refused,
or the printer isn't claimed must fall back to a styled HTML print dialog
(80mm and A4 layouts). A4 and business-pad documents always use the print
dialog. Printer selection and the chosen path are stored per browser
profile.
**Reason** — D-22: "printing must never be the reason a sale cannot be
completed."
**Consequences** — WebUSB works in Chromium browsers only; Firefox and iOS
Safari always take the fallback path — this is expected, not a bug to chase.
Posting a sale is never coupled to whether it printed.
**Reconsider when** — never without the owner.

### 9.9 Familiar consumer-app interaction patterns, never their visual identity
**Decision** — Navigation and interaction patterns (sidebar, global search,
notification bell, cards, lists, responsive bottom nav) borrow from the
consumer apps Bangladeshi shop owners already use — Facebook, YouTube,
bKash/Nagad. The **visual identity** of those apps is never imitated.
Combined with ERP/POS needs: fast entry, dense tables, filters, keyboard
operation.
**Reason** — D-38, and the 2026-08-19 change-log restatement of the actual
customer: "a Bangladeshi shop owner who is not a graduate and whose
computing experience is an Android phone, Facebook and YouTube."
**Consequences** — A screen that looks like a specific consumer app, rather
than merely behaving in a familiar way, is a rejected screen — same as one
that invents its own new visual language (`AGENTS.md` §"USE THE UI DESIGN
THAT ALREADY EXISTS").
**Reconsider when** — never without the owner.

---

## 10. Process and working protocol

### 10.1 R-0 outranks every other instruction in every file
**Decision** — The owner's working protocol (start the dev server every
session; never write test files; orient before working on a new/cleared
chat; ask module questions one at a time with `START` before code; write
only the confirmed module; build, run and hand over a UI manual; fix
reported bugs narrowly) is binding on every agent, Claude Code included.
**Reason** — `AGENTS.md` R-0, written down "after it was broken twice"
(owner instruction 2026-08-24, itself a revision of an earlier same-day
version — change-log entries 12 and 13).
**Consequences** — Work that breaks any R-0 step is rejected even when the
code itself is correct.
**Reconsider when** — never without the owner.

### 10.2 Never write test files; never run `pnpm test` unless asked in-conversation
**Decision** — No `*.spec.ts`, no vitest suite, no "quick verification"
script, ever, for any module. `pnpm build`, `pnpm typecheck`, `pnpm lint`,
`pnpm test:boundaries` still run every time — those are static checks, not
suites. Running the existing suites is a separate ask, made once at a module
gate.
**Reason** — `AGENTS.md` critical rule 11, R-0 step 1; change-log
2026-08-22 and 2026-08-24 record this superseding an earlier "one full
suite per change" cadence.
**Consequences** — "It would catch bugs," "this is financial logic," and
"there are tests elsewhere in this repo" are explicitly **not** exceptions.
**Reconsider when** — the owner asks for tests in the current conversation;
never inferred, never assumed from a bug's severity.

### 10.3 A new module opens with one question per message, up to ~20, then `START`
**Decision** — Each question carries 3–4 concrete options with the
recommended one first; a short Final Module Specification follows; only
then does code begin.
**Reason** — `AGENTS.md` §3, R-0 step 3; change-log 2026-08-24 records this
as the final settled cadence after briefly trying "all questions in one
message" earlier the same day (change-log entries 12, 16).
**Consequences** — Skipping straight to a specification (or to code) on the
strength of a fresh context window is a protocol violation.
**Reconsider when** — never without the owner.

### 10.4 `FUNCTION_MAP.md` is read before searching the codebase, and updated after
**Decision** — A reuse index of services, endpoints, repository methods and
shared components with file paths, read first and updated at the end of
every coding session.
**Reason** — Change-log 2026-08-22: "two habits were spending the budget
without improving the software — rediscovering existing code by reading the
repository, and re-running the whole suite after each edit."
**Consequences** — Duplicate implementations of an existing use case are a
scope violation (`AGENTS.md` critical rule 15), and this index is the first
line of defence against writing one by accident.
**Reconsider when** — never; it is one of the four permitted top-level docs
plus the `docs/` handoff set.

### 10.5 Only the owner sets a module's status to `DONE`
**Decision** — An agent may set a module to `CODE COMPLETE` in the delivery
status ledger (§6.1.1) once the gates are green; only the owner, after
driving the workflow in the running UI himself, sets `DONE`.
**Reason** — `AGENTS.md` "Recording a finished module"; `AI_HANDOFF.md` §4.
**Consequences** — The ledger is the **only** permanent record of what is
built — no separate status file, task log, or progress README is ever
created.
**Reconsider when** — never.

### 10.6 Documentation is limited to four canonical files plus one fixed `docs/` handoff set
**Decision** — `SRS_AND_BUILD_GUIDE.md`, `AI_CODING_INSTRUCTIONS.md`,
`AGENTS.md`, `FUNCTION_MAP.md` are the only place a requirement, decision or
delivery status may be recorded, plus `docs/AI_HANDOFF.md`,
`docs/CURRENT_STATE.md`, `docs/NEXT_TASKS.md`, `docs/DECISIONS.md` (this
file) added 2026-09-02 at the owner's explicit request. `docs/archive/`
holds superseded planning documents and must not be read — it contradicts
the current spec.
**Reason** — `AGENTS.md` "Documentation — exactly four files," `CLAUDE.md`.
**Consequences** — No task logs, module notes, or extra progress
READMEs — ever, regardless of how useful one seems mid-task.
**Reconsider when** — never without the owner's explicit request, as this
file itself was.

---

## 11. Explicitly rejected alternatives

### 11.1 Microservices, event sourcing, CRDT sync, logical PG↔SQLite replication, a separate offline codebase, a separate on-prem fork
**Decision** — All six rejected outright for V1 and the offline design.
**Reason** — §2.6: microservices need distributed transactions across
stock + ledger + cash with no ops capacity to run them; event sourcing as
the primary store hurts maintainability under AI agents when append-only
movements + audit already give most of the benefit; CRDTs merge
automatically where business documents need domain-aware conflict handling;
logical replication PG↔SQLite would bypass every business rule, permission
and audit check; a separate offline codebase means two implementations of
every rule; a separate on-premise fork means 31 modules maintained twice —
called "project-ending."
**Consequences** — The offline design instead reuses the same
domain/application layers through a second repository-interface
implementation (D-14, D-23).
**Reconsider when** — never without the owner.

### 11.2 T3/Next.js/tRPC stack
**Decision** — Rejected as the web stack.
**Reason** — D-21: it couples the client to a Node-rendered server and a
TypeScript-only RPC contract, breaking the REST + OpenAPI contract that
mobile, on-prem installs and MCP all share, and it has no path to running
the domain layer inside the browser for offline.
**Consequences** — Vue 3 + Vite + NestJS + REST/OpenAPI is the fixed stack;
no SSR framework is introduced later without reopening this decision.
**Reconsider when** — never without the owner.

### 11.3 Tauri as the primary offline runtime; IndexedDB as the offline engine
**Decision** — Both rejected as primary mechanisms. PWA + SQLite WASM +
OPFS is canonical; Tauri may only be evaluated after the Mobile phase as an
optional packaging/native-integration shell reusing the same domain
contracts.
**Reason** — D-20, D-23.
**Consequences** — IndexedDB may still be used for small key/value client
state — just never as the engine for business documents.
**Reconsider when** — Tauri: after the Mobile phase, only if a demonstrated
OS-integration need justifies it, and only as packaging (never a second
transaction engine). IndexedDB: never as the primary engine.

### 11.4 LIFO costing; VAT/tax in V1; bcrypt/argon2
**Decision** — All three rejected/removed.
**Reason** — D-05 (LIFO removed, FIFO/AVERAGE only); D-09 (VAT/tax removed
from V1, owner override); `AI_HANDOFF.md` §2 (bcrypt/argon2 rejected in
favour of Node's own scrypt).
**Consequences** — See sections 5.1 and 1.3 above for the accepted costs of
the first two.
**Reconsider when** — LIFO: never. VAT/tax: V2, through the normal
module-start process. scrypt vs bcrypt/argon2: never without the owner.

### 11.5 Loyalty/Premium features; stored opening-balance columns on products/parties; generic CRM, promotion engine, portals
**Decision** — All dropped or rejected as scope.
**Reason** — Change-log 2026-08-18 ("Loyalty/Premium dropped… Lean
medium-business omissions… generic CRM, a generic promotion/rule engine,
portals and configurable import machinery remain out of scope"); change-log
2026-08-19 entry 43 explicitly considered and rejected adding stored
opening-balance columns to `products`/`parties`: "the figures would have no
movement or journal line behind them and would have to be unwound once
Phases 5–6 make those ledgers real."
**Consequences** — Opening stock/balances are only ever written through the
real stock-opening and posting-kernel services, never a bare column.
**Reconsider when** — never without the owner; each was a deliberate
scope-boundary decision, not an oversight.

---

## Decisions a future agent must NOT casually reverse

- **The closed account list (§4.1 above).** Needing an account not on it is
  a stop-and-report, never a unilateral addition — it changes what every
  report means.
- **Append-only corrections (§4.3).** Never mutate or hard-delete a posted
  document, movement, journal line, or audit event.
- **Integer money and quantity (§3.3).** Introducing a float or `NUMERIC`
  anywhere breaks online/offline numeric parity by design.
- **`tenant_id` sourced only from `TenantContext`, cross-tenant = 404 (§3.2).**
  Any other source is a tenant-isolation hole; the wrong status code lets a
  probe confirm a record exists.
- **The `Clock` port (§2.2, §3.5).** An ambient `new Date()`/`Date.now()`
  outside `packages/shared-utils/src/clock.ts` moves a transaction into the
  wrong business day and the wrong report — CI-enforced.
- **The layering direction, and `core-domain`/`core-application` staying
  browser-safe (§2.1, §2.2).** Breaking this silently forecloses the offline
  and future MCP architecture the whole design assumes.
- **Nothing under `sync/` posts (§7.4).** Bypassing the online services on
  replay means an offline sale stops obeying the rules a counter sale obeys.
- **Quarantine, never auto-discard, for a refused offline operation (§7.5).**
  Auto-discarding silently loses a shopkeeper's transaction.
- **No COOP/COEP headers (§7.2).** Adding them back reintroduces the SAH-pool
  VFS's reason for existing and breaks Google sign-in for most shopkeepers.
- **`outbox` writes stay, even unread (§2.4 above).** Removing them destroys
  the change history a later sync engine needs to reconstruct.
- **The `@primeuix/styles` 1.0.3 pin (§9.5).** A routine bump silently strips
  PrimeVue's styling app-wide.
- **`ENTITLEMENT_SOURCE` defaults to `license` (§8.4).** Defaulting to the
  permissive subscription stub means a misconfigured install trades forever
  with no entitlement check at all.
- **Cash moved never assigned; the stored expected close is immutable
  (§4.4).** Editing the expectation instead of posting `CASH_SHORT_OVER`
  makes the ledger stop reconciling with the physical drawer.
- **The owner's working protocol, R-0 (§10.1).** Breaking it gets correct
  code rejected — it is not a quality bar, it is the acceptance gate itself.

---

## Phase 18 — Daily-first workflow UI and E2E coverage (owner decisions, 2026-09-03)

Fourteen decisions taken in the questioning round that opens a module (R-0 step
3). The module was specified and **not yet started** when they were recorded, so
this section is the authoritative statement of what was agreed — a new or
cleared chat should read it here rather than re-asking.

**The boundary, stated first because it governs the rest.** No accounting,
stock, permission or business-logic change. Every screen keeps calling the use
case it calls today. This is navigation, presentation, responsiveness and test
coverage. If a file under `packages/core-domain` or `packages/core-application`
changes, the module has overstepped.

1. **Daily-first navigation.** `Daily` becomes the first category **and the
   post-login landing route**. `Overview` stops being a top-level category and
   Dashboard becomes the first entry inside Daily — "what is my business doing"
   and "what am I doing today" are the same question at nine in the morning.
   Order: Daily · Sales · Purchases · Inventory · Parties · Finance · Reports ·
   Administration · Settings.
2. **Global Search is finished, not invented.** `AppTopBar.vue` already carries
   a disabled box with a `Ctrl K` hint. It becomes one permission-filtered
   server endpoint reusing existing list use cases: products (name, barcode,
   SKU), parties (name, phone), documents by printed number — **plus** a
   separately grouped `Go to…` for screen names. The two kinds of answer are
   grouped apart so they never interleave, which is the readability risk the
   owner accepted when he chose the command-palette variant.
3. **Declutter, all four kinds.** Raw ULIDs, permission codes and version
   strings out of ordinary screens (kept in the audit trail and in the
   support-call line UI-28 requires); Sync and Storage Check folded into the
   Offline page so Settings has one door instead of three; every empty screen
   given one sentence and one button; table columns trimmed to what somebody
   acts on. Deliberately **not** chosen: an "Advanced" toggle hiding screens,
   because a hidden screen cannot be found when a support call says to open it.
4. **Polish, not redesign — plus one shared list pattern.** The eight daily
   screens keep their layout; what improves is the first screenful, focus on
   open, an obvious primary action, sensible defaults. On top of that, all
   eight lists behave identically: same filter placement, same search, same row
   actions, same empty state.
5. **Phone-first for the eight daily screens only.** Cards below ~640px, thumb-
   reachable primary action, full-screen dialogs, correct `type`/`inputmode`.
   **Desktop density is untouched** — a counter PC with a keyboard is where a
   busy shop sells.
6. **Playwright lives in `apps/web/e2e`**, drives the real dev stack, and uses a
   dedicated `sher_e2e` database. Chromium plus a mobile project; not three
   engines for an app that ships on one.
7. **The Manager daily flow is one continuous business day** — open day → POS
   sale with paid *and* due portions → receive payment via Counter → purchase →
   expense → Daybook → close day. It must **assert business effects with exact
   numbers**, not that buttons can be clicked: stock down after the sale,
   customer due down after the receipt, stock up and the supplier effect after
   the purchase, all four documents in Daybook, and expected/counted/difference
   at close. It is **not** responsible for edge cases — returns, corrections,
   voids and unusual permissions stay in the vitest and API suites.
8. **SQL owns the test database; the ERP owns the business state.** Reset
   `sher_e2e`, run real migrations, run the role backfill, start the API — then
   create every business record **through the application's own HTTP API**,
   opening stock through its real workflow so the movements and entries exist.
   No stock balance, customer due, supplier balance or journal total is ever
   created by raw SQL. Baseline, seeded **once per suite**: tenant, Manager and
   Cashier, cash and bank accounts, `E2E Customer`, `E2E Supplier`, Product A
   (stock 20, cost 100, price 150), Product B (stock 10, cost 200, price 300),
   opening cash 1,000. Deterministic `E2E ` name prefixes; never a dependence on
   whatever happens to be in the development database.
9. **A hard safety guard on the reset.** If the database name is not exactly
   `sher_e2e`, the E2E reset **aborts immediately**. It may never operate on
   development, acceptance or production data. This is the same rule
   `apps/api/vitest.config.ts` already applies with `sher_test`, and it is not
   negotiable.
10. **The Cashier smoke proves three layers**: the sidebar draws only their
    categories; a forbidden route typed directly is refused; and a forbidden API
    call returns `PERMISSION_DENIED`. Three, because a hidden button is a
    courtesy and the server is the boundary — a spec checking only the menu
    would pass against a wide-open API.
11. **Mobile proves usability, not pixels.** One real cashier phone sale end to
    end, plus layout guards across all eight screens: no page-level horizontal
    overflow, primary action reachable, dialogs inside the viewport, tables not
    sliding off-screen, essential business information visible. Assert
    `type`/`inputmode` rather than driving a virtual keyboard, which Playwright
    cannot do honestly. **No screenshot baselines** — they break on font
    rendering and get bulk-approved, at which point they catch nothing. The full
    day is **not** re-run on mobile.
12. **Upgrade safety is a data-survival question.** Seed and trade on the
    current build, capture the figures, migrate and upgrade, then re-assert that
    the same invoices, stock, dues and day totals read back identically and that
    a fresh sale still posts — exercising the schema-version gate and the role
    backfill, which are the two things that silently break an upgrade.
13. **Selectors follow what a shopkeeper sees.** Accessible roles and visible
    text first; `data-testid` only where a screen genuinely has two identical
    controls. A spec should break when a screen becomes unusable, not when a
    class name changes — and an element with no accessible name cannot be found
    this way, so the discipline doubles as an accessibility check.
14. **Five slices, run straight through**, one walkthrough at the end: 18.1
    navigation + Global Search · 18.2 the shared list pattern · 18.3 declutter ·
    18.4 phone-first · 18.5 Playwright. E2E is **last** on purpose: specs
    written against screens that are still moving get rewritten twice, and the
    suite's real job is protecting this work from the *next* change.

**On test files.** `AGENTS.md` R-0 §1 forbids an agent from ever writing one,
with a single exception — the owner asking in the current conversation. He did,
explicitly, for Playwright, on 2026-09-03. That authorisation covers **Playwright
specs only**; no new vitest suite may be added alongside them, and R-0 §1
otherwise stands unchanged for every future module.
