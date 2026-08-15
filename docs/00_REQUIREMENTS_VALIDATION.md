# 00 — Requirements Consistency Review (SRS v3.0)

**Source:** `SherERP_Master_SRS_v3.md` (2026-08-14)
**Reviewer role:** Architecture / ERP / Offline / DB / Security / QA validation
**Rule applied:** No confirmed requirement is removed. Risky requirements are preserved and given a safe implementation path.

---

## A. Verdict Summary

| Area | Verdict | Note |
|---|---|---|
| Product scope (31 modules) | Coherent | Standard SME retail ERP scope |
| Online-first sequencing | Correct | Only safe order for offline reuse |
| Modular monolith | Correct | Matches team size + AI-assisted delivery |
| Tech stack | Appropriate, with 3 constraints | Vue 3 + NestJS + Drizzle + PostgreSQL (D-14); mobile = PWA (D-28); full SQLite/Tauri deferred |
| Offline full-write requirement | Achievable | Requires "one shared Domain/Application layer with a V1 PostgreSQL adapter and a future SQLite adapter" + single-writer rule (D-01) |
| Accounting model | **Incomplete** | Sub-ledgers exist, no posting kernel — see C-01 |
| Inventory + backdating/edit freedom | **High risk** | Retroactive re-costing undefined — see C-02 |
| Sync design | Feasible | Requires ULID PKs + operation log + server-side replay (see `SYNC_PROTOCOL.md`) |
| Security model | Sound, under-specified | Needs RLS, service-layer authz, backup key policy |

**Nothing in the SRS is technically impossible.** Two requirement clusters (C-01, C-02) are *underspecified in a way that will produce wrong money numbers* if implemented literally. Both are addressed with additive designs that do not remove business freedom.

---

## B. Contradictions Found

| # | Contradiction | SRS refs | Impact | Resolution path |
|---|---|---|---|---|
| X-01 | "Duplicate phone numbers are not allowed" vs "Walk-in Customer is a real customer record" (walk-in has no unique phone; families/shops share numbers; a person can be both customer and supplier) | §15 | Blocks legitimate data entry, or forces fake phones | D-02: uniqueness scoped to `(tenant_id, role=customer, phone)` with `system_reserved` exemption for walk-in + explicit override permission |
| X-02 | "Only one device may hold offline read/write" + "all other devices read-only" vs online system continuing to accept writes | §4, §4.2, §38 | If both accept writes, every stock/ledger number can conflict | **D-01 (blocking)**: define write-authority scope while offline mode is ON |
| X-03 | "Delete where permitted" (§45, §49) vs "never make a financially meaningful historical event disappear without an auditable trail" (§37) | §37/§45/§49 | Hard delete of an invoice destroys ledger/stock integrity | D-03: delete-policy matrix — hard delete only for never-posted master data; posted documents get void/reverse + soft delete |
| X-04 | Module 06 Supplier vs Module 07 Vendor vs Module 18 titled "Vendor Ledger & Payables" but containing "Purchases" | §16, §17, §28 | Two half-overlapping party models, duplicated ledger logic | D-04: single `parties` table with role flags; one ledger engine, filtered views |
| X-05 | "Physical stock issue rules and valuation method must remain conceptually separate" + LIFO offered | §23 | LIFO valuation over FIFO physical issue needs a separate valuation layer, not lot consumption order | D-05: lot consumption strategy and valuation method are two settings; LIFO = valuation-only in V1 |
| X-06 | "Profit must not be shown unless costing data is reliable" but no definition of "reliable" | §35 | Un-testable acceptance criterion | D-06: define reliability predicate (no unresolved provisional costs / no open negative-stock lots in range) |
| X-07 | Trial users authenticate by verified mobile number (§9) vs "Password security where applicable" + session security (§12) | §9, §12 | Ambiguous: OTP-per-login? no password ever? | D-07 |
| X-08 | Tenant may "Delete server data" then "Return later ... Upload backup" (§40) vs subscription/entitlement enforcement (§10) | §40 vs §10 | A trial tenant could restore a full paid-plan dataset and keep operating | D-08: entitlement re-evaluation on restore; data restored but gated features locked |

---

## C. Missing Requirements (must decide before Phase 3)

| # | Missing | Why it matters | Recommendation |
|---|---|---|---|
| C-01 | **No posting kernel / journal backbone.** SRS has customer ledger, vendor ledger, cash, bank, expenses as separate features | Without one balanced posting engine, sub-ledgers drift and nothing can be proven; "profit" is unverifiable | Add an internal double-entry `journal_entry` / `journal_line` backbone. UI keeps showing simple ledgers. No new user-facing requirement, huge integrity gain. **RECOMMENDED** |
| C-02 | **No re-costing policy** for backdated/edited/deleted stock transactions under FIFO/AVG | Editing a 3-day-old purchase silently changes COGS of sales already reported | Define: recompute-forward within an open period + `cost_adjustment` movement; never rewrite a closed period. **RECOMMENDED (blocking for M13)** |
| C-03 | **No period close / lock** | Every "correct/backdate/reverse" freedom is unbounded in time; reconciliation history can be invalidated forever | Add soft period lock + `unlock` permission + audit. Preserves freedom, bounds damage. **RECOMMENDED** |
| C-04 | **No tax/VAT** anywhere (BD Mushak/VAT, tax-inclusive pricing) | Retrofitting tax into sales/purchase/returns/ledger later is a rewrite | Decide now: V1 = tax-free but **reserve fields** (`tax_rate_id`, `tax_amount`, `is_tax_inclusive`) on all transaction lines. **FINAL (D-09)** |
| C-05 | **No stock location / warehouse dimension** | An offline shop device implies a physical location; multi-shop is the most common SME growth step | Reserve `location_id` on every stock movement/lot/balance with one auto-created default location. **RECOMMENDED** |
| C-06 | **No unit conversion** (unit exists; carton↔piece does not) | Purchase in carton, sell in piece is normal in this market | V1: single stocking unit + reserved `pack_size`; V2 conversions. **FINAL (D-10)** |
| C-07 | **No numbering-series configuration** and no offline-safe numbering | Two devices/two modes will produce duplicate invoice numbers | Device/mode-prefixed series with tenant-configurable format. **RECOMMENDED (blocking for offline)** |
| C-08 | **No opening balance entry** (opening stock, opening customer due, opening supplier payable) | Nobody can onboard a real running business | Add opening-balance workflow to M12/M17/M18/M19/M20. **RECOMMENDED** |
| C-09 | **No payment allocation rule** (advance payments, partial payments, on-account receipts) | "Payment allocation" is listed but not specified | Define: allocate-to-invoice explicit + auto-FIFO option + unallocated on-account balance. **RECOMMENDED** |
| C-10 | **No credit limit / due limit** | Listed nowhere; commonly requested right after go-live | Reserve field, enforce as warning-only in V1. **FINAL (D-11)** |
| C-11 | **No stock transfer** between locations | Follows C-05 | Defer to V2 |
| C-12 | **No definition of "reliable profit"**, no margin methodology | See X-06 | D-06 |
| C-13 | **No data retention / deletion SLA** for §40 "delete server data" | Legal + operational | Define purge job + retention window. **RECOMMENDED** |
| C-14 | **No rounding & precision policy** for money and quantity | SQLite has no NUMERIC; float money = guaranteed drift | Integer minor-units storage, fixed scales, documented rounding. **RECOMMENDED (blocking, Phase 0)** |
| C-15 | **No app-level i18n requirement** (only invoice Bangla/English) | Terminology config + Bangla invoices imply a Bangla UI expectation | Decide V1 UI language scope. **FINAL (D-12)** |
| C-16 | **No attachment/file storage** (purchase bill photo, expense receipt) | Universally requested; affects storage + backup + sync size | V1: optional, out of `.sherdb` core, sync deferred. **FINAL (D-13)** |

---

## D. Ambiguities Requiring Product-Owner Decision

All owner decisions are recorded as final in `OPEN_DECISIONS.md` and `OPEN_DECISIONS_User_note.md`. Remaining C-items in this validation are implementation risks/gaps, not owner decisions:

`D-01` offline write authority · `D-02` phone uniqueness · `D-03` delete policy · `D-04` party model ·
`D-05` LIFO semantics · `D-06` profit reliability · `D-07` auth model · `D-08` restore vs entitlement ·
`D-09` tax · `D-10` unit conversion · `D-11` credit limit · `D-12` UI language · `D-13` attachments ·
`D-14` ORM / dual-dialect strategy · `D-15` backup encryption key custody · `D-16` SMS bKash verification (manual vs API) ·
`D-17` costing scope (per location / per tenant) · `D-18` serial uniqueness scope · `D-19` negative-stock costing ·
`D-20` Tauri execution model (sidecar vs in-webview domain).

---

## E. Requirements Confirmed as Implementable As Written

- Modular monolith, online-first sequence, vertical-slice delivery (§6, §7, §46).
- Tenant isolation and server-side authorization on every operation (§8).
- Mobile-number + OTP first account creation and trial (§9).
- Product/brand separation, display name = Brand + Product Name (§14).
- Different purchase prices create lots, not duplicate products (§14, §20, §23).
- Configurable negative-stock behaviour (§18).
- Configurable financial terminology without changing accounting semantics (§27, §36).
- Landed cost V1 allocation by Purchase Value / Quantity / Manual (§24).
- Audit of edit/backdate/correct/reverse/cancel with ON TIME / LATE ENTRY / BACKDATED / CORRECTED indicators (§37).
- One offline read/write device with auditable transfer (§4).
- Encrypted portable tenant backup `tenantname.sherdb` (§40).
- MCP through application services only, never direct DB (§42).
- Acceptance requires manual real-transaction testing (§48, §54).

---

## F. Impossible / Must-Reject-As-Stated

**None.** One requirement is *conditionally* unachievable:

> §7.1 + §38: "the same business rules operate in both environments"

This is achievable **only if** the domain layer contains no NestJS, no Postgres-specific SQL, and no HTTP types. If business logic is written inside NestJS services with Drizzle/PostgreSQL calls inline (the default an AI agent will produce), the offline app becomes a second implementation and the requirement fails silently. This is enforced in `AI_CODING_RULES.md` (rule set R-D) and by a CI dependency-boundary test, not by good intentions.
