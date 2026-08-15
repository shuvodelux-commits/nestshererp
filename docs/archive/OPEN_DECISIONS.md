# Decision Register — Final / Verified

This document is no longer a list of unresolved product-owner questions. The decisions below are the current implementation authority for SherERP. If an older document conflicts with this register, this register and `OPEN_DECISIONS_User_note.md` take precedence.

## Final Decisions

### D-01 — Offline write authority
V1 temporary browser offline support uses IndexedDB. The full SQLite-based offline database implementation is deferred. When full offline database support is implemented, V1's selected/authorized-device single-writer rule applies unless a later decision changes it.

### D-02 — Customer phone number
Invoice search uses the customer's phone number, so each customer must have a unique phone number. A Party may have multiple roles.

### D-03 — Invoice deletion
Posted invoices cannot be permanently deleted. They must be reversed/voided while keeping history. Draft invoices may be permanently deleted.

### D-04 — Party system
Use one internal Party system with multiple roles such as Customer, Supplier, Vendor and Expense Party. Role-specific ledgers are views over the same Party/ledger model.

### D-05 — Stock and valuation
Physical stock and accounting valuation remain separate concepts, with independent settings and calculations.

### D-06 — Negative-stock cost / profit reliability
Negative-stock sales use the last known cost as a provisional cost. When actual purchase cost becomes available, affected COGS and profit are recalculated according to the configured costing method. Profit is reliable only after relevant costing is finalized.

### D-07 — Login and authentication
First account verification uses phone OTP. After verification, users may use PIN, email/password or Google OAuth for daily login. Sensitive actions require stronger authentication and permission.

### D-08 — Backup restore
Restore all compatible business data. Subscription and permissions always follow the current tenant/account. Data belonging to unavailable features remains preserved but read-only until the required plan is activated.

### D-09 — VAT / tax
V1 includes a minimal VAT/tax system.

### D-10 — Unit of measure
V1 supports manual UOM conversion. Products may be purchased, stocked and sold using different units such as Carton, Box, Piece, Pipe, Feet, Kg or Liter, with product-specific conversion rules.

### D-11 — Customer credit limit
Exceeding the customer credit limit shows a warning only; it does not block the sale.

### D-12 — Language
Default UI is English with optional Bangla helper text. The system is multilingual-ready from V1. Invoices and printed financial documents support Bangla and English from V1. Full Bangla UI translation may be completed in V1.1.

### D-13 — Attachments
Attachments are stored separately in online media storage, not inside `.sherdb`. The database stores metadata/references. V1 offline backup/sync does not include attachments; unavailable offline attachments are clearly shown as online-only.

### D-14 — Repository architecture / database strategy
V1 uses **Drizzle + PostgreSQL**. Business-specific repository interfaces are defined from the beginning. The shared Domain/Application layer contains all business rules and does not import Drizzle, PostgreSQL, SQLite or NestJS. Drizzle/PostgreSQL implementations live in infrastructure/repositories. Repository interfaces are designed so a **future Drizzle + SQLite implementation can be added later** without changing business logic.

Business rules covered by the shared layer include Sales, Purchase, Inventory, FIFO, COGS, Profit, Payment, Ledger, Return and Warranty. Do not create unnecessary `GenericRepository`, `BaseRepository`, `RepositoryFactory` or similar abstractions.

V1 does **not** require a full SQLite database implementation. Temporary browser offline support may use IndexedDB for the limited V1 offline requirements. Full SQLite offline architecture is a later implementation step.

### D-15 — Backup encryption password
Backups use a customer-controlled backup password. Optional server-managed recovery is available but OFF by default and requires customer consent. Without the backup password or enabled recovery option, the backup is permanently unrecoverable.

### D-16 — Bangladesh payment verification
SherERP supports bKash and Nagad personal-account payments without requiring a merchant account. The customer submits the Transaction ID and admin can manually verify it. The design should also support integration with Bangladesh SMS-provider/API-supported verification where available. Automatic verification may be added later while manual verification remains the fallback.

### D-17 — Inventory by location
Inventory quantity, lots, cost and valuation are tracked by **Product + Location**. V1 may expose one location in the UI, but the schema and business logic support multiple locations from the beginning.

### D-18 — Serial uniqueness
The same active serial number cannot be used for the same product within the same tenant. After an item is retired, the serial may be reused later with a warning.

### D-19 — Negative stock costing
Negative stock sales are allowed. If cost is unknown, use the product's last known cost as a provisional cost. When actual purchase cost becomes available, automatically recalculate affected COGS and profit.

### D-20 — Future Tauri architecture
Future Tauri offline support uses a local NestJS/Node process so existing application/service logic can be reused. Business logic is not rewritten in Rust. This is not required for V1.

## Architecture Rules

| Rule | Final decision |
|---|---|
| Business Logic | Shared Domain/Application only |
| Database Access | Business-specific Repository interfaces |
| ORM / DB layer | Drizzle |
| V1 Online DB | PostgreSQL |
| Future Offline DB | SQLite + Drizzle repository implementation |
| V1 Temporary Browser Offline | IndexedDB; limited temporary offline support |
| Server Authority | NestJS |
| Database-specific code | Infrastructure/repositories only |
| Duplicate Business Logic | Never duplicate online/offline rules |
| Domain Dependencies | No NestJS, Drizzle, PostgreSQL, SQLite or browser/DOM dependencies |

## Repository Rules

1. Define business-specific repository interfaces from the beginning.
2. Repository interfaces contain only operations required by Domain/Application.
3. Repository interfaces must not expose Drizzle-specific types.
4. Drizzle repository implementations handle persistence and database-specific queries only.
5. Repositories do not perform business calculations.
6. Do not create generic repository abstractions unless a real SherERP requirement requires one.
7. V1 implements the PostgreSQL repository path.
8. A future SQLite repository path must implement the same interfaces so Domain/Application logic remains unchanged.

## Core Principle

**Business logic decides what SherERP should do. Repository interfaces define what data the business logic needs. Drizzle implementations decide how that data is stored. PostgreSQL is the V1 database; SQLite is a future storage implementation.**

---

# Deployment-Mode Decisions (D-21 → D-24)

These four decisions exist because SherERP will be sold in two deployment modes from the same codebase:

- **SaaS mode** — Anthropic-style multi-tenant hosting operated by SherERP.
- **On-Premise mode** — a single customer installs SherERP on their own server for security/data-residency reasons, licensed by contract for a fixed term.

**Governing rule for all four:** the on-premise build is the **same build** as the SaaS build. Signup, OTP and subscription are **disabled by configuration, never deleted from the codebase**. Creating a separate on-premise fork is forbidden — it would double the maintenance cost of all 31 modules and is treated as a project-ending mistake (see R-25).

These decisions affect **Phase 1 (Auth/Tenant)** and must be implemented before M02 is built. Retrofitting them after M02 ships to SaaS customers means surgery on a live authentication module.

---

### D-21 — Identity verification strategy  ·  **Phase 1**

**Decision.** Identity verification is pluggable behind an `IdentityVerifier` interface. The auth module never calls an SMS provider directly.

| Implementation | Mode | Behaviour |
|---|---|---|
| `OtpIdentityVerifier` | SaaS | Phone → OTP via SMS provider, per D-07 |
| `NoOpIdentityVerifier` | On-premise | Verification auto-passes; the seeded admin account is created by the installer with a forced password change at first login |

**Why it matters.** D-07 makes phone OTP the first-account gate. An on-premise server may have no internet and no SMS gateway at all, so first login would be impossible. Without this interface, the on-premise build must delete OTP code — creating a fork.

**Rules.**
1. `sendOtp()` must be called from exactly one place, inside `OtpIdentityVerifier`.
2. No module outside M02 may import an SMS provider type.
3. Post-verification login methods (PIN, email/password, Google OAuth) from D-07 are unchanged in both modes. Google OAuth is automatically unavailable on an air-gapped install and the UI must hide it when unreachable.
4. `NoOpIdentityVerifier` must be rejected at boot if `SINGLE_TENANT_MODE=false`. A SaaS deployment must never run without real verification.

**Consequence.** Sensitive-action step-up authentication (D-07) remains mandatory in both modes.

---

### D-22 — Tenant provisioning strategy  ·  **Phase 1**

**Decision.** Tenant creation is pluggable behind a `TenantProvisioner` interface.

| Implementation | Mode | Behaviour |
|---|---|---|
| `SignupTenantProvisioner` | SaaS | Public signup endpoint creates tenant + owner + trial |
| `SeedTenantProvisioner` | On-premise | Installer creates exactly one tenant from the license key at first boot; the public signup endpoint is **disabled server-side** |

**Why it matters.** Hiding the signup screen in the UI is not sufficient. If the `POST /auth/register` route still responds, anyone on the customer's LAN can create additional tenants on a server the customer believes is single-purpose. This is a security defect, not a cosmetic one.

**Rules.**
1. When `SINGLE_TENANT_MODE=true`, registration routes return `404`, not `403` — do not advertise the existence of a disabled endpoint.
2. `SeedTenantProvisioner` is idempotent and refuses to run if a tenant already exists.
3. The tenant name and ID are taken from the license key, not from user input.
4. **`tenant_id` remains on every table and in every query in both modes.** No AI agent may remove it on the grounds that only one tenant exists. This is the primary defence for R-08 (cross-tenant leak) and keeps the two modes on one schema.
5. The tenant switcher UI is hidden when `SINGLE_TENANT_MODE=true`, but `TenantContext` continues to operate normally.

---

### D-23 — Entitlement source  ·  **Phase 1**

**Decision.** The `Plan` link of the confirmed entitlement chain is pluggable behind an `EntitlementProvider` interface. The rest of the chain is unchanged in both modes.

```
Plan → Feature → Setting → Permission → Access
 ↑
 └── EntitlementProvider (swappable)
```

| Implementation | Mode | Source of plan |
|---|---|---|
| `SubscriptionEntitlementProvider` | SaaS | Subscription module (M03), billing state |
| `LicenseKeyEntitlementProvider` | On-premise | Signed license key file, validated locally |

**Why it matters.** On-premise has no subscription module and no billing. Without this interface the on-premise build would have to bypass entitlement checks entirely, which would mean the two modes enforce permissions differently — an unacceptable divergence for an audited financial system.

**Rules.**
1. The on-premise mode **does not skip** entitlement checks. It answers them from the license key.
2. Licence validation is **offline** — signature verified against an embedded public key. No phone-home. This is a core selling point for a security-motivated customer.
3. Module on/off flags in the license key feed the existing Settings module; they do not create a second feature-flag system.
4. If the license is missing, malformed or fails signature validation, the application starts in **Read-Only** state (see D-24) — it does not crash and it never destroys data.

---

### D-24 — License term and expiry behaviour  ·  **Phase 1 (state machine), Phase 14 (UI)**

**Decision.** On-premise licenses are contract-term based (typically 1 year or 5 years). Expiry degrades the system gracefully; it never locks the customer out of their own data.

**License state machine.**

| State | Trigger | System behaviour |
|---|---|---|
| `ACTIVE` | Valid signature, `now < expiry` | Full operation |
| `EXPIRING` | Within 30 days of expiry | Full operation + persistent renewal banner |
| `GRACE` | `expiry < now < expiry + 30d` | Full operation + blocking warning at login |
| `READ_ONLY` | `now > expiry + 30d`, or invalid/missing license | No new transactions. Viewing, reporting, and **backup export remain fully available** |
| `RESTORED` | Valid renewed license installed | Returns to `ACTIVE`; no data loss, no re-entry required |

**Rules.**
1. There is **no state in which customer data is destroyed, hidden, or made un-exportable.** Backup export (D-15 `.sherdb`) works in every state including `READ_ONLY`.
2. The `READ_ONLY` behaviour must be stated explicitly in the sales contract so expiry is never a surprise.
3. License expiry checks use server time; clock tampering is not defended against beyond logging a warning. On the customer's own hardware, hard DRM is not achievable and is not attempted — the contract is the enforcement mechanism.
4. **Term recommendation:** sell the license term (1 or 5 years) separately from annual maintenance/support. A 5-year license without separately-billed maintenance obligates SherERP to support a five-year-old stack (Node, PostgreSQL, Drizzle majors) with no associated revenue.

---

## Deployment-Mode Configuration Flags

Both modes ship in one artifact. Mode is selected by environment configuration only.

| Flag | SaaS | On-premise | Effect |
|---|---|---|---|
| `SINGLE_TENANT_MODE` | `false` | `true` | Selects `SeedTenantProvisioner`, disables registration routes, hides tenant switcher |
| `IDENTITY_VERIFIER` | `otp` | `none` | Selects D-21 implementation |
| `ENTITLEMENT_SOURCE` | `subscription` | `license` | Selects D-23 implementation |
| `LICENSE_KEY_PATH` | unset | `/etc/sher/license.key` | Signed license file |
| `SMS_PROVIDER` | provider id | `none` | Disables SMS wallet (M29) |

**Boot-time validation is mandatory.** The application must refuse to start on any invalid combination — in particular `SINGLE_TENANT_MODE=false` with `IDENTITY_VERIFIER=none`. A misconfigured SaaS deployment with verification disabled is a critical security failure.

Full deployment detail, license key schema, install and upgrade procedure: see `11_DEPLOYMENT_STRATEGY.md`.

---

# Implementation Decisions (D-25 → D-32)

These eight were gaps found during the pre-build architecture sweep. Each one would have been decided implicitly and inconsistently by an AI coding agent at some point during the build, in a different way each time. They are decided here once.

**Principle applied throughout: choose the simplest option that does not create a correctness or rework problem.**

---

### D-25 — Period lock ownership  ·  **Phase 7**

**Decision.** Period lock is **not** a module. It is a `PeriodGuard` service in `core-application`, configured through Settings (M26) and enforced inside every use case that writes a document with a `business_date`.

- Lock granularity: **calendar month**, per tenant.
- States: `OPEN` → `CLOSED`. A closed month rejects any create, edit, void, or backdate landing in it with `PERIOD_LOCKED`.
- Unlock requires the `finance.period.unlock` permission **plus** step-up authentication, and writes an audit event naming who unlocked what and why (a reason string is mandatory).
- Re-costing (D-06/D-19 true-ups) **never** silently crosses a closed period. If a true-up would change a closed month, it is posted in the current open month as a correction entry referencing the original.

**Why not a module.** Locking is a cross-cutting precondition, like a permission check. Building it as a module would mean every other module calls into it anyway — with the added risk that some do not.

**Rule.** Any use case writing `business_date` calls `PeriodGuard.assertOpen()` between the permission check and loading aggregates (write path step 4).

---

### D-26 — Invoice templates  ·  **Phase 6**

**Decision.** An invoice template is a **saved set of line items** (product, quantity, optional price override) with a name. It is not a document, has no financial effect, and creates no journal entry.

```
sale_templates(id, tenant_id, name, party_id NULL, notes, ...)
sale_template_lines(id, tenant_id, template_id, product_id, qty, unit_price NULL, ...)
```

Behaviour: pick a template → lines load into a **draft** sale → user edits freely → posts normally. Prices are re-read live from the product unless the template stores an explicit override. A template never carries stale pricing into a posted invoice.

**Explicitly excluded from V1:** recurring/scheduled invoices, auto-send, subscription billing. Those are a different feature and would pull in scheduling infrastructure.

---

### D-27 — Daybook  ·  **new module M32 · Phase 9**

**Decision.** Daybook is a real module — the confirmed day-end review requirement. Full spec in `32_DAYBOOK.md`.

**Placement:** Phase 9, alongside Reports. It reads from every transactional module, so it cannot precede them; it must not be deferred past Reports because it is the owner's primary daily verification tool.

**Key constraint:** Daybook does **not** implement its own edit logic. Editing a sale from Daybook calls the same `UpdateSaleService` with the same permissions, period lock, and audit as editing it from the Sales screen. Daybook is a *lens*, never a back door.

---

### D-28 — Mobile strategy  ·  **V1 = PWA**

**Decision.** V1 ships the Vue web app as an installable **PWA**. React Native + Expo is deferred and may be dropped entirely.

**Rationale.** A separate React Native app is a second frontend codebase — the same trap as an on-premise fork (R-25), and this project cannot afford two UIs. A PWA covers the realistic mobile need (a phone or tablet on the shop floor for lookups, stock checks, simple POS) with zero additional codebase.

**Accepted limitations:** no native barcode hardware integration (camera scanning via the browser is adequate), no push notifications on iOS, and browser storage eviction risk on mobile (see D-29 note in `11_DEPLOYMENT_STRATEGY.md`). Revisit only if a paying customer's requirement is genuinely blocked.

---

### D-29 — Time and business date  ·  **Phase 0**

**Decision.**

1. All timestamps stored as `TIMESTAMPTZ` in **UTC**.
2. Each tenant has a timezone setting, default **`Asia/Dhaka`**.
3. `business_date` is a `DATE`, computed in the **tenant's** timezone, and is what every report, ledger, Daybook view, and period lock uses.
4. `created_at` is used for audit only, never for reporting.
5. Time is obtained through the injected `Clock` port. `new Date()` / `Date.now()` are banned outside its implementation (R-C8).

**Why this is a Phase 0 decision.** A sale rung up at 00:30 Dhaka time is 18:30 UTC the *previous* day. Getting this wrong moves a day's takings into the wrong report — and because both numbers look plausible, it can go unnoticed for months. Fixing it later means recomputing every historical report.

---

### D-30 — Document numbering  ·  **Phase 0**

**Decision.** Format `{PREFIX}-{YYYY}-{NNNNNN}`, e.g. `INV-2026-000123`.

- Sequence per `(tenant_id, doc_type, year)`, resetting annually.
- Allocated inside the document's own transaction from a counter row held with `SELECT ... FOR UPDATE` — no gaps from concurrency, no duplicates.
- `device_prefix` column reserved now and empty in V1. Future offline devices produce `INV-D2-2026-000123` with no schema change (A11).
- **Voided numbers are never reused.** A gap is normal and auditable; reuse destroys the audit trail.
- Prefixes are configurable per tenant in Settings; changing a prefix does not renumber history.

---

### D-31 — Rounding  ·  **Phase 0**

**Decision.**

- Mode: **half-up**.
- Money scale 2 (poisha). Quantity scale 3. **Unit cost scale 4.**
- Round **once**, at the storage or display boundary. Never round intermediate results.
- Line total = `round(qty × unit_price)`. Document total = **sum of already-rounded line totals**.

**Why unit cost carries 4 decimals.** FIFO consumption of fractional quantities against a 2-decimal unit cost accumulates error across thousands of movements until inventory valuation no longer ties to the ledger. Two extra digits cost nothing and eliminate the problem.

**Why the document total sums rounded lines.** The invoice must equal what the customer can add up by hand on the printed page. Summing unrounded lines and rounding at the end produces a total that is off by a poisha and impossible to explain at the counter.

### Allocation algorithm (binding)

Splitting one amount across several lines — landed cost, invoice-level discount, payment across dues, tax across items — uses the **largest remainder method**:

1. Compute each share as `floor(total × weight_i / Σweights)`.
2. Compute the leftover: `total − Σ floor_shares`.
3. Distribute the leftover **one minor unit at a time**, to the items with the largest fractional remainder.
4. **Tie-break by line index, ascending.** The earliest line wins.

Guarantees, all asserted in CI:

- The parts **always** sum exactly to the whole — no residue, ever.
- The result is **deterministic**: the same input always produces the same split, on the server, in the browser, and on a future offline device.
- Works when the total is smaller than the number of parts: `allocate(1 poisha, [1,1,1]) → [1, 0, 0]`.

**Why largest-remainder and not "give the rest to the last line".** Dumping the remainder on the final line makes that line visibly wrong on documents with many small items, and customers notice. Largest-remainder puts each stray poisha where it is most mathematically justified. Determinism matters more than fairness here: a non-deterministic split means the browser and the server can compute different numbers for the same invoice, which would surface as a phantom sync conflict that nobody can reproduce.

---

### D-32 — Concurrency  ·  **Phase 0 primitives, enforced per module**

**Decision.**

| Scenario | Mechanism |
|---|---|
| Two users edit one document | Optimistic lock on `version` → `CONFLICT_STALE_VERSION` |
| Two sales consume the same lot | **Pessimistic** `SELECT ... FOR UPDATE`, lots ordered by `id` to avoid deadlock |
| Document number allocation | `SELECT ... FOR UPDATE` on the counter row |
| Cash session close during an in-flight sale | Session state re-checked inside the same transaction |

**Lot consumption must be pessimistic.** Optimistic retry on stock produces oversell under POS load, and in a hardware shop that means a customer has paid for goods that are not on the shelf. This is one of the few places where the more expensive mechanism is the correct one.

---

## Decision Index

| Range | Domain | Phase |
|---|---|---|
| D-01 → D-20 | Product and business rules (owner-verified) | Various |
| D-21 → D-24 | Deployment mode: SaaS vs on-premise | Phase 1 |
| D-25 → D-32 | Implementation mechanics | Phase 0 / 6 / 7 / 9 |

**All decisions are final.** An agent encountering a case not covered here must **STOP and report** (R-A5), never improvise.
