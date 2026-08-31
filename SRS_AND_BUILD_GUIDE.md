# SherERP — Master SRS & Build Guide v4.2 (Reuse & UI Migration Reconciled)

**Canonical reconciliation date:** 2026-08-20 (Reuse, UI migration and compact-ledger reconciliation)

**Single source of truth for requirements, decisions, architecture, UI behaviour and build order.**
Supersedes the previous `SRS_AND_BUILD_GUIDE.md`, SRS v3.0, the former `docs/` planning package, and the historical Confirmed Module documents.

This version merges the strongest architectural/accounting/sync rules from the current implementation SRS with every owner-confirmed business/UI requirement reconciled on 2026-08-18. Where an older confirmed requirement conflicts with a newer decision, this document is authoritative.

Companion files: `AI_CODING_INSTRUCTIONS.md` (how to write code), `AGENTS.md` (repo orientation). Nothing else.

**Rule for this document:** decisions here are final. An agent hitting a case not covered here **stops and reports** — it never improvises a business rule.

---

# PART 1 — PRODUCT

## 1.1 What SherERP is

Multi-tenant SaaS ERP for Bangladeshi SME retail/wholesale: POS, inventory with lots and costing, purchasing, parties, ledgers, cash/bank, expenses, returns, warranty, reports, audit. Sold as SaaS and as on-premise (one build, config-selected).

**Governing principle:** maximum legitimate business freedom, while security, tenant isolation, accounting correctness, inventory correctness, auditability, API quality, performance and reliability remain mandatory.

## 1.2 Delivery sequence

```
Online-first
  → Sync infrastructure
  → PWA Offline (SQLite WASM + OPFS, single writer)
  → Mobile
  → Optional Tauri desktop packaging in a future phase
  → MCP
```

V1 is **online-first**. Sync-readiness is designed from day one. Full browser offline is a later phase and remains the canonical offline runtime. Mobile follows the PWA path first. **Tauri is deferred, not part of V1 and not a prerequisite for offline**; a future Tauri shell may package the same application only if a demonstrated OS-integration need justifies it. MCP remains a later integration phase.

No future Tauri implementation may fork business rules, create a second transaction engine, or bypass the REST/application-service/domain boundaries defined here.

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
| Mobile | PWA first. Native mobile may be evaluated later without duplicating domain rules (D-28) |
| Future desktop | Optional Tauri packaging **after Mobile**, only if justified; it must reuse the same domain/application services and offline database contract (D-20) |
| Rejected for V1 | Tauri/local Node sidecar as the primary offline architecture · T3 stack (D-21) |
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

**Created later, in their own phase, not now:** `packages/adapter-sqlite-wasm` (Phase 12 — SQLite WASM over OPFS, loaded inside `apps/web`) and `apps/mcp` (Phase 15). Creating empty packages ahead of time is speculative scaffolding — the layering that makes them possible is what matters, not the folders.

**There is no `apps/desktop` in V1 or the PWA-offline phase.** The offline adapter is a browser-side package consumed by `apps/web`. A future Tauri phase may add a packaging shell only after the Mobile phase and must not move business logic out of `core-domain`/`core-application`. Those packages therefore remain free of Node built-ins (`fs`, `path`, `crypto`) as well as NestJS and Drizzle. The boundary checker enforces this from Phase 0.

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

- Internal accounts are system-managed: `AR`, `AP`, `CASH:{id}`, `BANK:{id}`, `INVENTORY`, `COGS`, `SALES`, `EXPENSE:{cat}`, `VENDOR_PAYABLE`, `CUSTOMER_ADVANCE`, `SUPPLIER_ADVANCE`, `VENDOR_ADVANCE`, `WARRANTY_EXPENSE`, `CASH_SHORT_OVER`, `STOCK_ADJUSTMENT`, `OWNER_CURRENT_ACCOUNT`, `ROUNDING`, `OPENING_EQUITY`. `SUPPLIER_ADVANCE` and `VENDOR_ADVANCE` are current-asset accounts for money paid before goods/settlement; they must not be represented as negative liabilities in the Balance Sheet. This list is closed — an agent needing an account not on it must **stop and report**, because a new account changes what every report means.
- **`STOCK_ADJUSTMENT` is the stock-side counterpart of `CASH_SHORT_OVER`** (owner decision 2026-08-20). It is a P&L account: a stock loss (damage, theft, a count that came up short) debits it, a stock gain (found stock, a count that came up long) credits it, and `INVENTORY` moves by the same amount on the other side. Without it a physical-count correction has nowhere to balance to, so `INVENTORY` would permanently disagree with the goods on the shelf and INV-05 could not hold — the identical argument that added `CASH_SHORT_OVER`. Its balance over a period is the shop's total shrinkage, which is the number a shopkeeper needs and cannot get from a stock report alone. Adjustments are **never** posted to `OPENING_EQUITY` (that account is for opening balances, and a later correction is not an opening) or to `COGS` (goods lost were not sold, and burying them in cost of sales destroys the margin figure).
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

**Design goal:** SherERP must feel simpler than the owner's existing ERP while completing more related work in-place. A Bangladeshi shopkeeper who mainly uses an Android phone, Facebook and YouTube should be able to complete daily work without training, while an experienced counter operator still gets keyboard speed. **Simplicity means fewer decisions and fewer context switches, not fewer capabilities.** The interface shows the most likely next action first, keeps related work in the current business context, and progressively discloses secondary or exceptional actions.

Rules are numbered `UI-nn` so a task block or a review can cite them. UI-14…UI-21 implement D-12; they do not change it.

**Who this is actually for (owner direction 2026-08-19, binding on every screen).** The customer is a Bangladeshi shop owner who is *not* a graduate, whose whole computing experience is an Android phone, Facebook and YouTube. They are not short of intelligence — they run a business on margins and remember a thousand prices — they are short of *screen literacy* and of patience for a workflow that assumes office software. So: the five daily jobs (**add a product, add a customer, add a supplier/vendor, record an expense, make a sale**) must be doable without training and without reading a manual; a control they have not seen on a phone needs to earn its place; anything that can be tapped rather than typed should be; and the words on the screen are the words spoken across a counter (UI-16). When a design choice is defensible to a developer but would leave that shopkeeper hesitating, it is the wrong choice.

### A. Familiarity — patterns, not appearance

| # | Rule |
|---|---|
| UI-01 | Borrow **interaction and navigation patterns** users already know: persistent navigation on larger screens, a compact top bar, one global search, familiar notification/account affordances, simple lists, and a bottom bar or drawer on small screens. Borrow familiarity, not visual clutter. A pattern is kept only when it reduces hesitation or navigation. |
| UI-02 | **Never copy their visual identity** — no imitation of the colours, logo, typeface or brand styling of Facebook, YouTube or any other product. SherERP has its own plain, professional look. This is a legal line as much as a design one. |
| UI-03 | **Component library: PrimeVue 4** (styled mode), self-hosted (D-37). The visual rules below are implemented through the existing PrimeVue preset and shared CSS tokens. Tailwind utility syntax in a design reference describes appearance, not a dependency; do not add Tailwind or a second UI library. |
| UI-04 | Icons come from one self-hosted Vue-compatible set — **primeicons**, which ships with PrimeVue — 16–18px, and only for familiar meanings (search, bell, cart, print, filter, back, menu, user). `lucide-react` is not used because this is a Vue application, and no second icon set is added. An icon needing a legend gets a text label instead. |
| UI-05 | Every screen is understandable without a manual: visible labels, no icon-only primary actions, no hidden gestures, no hover-only affordances. |
| UI-06 | **All assets are self-hosted** — fonts, icons, images. §6.5 requires COOP/COEP for SQLite WASM in Phase 12; a CDN font breaks it. |
| UI-07 | The API base URL is read at runtime from `/config.json` (§6.5). `import.meta.env.VITE_API_URL` is banned — it forces a per-customer frontend build. |

### B. Shell and navigation

| # | Rule |
|---|---|
| UI-08 | One shared shell. Desktop uses the 256px sidebar / 68px collapsed rail; tablet and phone use the responsive navigation in UI-11. Desktop content padding is 32px horizontal / 24px vertical with a maximum width about 1400px; shared responsive tokens reduce padding on smaller screens instead of preserving desktop whitespace. Sidebar order is brand → primary navigation → flexible spacer → business identity. The top bar carries sidebar toggle · global search · business date · theme toggle · account menu. The page header belongs to the shell. POS runs full-screen without the sidebar. Colours and geometry are §2.7.I. |
| UI-09 | Navigation is generated from the permission-filtered feature list, ordered entitlement → feature setting → permission (§5.21). **Never render a control that will 403.** |
| UI-10 | The sidebar is one level deep wherever possible; a second level only where a module genuinely has sub-areas. No third level. |
| UI-11 | Responsive navigation: sidebar on desktop, collapsible drawer on tablet, bottom bar with the 4–5 most-used destinations on phone. The same destinations, the same names, in the same order, on all three. |
| UI-12 | Global search in the top bar covers products, parties and documents, and is reachable by keyboard from anywhere. |
| UI-13 | Every screen has a route with a stable path and is reachable from navigation or from a parent record (R-S7). |
| UI-54 | **Use PrimeVue 4 controls wherever the library has the correct semantic component** (owner decision 2026-08-20). All single-choice dropdowns use PrimeVue `Select` (searchable where the option set can grow); all business-date and expiry-date fields use PrimeVue `DatePicker` through one shared date-only adapter that preserves the canonical `YYYY-MM-DD` value without timezone conversion. Native `<select>` and browser `input[type=date]` are forbidden in SherERP screens unless a documented accessibility or platform defect makes the PrimeVue control unsuitable. The shared SherERP preset and tokens control density, focus, dark mode and error states; pages do not restyle a second version of the same control. |
| UI-55 | **Navigation uses a data-driven Category → Subcategory architecture over only SRS-required capabilities.** The persistent sidebar renders Category → Subcategory; it does not mirror every action as a menu entry. Opening a subcategory enters its working hub. Repeated subviews that users genuinely switch between may use compact scrollable PrimeVue tabs; operational commands such as Receive, Pay, Return, Correct, Print or Share are contextual actions, not navigation tabs. Infrequent or sensitive actions live under a clearly labelled `More actions` / `⋯` menu. **Parties (পার্টি)** is the sidebar category, with Customers, Suppliers and enabled Vendors as independent subcategories over the shared Parties domain. Dealer remains a Customer Group. No empty category, speculative feature, duplicate role switcher or permanently expanded third navigation level is rendered. Desktop uses the categorized PanelMenu, tablet/mobile use the PrimeVue Drawer/bottom navigation with the same resolved destinations, and expansion state persists per device. |
| UI-56 | **Related work is completed in one working hub; navigation changes context, actions do work.** Product/Categories/Brands/Units stay in Product Management; Stock/Adjustment/Movement/Lots/Serial/Expiry/Warranty/Valuation stay in the Inventory hub; customer sales, receipts, due/advance, returns, statements and ledger stay in the Customer hub; supplier/vendor equivalents stay in their role hub; finance entry/audit work stays in Counter (Quick Transactions), Daybook and the relevant account hub. A feature label does not imply a separate route. Create a separate full screen only when the task genuinely needs its own large transaction workspace (for example sale/POS or purchase lines), not merely because the backend has another capability. |
| UI-57 | **Do not place decorative introduction cards above self-explanatory forms** (owner decision 2026-08-20). Repeated icon/title/subtitle blocks such as “Who this is / Their name and how to reach them” consume space without adding an action or business fact and are omitted. Begin with the labelled fields. Keep only headings/disclosures that separate genuinely different field groups, and keep concise guidance where omitting it could cause an incorrect stored value or irreversible action. |
| UI-58 | **List and ledger-overview screens show only the smallest daily-use column set.** Searchable/detail-only identifiers, configuration fields and secondary facts do not occupy permanent columns just because they exist in the schema. Row-specific work lives in one permission-filtered `⋯` menu. Centralized tenant-configurable optional columns may be added later through one shared list-column contract, never page-local preferences. **Party ledger overview default columns are fixed for V1:** `Name` · `Phone` · `Address` · role-relevant `Current Balance` (`Due/Advance`, `Payable/Advance`, or Vendor net position) · `⋯`. Opening a row/name enters the individual ledger hub; the individual transaction ledger has its own Date/Reference/Debit/Credit/Running Balance columns and is not constrained to the overview columns. |
| UI-59 | **Use compact operational density across every module** (owner decision 2026-08-20). Remove ornamental whitespace and keep page padding, section gaps, cards, dialogs, filter bars and table rows as small as practical for daily ERP work. Density is controlled by shared shell/tokens/PrimeVue preset rather than page-specific shrinking. Preserve the 40px touch target, readable Bangla helpers, validation/consequence guidance, responsive overflow and accessibility focus states; compactness must not hide a required field, truncate a money/quantity fact, or make actions difficult to tap. |
| UI-60 | **Stay in context.** The sidebar/global navigation changes business context; it is not required for every operation. If the user is already inside a Customer, Supplier, Vendor, Product, Invoice, Purchase or Daybook record, normal related work starts there. |
| UI-61 | **Progressive disclosure.** Show the most likely next action directly, frequent related views/actions nearby, and infrequent/sensitive actions under `More actions` / `⋯`. Do not expose every capability as an equal-weight button, card or tab. |
| UI-62 | **Never ask again for context SherERP already knows.** `Customer → New Sale` preselects that customer; `Supplier → Pay` preselects that supplier; `Invoice → Return` preselects the source invoice/eligible lines; `Product → Movements` is already filtered to the product; `Daybook → Open Original` opens the exact source document. The user may deliberately change context only when the business rule allows it. |
| UI-63 | **Many entry points, one authoritative use case.** Customer, Invoice, Daybook, Search, Sales History and other contexts may launch the same Return/Receive/Pay/Correct/Void workflow, but all call the same application use case and permission/posting/reversal rules. A convenience entry point never creates a second transaction engine. |
| UI-64 | **Preserve working state.** Dialog/drawer completion, cancellation and return-from-related-document preserve the originating record, selected tab, active filters, search and practical scroll/page position. A successful mutation refreshes authoritative data without sending the user back to a module root unless the current record no longer exists or permission changed. |
| UI-65 | **Simple outside, powerful inside.** UI simplicity is measured by the number of decisions, re-searches and navigation hops needed to finish a real task, not by the number of capabilities implemented. A more capable module is acceptable only when its everyday path stays obvious. |
| UI-66 | **Reference screenshots specify workflow behavior, not visual identity.** Owner-supplied legacy screenshots/mockups are binding evidence for information hierarchy, action proximity, context preservation and task flow when the SRS points to them; SherERP improves spacing, consistency, responsiveness, accessibility and visual polish rather than copying old styling or accidental defects. |
| UI-67 | **Daily is the first operational sidebar category.** It contains the implemented/permitted entries `POS`, `Counter`, `Daybook`, and `Daily Cash`. `Counter` is UI-53. `Daily Cash` is the cash-session reconciliation/history view from §5.16.8. Entries appear only when their backing capability is implemented, enabled and permitted (UI-09); the category must not expose speculative placeholders. |
| UI-68 | **Daybook is the universal daily review and correction launcher.** The default view is the selected `business_date`/transaction-date range, with filters for type, party, user and account. Every row opens the real source transaction and exposes only valid source-module actions such as Edit/Correct, Return, Receive/Pay, Change Transaction Date, Print/Share and Delete/Void. Familiar UI labels may say `Edit` or `Delete`, but posted records still use versioning/reversal/void semantics; Daybook never updates journal/document rows itself. |
| UI-69 | **All ledgers default to Transaction Date and can switch to Entry Date for audit.** Customer, Supplier, Vendor, Expense Category/Ledger, Cash, Bank and Daybook show `Transaction Date` (`business_date`) by default. Authorized users may switch to `Entry Date` (`created_at`) to answer when data was entered. Changing a transaction date never changes `created_at`; the corrected `business_date` propagates naturally to all journal-derived ledgers/reports because there is one posted source of truth. |
| UI-70 | **Account Reconciliation is an account hub workflow.** Select a Cash/Bank/MFS account and date range, compare SherERP ledger activity to the physical/external statement, and launch `Open`, `Change Transaction Date`, `Correct`, `Add Missing Entry`, `Reverse/Void Duplicate/Wrong Entry`, and `Mark Reconciled` through the owning use cases. Reconciled history is never silently rewritten; later changes raise review. |
| UI-71 | **Daily Cash is expected-vs-counted reconciliation, not a free balance editor.** For each cash session it shows Opening, Cash In, Cash Out, Expected Closing, Physical Count, Difference and Note/Reason. The expected amount is immutable after close; a shortage/overage remains on that day and posts through `CASH_SHORT_OVER`. Selecting a mismatched day can open Daybook already filtered to that session/account/date for investigation, then return to the same Daily Cash row. |
| UI-72 | **One business action has one authoritative callable module/interface, regardless of how many screens expose it.** Example: editing/correcting a Sales Invoice from Customer Ledger, Sales Invoice History, Invoice Detail or Daybook must converge on the same invoice edit/correction use case. Draft edit and posted correction/versioning may branch internally according to document state, but callers do not implement their own variants. The same rule applies to Receive Payment, Supplier/Vendor Payment, Sales/Purchase Return, Void/Reverse, Change Transaction Date and other repeated actions. |
| UI-73 | **Existing-code migration precedes new-module expansion.** When a currently built module conflicts with the final SRS or contains duplicated business functions, finish that module's consolidation/refactor and real-UI migration first. Do not start the next business module while the current built module still has known duplicate writers, broken final-v4.2 workflow, or unresolved UI acceptance defects. Refactoring is allowed and required **inside the affected module/seam** when needed to establish the one authoritative implementation; unrelated cleanup remains forbidden. |



### C. Language — English UI, Bangla helper text (D-12)

| # | Rule |
|---|---|
| UI-14 | **The primary UI language is English.** Labels, buttons, menus, table headers and messages are English. The UI is not bilingual. |
| UI-15 | **Bangla helper text is visually subordinate to the English label.** Preferred compact label treatment is inline, for example `Supplier — সাপ্লায়ার`: English at the normal label weight/size, Bangla immediately after it in a smaller muted style. Do **not** normally stack `Customer` with `কাস্টমার` as a second full line underneath, because that increases row/form height and makes the ERP look busier. Use a shared helper token so pages cannot invent their own Bangla size/colour. |
| UI-16 | **Bangla guidance is contextual and must not damage the layout.** English remains the primary visible label. Use the compact inline treatment from UI-15 where it fits cleanly. If a second visible language would crowd a table header, narrow toolbar, icon action, compact row or mobile surface, keep the English label/action clean and expose the Bangla helper through the shared PrimeVue tooltip/help affordance instead. Tooltips must work on hover **and** keyboard focus, and any meaning required on touch must also be reachable by tap/focus; never make essential information hover-only. The same business concept reuses one helper key (UI-19). |
| UI-17 | Helper text is secondary in the visual hierarchy — smaller, muted — and never replaces the English label. |
| UI-49 | **Use tooltips aggressively for secondary guidance, but never to hide the primary task.** Icon-only controls, row `⋯` actions, unfamiliar abbreviations and places where visible Bangla would break compact layout use a concise shared PrimeVue tooltip. Longer consequence/help text uses the accessible help-tip pattern. Tooltip/help opens on hover or keyboard focus and must have a touch-accessible path where the information matters; no bare browser `title` attributes. Primary action names, critical amounts/status and destructive consequences remain visibly understandable without a tooltip. |
| UI-18 | Every string, English and Bangla, is an i18n key from Phase 1 — `sales.invoice.due.label` and `sales.invoice.due.help_bn`. A helper key may be absent; that is the normal case. No hardcoded strings. |
| UI-19 | One helper string per business concept, reused everywhere. Two different Bangla explanations of "due" is a defect. |
| UI-20 | The same language approach applies identically to Web, POS and mobile layouts. **Printed documents follow D-12 and §5.24 instead** — invoices support full Bangla and English, which is a separate concern from UI helper text. |
| UI-21 | Terminology settings (§5.21) are display mappings — changing a label never changes accounting semantics, and no component branches on a label (§2.4). |
| UI-74 | **Counter surfaces are English-primary with Bangla helper text** (owner decision 2026-08-31, replacing the Bangla-first rule of 2026-08-24). On the screens a cashier uses to do a job right now — Counter itself, Start Day, End Day, Reopen Day, cash in/out, owner money, POS payment — the **English phrase is the visible label** at normal label size and weight, and the Bangla sits under it as the 11px muted helper UI-15 gives it everywhere else. This makes the counter obey UI-14/UI-15 like the rest of the product rather than inverting them. **Why the earlier decision was reversed:** the counter is not one screen but a workflow — a launcher, then a dialog, then a confirmation — and under the old rule it changed register halfway through, because the dialogs a cashier reaches from Receive Money and Pay Supplier were English-primary already. One register end to end beats a stronger label on one screen of three. The Bangla is still present, still on every counter control, and still says the thing in the shop's own sentence (UI-75); it is the helper, not the headline.
| UI-75 | **A counter surface asks in the shop's own sentence, and prefers a tap to a typed word.** The label is the question as spoken across the counter — `How much cash is in the drawer now?` with `ড্রয়ারে এখন কত টাকা আছে?` beneath it (UI-74 as amended 2026-08-31), not `Counted cash` — and it names the one thing to do now: one primary action per screen, large enough to hit, with an icon carrying the same meaning as the words. Where an answer is a choice from a known set, it is a row of large preset buttons (`মালিক নিলেন` · `ব্যাংকে জমা` · `সিন্দুকে রাখলাম`) rather than a dropdown or free text; free typing is reserved for the amount and for a genuinely open note. Accounting vocabulary — session, reversal, shortage/overage, reconciliation, journal, opening equity — stays in the spec, the API and the Owner screens; the counter sees `টাকা কম` and `টাকা বেশি`. UI-47 is unaffected: digits stay Western inside Bangla labels. |

### D. Working surfaces and stay-in-context workflow

| # | Rule |
|---|---|
| UI-22 | **Choose the smallest working surface that completes the task without losing context.** The supported surfaces are: **List** (find/select records), **Hub/Detail** (one business context with summary, related history and actions), **Form** (focused data entry), **Dialog/Drawer** (short create/edit/action without leaving the current context), and **Transaction Workspace** (line-heavy sale/POS/purchase or similarly dense workflows). Do not force a workflow into a pattern merely for consistency; use the simplest surface that keeps the user's current context intact. |
| UI-23 | **Cards are for useful facts, not decoration or mandatory wrapping.** Dashboard and hub summary cards/tiles are allowed only when they expose an operational fact such as due, advance, payable, open documents, stock, cash or recent activity. Transactional lists may sit in a simple bordered/raised surface without an extra decorative card hierarchy. `Why?` drill-down remains mandatory only where §5.20 requires it. |
| UI-24 | Lists use keyset pagination (§3.9), never offset. Lists that can exceed ~500 rows use virtual scroll. |
| UI-25 | Filters are visible on the screen, not hidden behind a menu, and the active filter set is readable at a glance. |
| UI-50 | **Simple master data is created and edited in a dialog/drawer over its current list or point of use.** Product, customer, supplier, vendor, category, brand, unit and similar master data do not require a navigation round-trip. The compact form shows required fields plus the one or two normally needed fields; optional details sit under `More`. Saving closes the surface, refreshes the originating context and keeps its search/filter/scroll state. **Expense is a transaction, not master data**: expense entry uses the Expense workflow or Quick Transactions and follows Class T posting rules. Line-heavy sale and purchase documents remain transaction workspaces. |
| UI-51 | **Every picker of master data carries a joined settings action beside it, and every managed row carries its own actions** (owner decisions 2026-08-19 and 2026-08-20). `Category`, `Brand`, `Unit` and equivalent pickers use one visually joined `[ PrimeVue Select | gear ]` control: the gear is a separate icon-only button divided from the Select, never triggers the Select, and opens the full list of that master data, where each row has a `⋯` menu with `Edit` and `Delete`. Every icon-only action has a concise PrimeVue tooltip on hover/focus and an accessible name, so its meaning remains available to keyboard, screen-reader and touch users. The rule generalises: **the actions for a thing live where the thing is shown**, never only on a distant settings screen. Quick add (UI-45) and this are two halves of one idea — UI-45 creates a missing record from the point of use, UI-51 fixes or removes an existing one from the same place — and both go through the same use case, permission check and audit as the full screen (R-D, DRY). A row's actions are absent, not disabled, for a caller without the permission (UI-09), and §3.6 still decides whether `Delete` removes or archives, telling the caller which happened. |
| UI-52 | **A business record is a working hub, not a read-only detail page.** Selecting a customer opens that customer's useful summary, due/advance, invoices/sales, receipts, returns, statement and ledger in one context; supplier/vendor hubs expose the purchase, payment, credit, return and consignment equivalents. Show the most common next one or two actions directly; expose frequent related work as tabs/contextual actions; keep infrequent or sensitive actions under `More actions`. Every related row source-links to the authoritative document. Completing or cancelling an action returns to the same record, tab, filters and practical scroll position. No hub calculates or stores its own balance, and no hub owns a duplicate writer. |
| UI-53 | **`Counter` is the user-facing name of the Quick Transactions workspace, not a cash account or a second transaction engine.** It is the centralized manual Money In / Money Out workspace with exactly three primary tabs: **Receive Voucher**, **Payment Voucher**, and **Expense Voucher**. Receive selects a customer/allowed receivable party, shows the journal-derived Due/Advance plus open documents, and calls the existing receipt use case. Payment selects a supplier/vendor/allowed payable party, shows Payable/Advance plus open documents, and calls the existing payment use case. Expense selects an **Expense Category/Ledger** (for example Salary, Electricity, Transport, Rent), optionally identifies the Payee/Employee/Party, selects the payment account, and calls the existing expense use case. The Counter owns no balance, journal rule, allocation rule, correction rule or transaction table. It may preserve business date and payment account between consecutive entries, but every save has its own operation ID, document/voucher number, posting and audit event. |
| UI-46 | **Every column header in every list sorts, by tapping it** (owner decision 2026-08-19). Tap `Name` to sort by name, tap `Stock` to sort by quantity, tap again to reverse. This is the sorting model shop owners already know from their phone's file and gallery apps, and it replaces any separate "sort by" dropdown — a control that hides sorting behind a menu is a defect. The active sort shows an **arrow on that header**, so what the list is ordered by is readable without tapping anything, and the arrow points the way a person reads the result (down = biggest/latest first). The sort survives paging and is part of the keyset cursor (§3.9); columns come from a closed per-endpoint allow-list and each is indexed. A column showing a figure the database cannot order by — a computed mixed quantity, a derived label — is **not** made sortable rather than sorted approximately in the client, which would order one page instead of the list. |
| UI-26 | Destructive or financial actions (void, reverse, unlock period) are explicit actions opening a confirmation that names the document and consequence in clear English with concise Bangla consequence guidance where useful. Never an inline toggle, never a swipe. |
| UI-45 | **Quick add from the point of use — system-wide (D-39).** Wherever a form must pick an existing record, the same screen can create it inline without navigating away or losing what is already typed: a unit, brand or category while adding a product; a supplier while entering a purchase; a customer at the till; a customer group while editing a customer. The inline form asks **only for what that record cannot exist without** — the rest is filled in later on the record's own screen, and a record created this way is an ordinary record, not a draft or a stub. It goes through the same use case, validation, permission check and audit as the full form: **never a second write path**, and never a set of relaxed rules (R-D, DRY). It is offered only to a caller holding the create permission for that record, and only while the feature owning it is on (UI-09); otherwise the control is absent, not disabled. |

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
| UI-47 | **Digits on screen are Western** — `৳1,250.75`, `01712345678` (owner decision 2026-08-19). This is what the phone keypad, the calculator, bKash/Nagad and printed price tags all show, so a figure on screen can be checked against the device in the shopkeeper's other hand without transliterating. Bengali numerals on screen are a defect, **including** inside Bangla helper text. Printed documents are the separate concern UI-48 governs. |
| UI-48 | **Printed documents carry two language modes, Bangla and English** (owner decision 2026-08-19), covering the sales invoice, purchase invoice and purchase order. The shop picks its **default** in printing settings (§5.21); the print dialog then offers a one-tap switch for the other, because the customer standing at the counter and the supplier being emailed do not always want the same language. Switching is a **rendering** choice only — it never re-posts, re-numbers or alters a stored figure, and both modes render the same document id, totals and business date. In Bangla mode the numerals are Bengali, which is the one place they are correct; the money values themselves are unchanged. |

### G. Mutations and POS

| # | Rule |
|---|---|
| UI-34 | The client generates the `operation_id` (ULID) **once per user intent** and reuses it on retry — this is what makes R-D3 idempotency reachable from the UI. |
| UI-35 | Submit buttons disable while in flight; double-submit is impossible by construction, not by user discipline. |
| UI-36 | **No optimistic UI for anything touching money or stock.** The screen renders the server result. When an action was launched from a hub, Daybook, search result or source document, success updates that context and returns/stays there with the created document number visible; a standalone transaction workflow may land on the resulting document. The user is never forced through an unrelated menu after a successful action. |
| UI-37 | POS is keyboard-first: the scan/search field holds focus by default and returns to it after every line. Every POS action has a keyboard shortcut; nothing requires a mouse. |
| UI-38 | Barcode input is treated as keyboard input terminated by Enter — no driver, no pairing. |
| UI-39 | Nothing blocks completing a sale — not a print failure (D-22), not a customer lookup, not an undismissable warning. Credit-limit excess warns only (D-11). |
| UI-40 | Cost is never rendered without `inventory.cost.view`, and the field must be **absent from the API response**, not hidden in CSS (§5.7, R-E8). |

### H. Devices and quality

| # | Rule |
|---|---|
| UI-41 | **Daily workflows are responsive from Phase 1 on desktop, tablet and Android phone.** Desktop remains the fastest back-office layout; POS and Daybook optimize for tablet landscape but remain usable on phone; product/customer/supplier/vendor/expense creation, lists, search, hub actions and payment/return dialogs must be fully operable on phone, not best-effort. Large tables may switch to compact cards/rows or horizontal overflow, but no required action may disappear or become hover-only. |
| UI-42 | Minimum accessibility: every input labelled, focus always visible, POS tap targets ≥40px, contrast ≥4.5:1. Full WCAG conformance is not claimed. |
| UI-43 | Zero console errors or warnings on an accepted screen (Gate 3). |
| UI-44 | **Every module ships a UI acceptance trace plus one end-to-end workflow smoke test.** Before coding, map each applicable UI rule and module action to a screen/surface, implementation location and verification method. Before `CODE COMPLETE`, run the real workflow at desktop, tablet and phone widths for the daily paths, verifying required actions, progressive disclosure, context return, loading/empty/error/permission states, theme, keyboard/touch behavior and zero console warnings. Shared state components are tested once; business assertions remain in domain/integration tests. |

### I. Binding visual system — consistent from the first screen

**Revised 2026-08-18** from the owner-approved prototype set (`design-system/prototypes`, `design-system/references`). The tokens and component shapes below are the single SherERP visual language. They are stored centrally in `apps/web/src/design/` and the PrimeVue preset; pages consume them and must not redefine them.

**Two themes ship, and the theme is a per-device user choice.** Light is the default; dark is selected by the person using the machine and remembered on that device. `prefers-color-scheme` is deliberately **not** followed — a shop PC left on a vendor default, or a phone that darkens at sunset, must never flip a running counter to a theme nobody in the shop chose.

| Role | Light | Dark |
|---|---|---|
| Page background | `#f4f6fa` | `#080c14` |
| Card / raised surface | `#ffffff` | `#0f1623` |
| Sidebar and top bar | `#ffffff` | `#0b111c` |
| Sunken (table head, filled input, tile) | `#f7f9fc` | `#141c2b` |
| Primary action and active navigation | `#2563eb` (hover `#1d4ed8`) | `#3b82f6` (hover `#2563eb`) |
| Primary text | `#0f172a` | `#e8edf6` |
| Secondary text | `#64748b` | `#94a3b8` |
| Muted labels | `#94a3b8` | `#64748b` |
| Borders | `#e5e9f0`, strong `#d5dbe5` | `#1e293b`, strong `#2b3a50` |
| Success badge | bg `#dcfce7`, text `#15803d` | bg `rgba(34,197,94,.14)`, text `#4ade80` |
| Warning badge | bg `#fef3c7`, text `#b45309` | bg `rgba(245,158,11,.14)`, text `#fbbf24` |
| Danger/due badge | bg `#ffe4e6`, text `#be123c` | bg `rgba(244,63,94,.14)`, text `#fb7185` |
| Info badge | bg `#e8f0fe`, text `#1d4ed8` | bg `rgba(59,130,246,.14)`, text `#93c5fd` |

**Summary-tile tones — chosen by meaning, never by taste.** Money in is **blue**, cost is **slate**, profit is **green**, something needing attention is **amber**, a receivable is **violet**, a payable is **rose**. A module may not reuse a tone for a different meaning.

- Saturated colour is limited to: the primary action, the active navigation pill, status badges, category dots and summary tiles. **Gradients are allowed only** on a summary tile's fill, the brand mark and the avatar. Tables, forms, charts and page chrome stay neutral in both themes.
- Typography uses the self-hosted system sans stack. Page title 24px bold; breadcrumb 12px secondary; card title 18px semibold; table header 12px uppercase with tracking and muted colour; body/table 14px; helper and fine print 12px. Bangla helper text is **11px**, muted and visually lighter than the English label; the default is inline after the English label when space permits, never replacing it (UI-15…UI-17).
- Geometry: card radius 12px (auth card 16px), control radius 8px, badge fully rounded; control height 40px (32px for compact row controls); card padding 20px; content padding 32px horizontal / 24px vertical; maximum content width 1400px; sidebar 256px, 68px collapsed.
- Shell: white/dark sidebar with brand → primary navigation → flexible spacer → business identity pinned to the bottom. The top bar carries sidebar toggle · global search · business date · theme toggle · account menu. The page header lives inside the content area: breadcrumb → title → Bangla helper on the left, the screen's own actions on the right. POS runs full-screen without the sidebar.
- Buttons: primary is solid primary with white text; secondary is the card surface with a strong border; danger is the card surface with danger text and border. All 8px radius, 40px tall, 18px horizontal padding. Icon-only controls are permitted for row actions and shell affordances only, always with an accessible name (UI-05).
- Active navigation is a soft primary pill with primary text in light, a solid primary pill with white text in dark. Inactive items use secondary text with a neutral hover fill.
- Tables have no vertical borders; rows use thin dividers. Text aligns left, money and quantity align right with tabular figures, and state is a rounded badge rather than plain coloured text. Pagination sits bottom-right.
- Summary tiles: the **filled** gradient variant is for a dashboard's headline row only, at most six across. Module hubs use plain summary tiles **only when the figure helps the next decision** (for example due, advance, payable, open invoices, stock or cash). A hub is not required to have tiles. **Every figure is derived from authoritative journal/stock data or another SRS-defined projection (INV-10); placeholder or illustrative numbers are forbidden.**
- Module composition is **context-driven, not a fixed dashboard template**. Prefer: concise header → one or two primary actions → optional operational summary → the smallest useful tabs/filters → the main working list/history. Add a secondary chart/progress surface only when the module requirement needs it. Do not create a 2/3 + 1/3 layout merely for visual symmetry.
- The summary/progress card uses one horizontal stacked bar, then a legend with dot, label, percentage and right-aligned value, followed by a full-width `Show all` action when applicable.
- **Where this lives:** `apps/web/src/design/tokens.css` (all values, both themes), `design/components.css` (button, field, table, badge, notice, dialog, toolbar, skeleton shapes), `design/theme.ts` (the light/dark choice), `design/preset.ts` (PrimeVue), and the shared components `AppShell`, `AppSidebar`, `AppTopBar`, `AppCard`, `StatCard`, `EmptyState`, `ErrorNotice`. Reuse them. A new card style, navigation layout, accent colour, tone meaning or page composition requires an explicit edit to this section before implementation.

**Approved natural Bangla terms:** `Login` → `লগইন করুন` · `Customer name` → `কাস্টমারের নাম` · `Phone` → `ফোন নম্বর` · `Cash counter` → `ক্যাশ কাউন্টার` · `More customer information` → `কাস্টমারের আরও তথ্য` · `Guardian/Father's name` → `অভিভাবক/বাবার নাম` · `Address` → `ঠিকানা` · `Search invoices by phone` → `ফোন নম্বর দিয়ে আগের ইনভয়েস খুঁজুন` · `Save as customer` → `কাস্টমার হিসেবে সংরক্ষণ করুন`. These phrases are i18n values, not hardcoded component text.

**Deliberately not decided here:** logo artwork · POS p95 performance numbers (open item O-5, Phase 6) · full Bangla UI (D-12, V1.1) · PWA install prompt and persistent-storage gate (D-24, Phase 12) · print stylesheets beyond D-22 and §5.27.

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
| Registered customer lookup by phone | `(tenant_id, phone)` on parties |
| Invoice lookup by captured phone | `(tenant_id, customer_phone_snapshot, business_date DESC, id DESC)` on sales invoices; snapshot phone is not unique |
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
| **D-02** | **Customer phone and guest sale identity — REVISED 2026-08-17.** A registered customer's phone is mandatory and unique per `(tenant_id, phone)` **within the CUSTOMER role only**. Other roles may share a number. The walk-in customer is one real, `system_reserved` party exempt from the constraint. A fully paid new buyer does not create an individual party: the sale uses the walk-in party and stores immutable invoice snapshots of required customer name + phone and optional guardian/father name + address. Snapshot phones are searchable but not unique. If the sale leaves due, customer creation is mandatory and atomic with the sale. A later return continues using the walk-in party when it leaves no due, advance or store credit; an individual customer is created only when a balance must survive, or when the shopkeeper confirms creation for later use. |
| **D-03** | **Invoice deletion.** Posted invoices are reversed/voided with history retained; all related effects (stock, due, cash, expense) reverse. Draft invoices may be hard-deleted. |
| **D-04** | **Party system — REVISED 2026-08-20.** One internal `parties` table with role flags `CUSTOMER`, `SUPPLIER`, `VENDOR`, and optional `EMPLOYEE` identity for a real person/payee. **Expense is not a Party role.** Salary, Electricity, Transport, Rent, etc. are Expense Categories/Ledgers; an expense may optionally reference a Party/Employee as payee. UI shows separate Customer / Supplier / Vendor role hubs plus Expense Category/Ledger views over the same journal. Selling to a supplier requires explicitly choosing the transaction type; the party then appears in both histories. `EMPLOYEE` alone creates no receivable/payable semantics unless another SRS-defined transaction does so. |
| **D-05** | **Inventory issue and accounting costing — REVISED 2026-08-18.** `LIFO` is removed. SherERP exposes **two separate tenant settings**, each limited to `FIFO` or `AVERAGE`: (1) `inventory_issue_method`, controlling the operational stock-issue/lot-allocation policy, and (2) `sale_costing_method`, controlling POS/sales COGS and inventory valuation. Under `FIFO`, eligible lots are depleted by expiry/FIFO sequence and cost comes from those lots. Under `AVERAGE`, accounting uses moving weighted-average cost; because there is no physical “average lot”, traceability still links issued quantity to deterministic eligible lots using the rule in DR13.2A while the cost recorded on the issue comes from the average cost state. **The valuation report must always use the same accounting costing method as journal COGS so INV-05 remains true.** The two settings may differ operationally, but they may never create a second accounting valuation basis. |
| **D-06** | **Profit reliability.** Profit is provisional while any unresolved provisional cost or open negative-stock lot exists in the range. Profit display is blocked/marked until costing is finalized. |
| **D-07** | **Authentication — REVISED 2026-08-16.** **OTP is for first-time verification and password recovery only, never for daily login.** Signup: one field accepting **mobile or email** → 6-digit OTP → verify → set username, password and PIN in the same flow. Daily login: **email + password**, **phone + password**, **PIN**, or **Google OAuth**. Forgot password: OTP to the registered email or phone → set a new password. OTP channel follows the identifier — email identifier sends email OTP, phone identifier sends SMS. Sensitive actions require step-up authentication. |
| **D-08** | **Backup restore.** Restore all compatible business data. Subscription and permissions always follow the current tenant/account. Data belonging to unavailable features is preserved but read-only until the required plan is activated. |
| **D-09** | **VAT/tax — REVISED 2026-08-16, owner override.** **VAT/tax is removed from V1.** The reserved columns (`tax_rate_id`, `tax_amount`, `is_tax_inclusive`) are still created on transaction lines and remain `NULL`; no tax is calculated, posted, or printed. Tax becomes a V2 feature. **Consequence to accept knowingly:** SherERP cannot issue a VAT-compliant invoice in V1, so a customer who requires one cannot be sold to until V2. This was chosen over implementing tax in Phase 6, which would have forced re-costing every lot created in Phase 5. |
| **D-10** | **Units — REVISED 2026-08-19, see D-41.** V1 supports manual UOM conversion. Products may be purchased, stocked and sold in different units (Carton, Box, Piece, Pipe, Feet, Kg, Litre). Every product has a **base unit**; a product may optionally also have **one** conversion unit and its factor, e.g. `1 Carton = 24 Pieces`, `1 Pipe = 20 Feet`. Stock, costing and prices are stored and calculated in the base unit throughout. |
| **D-11** | **Credit limit.** Exceeding it shows a **warning only** — never blocks the sale. |
| **D-12** | **Language.** Default UI is English with **contextual natural Bangla guidance** where it reduces hesitation or explains business/accounting meaning; guidance is not mechanically duplicated on every repeated control or table header (UI-14…UI-21). **Counter surfaces follow the same rule as everything else** (owner decision 2026-08-31, reversing 2026-08-24; UI-74/UI-75): English is the visible label and Bangla the subordinate helper there too, because the counter is a workflow of several screens and one register across all of them beats a stronger label on one of them. Multilingual-ready from V1. Invoices and printed financial documents support Bangla and English from V1. Full Bangla UI across Owner/Manager screens may still land in V1.1. |
| **D-13** | **Attachments.** Stored in online media storage, not inside `.sherdb`. DB stores metadata/references. Limits follow the subscription plan. Offline backup/sync excludes attachments; unavailable ones are clearly shown as online-only without affecting the related record. |
| **D-14** | **Repository architecture.** V1 = Drizzle + PostgreSQL. Business-specific repository interfaces from day one. Shared Domain/Application contains all business rules and imports no Drizzle/PostgreSQL/SQLite/NestJS. A future Drizzle + SQLite implementation must be addable without changing business logic. |
| **D-15** | **Backup encryption.** Customer-controlled backup password. Optional server-managed recovery, **OFF by default**, requires consent. Without either, the backup is permanently unrecoverable. |
| **D-16** | **Payment verification.** bKash and Nagad personal accounts, no merchant account. Customer submits Transaction ID; admin verifies manually. API-based auto-verification may be added later with manual as fallback. |
| **D-17** | **Inventory by location.** Quantity, lots, cost and valuation tracked by **Product + Location** from day one. V1 may expose a single auto-created default location; a single-warehouse business never creates one manually. Multiple warehouses each maintain their own stock. Inter-warehouse stock transfer is supported once multiple locations exist. |
| **D-18** | **Serial uniqueness.** The same **active** serial cannot be used for the same product within a tenant. After retirement it may be reused with a warning. |
| **D-19** | **Negative stock costing.** Negative-stock sales are allowed. Cost uses the product's last known cost as **provisional**; when actual cost arrives, affected COGS and profit are recalculated per the configured method. |
| **D-20** | **Tauri — DEFERRED TO A FUTURE PHASE, REVISED 2026-08-18.** PWA + SQLite WASM + OPFS remains the primary offline architecture and is implemented before any desktop shell. After the Mobile phase, Tauri may be evaluated for native printer/filesystem/background integration. If added, it is packaging/integration only: it must reuse the same domain/application contracts, cannot introduce a parallel business-rule implementation, cannot become required for normal offline operation, and cannot weaken the single-writer/sync rules. |

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
| **D-27** | **Daybook is a real module (M32), Phase 9.** Read aggregator + source-action dispatcher for day-end/notebook review. It owns no business-transaction tables and no edit/posting logic; Transaction Date is default, Entry Date is an audit view. |
| **D-28** | **Mobile = PWA** for V1. React Native/Expo deferred and may be dropped. Accepted limits: no native barcode hardware (browser camera is adequate), no iOS push, and browser-storage eviction — the last of which is now governed by the hard gate in **D-24**, not merely accepted. |
| **D-29** | **Time and business date** — see §3.5. |
| **D-30** | **Document numbering** — see §3.7. |
| **D-31** | **Rounding and allocation** — see §3.3. |
| **D-32** | **Concurrency** — see §3.8. |
| **D-37** | **UI component library — PrimeVue 4, styled mode, self-hosted.** No CDN (COOP/COEP, §6.5), no second UI library. Chosen because an ERP is dense tables, forms and dialogs, and its DataTable ships lazy loading, virtual scroll, frozen columns and filters that Phases 3, 5, 6 and 9 would otherwise hand-write per screen. Rejected: **Vuetify** (Material look wrong for a shop counter, weaker data table) · **Tailwind + headless components** (every table and form becomes bespoke agent-written code, which is the code this project can least afford to review). |
| **D-38** | **UI/UX direction — familiar patterns, professional density.** Borrow navigation and interaction patterns from the consumer apps Bangladeshi users already know (sidebar, global search, notification bell, cards, lists, responsive bottom nav); **never** imitate their visual identity. Combine with ERP/POS needs: fast entry, tables, filters, keyboard operation, high information clarity. **English UI with selective Bangla helper text explaining business meaning, not literal translation** — implements D-12 and applies identically across Web, POS and mobile. Full rules in §2.7 (UI-01…UI-71). |
| **D-39** | **Quick add from the point of use — owner decision 2026-08-19.** Every screen that requires picking an existing record must also be able to create that record inline, asking only for its mandatory fields, with the rest completed later on the record's own screen. It applies to the whole ERP, not to one form: units/brands/categories from the product form, suppliers from purchase entry, customers from the till, customer groups from the customer form, and every equivalent choice a later module introduces. **Reason:** a shopkeeper entering a delivery has the goods in front of them and the supplier is new — being sent to another screen to create it, losing the half-typed purchase, is how entry stops happening at all. **Bounds:** the inline path reuses the same use case, permissions, validation and audit as the full form, so there is no relaxed second way to create anything; it never invents a placeholder or partial record; and it is hidden from anyone without the create permission (UI-45). |
| **D-41** | **Per-product unit conversion — owner specification 2026-08-19, refining D-10.** The feature is **optional per product**. A product keeps its normal base unit; when it needs it, it also carries **one** conversion unit and a conversion factor — `Base = Feet, Conversion = Pipe, 1 Pipe = 20 Feet`. **All stock is stored and calculated in the base unit**: `5 Pipe + 5 Feet` is normalised to `105 Feet`, one figure, never two. Purchase and POS show **two quantity boxes** for a product with a conversion, so a delivery of 5 Pipes and 5 loose Feet is entered as it arrives. Purchase and selling prices are **stored per base unit**; the entry and display unit may be switched between `/Feet` and `/Pipe`, and the system converts using the factor — the per-conversion direction is exact, the reverse rounds half-up once (D-31) and the screen shows what was actually stored. Stock is **displayed** in mixed form: `105 Feet` reads as `5 Pipe + 5 Feet (105 Feet)`. A product with no conversion unit and factor behaves exactly as before — single-unit quantity and pricing, no conversion behaviour anywhere. **Why one and not a list:** the two-box entry and the mixed display each need a single answer to "which unit?"; with several conversion units, `5 Pipe + 5 Feet` would not say which of them it meant, and a stock figure that cannot be read unambiguously is a stock figure nobody can count against. |
| **D-42** | **Daily operations architecture — owner decision 2026-08-20.** `Daily` is the first operational navigation category: POS, Counter, Daybook, Daily Cash. Counter centralizes manual Receive/Payment/Expense entry; Daybook centralizes review and launches correction/return/date-change/void workflows; party/expense/account ledgers expose the same relevant actions locally. These are multiple entry points over the same application use cases, never duplicate posting engines. |
| **D-43** | **Dual-date ledger and reconciliation model — owner decision 2026-08-20.** `business_date` is the Transaction Date and default basis for ledgers, Daybook and reports. Immutable `created_at` is the Entry Date and is selectable for audit views. Correcting Transaction Date never rewrites Entry Date. Account reconciliation may add missing entries, change transaction date, correct or reverse through source use cases; reconciled history becomes review-required when later changed. Daily Cash compares immutable session Expected Closing with Physical Count and never edits expected cash to force a match. |

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

Every module supports, where applicable: search · filter · sort · add · edit/correct · update/version · delete/void · audit · permissions · dashboard/view permission · **Transaction Date (`business_date`) and Entry Date (`created_at`) views** · export/print · API access · MCP readiness. **Repeated business actions must reuse the existing authoritative module/interface; a new screen is a caller, not a new implementation.**

Financial and inventory integrity rules override generic CRUD freedom. Not every action applies to every entity.

**Opening balances** are required throughout: customers, suppliers, vendors, products/stock, cash, bank. Editable, with audit.

## 5.0A Binding module specification contract for AI/code generation

Every module implementation task must resolve the following before code is accepted. If a detail is absent here or in the referenced cross-module rules, the coding agent must stop/report rather than invent it:

1. **Purpose and scope** — the business outcome and explicit out-of-scope items.
2. **Fields/data model** — required, optional, defaulted and feature-dependent fields.
3. **UI behaviour** — visible controls, default state, search/filter behaviour, touch/keyboard behaviour and permission-hidden controls.
4. **Workflow/state transitions** — entry point, actions, validation, post-success state and failure state.
5. **Business rules/invariants** — including exact precedence when multiple rules can apply.
6. **Permissions/entitlements/settings** — all gates on reads, writes and sensitive fields.
7. **Accounting effects** — journal/posting impact or explicit “none”.
8. **Inventory effects** — stock/lot/serial impact or explicit “none”.
9. **Correction/return/void behaviour** — what may change and how history is preserved.
10. **Search/filter/report requirements** — exact user-facing discovery paths needed for daily work.
11. **Edge cases and concurrency** — zero/negative stock, duplicate submission, closed period, offline replay, race conditions and feature-disabled history.
12. **Acceptance tests** — observable Given/When/Then or numeric scenarios proving the above.

A domain capability mentioned only abstractly is **not enough** when the owner confirmed a concrete UI action. Example: “payments are supported” does not satisfy the requirement for an invoice-detail **Receive Payment** action with allocation history.

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

**Google OAuth.** A Google account is linked to an existing user by verified email. If the email is **known**, Google signs that user in.

If the email is **unknown, Google may create the tenant** (revised 2026-08-17 — see the change log). Google's `email_verified` claim is the identity proof that the signup OTP would otherwise provide, so no OTP is sent on this path. Exactly one field is collected — the **business name** — and nothing is stored until it is submitted, so an abandoned form leaves no half-made tenant. The rest is derived:

| Field | Value on a Google-created account |
|---|---|
| `email` | the verified Google address, claimed in `user_identifiers` as the `EMAIL` channel |
| `username` | derived from the email local-part (`usernameFromEmail`, `core-domain`) — a display/audit identity, still not a login identifier |
| `password_hash` | **NULL** — Google is the only way in until the user sets one |
| `pin_hash` | **NULL** — PIN unlock is unavailable until the user sets one in Settings |
| `phone` | NULL — this path verifies an email, never a phone |

**A Google-created account therefore has no password and no PIN.** Its recovery route is forgot-password (§5.3, slice 1.2b), which sends an OTP to that same verified email and sets a password — this is the escape hatch if Google is ever unreachable, and it is why the credential columns are nullable (migration 0002). PIN is set afterwards in Settings → Security, which requires the current PIN and so is only reachable once one exists; **setting a first PIN is not built** and belongs with the administrator flow in slice 1.3.

The unknown-email response is distinguishable (`GOOGLE_ACCOUNT_UNKNOWN`), unlike a failed password login. This is not an enumeration oracle: the caller must present a Google ID token for the address, which only its owner can obtain, so it reveals nothing they could not learn about their own mailbox.

**OTP rules.** 6 digits · 5-minute expiry · single use · invalidated on a new request · maximum 5 verification attempts then the code dies · per-identifier and per-IP rate limits · code is stored hashed, never logged, never returned in a response body. Every send, failure and lockout is audited (R-13, SIM-swap).

**Password and PIN.** Both are set at signup and changeable in Settings; changing either requires the current credential, and changing a password invalidates all other sessions. PIN is a convenience credential for a returning session on a known device — it never substitutes for a password on a new device and never satisfies step-up.

## 5.4 M03 Subscription & Entitlements
Trial, monthly/yearly plans, feature entitlements, package restrictions, renewal, expiry, offline licensing period. Full implementation is Phase 10; the `EntitlementService` interface with a permissive stub exists from Phase 0.

Indicative tiers (exact matrix is open item O-1): **Basic** — core POS, products, customers, purchases, basic inventory · **Medium** — expanded finance, reconciliation, reporting · **Advanced** — vendor/consignment, advanced inventory, serial/warranty, advanced reporting.

**Vendor/consignment is Advanced-tier functionality.**

**On expiry:** restricted new actions are blocked per policy, **historical data is retained**, and upgrading restores access. Entitlement is enforced server-side. Expiry never destroys or hides data (consistent with D-36).

## 5.5 M04 Product & Catalog

### Purpose
Maintain one canonical product identity while allowing price, stock, lot, expiry, warranty, serial, barcode and feature-controlled behaviour to evolve independently.

### Mandatory product creation fields
A new product requires exactly these business fields unless an enabled feature dependency requires more:

- **Product Name***
- **Base Unit***
- **Purchase Price***
- **Selling Price***
- **Minimum Stock / Reorder Level***
- **Opening / Current Stock** defaults to `0`; the UI shows `0` and may allow an authorized opening-stock entry through the normal stock-opening service.

Category, brand, SKU, barcode, image, description, expiry, warranty and serial configuration are optional unless their feature is enabled and specifically requires them. The UI must not make optional catalog fields mandatory merely because the database supports them.

### Product identity and display
- Brand and Product Name are separate fields.
- Display name = `Brand + Product Name` when brand exists; otherwise Product Name.
- Different purchase prices, suppliers, expiry dates or receipts create inventory lots, **not duplicate products**.
- Product status is `ACTIVE` or `INACTIVE`. Inactive products remain in history but are excluded from new POS selection and new purchasing unless explicitly reactivated.

### Product list
The compact default list shows Product, Category, permission-gated Purchase Price, Selling Price, Stock Qty, permission-gated Stock Value, Status and one `⋯` row menu. SKU/barcode remains searchable, and Base Unit and Reorder Level remain available in product details and relevant inventory workflows, but these detail/configuration fields do not occupy default columns. Stock Qty and permission-gated Stock Value are supplied by an application read model; the Vue page must not sum location rows or choose an arbitrary location. Future optional-column visibility follows UI-58 through centralized tenant Settings, not per-page preferences.

### Products is the product working hub (owner decision 2026-08-20)
**M04 and the per-product half of M12 are one screen.** A shopkeeper thinks about a product, not about which module owns its quantity, so everything done *to one product* happens from its row on this list and every action opens as a modal over it (UI-50). There is no second product-centred inventory list; §5.10 keeps only the cross-product reporting that genuinely has no single product to hang from.

| Row action | Opens | Owning service |
|---|---|---|
| `Edit` | Product dialog, the same one `Add Product` opens | product create/update use case |
| `Stock` | Stock adjustment dialog (§5.10) | stock-adjustment service |
| `Lots` | Read-only lot history for that product (§5.11) | lot query |
| `Deactivate` / `Reactivate` | Confirmation | product status use case |
| `Delete` | Confirmation, with the §3.6 outcome stated | product delete use case |

Actions the caller lacks permission for are **absent from the menu, not disabled** (UI-09). `Add Product` is a top-right primary action opening the same dialog in create mode.

**`Delete` follows §3.6 exactly and says which happened.** A product that has never moved — no stock movement, no lot, no purchase or sale line — is hard-deleted. A product with any history is refused, and the message tells the shopkeeper to use `Deactivate`, which preserves every posted document that references it. The check is made **server-side inside the transaction**, never by the dialog inspecting a stock figure it happens to be showing.

**`Opening / Current Stock` appears on the create dialog and, while it is still unused, on the edit dialog.** It is a one-time entry: once a product has any stock movement the field is shown read-only with its posted opening figure, and every later change goes through `Stock` adjustment instead. This is the same one-opening-per-product rule §5.10 already states, surfaced so the shopkeeper is never offered a field that will be refused.

### Pricing, discount and product offers
Products support normal selling price plus optional default discount/promotional offer data:

- `default_discount_type`: `FIXED_AMOUNT | PERCENTAGE | null`
- `default_discount_value`
- `offer_price_minor` or promotional discount
- `offer_start_at`
- `offer_end_at`
- active/inactive state

Promotions **never overwrite** the normal selling price. The invoice line stores the final applied price/discount snapshot.

When more than one price source applies, the proposal precedence is binding:

1. normal retail selling price;
2. customer-group/dealer price when that feature is enabled and a matching registered customer is selected;
3. active product promotion/default offer;
4. permitted manual line price/discount override by the user.

The UI must show the original/base price and the applied discount/offer when an offer changed the proposal. Manual overrides are audited. No generic campaign/rules engine is required.

### Catalog capabilities
SKU/code, barcode, category/group/subcategory, image, status, description, expiry config, warranty config, serial tracking, reorder/minimum stock, unit conversion per D-10, product barcode generation and product/serialized-unit barcode support.

**Unit conversion (D-10 as revised by D-41) is optional and per product.** A product has a base unit, and may additionally name **one** conversion unit with the number of base units it contains. Both halves are required together — a unit with no factor, or a factor with no unit, is refused. The conversion unit may not be the base unit. Everything stored is in the base unit: the conversion changes how a quantity is **typed** (two boxes in Purchase and POS) and how it is **read** (`5 Pipe + 5 Feet (105 Feet)`), never what is stored. Prices are stored per base unit and may be entered or displayed per conversion unit, converted by the factor. A product without a conversion is unaffected in every respect.

### Operations and search
Add, edit, update, deactivate/reactivate, delete only where permitted, search, filter, brand filter, category filter, product-group/subcategory filter, stock-status filter, barcode search and scan. Posted historical documents never change when product master data changes.

### Acceptance requirements
- Product can be created with only the mandatory fields above, and opening stock defaults to `0`. **Revised 2026-08-19 by owner decision:** the create dialog carries an `Opening / Current Stock` field, so a shop entering its catalogue records what it already holds in the same breath as the product. Leaving it `0` remains valid and is still the default. The figure is **not** stored on the product row: saving calls the stock-opening service, which writes a real stock movement and its journal entry, exactly as it would for a purchase. A quantity written straight onto `products` would be stock INV-02 could not account for and INV-05 could not value.
- Changing a product name/brand does not rewrite posted invoice snapshots.
- Same product purchased at two costs stays one product and creates separate lots.
- Active promotion affects only eligible new sales; normal selling price remains intact.
- Inactive product is not selectable for a new POS sale.

## 5.6 M05 / M06 / M07 Parties (unified — D-04)
One `parties` table + `party_roles`. Customer phone is mandatory and unique within the CUSTOMER role (D-02). Supplier and Vendor are other roles over the same party identity.

**Customer fields:** Name, Phone, Address, Father/Guardian Name, NID, Email, Notes, Customer Group, Credit Limit, Status. Address, Father/Guardian Name, NID, Email and Notes are optional. Settings may hide/disable optional fields such as NID and Father/Guardian Name from normal forms while preserving stored historical data. **Loyalty/Premium customer functionality is dropped for now and is out of scope until explicitly reopened.**

**Optional party fields — owner decision, 2026-08-24.** The optional fields above belong to **every** party role, not only to customers: a supplier and a vendor are people too, and one `parties` table with one form has no reason to ask a supplier for less. Father/Guardian Name and the free-text field — labelled **Description** on the form — are **visible by default**; NID and Email remain off by default. A guardian's name is how two people with the same common name are told apart in Bangladesh, so a shop that cannot see the field reads it as absent rather than optional. Each remains a §5.21 toggle, and hiding one still preserves whatever is already stored.

**Customer profile:** summary, current receivable/due, advance/store-credit where applicable, sales history, invoice history, payment history, return history, statement and ledger drill-down.

**Party workflow hub (UI-52, UI-62…UI-64):** selecting a Customer, Supplier or Vendor opens that party's working ledger/profile context, not a disconnected detail card. The **ledger is the default operational view** once journal-backed history exists. Customer shows current Due/Advance at the top with `Receive Payment` and `New Sale` as primary actions, then the complete source-linked transaction history (sales/invoices, receipts, returns, corrections/reversals) with a running balance. Supplier shows Payable/Advance with `Pay Supplier` and `New Purchase`; Vendor shows the equivalent payable/receivable/consignment actions. The operator can open/correct a source sale or purchase, perform a return, correct/reverse a receipt/payment, print/share a statement and edit party master data **without leaving and re-searching the party**. Every action delegates to the source module's application use case and permission. Save/cancel returns to the same party, date basis, tab/filter and practical scroll position.

**Customer / party ledger overview interaction:** keep the overview intentionally small. The Customer ledger/list default columns are exactly `Name` · `Phone` · `Address` · `Current Due/Advance` · `⋯`. Do not add Credit Limit, NID, Father/Guardian, Email, created date, internal IDs or other detail/configuration fields to the default grid. Clicking the customer name opens that customer's working ledger hub. The row-end `⋯` menu contains only permitted contextual actions such as `View Ledger`, `Edit`, `Delete/Deactivate` and other source-module actions that are actually implemented; posted financial history is never hard-deleted through this menu. Supplier and Vendor overview lists use the same compact shape, replacing the balance column with the role-relevant current Payable/Advance or Vendor net position. `Add Customer` remains a modal/drawer over the preserved list. Unimplemented actions remain absent under UI-09.

**Supplier:** contact info, purchase history, payable, supplier credits, payments, purchase returns, statement and ledger. **Vendor/consignment** (entitlement-gated): vendor-owned stock, vendor cost, vendor payable, vendor payment, vendor return and source-transaction history.

**Opening-data import (required for onboarding):** one guided CSV import flow covers products/barcodes, customers, suppliers, opening stock with location and unit cost, opening customer receivables, opening supplier payables, and opening cash/bank balances. Each import has a downloadable template, preview, per-row validation and a final summary before posting. Posting is all-or-nothing per file, idempotent on the supplied import operation ID, tenant-scoped and audited. Opening balances use the normal journal/stock-opening services; an import must never write balances or stock directly. A failed row posts nothing. This is a migration/onboarding path, not a generic configurable import engine.

**Import rules settled on 2026-08-22, when the importer was built:** a file names master data — unit, brand, category, subcategory, customer group — by name, and a name the shop has not created is **refused, never created**; the preview lists every missing one so they can be added in a single pass. The opening-stock file carries its own optional unit cost, and a blank one values the opening at the product's purchase price exactly as the product form does; the location column waits for multi-location, since one location exists. A file holds at most 2,000 rows, because the whole file posts in one transaction. Each row reaches the same product, party or stock-opening use case a form reaches — the importer owns no create path of its own.

**Signed opening party balance and advances (owner decision 2026-08-20):** Add Customer, Add Supplier and Add Vendor expose an optional opening amount through the Phase-4 opening-balance posting service, not through a `parties` balance column. The UI accepts a signed amount and immediately explains its meaning for the selected role: Customer `+` = customer owes the business (AR), Customer `−` = customer advance/store credit (`CUSTOMER_ADVANCE`); Supplier `+` = business owes supplier (AP), Supplier `−` = advance paid to supplier (`SUPPLIER_ADVANCE`); Vendor `+` = business owes vendor (`VENDOR_PAYABLE`), Vendor `−` = advance paid to vendor (`VENDOR_ADVANCE`). Zero creates no journal entry. Each non-zero opening posts the party account against `OPENING_EQUITY`, in the same transaction as the party create when entered together, with business date, period guard, idempotency, audit and outbox. A failure rolls back both party and opening entry.

**Guest versus registered customer:** the system-reserved walk-in party represents fully paid buyers who have not been saved as individual customers. Their invoice still captures required name and phone plus optional guardian/father name and address as immutable snapshots. These snapshots make the invoice searchable and printable but do not create an individual party or individual ledger. Repeated snapshot phones are allowed; uniqueness begins only when a CUSTOMER party is created.

Creating a registered customer from a guest snapshot copies the details only after the phone passes the CUSTOMER-role uniqueness rule. The shopkeeper confirms conversion for a fully paid transaction. Conversion is mandatory and atomic with any sale, return or credit operation that would otherwise leave due, advance or store credit. Historical invoice snapshots never change when the resulting party is edited.

**Inventory must distinguish Owned Stock from Vendor-Owned Stock.** While held, vendor stock is excluded from valuation and COGS. On sale it is converted to owned stock at vendor cost inside the sale transaction (deemed purchase — DR13.10), which is what creates the vendor payable.

**Party selection defaults:** Sales/POS shows customers by default; Purchase screens show suppliers by default. Selling to a supplier is possible but must be an explicit user choice — never show every party type by default.

## 5.7 M08 Sales & POS
Fast product search, grid/list, barcode scan, brand/category/product-group filters, stock-status filters, customer selection, walk-in customer, quantity editing, permission-gated price editing, fixed/percentage discount, grand total, multiple payment methods, cash paid, due, invoice generation, printing, reprint, cancellation/correction and permission-controlled transaction editing.

### POS product visibility and stock state
- New POS selection includes **ACTIVE products only**.
- An ACTIVE product remains searchable/selectable when current stock is `0` or negative.
- An INACTIVE product is excluded even if stock remains.
- Stock status filters include at minimum `IN_STOCK`, `LOW_STOCK`, `ZERO_STOCK`, `NEGATIVE_STOCK`.
- Whether a zero/negative-stock sale may be posted is governed separately by the Negative Stock policy. Visibility must not be used as a substitute for that policy.

### Barcode behaviour
**Normal product barcode:** first scan adds the product to cart; scanning the same barcode again increments the existing cart line quantity rather than creating a duplicate line unless product configuration requires separate serialized lines.

**Serialized SherERP unit barcode:** scan resolves the unique inventory-unit ID, identifies product/lot/serial/warranty/expiry, adds the product to cart and automatically selects that exact inventory unit/serial. If the unit is not in a sellable state, POS blocks selection and explains why.

### POS cart and discount
Each line supports quantity, unit, selling price, discount and final line total. Discount supports both `FIXED_AMOUNT` and `PERCENTAGE`. Invoice-level discount may also support the same two types when enabled. The posting service validates discount boundaries and performs money rounding centrally. Price/discount changes require the relevant permission and are audited.

### Search filters
At minimum: free-text/product name, SKU/code, barcode, Brand, Category, Product Group/Subcategory and Stock Status. Search is keyboard- and touch-friendly.

### Vendor/consignment workflow
Source selection: `OWN_STOCK | VENDOR_CONSIGNMENT`. Vendor/consignment requires vendor, sourced quantity and vendor cost. Where the user has permission, POS offers **Create Vendor** without leaving the sale; the minimum vendor record is created through the normal Party service and immediately selected. Vendor/consignment remains entitlement/feature gated and follows the deemed-purchase posting rule DR13.10.

## 5.7 M08 Sales & POS
**Lean wholesale controls (disabled and hidden unless the tenant enables wholesale sales):** quotation → sales order → invoice, using the same products, parties, prices and document lines as the POS/sales path. Quotations reserve no stock and create no journal entry. Sales orders may show availability but reserve no stock in V1 and create no journal entry. Conversion copies the accepted quantities and current approved price into the next document, records the source link and prevents converting more than the remaining quantity. This is not a CRM, pipeline, delivery-routing or contract-management feature.

**Customer-group pricing (disabled and hidden unless dealer pricing is enabled):** a product may have one selling price per active customer group. Selecting a registered customer proposes that group's price; walk-in uses the normal retail price. The applied price is copied to the document line, remains permission-editable under the existing price-edit rule, and never changes a posted document when the group price later changes. No rule builder, date campaign, quantity-break or promotion engine is included in V1.

**Customer control:** a searchable customer combobox defaults to the walk-in/new-buyer flow. Selecting a registered customer immediately shows current due and advance derived from journal lines, never recomputed from invoices. Directly below it is `Search invoices by phone` (`ফোন নম্বর দিয়ে আগের ইনভয়েস খুঁজুন`). Searching a phone returns both registered-customer invoices and guest invoices matched through `customer_phone_snapshot`, newest first.

For a new buyer, `Customer name` (`কাস্টমারের নাম`) and `Phone` (`ফোন নম্বর`) are required on the invoice. `More customer information` (`কাস্টমারের আরও তথ্য`) expands optional `Guardian/Father's name` (`অভিভাবক/বাবার নাম`) and `Address` (`ঠিকানা`). These fields remain collapsed during normal counter work. If calculated due is greater than zero, posting first creates the CUSTOMER party and then links/posts the sale inside the same transaction; failure of either rolls back both. A fully paid sale stays on the system walk-in party unless the shopkeeper explicitly chooses `Save as customer` (`কাস্টমার হিসেবে সংরক্ষণ করুন`). Finding older guest invoices for the phone may offer that choice but never silently creates a party.

Source selection: Own Stock · Vendor/Consignment. Vendor/consignment requires vendor, quantity and vendor cost, and posts via the deemed-purchase rule (DR13.10). Sale templates per D-26.

**Negative stock policy** is a setting with three values: `BLOCK` · `WARN` · `ALLOW`. Default `WARN`. When `ALLOW`, costing follows D-19 provisional cost.

**Cost visibility in POS** is behind a small eye control on each selected cart line and requires `inventory.cost.view`. It reveals `Estimated cost` for ~2000 ms, then hides. For FIFO it is the estimated COGS of the selected quantity from the next FIFO/FEFO lot consumptions; for AVERAGE it is selected quantity × current average unit cost. It shows total and per-unit cost and is recomputed when quantity changes. Negative/open provisional stock is labelled `Estimated cost — provisional`. The server uses the same costing service as sale posting; this is never a client calculation and never merely "last purchase price". Bangla helper: `বর্তমান স্টক ও কস্টিং পদ্ধতি অনুযায়ী এই বিক্রির আনুমানিক খরচ`. Product/cart responses must omit every cost field for a user lacking the permission — never return blank or zero.

## 5.8 M09 Sales Invoice & Payments
Invoice creation, numbering, payment allocation, multiple payment methods, cash, bank, due, customer balance, invoice search (by phone), reprint, cancellation/correction, payment history.

### Invoice detail actions
An authorized invoice detail screen must expose: Receive Payment, Partial Return, Full Return, Payment History, Return History, Print/Reprint, Export/Share, Correct/Edit through versioning rules, and Void/Cancel where permitted. These controls invoke application services; they never mutate ledger projections directly.

**One invoice edit/correction implementation:** every place that offers invoice update/edit/correction — Invoice Detail, Sales Invoice History, Customer Ledger, Daybook or another authorized contextual entry — calls the **same authoritative invoice edit/correction module/interface**. A caller supplies the invoice identity plus allowed user intent; it does not own posting, reversal, versioning, stock or ledger logic. If legacy code currently has more than one implementation, consolidate/refactor that seam before building further invoice callers. Fix once, then every entry point inherits the fix.

### Transaction correction vs cosmetic invoice presentation
Financial/stock facts such as customer party, products, quantity, price, discount, payment and business date are **transaction changes** and follow §2.5 reversal/versioning rules.

The system may also support **invoice-specific cosmetic presentation overrides** that do not change accounting, stock, product master or customer master data, including: customer display name, product display label, additional note, delivery instruction, warranty note and custom message. Cosmetic overrides are stored as invoice-presentation data with audit history. They must never change quantity, unit price, discount, tax, payment, due, party allocation, stock movement or journal values.

### Invoice output and sharing
Invoices support Bangla/English document rendering, multiple templates, A4, 80mm thermal and Business Pad printing, PDF export, JPG/PNG image export, and a **Share** action for WhatsApp. The WhatsApp share path uses the authorized already-generated document/link and never exposes cost/margin fields or cross-tenant data.

### Invoice design settings
Configurable per tenant/template: language, template, paper size, logo, business information, customer-field visibility, SKU/barcode visibility, discount visibility, payment breakdown, due visibility, footer, terms & conditions, notes/messages and supported section ordering/visibility. A preview is recommended and must use the same renderer as final output.

### Business Pad mode
Supports configurable top/header spacing, page margins/content start position, hiding SherERP-generated logo/header/business block when the physical pad already contains them, and selecting which invoice sections are printed. Transaction facts remain unchanged.

Every credit sale has an explicit due date. Customer balances and invoices expose ageing buckets `Not due`, `1–30`, `31–60`, `61–90`, and `90+` days as of the requested business date. Ageing is derived from journal allocations and reconciles exactly to the customer receivable control account; a document's unpaid field is never treated as an independent balance.

Posted invoices have A4/80mm PDF output plus a share action suitable for WhatsApp. Sharing sends or downloads a link/PDF for the already-authorized invoice; it does not change posting state, expose other tenant data, or require a customer portal. The shared copy shows the same immutable invoice snapshot and carries no cost or internal-margin fields.

Every sales invoice stores the customer identity as it appeared at posting time: `customer_name_snapshot` and `customer_phone_snapshot` required; `customer_guardian_name_snapshot` and `customer_address_snapshot` nullable; `party_id` links either the selected/created registered customer or the system walk-in party. Snapshot fields are document facts and never change when party master data changes. Posted corrections create the normal new document version rather than rewriting historical snapshots.

**Guest accounting:** a fully paid guest invoice posts using the system walk-in party and creates no individual customer ledger. If the transaction leaves due, advance or store credit, an individual customer must exist and every related journal line uses that party. A later fully settled return/refund remains linked to the original invoice and continues using the system walk-in party when it leaves no remaining due or credit.

**Payment allocation:** select the invoice(s) being paid → apply → overpayment is retained as an **advance**, applicable later against due. Auto-FIFO allocation is an option; unallocated amounts sit as an on-account balance. Ledgers support current balance, due balance, advance balance, partial payments, sales returns, purchase returns, and cash refunds.

A sale transaction is atomic across: sale → customer snapshot/party creation when required → items → inventory consumption → stock movement → payment → party-ledger posting when balance-bearing (walk-in reference otherwise) → cash/bank → audit.

**Required tests:** full-paid guest → one walk-in-linked invoice, searchable by snapshot phone, no individual party · guest sale with due → one customer and invoice created atomically, receivable on that party · duplicate registered phone → rejected with no sale · fully refunded guest return → still walk-in, no individual party · return creating store credit → confirmed/created party owns the credit · selected registered customer shows journal-derived due/advance · unauthorized POS response contains no cost fields · FIFO and AVERAGE eye reveal matches the posting costing service for the selected quantity exactly.

## 5.9 M10 / M11 Purchase and Purchase Orders

**Purchase workflow hub:** Purchase remains one business module. Its top bilingual feature navigation is `New Purchase` (`নতুন মাল কেনা`) · `Purchase Invoice` (`কেনার তালিকা`) · `Purchase Return` (`কেনা মাল ফেরত`). These are entry/list/return contexts over the same purchase, stock, supplier-payable, payment and correction services—not three duplicated transaction engines. The navigation appears only when the corresponding Phase-5/Returns capability is implemented, permitted and enabled; no dead page is created earlier merely to display the tab.
Purchase: supplier, date, reference/invoice, product, quantity, purchase price, discount, additional costs, payment, due, lot creation, inventory increase, supplier ledger, cash/bank movement, purchase return. Different purchase prices create separate lots.

Purchase orders: create, supplier, products, quantities, expected cost, status, approval where enabled, partial receiving, conversion to one or more purchases, search/filter, edit, cancel, audit. Each receipt records ordered, previously received, received now and remaining quantities. Only the received quantity creates lots, stock movements and a supplier liability; duplicate receipt submission is idempotent and over-receipt is blocked unless an authorized user explicitly accepts it. **A purchase order itself must not increase physical stock.**

Every credit purchase has an explicit due date. Supplier balances and purchases expose ageing buckets `Not due`, `1–30`, `31–60`, `61–90`, and `90+` days as of the requested business date, derived from journal allocations and reconciling exactly to the payable control account. Supplier payments and purchase returns create supplier credits when over-applied; the user may explicitly apply an available credit to selected open purchases. Application changes allocation only—it must not post cash twice or rewrite the original return/payment.


### Purchase fields and correction workflow
Purchase captures supplier, transaction/business date, items, quantity, UOM, purchase price, item discount where supported, landed/additional costs, payment breakdown, due, due date and **Notes**. Each received stock line creates/updates the appropriate lot through the normal inventory service.

Authorized correction of a posted purchase may change supplier, transaction date, products, quantities, purchase price, landed costs and payment only through the normal version/reverse-and-repost path. Purchase return and cancellation/reversal are separate explicit actions. No correction may directly rewrite stock balances, supplier balance or journal rows.

### Purchase Order as a draft order list (owner decision 2026-08-20, build in Phase 5)
A Purchase Order is a **planning document that posts nothing**. It exists because a shopkeeper deciding what to reorder looks at what is running low, picks products and planned quantities, and needs to get that list to the supplier quickly — often as a photographed or shared image rather than a formal document.

- **Creating one:** pick products and planned quantities, optionally seeded from the Low Stock section of the Inventory Report (§5.10). No supplier commitment is implied and no line price is required.
- **Sharing it:** print, or share as an image/PDF to the supplier, following §5.24's document behaviour.
- **No stock, no journal, no ledger effect.** A PO creates no lot, no movement and no payable. It carries no `operation_id`-bearing financial write because there is nothing financial to make idempotent.
- **Receiving against it:** reopening a PO and choosing `Create purchase` opens the **existing New Purchase screen** with the PO's lines pre-filled. The user then adds, edits or removes lines, enters received quantities, actual purchase costs and any landed/extra cost, and completes the purchase. **The purchase use case is the same one a from-scratch purchase uses** (A14) — the PO only seeds the form. Stock, lots, costing and the supplier ledger happen at that point and not before.
- A PO records which purchase(s) fulfilled it and remains readable afterwards; it is never rewritten by the purchase.

This is a convenience entry point over one posting path, not a second purchase engine.

### Expiry, warranty and manufacturer serials at purchase
Expiry is captured per lot when expiry tracking is enabled. Warranty configuration is snapshotted as required. For serial-tracked products, **manufacturer serial numbers are entered or scanned from the physical goods; SherERP does not invent manufacturer serials.** The number of accepted serials must equal the serialized quantity received, and duplicate active serials for the same product/tenant are rejected per D-18.

## 5.10 M12 Inventory & Stock
Current stock, search, filters, low stock, out of stock, stock movement, adjustment, reconciliation, history, source transaction, concurrency protection, inter-location transfer (once multiple locations exist).

Every stock movement identifies: product, lot where applicable, quantity, source transaction, business date, created timestamp, user, cost where applicable, location. **No silent stock mutation.**

```sql
stock_movements(id, tenant_id, product_id, location_id, lot_id,
                qty, direction, business_date, source_doc_id, unit_cost, ...)
```

### Where inventory work happens (owner decision 2026-08-20)
Per-product stock work — adjust, view lots, record opening — lives on the **Products** row menu (§5.5), because that is the thing the shopkeeper is looking at. What remains here is the **Inventory Report**: the cross-product views that have no single product to hang from. There is no second product list.

The Inventory Report route is `/inventory-report` and presents, each as its own section with its own filters:

| Section | Shows | Permission |
|---|---|---|
| Stock Overview | qty on hand and value per product/location, with the stock-status filter §5.7 names | `catalog.product.view`; value needs `inventory.cost.view` |
| Low Stock | products at or below their reorder level, worst first | `catalog.product.view` |
| Stock Lots | lots across every product — source, remaining, expiry, status | `inventory.lot.view` |
| Stock Movements | the full movement trail, filterable by date, product and source type | `catalog.product.view` |
| Damaged & Written-off | adjustments by reason, with their posted value | `catalog.product.view`; value needs `inventory.cost.view` |
| Expiry | expired and near-expiry lots, where the feature is enabled | `inventory.lot.view` |
| Cost Adjustments | the `cost_adjustments` trail (true-ups, landed cost, re-costing) explaining why a valuation figure moved | `inventory.cost.view` |
| Valuation | valuation against the `INVENTORY` account, and whether they reconcile (INV-05) | `inventory.cost.view` |

Every figure is derived from stock movements and journal lines (INV-10) and supports the §5.20 "Why?" drill-down to the movements that produce it. Sales-performance, profit-by-product and forecasting figures are **not** here — they belong to §5.20 and are listed there.

### Stock adjustment (binding)
An authorized user adjusts one product's stock from the Products row menu. This is the §5.13 correction path made routine; it is not a second stock writer.

- **Input:** signed quantity (positive adds, negative removes), a reason from the closed list `DAMAGE | RECOUNT | THEFT_LOSS | OTHER`, an optional note (**required** when the reason is `OTHER`, since otherwise the row explains nothing), and an optional business date defaulting to today.
- **A zero adjustment is refused.** It would post an entry that moved nothing and mean nothing.
- **Write class T.** It runs the full ten-step path in one transaction: permission → idempotency → period guard → load → invariants → persist the adjustment document → stock movement + lot effect + journal entry → audit + outbox → commit.
- **Increase** creates a new `OWNED` lot at the product's current cost basis (moving average where `AVERAGE`, purchase price where there is no prior cost), posting `DR INVENTORY / CR STOCK_ADJUSTMENT`.
- **Decrease** consumes existing lots through the same `ConsumeStockService` FIFO/FEFO ordering a sale uses — never a special path — posting `DR STOCK_ADJUSTMENT / CR INVENTORY` at the consumed lots' cost.
- **A decrease larger than stock on hand is refused**, naming the quantity actually held. `negative_stock_policy` is written for *selling* more than you have (§5.7), which is a real thing a shop does under pressure at the counter; deliberately writing off more damage than exists is a typo, and refusing it is the safer default. The negative-stock path and its `NEGATIVE_STOCK_TRUE_UP` (DR13.7) arrive with POS, which is where the setting's own wording puts them. **No lot is ever written with a negative remaining quantity** (DR13.11, INV-03) in either case — the reference build's `OVERSOLD` rows with negative remaining quantities were wrong, and when negative stock does arrive the shortfall lives on the true-up obligation, never on a lot.
- **A zero-cost product cannot be adjusted.** The entry would have to balance to nothing, which `rejectEntry` refuses and INV-09 would fail. `openingStockPosting` already refuses the same case; a product needs a cost before its stock can be corrected.
- **Adjustments are never edited or deleted.** A wrong adjustment is corrected by a further adjustment, which is what makes the movement trail evidence rather than a draft.

### Active/inactive inventory behaviour
Inventory views may show both active and inactive products with explicit status filtering. POS uses only ACTIVE products, but an active product remains available in POS at zero or negative stock. Deactivation changes availability for new operational selection; it never removes historical stock movements or documents.

### Opening stock from the product workflow hub
An authorized user may record opening stock for an existing product that has no opening and has never been stocked, through the `Opening / Current Stock` field on that product's edit dialog (§5.5). The action captures quantity, optional historical business date and expiry when the product tracks expiry, and refreshes the stock figures in place after posting. **Revised 2026-08-20:** this entry point was previously an `Add opening stock` action on a separate Inventory row; the row moved to Products, and the field moved with it. The service, the one-opening-per-product rule and the posting are unchanged. It invokes the same stock-opening application service used by Add Product and the guided import; it never edits a displayed balance or writes quantity directly to the product. A product may have only one opening-stock document, retries are idempotent, and later corrections use reversal/versioning rather than a second opening.

### Expiry management
Where expiry tracking is enabled, expiry is stored per lot. Inventory must provide expired-stock, near-expiry and stock-by-lot/expiry views. Selling an expired lot follows a configurable `BLOCK | WARN | ALLOW` policy with permission where required. Near-expiry threshold is configurable. FEFO may take precedence within FIFO issue selection when expiry tracking is enabled.

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
| DR13.2 | `inventory_issue_method=FIFO`: physical lot depletion = expiry ASC when expiry is tracked (FEFO), then `business_date` ASC, `created_at` ASC, `id` ASC. |
| DR13.2A | `inventory_issue_method=AVERAGE`: accounting does **not** create an “average lot”. For traceability, quantity is linked to eligible positive lots using deterministic expiry/date/id order; operational screens label the issue method Average, while the cost attached to the issue is derived from the moving-average cost state. This preserves serial/expiry/lot traceability and prevents impossible synthetic lots. |
| DR13.3 | `sale_costing_method` (`FIFO` or `AVERAGE`, D-05) determines COGS for POS/sales and the accounting inventory valuation basis. The same accounting basis must drive the `INVENTORY` account reconciliation — there is never a second valuation basis. `inventory_issue_method` controls operational quantity/lot allocation and may differ without changing the accounting invariant. |
| DR13.4 | `sale_costing_method=FIFO`: accounting unit cost is resolved from the FIFO/FEFO cost layers required to price the sold quantity, independent of which traceability links were needed for serial/expiry handling. `sale_costing_method=AVERAGE`: accounting unit cost = `product_cost_state.avg_unit_cost` at the movement. Under Average, lot actual cost remains for traceability/landed-cost attribution, not as a second valuation method. |
| DR13.5 | AVG on receipt: `new_avg = (qty_on_hand×avg + qty_in×unit_cost) / (qty_on_hand + qty_in)`, integer minor units, half-up at scale 4, remainder to `ROUNDING` |
| DR13.6 | Changing either `inventory_issue_method` or `sale_costing_method` requires `settings.manage`, audit reason and an open-period boundary. Existing posted history is never silently rewritten. A costing-method change applies prospectively unless an explicit authorized recompute process is invoked under the defined accounting policy. |
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
Allocation methods: Purchase Value, Quantity, Manual (largest-remainder allocation per §3.3). Seeded categories: Transport, Labor, Loading/Unloading, Delivery, Customs and Other; tenants may add configurable categories. `actual_cost = purchase_cost + allocated_landed_cost`. **Original purchase cost remains traceable.**

## 5.13 M15 Stock Reconciliation
Physical count, system quantity, physical quantity, difference, adjustment reason, authorization, audit, stock movement. **No direct silent quantity manipulation.**

## 5.14 M16 Returns
Sales and purchase returns with original transaction reference, product, quantity, lot, reason, stock disposition, refund/credit, ledger adjustment, cash/bank adjustment, audit. **Returned inventory must have an explicit disposition.**

For a return against a fully paid guest invoice, preserve the original invoice identity snapshot and continue using the system walk-in party when the return is fully settled and leaves no due, advance or store credit. Do not create a customer merely because goods were returned. If the return creates a balance that must survive the transaction, require confirmation, create or match the registered customer by the snapshot phone, and attach that balance to the resulting party inside the return transaction.

## 5.15 M17 / M18 Ledgers
Ledgers are projections of journal lines — **no independent writers**. Customer, Supplier, Vendor, Expense Category/Ledger, Cash and Bank views may expose actions, but every mutation invokes the corresponding owning application use case.

### Date identity and ordering
Every ledger has two explicit date bases:
- **Transaction Date** = `business_date` — **default** for normal business work, statements, ageing and reconciliation.
- **Entry Date** = immutable `created_at` — audit view answering when the record was entered.

Changing/correcting Transaction Date changes `business_date` only, subject to PeriodGuard, permission, step-up/reason where required and normal correction/versioning rules. It **never rewrites `created_at`**. Because every ledger is journal-derived, the corrected business date is reflected consistently in Customer, Supplier, Vendor, Expense, Cash/Bank, Daybook and reports; no screen maintains its own date or balance copy.

### Statement and ledger requirements
Columns: Transaction Date or Entry Date (according to selected basis) · Reference · Description · Debit · Credit · Running Balance · Status/flags · Actions where permitted. Date-range output includes Opening Balance and Closing Balance. The selected date basis is visible and preserved while drilling into a source document and returning. `LATE_ENTRY`, `BACKDATED`, `CORRECTED`, `VOIDED` and reconciliation-review states are shown as clear badges, not hidden metadata.

Every party ledger exposes one signed net balance without row drill-down. Customer `> 0` displays Due, Customer `< 0` displays Advance; Supplier/Vendor `> 0` displays Payable, Supplier/Vendor `< 0` displays Advance paid; zero displays Settled. The signed net is a projection over the applicable journal accounts, never a mutable balance field.

### Customer ledger actions
At the top: current Due/Advance plus `Receive Payment` and `New Sale` when authorized. Row/source actions include Open Invoice/Sale, Receive Payment for that source where applicable, Sales Return, Correct/Edit through versioning, Change Transaction Date, Print/Share and Delete/Void/Reversal according to document state and permission. The ledger itself remains read-only projection data.

### Supplier/vendor ledger actions
At the top: Payable/Advance (and Vendor receivable/consignment position where applicable) plus `Pay Supplier/Vendor`, `New Purchase` or the relevant source action. Rows drill into Purchase, Payment, Credit, Purchase Return, Vendor/Consignment source and authorized correction/reversal/date-change workflows.

### Expense Category/Ledger
An **Expense Category/Ledger** is the classification of an expense (Salary, Electricity, Transport, Rent, etc.), not a Party role. An expense may additionally identify a Payee/Employee/Party for history and reporting. Opening an Expense Category/Ledger shows its journal-derived transaction history, totals and running view for the selected date basis, with `Add Expense` at the top and source actions for Correct, Change Transaction Date, Print and Void/Reverse where permitted. This distinction prevents `Transport` or `Electricity` from being modelled as fake people/parties.

### Reconciliation invariant
Opening + debits − credits (according to the account's signed convention) must reconcile exactly to closing balance and the relevant control account. No UI-maintained due/payable/expense/cash balance may diverge from journal allocations.

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

**Reopen — the one exception (owner decision, 2026-08-24).** A day closed by mistake can be reopened **only while it is still the current business date**, and only by the Owner or by the user who performed that close. Reopening does not edit or delete anything: the mistaken close is marked superseded, its shortage/overage posting is reversed by an equal and opposite entry on the same `business_date`, and the session returns to open so trading continues. The final close then posts its own count normally.

The day's history therefore shows **both** closes, each with its counted amount, its actor, its timestamp and the reason given for reopening — which is the point. An older day, or one whose date has rolled over, is never reopened; a wrong count there is corrected exactly as this section already says, by a new audited cash adjustment. On screen this is never called a reopen or a reversal: the cashier presses **ভুল করে বন্ধ করেছি** (UI-74).

### 5.16.5 Next-day opening cash

**The next day's opening cash is whatever the business physically puts in the drawer. It is normally the previous actual closing, but is never forced to equal it.**

Any difference posts on the **new session's `business_date`** — it is declared at Start Day, so it belongs to the new day. This also keeps a Start Day adjustment from landing in a period that has since been closed.

| Case | Meaning | Posting |
|---|---|---|
| **A — more cash added** | Opening > previous actual | `DR CASH:{id}` and `CR` the declared source: `OWNER_CURRENT_ACCOUNT` (owner injection), another `CASH:{id}` (transfer from safe), or `BANK:{id}` (withdrawal) |
| **B — less carried forward** | Opening < previous actual | `CR CASH:{id}` and `DR` the declared destination: another `CASH:{id}` (moved to safe), `BANK:{id}` (deposited), or `OWNER_CURRENT_ACCOUNT` (owner withdrawal) |
| **C — previous day was short** | Previous actual < previous expected | **Nothing.** The shortage was already posted at that day's close and stays in that day's session. Starting the new day at the counted amount does not erase, recalculate, or offset it |

**Case B has no "unexplained" option.** Cash always has a named destination — that is why `CASH:{id}` is per account rather than a single `CASH` (§2.4). Cash cannot leave the system without saying where it went.

**Case D — the shop's first day (added 2026-08-24, during Phase 4 build).** There is no previous actual closing to compare with, and a drawer opened with ৳20,000 holds money the journal has never seen. The comparison is therefore made against **the drawer's own ledger balance** rather than against the previous close: on every later day the two are the same number, because a close leaves `CASH:{id}` equal to what was counted (§5.16.4, INV-07b), so cases A, B and C are unchanged. On the first day the difference is the whole opening and a source must be named — normally `OWNER_CURRENT_ACCOUNT`, or nothing at all when the shop already typed that account's opening balance on the account form and starts the day at exactly that figure.

Without this the drawer and the ledger would begin their life disagreeing by exactly the opening cash, and INV-07b would be false from the shop's first hour with nothing on any screen to explain it.

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

### 5.16.8 Daily Cash Reconciliation & History

`Daily Cash` is a **read/control view over cash-session rows plus the journal**, not another balance table and not another close workflow. It exists because the owner reconciles what SherERP expected with what was physically counted, day by day.

**History columns:** Business Date · Note/Reason · System Expected · Physical Count · Difference · Status. `Matched` = zero difference, `Short` = actual < expected, `Over` = actual > expected. The row may also expose Opening, Cash In and Cash Out on expansion.

**Drill-down:** selecting a day shows Opening Cash · Cash In · Cash Out · Expected Closing · Actual Counted · Difference · shortage/overage posting · between-session movements and reasons. `Investigate Difference` opens Daybook prefiltered to that cash account/session `business_date`; returning preserves the Daily Cash row and date range.

**Integrity:** a closed session's stored expected/actual/difference values are immutable. Later corrections to business documents do not rewrite what the system expected at the historical close; they create their own audited correction effects and, where applicable, reconciliation-review flags. A miscount correction is a new audited cash adjustment, never an edit of the old count.

**Permissions:** `cash.daily.view` · `cash.daily.investigate` (the latter still requires the source-module permissions for any correction launched from Daybook).

## 5.17 M20 / M21 Bank and Account Reconciliation
Bank/MFS/cash account: name, account name, reference/number, opening balance, transactions, payments, receipts, statement, balance, audit and source linkage.

**Account Reconciliation purpose:** make SherERP's journal-derived account ledger agree with the real external statement or physical account record **without rewriting history invisibly**.

### Workflow
1. Select account (Bank, bKash/Nagad/MFS where configured, or another reconcilable account) and statement date range.
2. Show SherERP transactions ordered by `business_date`, with external/imported statement lines where available.
3. States: unmatched · matched · reconciled · bank-only · book-only · exception · review-required.
4. Authorized actions: Match · Open Source · **Change Transaction Date** · Correct allowed transaction fields through the source workflow · **Add Missing Entry** through Counter/source use case · Reverse/Void wrong or duplicate entry · Mark Reconciled.
5. After a correction/addition, return to the same account, range and position and refresh from authoritative journal data.

### Date correction
A transaction discovered on 20 Aug but belonging to 18 Aug keeps `created_at = 20 Aug...` and corrects only `business_date = 18 Aug`, subject to period-lock/backdating rules. That business date then appears consistently in the party ledger, expense ledger, account ledger, Daybook and reports. `created_at` remains available through the Entry Date audit view and audit event.

### Reconciliation history
Changes to reconciled transactions **trigger review and never silently rewrite reconciliation history**. The original match/reconciliation record remains traceable to the version it reviewed. A later correction/date change creates a review-required state with actor, time and reason.

### As built — Phase 11.1, owner decisions 2026-08-30

**Bank and MFS only.** Cash keeps the reconciliation it already has: counted against expected, in Daily Cash (§5.16.8, UI-71). Starting a reconciliation on a CASH account is refused with a message that says where to go instead — two different answers to "does this account agree" is the confusion this avoids.

**The statement arrives as the bank's own PDF.** It is uploaded, parsed, and shown to the owner in an **editable verification preview** before a single row is imported; a row the parser misread is repaired there, and the repair is recorded as `edited_by_user` so "the bank said" stays distinct from "we decided the bank meant". A scan with no text layer parses to nothing, and that is not an error: the file is kept as evidence and the reconciliation continues by hand against the paper. A file that will not open at all — corrupt or password-protected — is refused with a message saying which of the two it is. The original PDF is never discarded or replaced after parsing; parsed lines are working data, the file is the proof.

**Direction comes from the bank's own arithmetic, not our reading of its layout.** Every statement is laid out differently, and the one thing they share is a running balance, so `balance − previous balance` decides whether money came in or went out. A printed sign is the fallback, a keyword in the narration the last resort, and a row that none of them answers is returned as a **problem** for the owner rather than a guess.

**Matching is deterministic and rule-based — no model, no learning.** Two gates admit a candidate at all: the amount equal to the poisha, and the same direction. A one-poisha difference is never a match; on a reconciliation that is a different transaction or a mistyped one, and both are things the owner must see. Reference, date and description similarity then decide confidence, with description **never sufficient on its own**. Every threshold lives in one exported constant (`MATCH_RULES`) so they can be tuned centrally without touching the screen.

Three outcomes. **Auto Matched** when the pair agrees on reference or date *and* nothing else came close — uniqueness on both sides is part of certainty, so two ৳2,500 payments on one day always become suggestions rather than a guess. **Suggested Match**, shown with the reasons that produced it (same amount ✓ · same direction ✓ · date differs by 1 day · reference unavailable), for the owner to confirm or reject. **Unmatched**, split into Statement Only, SherERP Only, **Conflict** (same reference, different amount) and Needs Review. A statement line matching an entry posted to a *different* bank account raises **Possible wrong account** — a warning to read, never a transfer to make.

**Automatic matches are computed on every read, not stored.** The engine is deterministic, so a corrected transaction is reflected the next time the screen loads: no cache to invalidate, and the re-run after every import, correction, posting, unmatch or void happens by construction rather than by remembering to trigger it. Only human decisions are written while the reconciliation is open. Completing it **freezes** every standing link, because from that moment it is historical control data.

**The module writes reconciliation data and nothing else** — statement files, statement lines, reconciliations, matches and its own audit events. Its service is given no posting service, no numbering service and no period guard; its repository has no write path to `journal_entries`, `journal_lines` or any document table, and the journal appears only as read projections. `Add Missing Entry`, `Correct`, `Change Transaction Date` and `Void` are **launches** of the owning module's own workflow with the statement's figures prefilled — the owner presses that form's own Save, under that module's permission, period, versioning and audit rules (UI-72). Reconciliation may notice that something is missing and hand over the right form; it may not fill it in and post it.

**Completion is refused** unless the closing balance is confirmed, the difference is exactly zero, no pair is in conflict, nothing is parked for review, every statement line is accounted for, and each of the shop's own entries is either matched or explicitly marked as not yet cleared. Reconciled balance = opening balance + everything matched; entries the bank has not cleared are excluded by design, which is what makes the comparison mean anything.

**Later changes raise review without touching the record.** Each frozen link stores the matched document's posting count. A correction, cancellation or date change posts again (§2.5), the count no longer agrees, and the reconciliation reads back `REVIEW_REQUIRED` naming the document that moved. Nothing writes into the completed reconciliation to say so — nothing may. Reopening it needs its own permission and keeps every figure it certified.

**Permissions:** `bank.reconciliation.view` · `bank.reconciliation.perform` (import, match, complete) · `bank.reconciliation.reopen`. Manager sees; Accountant reconciles; undoing a sign-off stays with the Owner.

**Built in 11.2:** the standalone `Change Transaction Date` action and the Counter surface named above. Reconciliation still writes nothing itself — it launches the one date-change use case with the statement's day prefilled, and the owner presses that dialog's own Save (UI-72).

## 5.18 M22 Expenses
**Expense Category/Ledger** (configurable — Salary, Electricity, Transport, Rent, Other), optional Payee/Employee/Party, amount, business date, payment account/method, description/note, reference and user. Add/correct/update through versioning, void/reverse where posted, search, filter, audit, cash/bank linkage, and reporting by Transaction Date or Entry Date.

Salary paid to Belal is modelled as `Expense Category = Salary`, `Payee = Belal` → salary expense + the selected cash/bank movement + optional payee history + audit, all in one transaction. `Salary`, `Electricity` and `Transport` are **expense classifications**, not Party roles.

**Counter / Quick Transactions workspace (UI-53):** the first-class daily workspace groups:
- **Receive Voucher** — choose customer/allowed receivable party → show Due/Advance/open invoices → receive into selected Cash/Bank account.
- **Payment Voucher** — choose supplier/vendor/allowed payable party → show Payable/Advance/open purchases → pay from selected Cash/Bank account.
- **Expense Voucher** — choose Expense Category/Ledger → optional Payee/Employee/Party → amount → pay from selected account.

Counter is a shared entry surface over existing receipt, supplier/vendor payment and expense use cases, **not a fourth document type and not a new posting path**. It may keep selected business date/payment account for consecutive paper vouchers, but each save has its own operation ID, document/voucher number, posting, allocation, cash/bank movement and audit event. Permissions hide unavailable tabs/actions; period rules still apply. The successful result links to the source voucher plus affected Party/Expense/Account ledger and keeps Counter ready for the next entry.

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


### Serialized inventory unit model
Every physical serialized unit has its own durable record linked to Product, Manufacturer Serial, Lot, Supplier, Purchase/Receipt, Purchase Date, acquisition cost reference, Expiry where applicable, Warranty configuration/reference, current location and Current Status. Status changes are explicit and audited.

**Manufacturer serials are never generated by SherERP.** They are entered/scanned from the physical item. Duplicate active serials are rejected and received serial count must match serialized quantity.

### SherERP unit barcode
SherERP may generate its own barcode/QR identifier for a physical inventory unit. The encoded value identifies a stable **inventory unit ID**, not mutable business data. Product, serial, lot, warranty, expiry and status are looked up from current authorized data after scan. Do not embed current warranty status, price, customer or other mutable details in the barcode payload.

### Barcode label printing
Configurable label fields may include Product Display Name, Manufacturer Serial, Warranty reference/period, Expiry and SherERP barcode/QR. Label templates must support common thermal label printers through the document/print layer.

### POS selection and search
Serialized sale selection supports scan plus manual search by Serial Number, Warranty Number/Reference and Barcode. Only valid, available, sellable inventory units may be selected. Scanning a serialized unit barcode automatically adds/selects its product and exact unit/serial.

## 5.20 M24 / M25 Reports & Dashboard

**Sales:** summary by date, product, customer, cashier, brand, category, payment method.
**Purchasing:** summary by supplier, product, date.
**Inventory:** current stock, low stock, out of stock, movement, lot, valuation, lot ageing/near expiry, cost adjustments, COGS by period, provisional-cost exposure, margin per product/sale.
**Finance:** customer due ageing, supplier payable ageing, vendor payable, vendor receivable, cash, bank, expenses, profit when reliable (D-06). Ageing totals reconcile exactly to their journal control accounts as of the same business date.
**Reconciliation:** unmatched, reconciled, late entries, corrections, cost adjustments after sync.

**Reports read from journal lines and stock movements only — never computed from documents directly (INV-10).**

Dashboard cards are configurable and permission-gated: today's sales, stock value, purchase orders, low stock, recent sales, due collection, payable, cash/bank balance. Profit is hidden unless costing is reliable (D-06) and the feature is enabled.

### Sales performance and profit forecasting (owner decision 2026-08-20, build after Sales/POS)
The owner asked for product-level performance and a forward view. Recorded here, in the module that owns profit, rather than built into Inventory — which has no sales data and must not grow a second profit figure (INV-10).

**Performance (built once Sales/POS supplies data):** units sold and revenue per product over a chosen range, gross profit per product from journal `SALES` less `COGS`, best and worst movers, and stock turn (units sold ÷ average units held) so slow stock is visible as a number rather than a hunch. Every figure derives from journal lines and stock movements and drills down to them.

**Target and forecast (needs its own owner decision before it is built):** the shape is agreed — a shop sets a profit or sales target for a period and sees actual against it, plus a projection of where the period will land. **What is not yet decided, and must be before any code:** whether a target is entered manually per period or derived from history, whether it is set per shop, per category or per product, and what basis the projection uses (simple run-rate to period end, or a trend over prior periods). Inventing any of these would be a fabricated business rule (R-A5). A forecast figure must always be labelled as an estimate and must never be presented beside posted figures as though it were one.

Profit shown anywhere here obeys the Dashboard profit rule below: feature enabled, `report.profit.view` held, and costing reliable for the range (D-06) — provisional costing is marked, never presented as final.

### Explainability — the "Why?" requirement

Every important total supports drill-down to its source transactions:

```
Stock: 127            [Why?] → the movements that produce 127
Customer Due: ৳80,000 [Why?] → the journal lines that produce ৳80,000
Vendor Payable: ৳65,000 [Why?]
Bank Difference: ৳11,500 [Why?]
```

This is a product requirement, not a nice-to-have. It is also the practical test of INV-10: if a figure cannot be traced to journal lines or stock movements, it was computed the wrong way.


### Dashboard profit rule
Profit **may appear** on the main Dashboard only when all three conditions are true: (1) the Profit dashboard feature/card is enabled, (2) the user has `report.profit.view`, and (3) costing for the displayed range is reliable/finalized under D-06. If costing is provisional, the card is hidden or clearly marked provisional according to the configured policy; it must never present provisional profit as final.

Dashboard cards and lists are configurable by allowed feature/permission. Common cards include Today Sales, Stock Value, Purchase Order status/count, Low Stock count, Recent Sales, Due Collection/Receivables and Payables. No user may enable a card whose entitlement/permission denies its underlying data.

## 5.21 M26 Settings & Feature Controls
Product settings (**costing method — `FIFO` or `AVERAGE`, D-05**; stock behaviour; product behaviour) · party settings · permission settings · module feature on/off per entitlement · terminology · tenant timezone · numbering prefixes · period lock configuration · negative stock policy (`BLOCK`/`WARN`/`ALLOW`) · backdating policy · cash session on/off · wholesale sales on/off · dealer pricing on/off.

**Printing settings** carry the **default print language** for each document type the shop hands out — sales invoice, purchase invoice, purchase order — as `BANGLA` or `ENGLISH` (UI-48, owner decision 2026-08-19). It is a default, not a lock: the print dialog always offers the other language in one tap, because the customer at the counter and the supplier being emailed do not want the same one. The setting changes rendering only and never a stored figure, a document number or a posting.

There is no "lot consumption method" setting — physical issue is always FIFO/FEFO (DR13.2).

**Only enabled features appear in navigation and screens.** Navigation visibility is driven by entitlement → feature setting → permission, in that order. Never render a control that will 403.

**Feature dependencies must be validated — invalid combinations are prevented, not merely discouraged:**

```
Vendor/Consignment  →  requires Vendor Management + Vendor Ledger
Warranty            →  requires Serial Tracking where the product is serial-tracked
Bank Reconciliation →  requires Bank Accounts
Dealer Pricing      →  requires Wholesale Sales + Customer Groups
```

Turning off a parent feature must either cascade or be refused with an explanation — never leave a dependent feature enabled and broken.


### Required feature/settings controls from the confirmed product behaviour
At minimum settings cover: product offers/default discounts; optional customer fields such as NID and Father/Guardian Name; dealer/customer-group pricing; Vendor/Consignment; serial/warranty; expiry; negative-stock sale policy; expired-stock sale policy; invoice template/visibility controls; dashboard card visibility; `inventory_issue_method` (`FIFO|AVERAGE`); `sale_costing_method` (`FIFO|AVERAGE`).

Feature access remains `Plan → Feature → Setting → Permission → Access`. Turning a feature off hides new-use UI but preserves historical data.

## 5.22 M27 Audit
Every audit event records: user, action, entity, entity ID, old value, new value, timestamp, reason where required, source transaction, and `source` (e.g. `DAYBOOK`, `SYNC`, `API`).

Authorized freedom — edit, update, delete where allowed, change transaction date, correct, reverse, cancel — is always auditable. Indicators: `ON_TIME` · `LATE_ENTRY` · `BACKDATED` · `CORRECTED`. **The system must never make a financially meaningful historical event disappear without an auditable trail.**

Permission **denials** on mutating actions are audit-logged with user, code, record, timestamp, trace ID. Read denials are logged in aggregate only.

## 5.23 M28 Offline & Sync — future phase

Offline runs **inside the PWA** on SQLite WASM + OPFS (D-23), under the single-writer rule bound to a registered browser profile (D-01). Tauri is **not used for this phase**; it is a possible later packaging/integration phase after Mobile (D-20). Everything below is the reason for the ULID, integer-money, outbox and idempotency decisions taken in V1.

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


### Binding document/printing behaviour
The centralized document service must render invoice/statement documents consistently for screen preview, A4, 80mm thermal, Business Pad, PDF and JPG/PNG output. WhatsApp sharing is an explicit action for invoices and may use a generated authorized link or exported file. The share action must be available from invoice detail where platform capabilities allow it, with a download/copy fallback on desktop browsers.

Business Pad rendering must honor configurable header/top offset, margins/content start, optional suppression of software logo/business header and per-section visibility so a pre-printed pad can supply those elements physically.

## 5.25 M30 SaaS, Multi-tenancy & Backup
Tenant isolation and lifecycle, subscription, entitlements, trial, upgrade, renewal, expiry, account closure, data export, data deletion (with a defined purge job and retention window), restore.

Encrypted export as `tenantname.sherdb` with encryption, integrity protection, versioning, import validation, restore, migration, tenant ownership validation. Supported lifecycle: download backup → close account → delete server data → return later → create/restore account → import backup → continue operating.

### As built — Phase 10, owner decisions 2026-08-30

**V1 is a single-business installation product, not a shared multi-tenant SaaS service.** One deployment and one database serve exactly one business, which may still have many users, roles, locations and a large transaction history. `tenant_id`, `TenantContext`, the tenant-scoped repository boundaries and the isolation checks **remain intact** as architectural safety and future SaaS readiness, and must not be removed. SaaS signup, platform-operator tooling, central subscription and top-up workflows, the SMS wallet (§5.24) and cross-tenant lifecycle management are **deferred out of V1** — disabled by configuration, never deleted (§4.4's governing rule). V1 runs the existing single-tenant provisioning and licence-based entitlement path, with backup/restore and upgrade safety treated as first-class release requirements.

**Two complementary backup mechanisms, neither replacing the other.** The encrypted, versioned `.sherdb` file is the owner's portable logical backup and supports validated forward migration during restore. A separate automatic `pg_dump` is an operational recovery artifact taken immediately before every database migration and before a reset, and used for exact rollback if the operation fails.

**Restore is allowed only into an empty business, and never deletes anything.** Clearing an existing business is a separate, step-up-protected **Reset Business Data** operation that first creates *and verifies* a PostgreSQL recovery dump. Business backup data is never merged: accounting rows that merge produce colliding document numbers and a ledger that stops agreeing with itself.

**One encrypted `.sherdb` every night, created and verified**, with the latest 14 successful automatic backups retained, plus manual download at any time. The dashboard warns when no manual export has occurred for 7 days, and warns immediately when automatic generation or verification fails. **The UI must not claim that a backup is off-device unless an external backup destination has actually confirmed it** — no such destination exists in V1, so the wording says only when a copy was last downloaded from this server.

**One customer-controlled backup encryption secret** for both automatic and manual archives, stored outside PostgreSQL in a restricted installation-level key file — never in a database row, backup archive, log, diagnostic bundle or API response. The UI never reveals it; an authorized Owner may replace it under step-up, warned explicitly that existing backups remain encrypted under their previous secret. **No server-managed recovery exists in V1** (D-15's stated consequence, said plainly on the screen).

**Original Bank/MFS statement files referenced by any reconciliation, draft or completed, are mandatory evidence and are included in every `.sherdb` backup.** Generic uploaded attachments and media may remain outside it under the normal attachment policy (D-13).

**Identity comes from the backup; entitlement comes from the machine.** Business identity, users, credential hashes, roles and historical authorization/audit relationships are restored from the archive. Current runtime entitlements come exclusively from the licence installed on the destination system: **restoring a backup cannot restore, extend or bypass a licence** (D-08). The seeded bootstrap admin exists only to gain access to an empty installation and perform recovery; a successful restore replaces the temporary seeded identity and users, and the operator must then authenticate with a restored business account.

**A licence that excludes a module the business has never used hides it completely.** If the business already holds data belonging to that module, it stays visible in a read-only historical state so the business can always reach its own records; new writes remain blocked until the licence includes it again. Full licence detail lives on a dedicated **Settings → Licence** page; escalating global notices appear only when action is required — nothing while `ACTIVE`, a quiet warning in `EXPIRING`, a prominent countdown in `GRACE` while writes still work, and in `READ_ONLY` a persistent notice **to every user** explaining that writes are blocked while all existing data stays readable and exportable.

**`.sherdb` contains the complete durable business state** required to reproduce the business: identity, users, credential hashes, roles, settings, master data, all transactional/accounting/inventory data, numbering state, full audit history, permanent `operation_id` values, reconciliation data and statement evidence. Ephemeral runtime state — sessions, refresh tokens, OTPs, the temporary idempotency cache, the pending operational outbox, locks, caches, runtime secrets, licence and machine configuration — is excluded and recreated cleanly after restore.

**A restore source is always a file selected by the recovery administrator through the browser Restore screen**, which may physically come from USB storage, an external disk, the user's computer, a mounted network share or downloaded cloud storage. The application streams and validates the archive before any business data is written. Direct server-filesystem selection is not part of the V1 workflow.

**Upgrades are explicit maintenance operations, never automatic API-startup migrations.** A single shipped upgrade command validates prerequisites, creates and verifies a PostgreSQL recovery dump, runs forward-only migrations, performs post-upgrade health checks, and automatically restores the pre-upgrade dump if any step fails. The application refuses normal service when its executable and database schema versions are incompatible.

**Permissions.** `backup.export` → permission + step-up · `backup.restore` → permission + step-up · `business.reset` → permission + step-up + typed confirmation · `license.term.view` → permission only. All four are seeded to the **Owner** alone; Manager, Accountant, Cashier, Storekeeper and Viewer receive none.

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

**Pagination** keyset only; default limit 50, max 200; filters use `business_date`, never `created_at`.

**Sorting is caller-selected** (owner decision 2026-08-19, UI-46): a list endpoint accepts a `sort` column and direction from a **closed allow-list per endpoint**, never a free column name — an unchecked sort parameter is an injection hole and an unindexed sort is a table scan on the busiest screen in the shop. Each endpoint declares its sortable columns, each one is indexed, and the default remains `business_date DESC, id DESC` (`name ASC` for master-data lists, which have no business date).

Keyset paging still applies and the cursor carries **the sort key plus `id`**. The id is a mandatory tiebreaker, not a nicety: sorting by a non-unique column (stock quantity, price, name) without one makes rows on the page boundary shuffle between pages — a shopkeeper paging through low stock would see the same product twice and another one never.

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

The shop owner's **universal daily review and notebook-reconciliation screen**: every relevant transaction for a date/range in one place, with source-aware actions that let the operator correct the real transaction without navigating back through module menus. **Not a second transaction engine** — Daybook creates no business documents of its own, computes no mutable balances, and implements no edit/posting logic. An authorized row action opens the owning module's Receive/Pay/Edit-Correct/Return/Change-Date/Void-Reversal/Print workflow as a dialog/drawer or source detail; save/cancel returns to the same date basis, range, filters and scroll position with refreshed journal-derived totals.

**Requirements:** default `Date Basis = Transaction Date`; authorized switch to `Entry Date` for audit · range defaults to today · sales, purchases, receipts, payments, expenses, returns, cash movements, bank movements and stock adjustments · source-linked rows · familiar `Edit`/`Delete` actions mapped internally to correction/versioning and void/reversal for posted records · filter by type, party, user, payment account/method · running cash/account position where meaningful · print a physical day-end report · identical source-module permissions, period locks, idempotency and audit.

**Cash drawer session history.** Daybook shows, for each business date in range: opening cash, cash in, cash out, expected closing, actual counted, difference, and any between-session movement (owner injection/withdrawal, transfer to or from another cash account, bank deposit) with its reason. A shortage or overage is shown on the day it was counted and is never netted against another day. These figures come from the session rows and the journal, not recomputed by Daybook.

**Tables — no new transactional tables.** Only `daybook_prints(id, tenant_id, from_date, to_date, printed_at, printed_by, opening_cash_minor, closing_cash_minor, transaction_count, totals_json, reprint_of_id)` and `daybook_review_marks(id, tenant_id, business_date, reviewed_at, reviewed_by, note)`. `daybook_prints` exists so a reprint can be proven identical to — or explicitly different from — the original physical copy.

**Reading model:** reads `journal_entries`/`journal_lines` ordered by `business_date, created_at, id`, unioned with `stock_movements` for stock-only events that produce no journal entry. Reading per-module document tables would let Daybook disagree with the ledger — exactly what INV-10 forbids.

**Domain rules**

| # | Rule |
|---|---|
| DR1 | Daybook contains **no** business logic. Every mutation delegates to the owning module's use case |
| DR2 | In Transaction Date mode rows are ordered by `business_date`, `created_at`, `id`; in Entry Date mode by `created_at`, `id`. Both are stable and reproducible |
| DR3 | Transaction Date mode filters/ranges on `business_date`; Entry Date mode filters/ranges on `created_at`. The selected basis is explicit in UI and query contract; reports remain business-date based unless an audit view explicitly says otherwise |
| DR4 | Voided documents are shown struck through with their reversal linked — not hidden |
| DR5 | A transaction in a locked period is read-only, with a lock icon and reason |
| DR6 | Opening cash = the closing cash of the previous **cash session** (§5.16), which belongs to the previous trading date. Where cash sessions are disabled, it is the previous business date's closing cash. Mismatch is shown as a visible discrepancy, never silently reconciled |
| DR7 | Backdated/late entries appear on their `business_date` with a clear flag, and remain discoverable in Entry Date mode / the "entered today, belongs elsewhere" audit section |
| DR8 | `Change Transaction Date` delegates to the source correction/date-change use case; `created_at` is immutable and never copied/re-written by Daybook |
| DR9 | `Add Missing Entry` launches Counter or the owning source workflow with Daybook date/account context prefilled; the new entry returns to and refreshes the same Daybook review context |

DR7 is what makes Daybook trustworthy under this project's backdating freedom.

**Services:** `GetDaybookService`, `GetDaybookSummaryService`, `MarkDayReviewedService`, `PrintDaybookService`. **No edit services.** If `DaybookUpdateSaleService` ever appears, the module has become a back door.

**Endpoints:** `GET /daybook?from=&to=&dateBasis=BUSINESS_DATE|CREATED_AT&type=&partyId=&userId=&accountId=&cursor=` · `GET /daybook/summary` · `POST /daybook/review` · `POST /daybook/print` · `GET /daybook/prints`. Mutations always use the existing source-module endpoints/use cases.

**Permissions:** `daybook.view`, `daybook.view.all_users`, `daybook.view.entry_date`, `daybook.review.mark`, `daybook.print`. **Every mutation launched from Daybook requires the source module's own permission** (including backdate/date-change/void/return). Daybook concentrates visibility, never authority.

**Print layout, in order:** header (shop, address, range, printed at/by, print serial) → opening state (cash, bank, receivable, payable) → chronological transaction list → section totals → closing state → movement summary per account → **backdated section** (entries recorded in this range but dated outside it, and entries dated in this range but recorded outside it) → footer with signature lines, page numbers, `REPRINT` watermark. PDF, A4, with a condensed 80mm thermal variant.

Without the backdated section, a printed day-end report can be silently invalidated by a later backdated entry.

**Validation:** `to_date` before `from_date` rejected · range > 92 days rejected (use Reports) · future `to_date` allowed · printing a zero-transaction day allowed.

**Audit:** edits via Daybook are audited by the source module with `source: DAYBOOK` — distinguishing "corrected during day-end review" from "changed weeks later". Every print writes a `daybook_prints` row; reprints set `reprint_of_id`.

**Tests:** T1 Transaction Date range correctness · T2 **Daybook totals equal Reports totals** in Transaction Date mode (INV-10) · T3 Entry Date mode returns by immutable `created_at` without changing report totals · T4 opening = previous closing · T5 voided struck through with reversal linked · T6 locked rows read-only, source mutation returns `PERIOD_LOCKED` · T7 backdated appears on business date and in entry-date/audit discovery · T8 `Change Transaction Date` changes `business_date` only and refreshes Party/Expense/Account ledgers consistently · T9 `Add Missing Entry` routes through Counter/source use case and returns to same Daybook context · T10 audit identical to source edit plus `source: DAYBOOK` · T11 cashier without `daybook.view.all_users` sees only own · T12 cashier response body has no cost/profit field · T13 cross-tenant invisible · T14 reprint records `reprint_of_id` and watermark · T15 a 00:30 Dhaka sale appears on the cash session's business day.

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

# PART 5A — 2026-08-18 CONFIRMED RECONCILIATION

This matrix is binding and exists to prevent older prompts from reintroducing superseded behaviour.

| Topic | Canonical decision |
|---|---|
| Product offers/default discounts | Included; normal price retained; promotion dates/types explicit |
| Minimum product fields | Product Name, Base Unit, Purchase Price, Selling Price, Minimum/Reorder Stock; Opening/Current Stock defaults 0 |
| Customer optional fields | Address, Father/Guardian Name, NID, Email, Notes; configurable visibility |
| Loyalty/Premium | **Dropped for now** |
| POS discounts | Fixed amount and percentage |
| Barcode scan | First scan adds; repeat normal scan increments qty; serialized scan auto-selects exact unit/serial |
| POS filters | Brand, Category, Product Group/Subcategory, Stock Status plus search/barcode |
| Zero/negative stock visibility | ACTIVE products remain visible/selectable; INACTIVE products excluded |
| Vendor creation from POS | Included when permission/feature allows |
| Cosmetic invoice editing | Included, presentation-only and audited; cannot change accounting/stock facts |
| Invoice design settings | Included |
| Image export | PDF + JPG/PNG |
| WhatsApp share | Included |
| Business Pad controls | Included |
| Manufacturer serial | Enter/scan physical serial; SherERP does not generate it |
| Serialized unit model | Included |
| SherERP unit barcode | Stable unit ID; mutable data looked up, not encoded |
| Barcode labels | Included |
| Serial/warranty/barcode search | Included; only valid available units selectable |
| Expiry management | Lot expiry + expired/near-expiry views + configurable sale policy |
| Landed cost seeded categories | Transport, Labor, Loading/Unloading, Delivery, Customs, Other |
| Ledger actions/statements | Explicit UI actions plus opening/running/closing balance and dual dates |
| Invoice payment/return history | Explicit detail-screen actions |
| Purchase corrections | Explicit supplier/date/items/qty/price/landed-cost/payment correction via versioning |
| Purchase notes | Included |
| Dashboard profit | Only feature enabled + permission granted + costing reliable |
| Roadmap | Online-first → Sync infrastructure → PWA Offline → Mobile → Tauri future → MCP |
| Costing options | FIFO and AVERAGE only; LIFO excluded |
| Settings | Separate `inventory_issue_method` and `sale_costing_method`, each FIFO/AVERAGE; accounting valuation follows sale costing |
| Offline authority | One offline writer per tenant, registered browser profile; others read-only offline |
| Merge policy | New architecture/security/accounting kernel retained; missing confirmed business/UI behaviour merged into it |

# PART 6 — BUILD PLAN

## 6.0 Module-scale vertical development

**SherERP is built one complete business module at a time, top to bottom.** This replaces the earlier one-screen micro-slice cadence from 2026-08-17 onward. Existing completed slice history remains valid.

A **module increment** contains the related user actions needed to make one business area useful. Each internal path is connected across every layer before the next path begins. **Every module starts with the pre-build question round and the owner's `START`** (`AI_CODING_INSTRUCTIONS.md` R-Q), and **verification happens once at the end**: the existing full `pnpm test` suite plus a manual checklist the owner works through in the real UI (R-E). New automated tests are not written without the owner's permission.

```
Pre-build questions (10–20, unresolved decisions only)
  → owner's answers → final module specification
  → added / changed / reused, exact UI & workflow, files & modules affected
  → WAIT for START
  → Acceptance criteria (expected numbers written FIRST)
  → Domain logic            (core-domain)
  → Application use cases   (core-application)
  → Migration               (schema for this module only)
  → Repository/adapter      (adapter-postgres)
  → API + contract          (core-contracts, apps/api)
  → Frontend workflows      (apps/web, shared visual system from §2.7.I)
  → Existing full `pnpm test` suite, run ONCE on the complete module
  → Manual checklist handed to the owner
  → End-to-end manual UI acceptance against pre-written numbers
  → Module-gate commit
  → Next module (only after the owner confirms this one)
```

**This is forbidden:** all backend → all database → all frontend → tests at the end. It defers every integration risk to the point where fixing it is most expensive, and it produces nothing the owner can verify for months.

**A module is not complete because the backend compiles, the test suite passes, or endpoints return 200.** It is complete when the entire listed workflow works in the real UI and the owner confirms the numbers by manual testing.

### How big is a module increment?

Target one working week and several dependent business areas, not one screen and not an arbitrary collection of unrelated work. The four one-month modules in §6.1 are the binding size examples.

| This is one module increment | Too small | Too large |
|---|---|---|
| Business setup: remaining access/admin + catalog + parties | Create product form only | Business setup + inventory + sales |
| Stock, money and purchasing: the complete foundation required to buy and pay | Opening-stock API only | Stock/purchase + unrelated SaaS billing |
| Sales and corrections: sell, pay/due, print, reverse, return and adjust | Add line to cart only | Sales + backup/restore + bank reconciliation |
| Control and operations: reports/Daybook + SaaS operations + bank reconciliation | One dashboard card | Control module + offline/MCP |

Use checkpoint commits inside the module. If a weekly module cannot be completed within five working days, keep unfinished paths visibly unfinished and split at a real workflow boundary, not by technical layer.

### Foundation exception

Infrastructure may be built without a UI **only** when it is genuinely foundational and every later module depends on it:

- monorepo structure and dependency boundaries
- `Money` / `Qty` / `UnitCost`, `Ulid`, `Clock`
- `TenantContext`, `UnitOfWork` / transaction infrastructure
- audit, idempotency, permission, numbering, period-guard, outbox and posting **interfaces**
- migration infrastructure and the test harness

This is **Phase 0 only**. "Foundation" is not a licence to build future functionality before a working module. Outside Phase 0, proposed foundation work must name the current module path that is blocked without it.

### Session economy and the function map (owner decision, 2026-08-22)

SherERP is built by AI agents that start each session with no memory of the last one. Two habits waste the owner's budget without improving the software: re-reading the codebase to rediscover what already exists, and re-running the entire test suite after every edit. Both are now bounded, and `AI_CODING_INSTRUCTIONS.md` R-T holds the binding rules:

- **`FUNCTION_MAP.md` is read before the codebase is searched.** It is a reuse index at the repository root — reusable functions, services and use cases, API endpoints, repository/database methods, shared UI components and the important business rules, each with its file path and when to call it. Deeper searching happens only for what the map does not answer.
- **Every coding session updates it** with what it added, changed or removed, in the same commit as the work. It is the fourth permitted markdown file; the ban on task logs, decision logs, module docs and planning documents is unchanged, and it never restates requirements — those stay here.
- **The full suite is not run after every change.** The module is finished first, then the four gates run once before owner acceptance. Superseded on 2026-08-22 by the owner's testing policy below.

### Pre-build questions and the testing policy (owner decision, 2026-08-22)

These two rules are binding for every module and are stated in full in `AI_CODING_INSTRUCTIONS.md` R-Q and R-E:

- **Nothing is built until the owner replies `START`.** The agent first asks 10–20 concise questions about genuinely unresolved decisions only — never about what this document, the instructions, `FUNCTION_MAP.md`, existing code or a previously confirmed requirement already answers — then presents the final module specification, what will be added/changed/reused, the exact UI and workflow the owner will receive, and the files and modules expected to be affected.
- **The complete module is built first; new tests are not written by default.** The only mandatory automated check is the existing full `pnpm test` suite, run once when the module is done, followed by a concise manual checklist so the owner tests the real UI, calculations, data flow and business workflow. Unrelated pre-existing failures are reported briefly and not investigated without the owner's approval. Extra permanent tests for critical financial, balance, FIFO/stock, payment, refund, accounting, unit-conversion or settlement logic are optional and need the owner's permission, granted only after their manual testing. No UI/E2E tests, mocks, fixtures or diagnostic tests unless requested. Existing tests are never skipped, weakened or deleted, and the next module does not start until the owner confirms the current one.

**How the questions are asked (owner instruction, 2026-08-24, final).** **One question per message**, up to about **20** where the module needs them and fewer when it is already well defined. Each question carries **3–4 suggested answers** with the best marked **(Recommended)**, each option short and stated as its practical effect on the shop's daily work, plus a final *“Type your own answer”*. The owner picks one or writes his own; the decision is recorded and the **next** question follows. Nothing the SRS, the instructions, a confirmed decision or an earlier part of the conversation already answers is asked — it is stated as settled in one line (Q2/Q7). Questions target real workflow, permissions, accounting behaviour, edge cases and UI/UX, and are written for users who may have **low literacy**: simple workflows, Bangla-friendly labels, minimal steps, clear actions. When all are answered, a short **Final Module Specification** is shown — workflow · permissions · accounting/business rules · UI behaviour · edge cases · files and modules expected to change — and the agent **waits for `START`**. Full rules in `AI_CODING_INSTRUCTIONS.md` R-Q (Q6–Q8) and R-0.

**No test code is written, and no test suite is run (owner instruction, 2026-08-24, binding).** The owner verifies each module by driving the running application himself, so the acceptance gate is a **step-by-step UI walkthrough** handed over once the code is built and running — never an automated suite. The required sequence is: questions → final specification → `START` → code → build and run the app → **the owner reviews the UI** → he reports bugs → the agent inspects only what is needed to diagnose each one and fixes it. `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test:boundaries` still run every time; `pnpm test` runs only when he asks. This is `AI_CODING_INSTRUCTIONS.md` **R-0**, which outranks every other rule in that file.

**The dev server is started at the beginning of every session (owner instruction, 2026-08-24, mandatory).** Postgres, the API and the web server, before status is reported or anything is asked — so the owner can open the running app at any moment, and so no agent reports work it has not seen run. R-0 step 0; commands in `DEV_SERVER_START_GUIDE.md`.

**This changes cost, never correctness.** The four gates, the golden invariants, tenant-isolation and permission proof, exact-number acceptance and manual UI acceptance are all untouched. An agent may skip reading a file it does not need; it may not skip reading a file it is about to change, skip a required §5 module section, or ship an unverified number.

## 6.1 Phases

The roadmap phases group requirements and dependencies. For the one-month V1 build, adjacent phase scopes are consolidated into the four weekly delivery modules below. Items in a phase scope cell are internal paths, not separate full-regression or owner-acceptance events. Phase 0 keeps its historical foundation slices.

| Phase | Module increment | Scope included in the one module gate | Module exit criteria |
|---|---|---|---|
| **0** | Foundation kernel *(no UI — the only exception)* | 0.1 monorepo + CI boundary checks · 0.2 Money/Qty/UnitCost/Ulid/Clock · 0.3 TenantContext, AccessControl, PeriodGuard, AuditWriter, IdempotencyStore, UnitOfWork, NumberingService, Outbox + one reference use case | `/health` returns 200; all CI gates green; boundary checker proven to catch a violation; cross-tenant, RLS, idempotency, period-lock and concurrent-numbering tests pass |
| **1** | Business platform | Existing registration/login/credential/user work plus roles and permissions, settings, audit viewer, and deployment-mode boot validation | Owner registers, signs in, creates a user, assigns a role, changes a setting and sees the audit trail. Both deployment smoke modes pass |
| **2** | Catalog and parties | Product create/edit/list/search, brands, categories, barcode, units/conversion; party create/edit/list/search, role flags, customer-phone uniqueness and walk-in customer; guided CSV import for product/party master data | Products and parties fully usable in the consistent UI with permissions enforced; valid master data imports once and any invalid file posts nothing |
| **3** | Inventory core *(Gate G2)* | Opening stock including its CSV step, movement + journal + lot, stock and lot views, FIFO/AVERAGE setting, valuation, negative-stock policy and movement drill-down | **INV-01…INV-05 green under both costing methods**; valuation equals `INVENTORY` exactly |
| **4** | Money accounts | Cash accounts, Start Day, End Day, **Reopen Day (same business date)**, **Daily Cash reconciliation/history**, bank/MFS accounts with balance and statement, transfers, owner injection/withdrawal, and opening cash/bank balances **typed on the account form** (owner decision 2026-08-24 — no CSV path for these; a shop has a handful of accounts, and opening AR/AP already shipped in 2.4·3.6). Bank *reconciliation* against an external statement (§5.17) is **not** in this phase | §5.16.6 reproduces exactly; Daily Cash shows immutable Expected vs Counted history and opens filtered Daybook investigation when available; imported openings post once through normal services; cash/bank prove from journal; INV-07 a/b/c green |
| **5** | Purchasing *(first real milestone)* | Purchase create/list/detail, lot + stock + payable posting, purchase due date/ageing, supplier payment/credit application, supplier ledger, edit and void/reversal | Purchase → stock → payable → payment/credit → ledger → cash works as one UI scenario with exact numbers; payable ageing equals its journal control account |
| **6** | Sales and POS *(Gate G3)* | POS sale, customer/walk-in, multi-method payment and due, invoice due date/ageing, invoice detail/print/share, customer ledger, receipt allocation/advance, templates and void/reversal; hidden wholesale quotation/order and dealer-pricing paths | Full buy–stock–sell cycle passes manually; receivable ageing equals its journal control account; shared invoice matches the posted document; POS performance budget is met |
| **7** | Corrections and adjustments | Sales/purchase returns, stock reconciliation, expense, backdating, period close and controlled unlock; **Counter becomes fully populated with Receive / Payment / Expense once its backing use cases exist** | Correction scenarios pass; locked writes return `PERIOD_LOCKED`; Counter calls only existing receipt/payment/expense use cases; every correction is auditable |
| **8** | Purchasing extras | Purchase orders with partial receiving, landed cost, consignment, serial capture and warranty lifecycle | Partial receipts create only received stock/payable and cannot be duplicated; all scenarios pass with correct journals |
| **9** | Reporting and Daybook *(Gate G4)* | Sales, purchase, inventory and finance reports; Why drill-down; dashboard; **Daybook Transaction-Date/Entry-Date review, source correction launcher, notebook reconciliation**, and day-end print | INV-10; Transaction-Date Daybook totals equal Reports; Entry-Date audit mode verified; source actions return to preserved Daybook context; A4 and 80mm output verified |
| **10** | SaaS operations | Plans/entitlements, tenant lifecycle, export/import/restore, SMS wallet and bKash top-up | Entitlements work; backup → wipe → restore matches exactly |
| **11** | Account reconciliation | Select account/range, import/match where available, **change Transaction Date, add missing entry through Counter/source workflow, correct/reverse, reconcile and later-edit review** | Reconciliation scenarios pass; `created_at` never changes; later edits of reconciled rows become review-required |
| **12** | Sync infrastructure + PWA Offline *(Gate G5)* | Complete the sync infrastructure designed from Phase 0: **persistence gate (D-24) first** · profile registration + single-writer authority · SQLite WASM/OPFS adapter · outbox push · pull · conflict quarantine · local backup export/import | SY-01…SY-16 pass; an offline day equals the online result exactly; no write is ever accepted without granted persistent storage |
| **13** | Mobile / PWA polish | Responsive/touch optimisation, installability, camera barcode, mobile navigation and offline UX using the same PWA; evaluate native wrapper only if a proven gap remains | Core POS, inventory lookup and reports usable on supported phones/tablets without a second business-rule implementation |
| **14** | Future Tauri desktop packaging *(optional)* | Only if owner approves after Mobile: package the same application for desktop/native integrations; no forked domain logic or alternate sync rules | Desktop-specific integration benefit proven; same acceptance tests and sync invariants pass as PWA |
| **15** | MCP / AI + on-prem packaging | Read tools before write tools; same application-service path; on-prem install/upgrade hardening | AI actions audited, permission-bound and explainable; on-prem install/upgrade verified on a clean VM |
| **16** | Reusable core extraction | Package hardening | Core packages published internally, one sample reuse |

### One-month online V1 delivery target

The owner-selected one-month target is the complete **online V1 scope through Phase 11**. Sync/PWA offline, Mobile, optional Tauri, MCP/on-prem packaging and reusable-core extraction (Phases 12–16) remain post-V1. The four module gates are intentionally large:

| Week | Module gate | Required outcome |
|---|---|---|
| 1 | **Business setup** — finish Phase 1 + Phase 2 | Owner/staff authentication, roles, settings and audit; products, units, customers and suppliers fully usable; product/party CSV import verified |
| 2 | **Stock, money and purchasing** — Phases 3–5 | Inventory/costing, cash/bank sessions and statements, remaining opening-balance CSV steps, complete purchase/payable/ageing/payment/credit/void workflow |
| 3 | **Sales and corrections** — Phases 6–8 | POS/sales/payments/ageing/printing/sharing/void plus optional wholesale quotation/order and dealer pricing, returns, expenses, reconciliation, periods, partially received purchase orders, landed cost, consignment, serial and warranty |
| 4 | **Control and operations** — Phases 9–11 | Reports, Why drill-down, dashboard, Daybook/print, SaaS lifecycle/backup/SMS wallet, and bank reconciliation; clean-database full regression |

This schedule is exceptionally aggressive. The date does not change the meaning of `DONE`: unfinished paths remain unfinished rather than being hidden, mocked or accepted without tests. Never remove tenant isolation, journal/stock invariants, idempotency, reversal, cash correctness, backup-restore proof or owner acceptance to protect the date.

During a module, run focused tests for the path being built. At each module gate run the four complete commands and the module's manual UI scenario. At the end of Week 4, run the full suite and the complete buy–stock–sell baseline again on a clean database.

## 6.1.1 Delivery status ledger

**The only record of what is built.** Historical micro-slice rows remain unchanged. From the module-scale revision onward, related rows are internal scope checkpoints and receive one full regression/owner acceptance at their weekly module gate. Nothing else tracks progress — do not create a status file, task log or README.

Rules:

- A row is added when a module or explicitly tracked internal path **starts** (`IN PROGRESS`) and updated when code is complete.
- `DONE` requires all four gates green **and** owner acceptance. An agent may set `CODE COMPLETE`; **only the owner sets `DONE`.**
- Commit is the accepted code/module-gate commit. Because a commit cannot contain its own hash, the owner may fill it in with the `DONE` follow-up ledger commit.
- Never delete or rewrite historical rows. A reopened tracked path gets a new row with the same number and a note.
- Each phase exit is tagged in git: `git tag phase-3-complete`.

| Slice | Name | Status | Commit | Owner accepted | Note |
|---|---|---|---|---|---|
| 0.1 | Monorepo skeleton + CI boundary checks | DONE | ef3482f | 2026-08-16 | No UI (Phase 0 foundation exception, §6.0). Owner accepted on the four green commands; no UI check applicable. |
| 0.2 | Money / Qty / UnitCost / Ulid / Clock | CODE COMPLETE | 75b498e |DONE | No UI (Phase 0 foundation exception, §6.0). 100% branch coverage on money.ts and qty.ts enforced as a build gate. |
| 0.3 | TenantContext, AccessControl, PeriodGuard, AuditWriter, IdempotencyStore, UnitOfWork, NumberingService, Outbox + reference use case | CODE COMPLETE | d019014 | DONE | No UI (Phase 0 foundation exception, §6.0). CreateNoteService is the R-D template. |
| 1.1 | Register tenant via OTP → username/password/PIN → empty dashboard | CODE COMPLETE | 5a53bc7 | DONE | First UI slice. `apps/web` created (Vue 3 + Vite + PrimeVue 4, D-37) with the shared design tokens every later screen inherits. Adds `otp_codes` and the non-RLS `user_identifiers` pre-auth index; `audit_events.tenant_id` is now nullable for pre-tenant OTP auditing (§5.3). OTP delivery is the development transport only — real SMS/email is D-33, slice 1.7, and boot refuses the dev transport in production. |
| 1.2 | Log in / log out (password, PIN, Google) | CODE COMPLETE | 0284d3e | DONE | **Split from the original 1.2** (§6.1.1 permits splitting within a phase): logging in is one demonstrable feature, and forgot-password and change-password are two more. Adds `refresh_tokens` (server-stored, rotating, revocable) and `UnitOfWork.runWithoutTenant`'s `adoptTenant`, since a login resolves its tenant mid-transaction. Google uses the OIDC redirect flow, not Google's script (UI-06, §6.5 COOP/COEP), verified against Google's JWKS with Node's own crypto. |
| 1.2b | Forgot password via OTP + change password/PIN in Settings | CODE COMPLETE | ffa2567 | DONE | The remainder of the original 1.2. `otp_codes.purpose` now admits `PASSWORD_RESET` and **every** OTP lookup is scoped by purpose, so a signup code can never be spent to reset a password. A recovery reset revokes every session (nobody is trusted through a forgotten password); a Settings password change revokes all *others* and spares the device presenting its own refresh token (§5.3). Neither operation checks a permission code (it acts only on the caller's own row, and no role holds any permission until slice 1.4) nor writes an idempotency key (`idempotency_keys` stores a request fingerprint, and a fingerprint of a credential change would put a plaintext password in a row — security outranks write-path uniformity in the principle priority). Both departures are argued in the use-case headers. First screen under `/settings`. Also fixes a defect found during acceptance: `AppErrorFilter` mapped **every** framework exception to `INTERNAL_ERROR`, so a request to a route a stale build did not have returned 500 instead of 404 — indistinguishable from a broken server, and the cause was discarded rather than logged. Framework refusals now keep their own status and unexpected errors are written to stderr (never to the response). |
| 1.2c | Google sign-in completes signup for an unknown email | CODE COMPLETE | 3fa6684 | DONE | Implements the 2026-08-17 D-07 revision (see the change log). Not in the original phase plan — added because Google OAuth went live and the owner chose to let it create the tenant. No migration: the credential columns have been nullable since 0002, which is exactly the case they were made nullable for.  Credential-setting for Google accounts landed with it (same commit): Settings offers Set when none exists, Change when one does. |
| 1.3 | Create and edit users | CODE COMPLETE | b8fc46a | DONE | Ships all six §5.26 seed roles with every tenant — otherwise the first hire could only be made an Owner. No migration: disable is the existing soft delete (§3.6), and `roles`/`role_permissions` already existed. Step-up (§5.3) is the caller's own password, re-entered; a PIN never satisfies it. A new user gets no password and sets one through forgot-password, so the person who added them never sees it. |
| 1.4 | Create roles and assign permissions | CODE COMPLETE | d95bdb2 | DONE | No migration: `roles` and `role_permissions` existed from Phase 0, and a revoked permission is soft-deleted rather than removed, so `grant` revives the row instead of colliding with it. Owner is frozen at every permission — `§5.26` says it cannot be de-privileged, and freezing it at the full set also stops a later slice's new code from quietly locking the owner out. Adding a permission code means running `pnpm db:backfill` so existing tenants receive it. |
| 1.5 | Change a setting and see it take effect | CODE COMPLETE | b1bad29 | DONE | Adds `settings` (migration 0005), a key/value row per setting a tenant has **changed** — an absent row is the shipped default, so a default is never confused with an unset value. Not a column per setting (a migration every time §5.21 grows) and not one JSONB blob (two unrelated settings would collide on one optimistic lock, and every audit row would record the whole blob). §5.21's feature dependencies are enforced in both directions and asymmetrically: turning a parent **off** cascades transitively and names what fell with it, turning a child **on** is refused naming the parent — enabling parents on the owner's behalf would switch on features nobody chose to watch. Costing method is step-up (§5.3). **Owner decision 2026-08-18: seed the full §5.21 key list now.** 22 keys are seeded; the settings §5.21 names but never gives values for — terminology, numbering prefixes, backdating policy, period-lock configuration, invoice/dashboard visibility — are deliberately absent, because inventing their values would put a fabricated business rule in the database under an SRS-shaped name (R-A5). Each arrives with the module that defines it. A seeded key whose module does not exist yet renders with a "takes effect with …" marker rather than as a live control. |
| 1.6 | Audit trail of everything above | CODE COMPLETE | b1bad29 | DONE | Read-only screen over the rows slices 1.1–1.5 have been writing all along; no new write path. Keyset paging (§3.9, `OFFSET` banned) on the ULID id, which is both sort key and cursor. Date filters convert tenant-local days to instants in the use case, never in SQL — asking for the 18th in Dhaka must not return six hours of the 17th (§3.5). Adds §5.22's **denial** auditing for refused *mutations* only (read denials are aggregate-only), written in its own transaction because the refused operation's transaction has already rolled back — an audit row inside it would roll back with it and leave no evidence. Adds per-request trace ids: §5.26's error envelope has carried a `traceId` field since Phase 0 and nothing ever set it, so every response carried an empty string. Migration 0006 widens `audit_events.entity_id` from `CHAR(26)` to `TEXT` — a defect found by this slice's tests: `CHAR` blank-pads, and an audited entity is not always a ULID (a setting is identified by its key, a denial by its permission code). |
| 1.7 | Deployment-mode providers (D-33…D-36) + boot validation + license states | CODE COMPLETE | b1bad29 | DONE | All six §4.4 flags, and the three mandatory boot refusals — each is a combination that would otherwise run, look healthy and be wrong. Verifier and entitlement source are now chosen by configuration rather than by `NODE_ENV`. `NoOpIdentityVerifier` throws rather than succeeding quietly: an on-premise install has no signup flow, so reaching it is a misconfiguration and the loud failure is the useful outcome. D-35's licence is verified **offline** (Ed25519 over `base64url(payload).base64url(sig)`), re-read per call so a renewal takes effect without a restart, and nothing in that path throws — missing, forged or truncated all resolve to `READ_ONLY`. D-36's ladder is pure domain logic with the boundaries tested exactly; `GRACE` still writes, because the 30 days after expiry exist so a late renewal does not stop a shop trading. The read-only guard refuses **writes only** — reads, sign-in and (in Phase 10) backup export must keep working, since there is no state in which data is hidden or un-exportable. **Not implemented, blocked on the owner:** `IDENTITY_VERIFIER=otp` needs a chosen SMS provider and credentials (§5.24, D-33), so it throws rather than silently falling back to the dev transport; and no licence signing keypair exists, so `LICENSE_PUBLIC_KEY` is empty and boot refuses `ENTITLEMENT_SOURCE=license` until one is supplied. |

| 2 | Catalog and parties | IN PROGRESS | bb8091f | — | **Paths 2.1, 2.2 and 2.3 are committed with all four gates green; 2.4 is not started** — the module gate is not reached, so this is not CODE COMPLETE and the owner has not accepted it. All four commands were run on the committed tree: lint clean, typecheck across 8 projects, boundaries OK, 260 API + 114 web + 44 domain/shared tests passing. **Built:** units/brands/categories (migration 0007), products with unit conversions (migration 0008), and parties with role flags, customer groups and the walk-in customer (migration 0009), each connected domain → application → repository → API → Vue with focused tests: 11 + 27 + 25 API tests, 8 + 8 + 10 web tests, 7 shared-utils and 4 + 11 domain tests, all passing. **Not built:** the guided CSV import (2.4). Products are Class A master data, deliberately not Class B: §3.9 says master data has neither `business_date` nor status transitions, so the R-C9 reserved transaction columns are absent and stock lives on movements from Phase 3. Opening stock is **not** written by the product form — §5.5 defaults it to 0 and sends a real opening entry through Phase 3's stock service, so a quantity written here would be stock with no movement and no journal behind it. `inventory.cost.view` is enforced by **omitting** `purchasePriceMinor` from the serialized body, not by hiding a column (UI-40, R-E8), and is asserted against the response body. Product create takes an `Idempotency-Key`; unlike a document it has **no permanent `operation_id` column**, because two products may legitimately share a name and there is no natural key for a unique index to catch a replay with — so the 30-day fast path is the whole guarantee, and Phase 12 sync must reconcile master data by identity rather than relying on it. D-32's optimistic lock is enforced in the `UPDATE … WHERE version = ?` itself; the loser gets `CONFLICT_STALE_VERSION` rather than overwriting the winner. Offer dates are **tenant-local days** in and out (§3.5): stored as the instants §5.5 names, with the end held at the last millisecond of the chosen day, and converted in both directions server-side so no client can be a day out. Category depth is fixed at two levels (category → subcategory), matching §5.5's category/group/subcategory and §5.7's two filters; a third would give one product two competing group filters. Removal follows §3.6 exactly — a name nothing carries is deleted, a name products already carry is archived — and the caller is told which happened. **Assumptions stated for the owner:** a generated product barcode uses the existing `NumberingService` (`P-2026-000001`) rather than an invented EAN-13 in-store scheme, since no symbology is specified anywhere in v4; the seven D-10 units are seeded with every tenant because a base unit is mandatory and a tenant with none cannot add its first product; and a stored `FIXED_AMOUNT` default discount larger than the selling price is refused, reading §5.7's "the posting service validates discount boundaries" as applying to a stored default that would otherwise propose a negative line total. **Deferred, and why:** product image (needs D-13 media storage), product-level warranty configuration (§5.19 defines no product-level shape — inventing one would be a fabricated rule), the stock-status filter (§5.7 — stock does not exist until Phase 3), and dealer/customer-group pricing (Phase 6). **Operational:** adding permission codes and the seeded units means running `pnpm db:backfill` after deploying — done on `sher_dev` (945 permissions, 105 units, 15 tenants). **Two pre-existing defects fixed because this module could not compile around them:** `@sher/core-domain` was never path-mapped, so `core-application` typechecked against a stale `dist`; and `apps/web` resolved `@sher/core-contracts` to `dist` too, which CI cannot have — it runs `typecheck` with no build step, verified by removing `dist` and watching every import fail. Both now read source, as every other package already did. **Risk noticed outside this module:** `ManageUsersService`, `ManageRolesService` and `ManageSettingsService` write no outbox records, though R-D's Class M path calls for them and D7 forbids removing them; products and catalog do. Users and settings are sync-relevant in Phase 12. **Path 2.3 — parties (§5.6, D-02, D-04).** One `parties` table plus `party_roles`, exactly as §5.6 names it, rather than three tables: a supplier you also sell to must be one identity with one phone number, not two records nobody can reconcile. Class A master data like products — no `business_date`, no posted status, none of the R-C9 reserved columns. **No balance is stored on a party**: §5.0 requires opening receivables and payables, but INV-06 makes a balance the sum of journal lines, so the opening entry goes through the posting service in Phase 4 exactly as opening stock goes through Phase 3 — a figure typed on this form would be a balance with nothing behind it. **D-02 is enforced by the database, not only by a check.** The rule is "unique per `(tenant_id, phone)` within the CUSTOMER role only", and the role lives in `party_roles`, where a partial unique index on `parties` cannot see it; an application-only check loses to two cashiers saving the same new customer at once. So the repository writes the customer's phone into a derived `customer_phone_key` column (NULL for anyone who is not a live customer) and the partial unique index does the rest. It is a uniqueness key, not a second role store: derived from the roles and phone in the same statement, in one place, and never read to decide what a party is. **The walk-in customer** is seeded with every tenant by `provisionTenant` and refused every edit, deactivation and delete — Phase 6's fully paid guest sales all point at it, and a renamed or removed one would break sales that are already printed. **A hidden optional field is not editable and is never cleared** (§5.6, §5.21): supplying a value for a field the shop has switched off is refused on create, and on edit the stored value is carried through untouched while whatever arrived is ignored. The asymmetry is deliberate — a form that cannot show a field cannot be trusted to send it back, and treating its silence as "clear it" would destroy exactly the historical data the setting promises to preserve. The same rule keeps customers in their group when customer groups are switched off. Three role permissions over one table (§5.26), because the cashier who may add a customer at the counter has no business adding a supplier; the vendor role and customer groups are additionally behind their §5.21 settings, and the Vendors tab is **absent** rather than disabled while they are off. Customer groups follow §3.6 exactly — a group nobody is filed under is deleted, one in use is archived, and the caller is told which. **Assumption stated for the owner:** a phone number is normalised by **removing whitespace only**. `+8801712345678` and `01712345678` are therefore stored and compared as different numbers, because nothing in v4 says they are the same and folding them would be a business rule this code invented (R-A5). The consequence runs both ways and is recorded under risks below. **Deferred, and why:** the party profile's sales/purchase/payment/return history, statement and ledger drill-down (they are read from the journal, which has no rows until Phases 5–6); the guest-snapshot → registered-customer conversion (it is atomic with a sale, Phase 6); vendor-owned stock and vendor payable (Phase 8); credit-limit **enforcement** (Phase 6 — the limit is stored now because it is a §5.6 customer field and re-entering it later for every customer would be worse); and D-04's `EXPENSE` and `EMPLOYEE` role flags, which the migration's CHECK admits but no API offers, because no module defines yet what they mean. **Operational:** `pnpm db:backfill` now also gives existing tenants their walk-in customer, and must be run after deploying. **Was blocking, cleared by owner instruction 2026-08-19:** `roles.spec.ts` and `users.spec.ts` failed because path 2.2 added catalog and party permission codes to `SEED_ROLES` while those suites asserted the seeded matrix literally — Manager holding only `user.account.view`, Cashier holding nothing. Changing expected values in an existing test is R-H's to authorise, and the owner did. Each case now asserts the permission **under test** and that nothing else moved, rather than restating the seed: a suite that must be edited every time a module adds a permission code is testing the fixture, not the behaviour. `product-form-conversion.spec.ts` (6 cases) was stale the same way — it drove the conversion fields without ticking the second-unit checkbox that now gates them. **Risk noticed:** with no country-code folding, a shopkeeper who types `+880…` once and `01…` the next time gets two customer records with two ledgers for one person. Deciding to fold them is a business rule the owner should confirm before Phase 6 makes those ledgers real. **Quick add (D-39, UI-45), owner decision 2026-08-19, applied across the module.** One shared `QuickAddSelect` component: a picker that can create what it is picking, inline, without leaving the half-filled form. Wired to the product form (unit, brand, category, subcategory) and the customer form (customer group); every later picker — supplier during purchase entry, customer at the till — uses the same component and the same rule. It calls the **same** use case the full form calls, so there is one write path, one set of validations and one audit trail (R-D, DRY); it never writes a placeholder or partial record; and it is absent, not disabled, without the create permission (UI-09) or while the owning feature is off. Its own component test (7 cases) covers the shared behaviour, so no page repeats it (R-E11). **Not a code defect, recorded because it cost acceptance time:** the `NOT_FOUND` seen on the Customers screen was a stale `dist/main.js` running from before the module existed, on a `sher_dev` still at migration 0008. After `pnpm db:migrate` (0009 applied) and `pnpm db:backfill` (15 tenants given their walk-in customer), the built server answers `/api/v1/parties` and `/api/v1/party-setup` with `401 UNAUTHENTICATED` rather than 404 — verified on a throwaway instance. **The API must be restarted after every module gate**; there is no watch mode on `pnpm dev`. **Restart it with `pnpm dev` and nothing else.** That script is `pnpm --filter "@sher/api..." build && node dist/main.js`, and the `...` is load-bearing — it rebuilds the workspace packages the server compiles against. Running `pnpm --filter @sher/api run build` by hand omits them, so the server starts against a **stale `core-contracts/dist`**. That failure is silent and misleading: the schemas are `.strict()`, so a client sending a field the stale build has never heard of gets `VALIDATION_FAILED` on a request whose body is perfectly valid. It cost acceptance time once already — after UI-46 added `sort` to the list query, saving a product worked and then *listing* it failed, which reads like a broken create. **Unit conversion respecified (D-41), owner decision 2026-08-19, migration 0010.** Path 2.2's list of per-product conversion rules is replaced by **one** optional conversion unit and factor on the product row, because the behaviour the owner specified — two quantity boxes in Purchase/POS and a stock figure that reads `5 Pipe + 5 Feet (105 Feet)` — has no single answer with a list. Arithmetic lives in `core-domain/catalog/unit-conversion.ts` and nowhere else: `toBaseQty`, `splitToMixed`, `pricePerConversionUnit`, `pricePerBaseUnit`, all pure, all integer, borrowing D-31's half-up rounding from `shared-utils` rather than writing a second one. 19 domain tests, including the property that `toBaseQty(splitToMixed(q, f), f) === q` for every case — a figure that reads as `5 Pipe + 5 Feet` but is not `105 Feet` is one a shop would count against and find wrong. **Money is stored per base unit, always.** The form's price toggle converts before sending; the per-conversion direction is exact, and the reverse rounds half-up once (৳105.05/Pipe over 20 Feet is ৳5.2525/Foot → ৳5.25), which the screen says in words and shows back rather than pretending the poisha survived. Migration 0010 is additive: it adds the two columns with a CHECK enforcing both-or-neither, carries across products holding exactly **one** old rule, and deliberately leaves a product with several rules **unconverted** rather than picking one for the owner (R-A5). `product_unit_conversions` is left in place per §3.10 — stop writing it, deploy, verify, drop in a later release — and `sher_dev` had no rows in it, so nothing was at stake. **Not built, and bound by D-41 when they are:** the two-box quantity entry (Purchase, Phase 5; POS, Phase 6) and the mixed stock display (Phase 3) — neither has a screen to live on yet. **Outside the module, and reported:** `shared-utils` now exports `multiplyScaled` and `divideRoundHalfUp`, which already existed, so the conversion arithmetic reuses D-31's rounding instead of a second implementation; and `apps/web` gained a workspace dependency on `@sher/core-domain` (no npm package added) so the price switch and mixed read-back call the domain rather than doing arithmetic in a component, which B8 and R-C3 both forbid. `core-domain` is browser-safe by design for exactly this reason (§2.1, Phase 12). **Defect found at acceptance and fixed: the browser could not save anything.** `main.ts` allowed only `content-type` and `authorization` through CORS, but the web client also sends `idempotency-key` on every create — it is the transport for `operation_id` (§5.26, R-D3, UI-34). A header missing from that list is not refused with a status anyone can read: the browser blocks the request before it is sent, so the screen showed `NETWORK_UNREACHABLE` and the server logged nothing, because nothing arrived. Product create had been unusable from the real UI since path 2.2, and party create would have been too. **Every integration test passed throughout**, because supertest speaks HTTP directly and never preflights — this is precisely the gap S2 names, and the reason a module is not done when its backend compiles. The allowed-header list now lives in `apps/api/src/common/cors.ts` so `main.ts` and the regression test assert the **same** object; a second copy would have proved nothing. `cors.spec.ts` (3 cases) was verified to fail when the header is removed and pass when it is restored, the same discipline Phase 0 applies to the boundary checker. |
| 3 | Inventory core (Gate G2) | IN PROGRESS | — | — | **Started 2026-08-19. Path 3.1 — the posting kernel domain — is the only part built.** §2.4's closed account list and the balanced-entry rule now exist as pure domain code with 14 tests; nothing posts through them yet. **Journal lines are signed, not debit/credit column pairs.** §2.4 calls them signed journal lines and defines Debit/Credit, Cash In/Out and পাবো/দিব as display mappings over the same rows, so one signed amount is the honest storage and INV-01 becomes literally "the lines sum to zero"; two columns would let a line be both or neither, and every reader would subtract them anyway. A zero line is refused rather than ignored — it is a dropped amount or an unfilled placeholder, and once posted it is indistinguishable from a real line worth nothing. `AR`, `AP`, `CUSTOMER_ADVANCE` and `VENDOR_PAYABLE` lines are refused without a `party_id`, because INV-06 makes a party's balance the sum of their lines and one without a party would count towards the control account while appearing on no statement — precisely the drift INV-06 exists to catch. `OWNER_CURRENT_ACCOUNT` deliberately does **not** require one: §2.4 wants the party there so an owner statement can be produced, but a single-owner shop that never files the owner as a party is normal, and refusing its cash injection would stop real work over a reporting nicety. `reverseEntry` negates every line rather than rewriting the original, so §2.5's edit/void rule and INV-08 hold by construction instead of by a cleanup routine that might miss a line. The account list is enforced as **closed**: a code is a branded type obtainable only through `fixedAccount`/`parameterisedAccount`, and an id may not contain the `:` separator — `EXPENSE:transport:extra` is refused, since otherwise a report grouping by account would silently split one expense category in two. **Remaining in this module:** locations, `stock_movements`, `inventory_lots`, `lot_consumptions`, `cost_adjustments`, `product_cost_state`, the FIFO/AVERAGE services (DR13.1–DR13.12), valuation, negative-stock policy, opening stock and its CSV step, and the stock/lot/movement screens. **Onboarding depends on this module and Phase 4** — see the 2026-08-19 change-log entry on opening balances. **Paths 3.2 and 3.3 followed** (locations, `stock_openings`, `inventory_lots`, `stock_movements`, `journal_entries`/`journal_lines`, `product_cost_state`, `lot_consumptions`, `cost_adjustments`; migrations 0012 and 0013), giving opening stock end to end with lot drill-down and method-aware valuation. |
| 3.4 | Products & Stock working hub — stock adjustment, merged product/stock UI, Inventory Report | CODE COMPLETE | — | DONE | **Implements the 2026-08-20 owner decisions** (see the four change-log entries of that date). **`STOCK_ADJUSTMENT` added to §2.4's closed account list** — raised as an R-H stop rather than decided by the agent, because a stock correction moves `INVENTORY` and no account on the closed list could take the other side; it is deliberately shaped like `CASH_SHORT_OVER`, for the same reason that one was added. **Stock adjustment (migration 0014, Class B document, write class T).** Signed quantity, closed reason list `DAMAGE | RECOUNT | THEFT_LOSS | OTHER` with a note mandatory for `OTHER`, optional business date, full ten-step path in one transaction. **The journal amount is the exact change in inventory value, not the quantity re-multiplied by a cost:** an increase is worth what the new lot adds to the valuation, a decrease is worth what the consumed lots stop contributing (each lot's before-value minus its after-value). Multiplying and rounding separately leaves a poisha behind at every rounding boundary, and INV-05 — valuation equals the `INVENTORY` account to the poisha — is precisely the invariant that would then fail; `STOCK_ADJUSTMENT` absorbs exactly what `INVENTORY` moved, so INV-01 and INV-05 both hold by construction rather than by a rounding line somebody has to remember. A decrease consumes lots through the same FIFO/FEFO ordering a sale will, writing `lot_consumptions` and closing a lot at zero (DR13.11) — **no lot is ever written with a negative remaining quantity**, which is where the reference build was wrong. **Removing more than is in stock is refused**, naming the quantity held: `negative_stock_policy` governs *selling* more than you have (§5.7), a real counter situation, whereas writing off damage that does not exist is a typo; the negative-stock path and its `NEGATIVE_STOCK_TRUE_UP` arrive with POS. **Products and per-product inventory merged into one hub.** `ProductFormPage` was split into `ProductForm` (the form) and a thin route wrapper, so the dialog on the list and `/products/:id` render the **same** component — one form, one validation set, one save path, and the route stays for UI-13's bookmarkable screen. The `⋯` row menu carries Edit, Stock, Lots, Deactivate and Delete, each a modal over the list; unpermitted actions are absent, not disabled. **`Delete` follows §3.6:** `assertNeverUsed` — which Phase 2 left as a placeholder with a comment telling each later module to add its count — now asks `productHasStockHistory` inside the transaction, and a product with any movement is refused and directed to Deactivate. The row menu hides `Delete` for such a product, from a `hasStockHistory` flag the read model supplies; the server refuses it either way. **Stock Qty and Stock Value are read-model columns** (§5.5), method-aware: FIFO sums each lot rounded once (the same arithmetic `GetValuationService` does, in integer SQL with no floating point), AVERAGE uses quantity × moving average — sending the wrong basis would put a figure on the list that disagrees with the valuation report over the same stock, which INV-10 calls a blocking defect. Stock **value** is omitted without `inventory.cost.view` like `purchasePriceMinor`; stock **quantity** is not a cost and stays. **`/inventory` becomes `/inventory-report`** (the old path redirects, so a bookmark does not 404) with eight sections: Stock Overview, Low Stock, Stock Lots, Stock Movements, Damaged & Written-off, Expiry, Cost Adjustments and Valuation. The movement source drill-down (§5.20's "Why?") was preserved rather than dropped in the move. **Defect caught by its own test:** `SUM` over `BIGINT` is `int8`, which node-postgres returns as **text**, so the new stock-value column arrived in the JSON body as `"100000"` rather than `100000` — a money figure that would have become `NaN` in the next arithmetic. It is now converted once with the safe-integer range checked. **Tests:** 12 new domain cases for the adjustment posting, 9 new API cases (exact numbers: opening 10 @ ৳100.00 → remove 3 → 7 on hand and ৳300.00 to `STOCK_ADJUSTMENT`, valuation and the `INVENTORY` account both ৳700.00; add 5 → ৳500.00 the other way, both ৳1,500.00), plus idempotency, over-removal refusal, cost masking and cross-tenant 404; the web suites for the row menu, the §3.6 delete rule and the report. **Not implemented:** negative-stock adjustment and its true-up (arrives with POS), a zero-cost product cannot be adjusted (`openingStockPosting` refuses the same case — the entry would have to balance to nothing and INV-09 would fail), and stock reconciliation's guided physical count (§5.13) remains its own module. |
| 3.5 | Golden invariant harness — INV-01…INV-05 asserted on every stock and money posting, under both costing methods | CODE COMPLETE | — | DONE | **§3.11 said these are asserted on every commit touching money or stock, and nothing was asserting them.** Individual tests checked the numbers they happened to care about; none would have noticed a lot quietly ceasing to agree with the movements behind it, or a valuation drifting a poisha from the `INVENTORY` account. `assertGoldenInvariants` now recomputes all five from `stock_movements`, `inventory_lots`, `journal_lines` and `product_cost_state` and is called from an `afterEach` in every spec that posts stock or money, so a path added later is covered the moment its test is written. **It reads through RLS, as a tenant** — an invariant proven with the owner's bypass would say nothing about what the application can actually see. It borrows `stockValueMinor` from the domain and nothing else: rounding is the rule under test, and reimplementing it in SQL would only prove that two roundings agree with each other. INV-04 counts vendor lots, because DR13.10 excludes consignment goods from *value*, never from quantity. **Three tests corrupt the database behind the services' backs** — a lot that no longer adds up, a movement that no longer matches the stock on hand, an extra journal line — and require the harness to catch each; a harness that has never failed proves nothing, which is the same reason §6.1 makes Phase 0 demonstrate the boundary checker catching a violation. Scenario runs twice, once per costing method: opening 10 @ ৳100.00, opening 7 @ ৳33.33 (a price chosen so ৳233.31 only comes out right if the rounding does), a found-stock increase of 5, then a decrease of 12 that empties and closes the opening lot and takes 2 from the next — valuation and the `INVENTORY` account both ৳533.31 under FIFO and under AVERAGE. **Not implemented:** two live lots at *different* costs, and therefore the multi-cost FIFO ladder of §5.11's manual scenarios 1 and 2. An adjustment increase takes its cost from the moving average, so every lot a shop can create today is worth what its other stock is worth; those scenarios need a purchase document and are added to this file when Phase 5 provides one. Owner decision of 2026-08-21, recorded in the change log. |
| 2.4 · 3.6 | Guided CSV import — products, customers, suppliers and opening stock | CODE COMPLETE | — | — | **One importer with three callers, closing Phase 2's guided import and Phase 3's opening-stock CSV step together**, in the order the 2026-08-21 change log set. **It creates nothing itself.** Every row goes through the use case that already owns that record — `ManageProductsService`, `ManagePartiesService`, `ManageInventoryService` — so an imported product obeys the same validation, permissions, audit and outbox rules as one typed into the form, and an imported opening quantity becomes a real stock movement with a real journal entry behind it. §5.6 is explicit that "an import must never write balances or stock directly", and INV-02 and INV-05 would break the moment it did. **The whole file is one transaction (R-D5), which is what all-or-nothing means.** The three owning services therefore gained one inside-transaction method each (`createWithin`, `recordOpeningWithin`), called by their own public `create` and by the importer — calling the public method once per row would commit each row separately, and a file that half-posted is the state a migration must never end in. Idempotency stayed with the caller: a form is idempotent on its own row, an import on the whole file. **Every row is evaluated before any row is written**, so a file with a problem on its last line never leaves its first line behind — the refusal happens before the first insert rather than relying on the rollback, and the shopkeeper is told which rows to fix. The preview runs the identical evaluation and writes nothing; a row that previews clean is a row that will post. **The file's shape is pure domain code** (`core-domain/import/`): a CSV reader that handles what Excel actually writes — a byte-order mark, `\r\n`, quoted commas and newlines, doubled quotes — and one closed column template per file type, with cells read through the existing `parseMoney`/`parseQty`, so a price typed into a spreadsheet is read by the same rule as a price typed into the form and a third decimal is refused rather than rounded away (R-C3). **Row numbers are the spreadsheet's own**: a blank line is dropped without renumbering the rows after it, because the whole value of a preview is "row 14 is wrong" being a sentence someone can act on. **No migration and no new permission code.** The importer is a caller of `catalog.product.create`, `party.customer.create` and `party.supplier.create`; a role that may not create the record may not import it, and the type is absent from the screen rather than offered and refused (UI-09). One repository method was added — `findIdsByName` — because an opening-stock file names a product rather than carrying its id, and it returns **every** match rather than the first: §5.5 lets two products share a name, and picking one would open stock against the wrong item, so the row is refused asking for its Product Code. **In-file duplicates are caught in the preview** (a repeated product code, barcode or customer phone, a product opened twice), naming the earlier row — the database would catch them only once the first row had been written, and D-02's uniqueness index cannot see two rows of a file that does not exist yet. **Exact numbers verified:** ৳100.00 and ৳550.50 purchase prices import as `10000` and `55050` poisha with reorder levels `10000` and `5000`; 10 units opened with no cost in the file are valued at the product's ৳100.00 = ৳1,000.00, 5 units with ৳60.00 stated in the file over a ৳50.00 product are ৳300.00, valuation totals ৳1,300.00 and the `INVENTORY` account agrees to the poisha (INV-05). A file naming an unknown unit, an unknown product or a repeated key creates nothing at all, asserted by counting what exists after the refusal rather than by trusting the status code. The golden invariants run after every case in the suite. **Assumptions stated for the owner, and recorded in the change log:** unknown units, brands, categories and customer groups are refused rather than created; the `Location` column §5.6 names is absent while one location exists; a blank `Unit Cost` values an opening at the product's purchase price; and a file is capped at 2,000 rows. **Not implemented:** opening receivables, payables and cash/bank balances (Phase 4's posting services), product offers, expiry, serial tracking and unit conversion as columns (each is behind its own §5.21 feature and belongs on the product's own screen, where a shopkeeper can see what they are switching on), and updating existing records — every row creates, and a row that clashes with something already there is refused rather than overwriting it. **Risk noticed:** the preview is a POST, so a deployment in D-36's `READ_ONLY` licence state refuses it with the "cannot be saved" message even though it writes nothing. The outcome is right — no import is possible in that state — but the wording is about saving, not previewing. |
| 2.5 | Parties working hub — balance and statement from the journal, opening balances set and corrected | CODE COMPLETE | 9c259a5 + this commit | — | **Closes the deferrals path 2.3 left behind**, now that Phase 3's posting kernel exists to carry them. Two commits: `9c259a5` added migration 0015 (`party_openings`, and the partial `journal_lines (tenant_id, party_id, created_at, id) WHERE party_id IS NOT NULL` index every balance and statement rests on), the opening balance on the create form, the balance on the list row, the summary tiles and the full statement; this one turns the party into the working hub §5.6 describes. **No migration in this increment.** **There is still no stored balance.** INV-06 makes a party's balance the sum of their journal lines, and `balanceNetMinor` is a correlated subquery in the same statement as the row, so the list, the tiles, the hub header and the statement are the same number rather than four copies that drift. `balance` also became a **sort key**, ordered by that same subquery — "who owes me most" is the first question anyone asks of a customer list, and the alternative is exporting the page and sorting it by hand. **An opening balance can now be set after the fact.** §5.6 puts the figure on the create form, and a shop onboarding a hundred customers will miss it on some of them; the alternative was deleting the party and re-adding it, which stops being possible the moment anything posts against them. Nothing new posts here — `setOpening` is the same `postOpening` the create form goes through (same document, journal entry, period guard, numbering, audit, outbox), reached from a second entry point, and 0015's `UNIQUE (tenant_id, party_id, role)` is what makes it *set* rather than a silent second balance. **A posted opening is corrected, never edited (§2.5).** The original journal lines stay exactly where they are and one four-line entry reverses them and posts the new figure, so the statement reads `opened at 3,000 · corrected −3,000 · +2,500` and a shopkeeper who wonders why a balance moved can see it. One entry rather than two, because `journal_entries_source_unique` is on (tenant, source type, source id) and a correction is one document event. The **document** does take the new figure and gains `CORRECTED` as its entry mode — 0015 holds one opening per party per role, because a second row is not a correction but a doubled balance — so history lives in the journal, where it belongs, and the document keeps saying what the opening currently is. Corrections are numbered `OBC-<year>-<seq>`: the series name becomes the number's prefix and `OPENING_BALANCE_CORRECTION-2026-000001` was wide enough on its own to push a printed statement into a horizontal scroll. D-32's version is carried through the dialog, so two people correcting the same opening means the second is told rather than silently winning, and **both** business dates are period-guarded — moving an opening *out* of a closed period changes that period as much as posting into it, and a correction that checked only its destination could quietly empty a month already reported on. **`assertNeverUsed` stopped being a stub.** Path 2.3 left it a no-op with a comment telling each later module to add its count; openings made a party something the journal can point at, so deleting one left lines pointing at a row that no longer existed — INV-06 false in the one direction nothing checks. The test is `hasLedgerEntries`, computed in the same query as the row, and deliberately **not** a settled balance: a customer who owed 500 and paid it nets to zero and still has a statement worth keeping. The `⋯` menu and the server therefore answer the same question about the same party, and the server refuses either way. **`/api/v1/me` now returns `features`.** The shell has to decide whether Vendors and Customer Groups exist at all before it can draw itself (§5.6 — absent while the feature is off, not disabled), and a cashier who may not open Settings still needs a correct sidebar. Read through `effectiveSettings` rather than off the stored rows, so a setting nobody has touched reports its catalogue default instead of vanishing; like `permissions` it decides nothing, because every endpoint re-checks its own gate. **The party ledgers left `planned`** and became contextual leaves on the hub with no route of their own — a ledger is not a destination, it opens from the party, exactly as stock adjustment opens from a product (UI-56). **Recorded deviation, owner decision 2026-08-22:** the hub's Receive Payment / New Sale / Pay Supplier / New Purchase actions are shown **disabled with a tooltip naming the phase they arrive in**, where UI-09 and §5.6 would leave an unimplemented action absent. A statement prints through the browser's own print dialog over a print stylesheet rather than a PDF dependency — what a shop does with a statement is hand it over or photograph it, and the page already holds every figure. **Gates, run once on the finished module:** lint clean · typecheck clean across 8 projects · `Boundaries OK — no layering violations` · 305 API + 191 web + 137 domain + 83 shared-utils tests passing, 65 files, none skipped. **Not implemented:** receiving or paying against the balance (Phase 4's cash and bank accounts, then Purchases and Sales), voiding an opening rather than correcting it (§2.5's void path has no caller yet), the sales/purchase/return history tabs of the profile (no documents exist to list), and D-04's `EXPENSE` and `EMPLOYEE` roles, still unoffered because no module defines what they mean. **Risk noticed:** the balance subquery is per row, so a 200-row page is 200 index lookups. The partial index makes that affordable now; a shop with years of history should be re-measured before the page size grows. |

| 5.1 | Purchasing — buy → stock → supplier due → pay | CODE COMPLETE | — | — | **The first closed money loop.** Migration 0017 adds `purchases`, `purchase_lines`, `supplier_payments` and `payment_allocations`, plus the three permission codes `purchase.bill.view` / `purchase.bill.create` / `purchase.payment.record` (backfilled: 165 permissions across 15 existing tenants). **There is no outstanding column anywhere.** What a bill still owes is `grand_total − paid_minor − Σ allocations`, computed in the same statement as the row it belongs to, so the list, its tiles, the bill's own screen and the Pay Supplier dialog are four readings of one expression — the same argument migration 0015 made for a party balance and 0016 for an account balance. **The bill discount and the extra cost are spread over the lines by value** (§3.3 largest remainder) into each lot's `actual_unit_cost`, so van fare lands on the shelf rather than in this month's expenses: the goods have not been sold yet. There is deliberately no purchase-discount account — §2.4's closed list has none, and a discount is simply a lower cost of goods. **`ROUNDING` carries the remainder.** A unit cost is rounded once to scale 4, so `Σ qty × cost` need not come back to the exact taka on the bill; the difference posts to `ROUNDING` rather than being folded into `INVENTORY`, because INV-05 requires the `INVENTORY` account to equal a valuation computed from those same rounded lot costs. **Two entry points, one payment use case** (owner decision): `Pay Supplier` is the large primary action on the supplier's hub and settles their oldest bills first; `Pay this bill` is the small secondary action on a purchase and is the same call with one bill named. Allocation moves no money — §5.9's "application changes allocation only" is why `payment_allocations` is a table of links. **Assumptions stated for the owner:** a purchase refreshes the product's purchase price silently and never touches the selling price, warning instead when the new cost has caught up with it; over-paying a supplier is refused rather than becoming a credit, because the screens that spend a credit are the next build; a supplier must hold the SUPPLIER role and be active; and expiry on a purchase line is optional even for a tracked product (owner decision), which is safe while nothing passes `expiryTracked` to `costIssue` and must be revisited when FEFO ships. **Not built in this slice:** void/reversal, editing a posted purchase, supplier credit application, ageing buckets, purchase returns and Purchase Orders. |

| 6.1 | Sales & POS — sell → stock out → invoice → money in → customer ledger | CODE COMPLETE | — | — | **The cycle closes.** Migrations 0018–0022: `sales`, `sale_lines`, `sale_payments`, `customer_receipts`, `receipt_allocations`, `invoice_presentation` (+ per-line labels), `invoice_settings`, `quotations`/`sales_orders`, `product_group_prices`, a product thumbnail, and the invoice's own identity block. Ten permission codes; 390 backfilled across 15 tenants. **There is no outstanding column anywhere** — an invoice's due is `grand_total − paid_minor − Σ allocations`, computed in the same statement as the row, exactly as 0015, 0016 and 0017 argued for a party, an account and a bill. **The POS runs the server's own arithmetic.** `saleTotals` is a domain function called from the browser on every keystroke and from the posting service on every save, because the owner's binding rule is that no figure waits for a round trip and two implementations of one rounding rule is how a poisha goes missing. Nothing the screen computes is ever posted: the server recomputes from the lines (DR13.12). **Guest accounting is §5.8 exactly** — a fully paid sale stays on the walk-in party and creates nobody; the moment it leaves a due or an advance the customer is created **inside the same transaction** through `ManagePartiesService.createWithin`, so an invoice's customer obeys the same validation, D-02 phone rule, permissions and audit as one typed into the form. **Cancellation is a reversal built from the entry that was posted**, read back from the journal rather than recomputed — costs move, and a sale cancelled a week later at today's average would leave COGS and INVENTORY holding a difference nobody sold anything to create. Both business dates are period-guarded. **Owner decisions taken in the question round (2026-08-25):** full Phase 6 scope in one module; the POS layout the owner drew (scan bar, grid left, cart right); one Received box with a Split link and one row per real account; due date optional; the cash-day rule per payment row; Complete Sale opens an invoice preview whose **display-only** fields are editable (§5.8's cosmetic layer, structurally unable to reach a figure); wholesale and dealer pricing built but off by default; share as a JPG through the print renderer; two templates plus a full design screen; receive money from both the customer hub and one invoice through one service; one optional product picture, resized in the browser; the day strip in day language, not "session"; the eye reveals the product's purchase price for 1.2s; vendor sourcing at the till. **Defects found and fixed during acceptance:** FEFO refused a sale when any lot lacked an expiry date — the risk Phase 5 recorded when expiry was made optional — so a product falls back to FIFO unless **every** open lot is dated; PrimeVue's `InputNumber` commits on blur, so every total lagged a keystroke behind until `AmountInput` was written; figures were reactive within a screen but not across screens, so a posted sale left Money Accounts stale until reload — every non-GET now raises one signal and every journal-derived screen re-reads itself; Vendor Sourcing was offered while `vendor_consignment_enabled` was off, against UI-09. **Verified on the running app, against the owner's own data:** every journal entry balances to zero; `INVENTORY` ৳24,476 = owned-lot valuation ৳24,476 (INV-05); the `AR` control account reconciles line by line — openings ৳33,000, sales ৳1,050, cancellation −৳490, receipts −৳320 — leaving ৳240, exactly the sum of unpaid invoices (INV-06); `COGS` ৳544 = Σ sale line cost; `SALES` ৳560 = Σ grand totals; cached stock equals its open lots for every product. Lint clean · boundaries clean · typecheck clean across 8 projects. **Not built:** sales returns and refunds (Phase 7, the owner's rule for them recorded), serial/warranty capture (Phase 8), and the ভ্যাট line the owner's reference invoice shows — D-09 removed VAT from V1 and printing a tax the system never calculated would be a lie on a document. |

| 7.1 | Corrections and adjustments — sales return, purchase return, purchase edit and void, expenses, stock count, backdating, period close | CODE COMPLETE | f158eba · 67a7266 · 5b8f354 · 31b8f5e · bd00dfb · 943c36c | — | **Everything that undoes or corrects something, plus Phase 5's two leftovers.** Migrations 0027–0030: `sales_returns`, `purchase_returns`, `expenses` + `expense_categories`, `stock_counts`, and two refund-cap columns on `roles`. Eleven permission codes; 525 backfilled across 15 tenants, plus 105 seeded expense categories. **A return is always against its document** (owner decision 2026-08-26): the quantity cap is what that invoice sold minus what has already come back — computed from the lines, never stored, the same argument 0015 makes for a party balance and 0017 for a bill's outstanding. The value is what the customer actually paid, apportioned by quantity with the **last returnable unit carrying the remainder**, so a line returned in full gives back exactly what was charged; the cost is the cost that left, read from the lots the sale consumed, because a return re-costed at today's average would leave `COGS` and `INVENTORY` holding a difference nobody created. Goods go back into **the lots they came out of**, newest consumption first. **The purchase return's asymmetry is the accounting decision of this module:** stock leaves at `actual_unit_cost`, which carries that line's share of the extra cost, while the supplier credits only what they billed — the difference is transport already spent on goods the shop no longer owns, and it posts to `STOCK_ADJUSTMENT` because it cannot stay in `INVENTORY` (INV-05 compares that account against a valuation of what is left) and cannot be charged to a supplier who never received it. Its second cap is the lot: goods already sold cannot be sent back, and the refusal says exactly that. **How much cash a return may hand back is a number on the role, not a permission** (owner decision): a per-return cap and a per-day cap, `null` unlimited, `0` a role that may take returns and never open the drawer; over either, a senior PIN is checked against the same hash a login checks and only ever compared against somebody whose own role could have approved it, with the approver stored on the return. Cashier ships at ৳5,000/৳10,000. **A posted purchase is corrected by reversal, never edited:** `CreatePurchaseService` gained `correctionOf`, so the correction is the create path — one purchase writer — reversing the original inside the same transaction and re-posting under the **same number** with entry mode `CORRECTED`; refused once any of the bill's lots has been drawn down, and later payments follow the number onto the replacement. Reversing a receipt **un-makes the average it created**, not just the quantity. **The stock count posts no stock of its own:** every difference goes through `adjustStockWithin`, the same use case the Stock Adjustment dialog calls (§5.13 forbids a reconciliation writing stock directly), which is why `ManageInventoryService` gained an inside-transaction method — the split the importer made with `createWithin`, for the same all-or-nothing reason (R-D5). Differences are recomputed against **live** stock at posting time and anything that moved is named for recount rather than silently corrected. **An expense's category is half its account code** (`EXPENSE:RENT`), derived once and frozen, so a month's rent is a balance rather than a filter. **Closed is final** — recorded deviation from this table's "controlled unlock" wording: there is no reopen method and no unlock endpoint, a correction posts in the open month, and the current month cannot be closed. **Owner decisions taken in the question round (2026-08-26):** returns start from the document and are read from their own history pages; refund or credit chosen per return with the credit clearing that document first; no good/damaged choice on the return screen (damage stays with Stock Adjustment); one permission per action; a short reason list plus an optional note; SR/PR/EXP/SC as separate short series; expenses on their own page with a compact Add dialog; count differences computed at posting time; surplus at current average cost; backdating behind its own permission with a required reason and the entry timestamp preserved. **Also settled this module:** the binding UI rule that every one-task action is the same compact modal, and the owner's instruction that the existing test suites are run once when a module is finished. **Gates, run once on the finished module:** lint clean · typecheck clean across 8 projects · `Boundaries OK — no layering violations` · web 191/191. **Guard tests brought up to date** (maintenance, not new tests): the navigation route list had been missing `/pos`, `/sales` and `/settings/invoice-design` since Phase 6, and the `sales` category assertion still claimed that category never resolves. **Not implemented:** voiding a return, editing a posted expense, partial receipt of a purchase return, ageing buckets, and supplier credit application — the last of Phase 5's leftovers. |
| 8.1 | Purchasing extras — purchase planner, supplier orders, landed cost, serial capture, warranty claims, vendor consignment stock | CODE COMPLETE | — | — | **The five things Phase 8 names, plus the Purchase Planner the owner specified on top of them.** Migrations 0031–0034: `purchase_plans` + `purchase_plan_lines` + `supplier_purchase_orders` + `supplier_purchase_order_lines`, `purchase_landed_costs`, `inventory_units`, `warranty_claims` + `vendor_stock_receipts` + `vendor_stock_returns`; columns `products.usual_supplier_id / min_order_qty / warranty_months / supplier_warranty_months`, `purchase_lines.plan_line_id / supplier_warranty_months`. Five permission codes, 270 backfilled across 15 tenants; two new settings (`planner_look_back_days`, `planner_cover_days`). **The suggestion is hybrid by owner decision:** average daily sales × target cover days, less sellable stock and less what is already on order, but only once a product has sold on **three separate days** in the window — one wholesale sale of fifty is one day of demand, and treating it as a rate would order hundreds; anything thinner falls back to the reorder level the shopkeeper already set. Sellable stock excludes expired lots and vendor-owned ones. Suggestions round **up** to the product's existing conversion pack and to an optional Minimum Order Qty; a budget funds Critical → High → Medium → Low in full to the cutoff and part-funds the next line, rounding **down** so it stays inside the money, with skipped rows visible at zero. Priority is days-of-cover against the shop's own target — a quarter of it is Critical, half is High — with the biggest earners first inside a band. **Fulfilment and plan status are derived, never counted:** `plan_line_id` on a purchase line makes "how much has arrived" a SUM over posted bills, so voiding one makes the plan right again with nothing to unwind. **The supplier's copy carries no money field at all** — not hidden, absent from the response type — so no print template can grow one; it is snapshotted when sent, because editing the plan afterwards must never change a paper somebody is holding. **A landed cost arriving after the goods is the module's one hard accounting decision** (owner chose it knowingly over the simpler option): each line's share is split by what is left of its lot, the unsold part raises `actual_unit_cost` and the sold part goes to `COGS`, `INVENTORY` is debited by what the valuation **actually** moved with the remainder to `ROUNDING` (INV-05 requires the account to equal the valuation exactly), and it is dated **the day it is recorded** — backdating it would mean rewriting a period that may be closed. **Warranty implements no accounting of its own,** literally: a replacement from own stock runs through `adjustStockWithin` with a new optional `counterAccount` on `stockAdjustmentPosting` pointing at `WARRANTY_EXPENSE`, and a supplier settlement credits it back; **no warranty receivable is ever created** (§5.19), so net warranty cost is that account's balance. **Vendor stock posts nothing in either direction** — the lot is `owner_type='VENDOR'`, and the payable is still created by the sale's deemed purchase (DR13.10), which already existed. **Owner simplifications taken before coding (2026-08-26):** eleven claim statuses became six plus a settlement type; Direct-Shop-vs-Courier became a field, not a second workflow; Supplier Warranty Send, unit-barcode generation, label printing and tenant-added landed-cost categories were all cut as complexity without present value; twelve planned permission codes became five. **Gates, run once on the finished module:** lint clean · typecheck clean across 8 projects · `Boundaries OK — no layering violations` (this also fixed a pre-existing `new Date()` violation in `manage-inventory-service` by moving `addDays` into `shared-utils/clock.ts`, the one file R-C8 allows) · suites re-run. **Guard test brought up to date** (maintenance): `navigation-architecture.spec.ts` gained the `inventory.warranty` subcategory and the three new routes. **Not implemented:** landed-cost lines typed *on* the New Purchase form (the box there is still the single extra cost; named lines are added from the posted bill), serial selection at the POS and consumption of received vendor lots at the till, and a vendor settlement panel on the party hub. |
| 8.2 | Purchase Planner rework, and the owner's first pass over Phase 8 | IN PROGRESS | — | — | **Driven by the owner on 2026-08-26 and reworked against what he found.** Migration 0035: `purchase_plans.status/notes/decided_at/decided_by`, `supplier_purchase_orders.status/purchase_id`, `purchases.supplier_order_id`. **The planner's flow was the real defect** — the first cut auto-loaded, had no explicit quantity step, and the owner could not tell how to begin. It is now one page with three tabs and a sequence you can see: set four numbers → **Analyze Stock** → tick **Use** and set **Planned Qty** (or press **Use All Suggested** / **Auto Fit Budget**) → **Save Plan** → **Approve** → the supplier orders fall out of approving → **View** an order to print/PDF/share, or **Convert** it into a fully editable New Purchase. **"Send" is gone entirely** (owner: *"no need to send, I save or print plan as pdf or whatsapp share"*): approving is what creates the orders, nothing is transmitted, and so no order carries a sent-at or a delivery state. A plan is `DRAFT → APPROVED|REJECTED` — a stored decision, replacing a status derived from what had been bought, which answered a question nobody was asking. Fulfilment stays derived. **Bugs the owner found, and what each really was:** a **negative cash drawer** that then could not be closed — the drawer had paid out ৳115,030.73 it never held, because `resolvePaymentAccount` checked the account, the permission and the open day but never the balance; now guarded on the five outflow paths only (a receipt must not be refused because the drawer is empty, and a bank may be overdrawn). **Dropdowns reopening after a pick** — diagnosed wrongly the first time as a `watch` writing back into the bound ref (a real bug, fixed), then correctly: an option whose **value is `null`** cannot be matched by PrimeVue, so the control drew blank and reopened; sentinels now, converted back at the request edge. **Two 500s from raw SQL** naming columns that do not exist (`purchases.number`, `purchase_lines.location_id`) — found by checking every Phase 8 query against `information_schema` rather than one at a time. **The Months screen** looked broken because the current month has no Close button by design; it now says why. **Owner UI rules settled here, binding beyond this module:** quantities are drawn `12`, not `12.000` — `qtyText`/`formatForDisplay`, at most two decimals, trailing zeros trimmed, storage form untouched; Bangla helper text sits **under** the English label on these screens; `Add New Product` opens a D-39 inline modal asking only §5.5's mandatory fields rather than navigating away and losing the plan. **Gates:** lint clean · typecheck clean · `Boundaries OK` · suites last run green at 8.1 (305 API · 191 web · 137 domain · 83 shared-utils) and **not re-run since this rework**. **Still open:** landed-cost lines typed on the New Purchase form; serial selection at the POS and the till consuming received vendor lots; a vendor settlement panel on the party hub; the rest of the app still puts Bangla beside rather than under the label (owner to decide whether to make it consistent). |

| 9.1 | Reporting, dashboard and Daybook — the four report screens, Why drill-down, the fixed dashboard cards, the monthly target, and Daybook with its day-end print | CODE COMPLETE | — | — | **Gate G4's module: do reports match reality?** Migration 0036 adds three tables and **not one of them holds a business figure** — `profit_targets` (what the owner typed), `daybook_review_marks` (that a day was checked), `daybook_prints` (that a day was printed, with the totals it showed). Every number on every screen is read from `journal_entries`, `journal_lines` and `stock_movements` at request time (INV-10); a reporting table holding a total would be the first thing to disagree with the ledger. Twelve permission codes, 555 backfilled across 15 tenants. **The ageing decision is the accounting one:** ageing is built from the **control account's own lines**, settling each party's credits against their oldest debits, rather than from invoices — so openings, sales, returns, receipts and payments all age by one rule without ageing knowing they exist, and the rows sum to `AR`/`AP` **by construction**. Verified on the owner's data: customer dues ৳176,518 = the `AR` control account exactly, `reconciled: true`, and the screen shows the difference rather than hiding it when there is one. Age is counted from the **document date** in 0–30 · 31–60 · 61–90 · 90+ buckets (owner decision), because Phase 5 made the due date optional and ageing from it would put two equally old amounts in different buckets; overdue stays a separate flag on the rows that named a day. **Where documents are read at all, and why it is still INV-10:** the journal has no product, brand or category column, so the groupings that need those dimensions read the sale and purchase lines that produced those journal lines — money from the ledger, dimensions from the documents, and the two comparable. **O-10 is closed** (owner decision): one target per month for the whole shop, typed, with a **run-rate projection** that is never stored, never added into a posted total, and always labelled an estimate. **Owner decisions taken in the question round (2026-08-30):** all three pieces in one module; few screens with many filters rather than 25 report entries; preset date buttons with This Month selected; Why? as a dialog; print/PDF/share **plus** CSV; a fixed permission-gated dashboard card set with no arrangement screen; performance metrics now and a manual monthly target with a run-rate projection; Daybook as money summary on top with one time-ordered list under it; row actions that open the owning module; A4 **and** 80mm with the print recorded; Mark as Checked with a note; one permission per report screen plus profit, target and dashboard; the new screens Bangla-under-English with the app-wide sweep as its own later pass; and the Phase 3 Inventory Report **folded into** the Stock report rather than a second screen answering the same question — `/reports/stock` redirects to it, and it grew cost-of-goods-sold and margin-per-product, the two views the inventory endpoints cannot serve. **Daybook posts nothing and cannot**: it is constructed without a numbering service, an outbox or an idempotency store, and its row menu is built from server-decided capability flags, because whether a document can still be corrected depends on the period lock, its status, what has been drawn from its lots and the user's permissions. **Gates:** lint clean · typecheck clean across 8 projects · `Boundaries OK — no layering violations` · web 191/191 · domain 137/137 · shared-utils 83/83. **Guard tests brought up to date** (maintenance, not new tests): the navigation route list gained the four Phase 9 routes; the dashboard spec now mounts the cards endpoint the filled screen reads; and six stale `12.000`-style quantity expectations were corrected to the `12` form Phase 8.2's owner decision introduced. **Not implemented:** Edit and Delete from a Daybook row for the document types whose modules have no correction path yet — receipts, supplier payments, expenses, cash movements, stock adjustments and both kinds of return. Those rows say where the shop does it instead rather than offering a menu item the server cannot honour; building the missing writers is the owner's next call. |

| 9.2 | Corrections and cancellations — every posted document can be corrected or cancelled from the daybook and from its own screen | CODE COMPLETE | — | — | **What the owner asked for on 2026-08-30 — "in daybook module all transaction can edit/delete/update possible" — built the only way the accounting allows.** A posted document is never mutated and never row-deleted: **Edit** reverses what was posted and re-posts the corrected figures **under the same number** in one transaction, **Delete** posts one reversing entry and leaves the document standing, marked `VOIDED` with a compulsory reason. Both facts stay in the journal, which is the only way a shopkeeper can be shown what a figure used to be, that it was corrected, and what it became (§2.5). **The date rule is the owner's, and it is now binding on every correction path:** a correction to a month still open carries the original business date; a correction to a **closed** month posts **today** as a `PRIOR_PERIOD` adjustment carrying the date it belongs to, because a closed month may never be rewritten — not even to fix it; a cancellation always carries the day it was made. Any correction that cannot post on its own date requires a reason; a same-day one does not, because the before-and-after values are their own explanation. **Both halves of a correction land on the same day** — reversing on today and re-posting on the original date would leave one day showing both figures and another showing a negative nothing on it explains. **Seven new permission codes**, cancelling separated from recording per §5.26 (`sale.receipt.void`, `purchase.payment.void`, `expense.void`, `cash.movement.void`, `stock.adjustment.void`, `sales.return.void`, `purchase.return.void`); correcting rides on the code that recorded the document, so a cashier may fix the amount they typed but not undo yesterday's receipt. Owner and Manager hold all seven, Accountant the four money ones, Cashier none. **Four money documents share one reversal port** (expense, receipt, supplier payment, cash movement) because each posted exactly one balanced entry and moved no stock; **the three stock-bearing ones do not and must not** — a stock adjustment, a sales return and a purchase return each unwind lots and cost states from the **stored** figures, since an undo priced at today's average would leave `INVENTORY` disagreeing with the valuation (INV-05). **Two refusals that matter:** cancelling an increase whose stock has been sold, and cancelling a customer return whose goods have been sold again — in both cases the goods are not on the shelf to take back, and the message says exactly that. **Three defects found and fixed while building, two of them pre-existing:** (1) `journal_entries_source_unique` allowed a document exactly **one** journal entry, so **Phase 7's purchase correction would have failed the first time the owner used it** — migration 0038 replaces it with a partial index over original postings only, and makes document numbers unique among **live** rows so a corrected document can keep the number on the paper the shop filed; (2) **closing a month crashed** (`row.closedAt.toISOString is not a function`) because `closed_at` arrives as a string from a raw statement — the same class of bug fixed in the Phase 9.1 repositories, now fixed in `period-repository` too, which means Phase 7's period close worked for the first time here; (3) my own first cut guarded the **original** month as well as the posting month, which refused the very prior-period case the rule exists for — only the day a reversal actually posts on is guarded now. Migration 0037 adds `void_reason`, `correction_reason` and `original_business_date` to nine document tables; 0039 adds `PRIOR_PERIOD` to the entry-mode check on eight of them. **Not built: editing a posted invoice.** A sale has lines, and §2.5's answer for a document with lines is to cancel it and sell again — which is what the invoice screen already offers and what the daybook row now says. **Verified end to end against the running app, on the owner's own data:** 38 checks over every path — expense corrected twice then cancelled (net zero), cash movement corrected and cancelled (net zero), receipt corrected and cancelled with its allocations released so the invoices are owed again, supplier payment the same, a stock increase cancelled (quantity and average restored exactly, the lot it created closed at zero, `INVENTORY` net zero), a stock decrease cancelled (the goods back **in the very lots they came from**), a customer return cancelled (stock 33 → 32, the lot 14 → 13, `INVENTORY` down by precisely the cost that came in), a supplier return cancelled (the goods back into the lot they left, `AP` and `INVENTORY` net zero), and the closed-month rule proved on a scratch tenant: July closed, the correction refused without a reason, then accepted and posted on 30 August as `PRIOR_PERIOD` carrying 2026-07-15, **with nothing new posted into July**. Refusals proved: no reason, cancelling twice, a backdated correction without a reason. INV-01 (every entry balances) and INV-02/03 (cached stock equals its open lots, every product) green after the whole run. **Gates:** lint clean · typecheck clean across 8 projects · `Boundaries OK` · web 191/191 · domain 137/137 · shared-utils 83/83 · API suite re-run at the gate. **Still open:** editing a posted invoice; the daybook's Edit for receipts, payments, expenses and cash movements currently opens the module's own screen rather than an inline dialog on the daybook row itself; and Phase 7's `VoidPurchaseService` still guards the original month, so cancelling a bill dated in a closed month is refused where the new paths would allow it — one rule, two behaviours, and the owner's call which way to settle it. |

| 11.1 | Account reconciliation — the bank's PDF read, matched against the journal, and signed off | CODE COMPLETE | — | — | **Phase 11's module, and the first one whose main safety property is structural.** Migration 0039 adds four tables — `bank_statement_files` (the PDF, kept whole as evidence), `statement_lines` (that PDF parsed, working data), `account_reconciliations` (the sign-off) and `reconciliation_matches` (which of our rows is which of theirs). **They are the only tables this module can write.** The service is constructed without a posting service, a numbering service or a period guard, and the repository has no write path to `journal_entries`, `journal_lines` or any document table; the journal appears as three SELECTs. `Add Missing Entry`, `Correct` and `Void` open the owning module's own dialog with the bank's figures prefilled, and the owner presses that form's Save (UI-72). An API test exercises the whole module end to end and asserts the ledger row counts are bit for bit unchanged. **The statement is a PDF, not a CSV** (owner decision 2026-08-30): pdf.js extracts positioned text in `apps/api/src/infrastructure`, a pure parser in `core-domain` turns it into rows, and the owner reads an **editable preview** before anything is imported. A scan parses to nothing and falls back to matching by hand with the file kept as evidence; a file that will not open is refused, saying so. **Direction is read from the bank's own running balance**, not from column headings or keywords, and a row nothing establishes comes back as a problem rather than a guess. **Matching is deterministic, rule-based and explainable**: amount equal to the poisha and same direction are gates, reference and date decide confidence, description never suffices alone, an auto-match must also be unique on both sides, and every threshold sits in one `MATCH_RULES` constant. Cash is excluded — it is counted in Daily Cash (UI-71). Completion needs a zero difference and no loose ends, and freezes the links it certified; a later correction posts again, the stored posting count no longer agrees, and the reconciliation reads back `REVIEW_REQUIRED` without anything having written into it. Three permissions, 105 backfilled across 15 tenants. Tests: `matching.spec.ts`, `statement-parser.spec.ts` (which found two real parser defects — the leading date being read as money, and a partial parse reported as an unreadable scan), `reconciliation.spec.ts` and `reconciliation-pdf.spec.ts`. **Not in this slice:** the standalone Change Transaction Date action and the Counter surface. |

| 11.2 | Change Transaction Date, and the Counter surface — Phase 11's two leftovers | CODE COMPLETE | — | — | **Two things that had been named since Phase 9 and built by nobody.** *Change Transaction Date* is the standalone action §5.15 and D-43 describe: one use case behind Daybook, the party and account ledgers and the reconciliation compare screen (UI-72), reached through `POST /api/v1/corrections/transaction-date` and nowhere else. It is **append-only** (owner decision 2026-08-31): the standing posting is reversed **on the day it is leaving** and the same figures re-posted **on the day it is going to**, in one transaction under the same number — the one correction whose two halves land on different days, because here the two days *are* the change. `created_at` is never in a statement that writes. Scope is the four money vouchers `reverse-money-document.ts` already reverses; a sale or a purchase would have to move its stock movements and re-run cost layering, so those keep the date field in their own correction form. Four refusals, all in one pure `planRedate` the dialog and the server share: the same day, a future day, a day **before an invoice the money settles** (named in the message), and a day outside the session for money that went through a counted drawer — an expected closing is immutable once counted (§5.16.8). **A closed period is protected, not immutable**: everyone below the Owner is refused, and the Owner passes an acknowledged warning plus §5.3 step-up, expressed as a second permission `finance.transaction_date.change_locked` that no seeded role but the Owner holds. Any completed reconciliation that matched the document reads back `REVIEW_REQUIRED` on its own — the posting count it stored no longer agrees — and nothing is written into it. The ledger and Daybook show **one live row on the new date** with a `CORRECTED` badge saying *moved from 12 Aug — reason*; the reversal and the old posting stay in the journal. A reason is never blank and is normally one tap of four presets. Two permissions, 60 backfilled across 15 tenants; no migration — every voucher table already had `correction_reason` and `original_business_date`. **Counter** is the UI-53/D-42 surface: a launcher at `/counter` under `Daily`, six large actions each opening the dialog that already owns it, today's drawer figure and day state above, and the last few things entered today read from Daybook's own model so the same ৳500 is not entered twice. It owns no table and posts nothing. It appears for anyone holding **any** of its six permissions, and each button appears only under its own (UI-09). **Counter is English-primary with Bangla helper end to end** (owner decision 2026-08-31, amending UI-74/UI-75): the launcher and the dialogs it opens read in one register, so nothing switches language halfway through a task. Four dialogs were flipped — Start Day, End Day, Reopen Day, Move Money — and the other three the Counter reaches (Receive Payment, Pay Supplier, Record Expense) were already English-primary and were left alone. |

| 10.1 | Licence, backup and recovery — the business exported as one encrypted file, restored into an empty installation, and a licence that is finally visible and finally binding | CODE COMPLETE | — | — | **Phase 10, reshaped by the owner's decision of 2026-08-30 that V1 is a single-business installation product rather than a shared SaaS service.** SaaS signup, platform-operator tooling, central subscriptions and the SMS wallet are deferred; `tenant_id`, `TenantContext` and the tenant-scoped repository boundaries stay exactly as they are. Migration 0040 adds `backup_runs` and `restore_events`, and **neither holds a business figure** — the module posts nothing, numbers nothing and never touches a period. **The archive's table list is discovered from the database, never compiled in:** every table carrying a `tenant_id` is exported except an explicit exclusion list, so a module added next month is in the backup without anybody remembering to add it, and an API test asserts exactly that. Write order comes from `pg_constraint` at run time, with a legitimate cycle (a bill naming its supplier order, that order naming its bill) broken on a nullable column and filled by a second pass. **Forward migration is the import loop rather than a registry of hand-written steps:** a column this build dropped is skipped, a column it added takes its default, and a required column the archive cannot supply stops the restore by name. AES-256-GCM with a per-file salt and scrypt; the three failures — wrong password, damaged file, not an archive — are kept apart because they send a shopkeeper to three different places. **Restore refuses anywhere but an empty installation** and never deletes; Reset Business Data is the separate step, and it will not clear a row until a `pg_dump` has been taken *and read back*. `modules[]` finally bites, through the existing `Plan → Feature → Setting → Permission → Access` chain in one place — `PostgresAccessControl` — so an unlicensed module disappears from navigation when unused and goes read-only when it holds data, with no second rule written per screen. Four permissions, 60 backfilled across 15 tenants. The API refuses to boot when its schema version and the database's disagree, in **both** directions. Tests: `archive.spec.ts` and `backup.spec.ts`, the latter proving the gate itself — a shop with products and a customer is exported, the whole database destroyed, a fresh installation seeded, and the file restored into it, with the tenant id, the users, the credential hashes and every count coming back. **Not in this slice:** the SMS wallet and bKash top-up, and any platform-operator surface. |

Rows for Phase 2 onward are added as each delivery module begins, from the scope in §6.1 and the one-month grouping above.

**Online V1 critical path:** `0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`. Phase 4 is mandatory before purchase/sales payments because those operations require real cash accounts. Offline 12 follows only after online V1 is stable; 13/14 come after 12.

**Module scope for phases 0–11 is fixed above.** Phases 12–16 are detailed at the start of their phase because post-V1 integration decisions may still require implementation-level refinement. Splitting a module is allowed only at a real workflow boundary when it cannot fit the five-day timebox; manual acceptance remains mandatory at the resulting module gate.

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
| **Internal path** | Connected through domain, application, database, API and UI; its focused risk-based tests pass. This is a checkpoint, not an accepted release |
| **Module/Phase** | All internal paths work together · all four gates in `AI_CODING_INSTRUCTIONS.md` pass once · full regression is green · owner accepts the pre-written UI scenario |
| **Gate** | Owner has personally run the gate's scenarios and signed off (§6.3) |
| **V1** | Phases 0–11 complete; sync/PWA offline (12), Mobile (13), optional Tauri (14) and MCP (15) are post-V1 |

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

**Diagnostic bundle export** (Phase 15): one-click zip with 7 days of logs, app/schema versions, license state, configuration with secrets redacted, row counts, DB size, slow-query summary, health-check results. Without it every support ticket becomes a phone call with a non-technical shopkeeper.

**Sales constraint: cap on-premise customers at 2–3 until V1 is stable.** Each install multiplies support surface with no remote visibility. Take the first customers close to home.

**Standalone single-PC offline is not available until Phase 12 completes.** Do not sell it. When it arrives it is the installed PWA on SQLite WASM + OPFS — **not** a desktop application (D-20), so do not describe it to a customer as one. On-premise LAN solves the connectivity problem today: the server sits inside the shop and an internet outage is irrelevant.

**COOP/COEP headers are required** on the app origin for `SharedArrayBuffer`, which SQLite WASM needs for OPFS synchronous access. nginx must set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the frontend, in both SaaS and on-premise. Any third-party asset that cannot be served with `Cross-Origin-Resource-Policy` must be self-hosted — verify this before Phase 12, not during it.

## 6.6 Working rhythm

One module increment at a time, one module per agent conversation:

```
1  Pick the next module from §6.1 and timebox it to 3–5 working days
2  Write its complete UI workflow, acceptance criteria and expected numbers BEFORE code
3  List WRITE CLASS T/S/M/READ ONLY for each mutation and paste the module task block
4  Agent replies with one plan covering domain, database, API, shared UI components and focused tests
5  Build one internal path at a time through every layer; run only its focused tests and make a checkpoint commit
6  Repeat until the complete module workflow is connected
7  Run full lint, typecheck, boundaries and test ONCE at the module gate; paste real output
8  Review the complete module diff and run its real UI scenario yourself
9  Record owner acceptance and the module-gate commit in the ledger
10 Start the next module
```

Never skip step 8. Reducing repetitive automated tests makes the pre-written manual numbers more important, not less.

Before each phase: read the phase row · confirm the previous phase's exit criteria are met · **write the manual scenarios with expected numbers before any code exists.**

## 6.7 Honest expectations

- The owner-selected one-month target is online V1 through Phase 11. It is an exceptionally aggressive target, not permission to mark incomplete work done. Phases 12–16 remain outside the month.
- Foundation work already completed remains valuable; do not restart it to fit the new cadence.
- **Phase 5 is the first real milestone.** Buy stock, see it in inventory, pay the supplier, watch the ledger and cash agree — the architecture is proven and everything after is repetition of a working pattern.
- Something will be wrong in the money math at least once. The invariants and manual scenarios will catch it — if you actually run them.
- You will be tempted to skip Phase 0's boundary checker to reach visible features. Don't. It is the one thing that cannot be retrofitted, and it is what keeps the offline plan alive.
- **The biggest risk is not bad AI code. It is accepting good-looking AI code without verifying the numbers.** Bigger modules must still end in exact owner-checked scenarios.

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
| O-10 | Profit target and forecast basis (§5.20): is a target entered manually per period or derived from history · is it set per shop, per category or per product · does the projection use a run-rate to period end or a trend over prior periods. The performance metrics beside it need no decision and can ship first | Phase 9, with Reports |

*O-3 (VAT field set) is closed — D-09 was revised on 2026-08-16 to remove tax from V1 entirely.*

---

# CHANGE LOG

Only decisions that changed after first finalisation. Update the relevant section above **and** add a line here — do not create a separate decision file.

| Date | Change |
|---|---|
| 2026-08-31 | **Change Transaction Date is settled, and the counter stops being Bangla-first.** Owner decisions from the Phase 11.2 question round. **Date change:** append-only — the standing posting is reversed on the day it leaves and re-posted on the day it arrives, `created_at` immutable, the document's effective `business_date` becoming the new one; scope is the four money vouchers only, sales and purchases keeping the date field in their own correction form; gated by one new permission `finance.transaction_date.change` seeded to Owner, Manager and Accountant; **a closed period is protected, not immutable** — normal users refused, the Owner passing an explicit warning, §5.3 step-up, a mandatory reason and permanent audit, with any covering reconciliation dropping to review on its own; allocations survive only when still valid, and the whole operation is refused before anything is written if the new date precedes any invoice the money settles; the ledger and Daybook show one live `CORRECTED` row while the journal keeps original, reversal and repost; a reason is never blank and is normally one tap of four presets, free text required only for `Other`. **Counter:** six large actions, drawer and day state, and a short list of today's entries read from Daybook to prevent a double entry, owning no data and no posting path, with **View All Today** opening Daybook; visible to anyone holding any one of its six permissions, each button gated on its own. **Language:** UI-74 and UI-75 reversed — the counter workflow is English-primary with Bangla helper end to end, launcher and dialogs alike, because the counter is several screens and the old rule made it change register between them; D-12 amended to match; the Bangla stays on every control as the helper, and UI-47's Western digits are unaffected |
| 2026-08-24 | **R-0 revised and finalised — question style, no test runs, and a mandatory dev server.** Owner instruction, superseding the earlier same-day version below and any conflicting older instruction. **Questions are asked one at a time again**, up to ~20, each with **3–4 suggested answers**, the best marked **(Recommended)**, plus *“type your own”*; each answer is recorded before the next question; then a short **Final Module Specification** and `START`. **Automated tests are neither written nor run** — `pnpm test` only on the owner's explicit request in that conversation; `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test:boundaries` still run every time. The sequence is fixed: questions → specification → `START` → code → build and run → **owner reviews the UI** → he reports bugs → narrow diagnosis and fix → rebuild for him to verify. **The dev server is started at the beginning of every session**, before anything else. Coding stays confined to the confirmed module, reusing existing components, patterns, APIs and `--sher-*` tokens, inventing no new visual style and touching no adjacent module. Written into `AI_CODING_INSTRUCTIONS.md` (R-0, R-Q Q6–Q8, R-E, R-S S8, R-T T4, DoD, reporting template, prompt kernel) and `AGENTS.md` (top of file, for Codex CLI) |
| 2026-08-24 | **R-0 — the owner's working protocol becomes the highest rule for every agent.** Owner instruction, written into `AI_CODING_INSTRUCTIONS.md` (new R-0, above the Principle Priority list) and `AGENTS.md` (top of file, for Codex CLI) after being broken twice. Five steps: **(1) never write test files** — the owner verifies in the running UI, and only he can ask for tests; **(2)** a new or cleared chat orients on the last end position and asks before starting work; **(3)** a new module opens with **one message containing all the questions**, each with suggested answers — this withdraws the same day's one-question-per-turn rule; **(4)** then code only, no tests and no unrequested extras; **(5)** then start the dev server, run the existing checks, make the feature reachable (build packages · migrate · **backfill seed roles** · restart) and hand over a click-by-click UI manual. Plus the design rule, binding on every tool: **use the UI design that already exists and never invent a new one** — reuse the shared components and `--sher-*` tokens, follow the established patterns of §2.7, and STOP and report rather than introduce a second visual language. R-Q gains Q8 and revises Q6 |
| 2026-08-24 | **§5.16.5 gains case D — the shop's first day.** Found while building Phase 4. The counted opening is compared against the **drawer's ledger balance**, not against the previous actual closing alone. The two are identical on every day after the first (INV-07b), so cases A, B and C are untouched; on the first day the difference is the whole opening and a source must be named. Without it the drawer and the ledger start life disagreeing by exactly the opening cash |
| 2026-08-24 | **Counter surfaces become Bangla-first, and Phase 4's money workflow is settled.** Owner decisions from the Phase 4 question round. Language: UI-74 and UI-75 invert UI-14/UI-15 on the screens a cashier acts on — Bangla is the visible label, English the subordinate helper, the label is the spoken question (`ড্রয়ারে এখন কত টাকা আছে?`), presets beat typing, and accounting words (session, reversal, shortage/overage, reconciliation) never reach the counter; Owner/Manager screens stay English-primary; D-12 amended; UI-47's Western digits unaffected. Workflow: one counted drawer per day; **Reopen Day** allowed only on the current business date, by the Owner or whoever closed it, reversing the mistaken close's posting and keeping both closes visible (§5.16.4); the previous day must be closed before a new one starts, never auto-closed at expected; Start/End Day reachable from both a top-bar day chip and Daily Cash; one counted total, denomination breakdown deferred behind a setting; owner injection/withdrawal is a standalone any-time action; cash and bank account setup lives under Settings while Daily Cash stays under `Daily` (UI-67); bank/MFS ship with balance and statement only, reconciliation deferred; an account deactivates only at zero balance; opening cash/bank balances are typed on the account form, not imported |
| 2026-08-24 | **Pre-build questions are asked one at a time, as multiple choice.** Owner decision. R-Q's question round keeps its scope and its `START` gate; only the delivery changes — one question per turn with 2–4 concrete options, recommended option first, each option explained as shop work rather than code, and settled points stated rather than asked. §6.1's pre-build subsection and `AI_CODING_INSTRUCTIONS.md` R-Q (new Q6, Q7) carry the rule for every module from here on |
| 2026-08-24 | **Four owner corrections from the running Parties hub.** All four are UI-layer defects or presentation decisions; no business rule, stored figure or posting path changed. **(1) A printed statement carried the whole application with it.** `PartyLedgerPage` hid its own controls in a `<style scoped>` `@media print` block, and a scoped block cannot reach a parent component's markup — so the sidebar, top bar, breadcrumb, dark-mode toggle, bottom navigation and footer all printed around the statement. Print rules now live once in `apps/web/src/design/print.css`, globally: chrome and overlays are hidden, the fixed-height shell and its inner scroller become ordinary flowing blocks (they were clipping a long statement to one screen's worth of paper), and the palette drops to black on white. Every later print surface — invoice, receipt, purchase order, report — inherits it instead of writing its own. **(2) The ledger opened without saying whose it was.** The party's name, phone, address and closing balance were written as `<template #header>`, and `AppCard` has no `header` slot — only `actions` — so Vue discarded the block silently and the screen opened on a bare table. It is ordinary card content now. A print-only line adds the shop's name and the period, because a statement that leaves the building has to say who issued it and over what. **(3) The ledger's page size is now chosen: 50 by default, or 100 or 200.** The contract already accepted `limit` 1–200 and the service already defaulted to 50, so this is a control, not a new capability; changing it reloads from the first row, because a keyset cursor taken at one page size means nothing at another. **(4) Father/Guardian Name and Description default to visible, on every party role** — see §5.6. Recorded here because a shipped default is a business decision: it changes what a new shop is asked for on the day it opens. | 
| 2026-08-24 | **Phase 5 purchasing, settled in the question round.** Owner decisions taken before the build. **(1) A due date is optional**, blank by default and typed only when the supplier named a day — this overrides §5.9's "every credit purchase has an explicit due date": most suppliers here give goods without naming one, and a required field would be filled with a guess. A bill with no due date is unpaid but never overdue. **(2) One payment box on the bill** — "Paid now" plus the account it left, with the remainder becoming the supplier's due; part payment is the common case and a Cash/Credit choice would need a second step for it. **(3) Bill-level discount and extra cost**, spread over the lines by value, rather than per-line discount boxes. **(4) A purchase refreshes the product's purchase price and never the selling price**, warning when the new cost is at or above what the product sells for. **(5) A product missing from the list is added in a dialog on the purchase screen**, so the half-typed bill is never lost. **(6) Both supplier-payment entry points exist**, `Pay Supplier` primary on the supplier page and `Pay this bill` secondary on a purchase, through one service. **(7) The cash-day rule:** a **cash** payment on a day nobody started is blocked in place with `দিন শুরু করুন` offered inside the same flow and the typed form preserved; **bank and bKash/MFS are unaffected**, because there is nothing to count. The refusal carries `reason: CASH_DAY_NOT_STARTED` so the screen can offer the button rather than a dead end, and the rule applies wherever a supplier is paid. **(8) Three permission codes**, separating recording a delivery from handing over money. |
| 2026-08-22 | **Pre-build questions and a manual-first testing policy become the single project policy.** Owner decision, superseding the earlier test cadence in the entry below and every "tests ship with the module" instruction. **No module is built until the owner replies `START`:** the agent asks 10–20 concise questions about genuinely unresolved decisions only — never about what this document, `AI_CODING_INSTRUCTIONS.md`, `SKILL.md`, `FUNCTION_MAP.md`, existing code or a confirmed requirement already answers, and fewer for a simple module — then presents the final module specification, what is added/changed/reused, the exact UI and workflow, and the files and modules affected. **The complete module is built before anything is verified, and new test code is not written by default:** the only mandatory automated check is the existing full `pnpm test` suite, run once at the end, after which the owner gets a concise manual checklist for the real UI, calculations, data flow and business workflow. Unrelated pre-existing failures are reported briefly and their modules are not touched without approval; extra permanent tests for financial, balance, FIFO/stock, payment, refund, accounting, unit-conversion or settlement logic are optional and need the owner's permission after their own manual testing; no UI/E2E tests, mocks, fixtures or diagnostic tests unless requested; existing tests are never skipped, weakened or deleted; and the next module does not start until the owner confirms the current one. **UI surface rules are also now binding:** full page for major or complex workflows, drawer/side panel for contextual work that preserves the current page, small modal only for short actions and confirmations, no nested modals or unnecessary temporary layers, near-full-screen keyboard-friendly drawers on mobile, preserved form/filter/tab/search state, and reuse of the existing authoritative logic from every entry point. §6.0, `AGENTS.md` (rules 11 and 22, pre-build section), `AI_CODING_INSTRUCTIONS.md` (new R-Q, rewritten R-E, S2/S8, R-T3–T5, R-UI surface table, Gate 1, prompt kernel) and `SKILL.md` (§17b, §23, §24, §29, §30, §31) updated to match. |
| 2026-08-22 | **Session economy rules adopted: `FUNCTION_MAP.md`, and no full test suite after every change.** Owner decision. Agents start every session with no memory, and two habits were spending the budget without improving the software — rediscovering existing code by reading the repository, and re-running the whole suite after each edit. A reuse index at the repository root is now read **before** the codebase is searched, and every coding session updates it with the functions, services, endpoints, database methods, shared components and business rules it added or changed, in the same commit. It is the **fourth** permitted markdown file and records only *where code is and how to call it*; requirements stay in this document, rules in `AI_CODING_INSTRUCTIONS.md` (new section R-T), the delivery record in §6.1.1, and the ban on task logs, decision logs, module docs and planning documents is unchanged. Testing cadence is now explicit: one focused suite per changed path while building, the core business-logic suites when a module or major feature is complete, and the four gates once at the module gate. **Nothing about correctness moved** — the gates, golden invariants, tenant/permission proofs, exact-number acceptance and manual UI acceptance are all as they were, and R-T7 states that token economy never buys a shortcut through them. §6.0 and `SKILL.md` updated to match. |
| 2026-08-22 | **One guided importer with three callers, and the four decisions it needed.** §5.6 requires a guided CSV import with a downloadable template, a preview, per-row validation and an all-or-nothing post; it does not say what happens when a file names a unit, brand, category or customer group the shop has not created yet. **Unknown master data is refused, never created.** A file that quietly added "Kilogrm" to Units would leave a typo in the master data of every later purchase, and inventing master data nobody confirmed is a business rule this code would have written for itself (R-A5); the preview names every missing one at once, so they are added in a single pass before the file is imported. **§5.6's "opening stock with location and unit cost" ships with the unit cost and without the location column.** A shop has exactly one stock location today, created on demand by the stock services, so a column that could only ever hold one value would be noise; it arrives with multi-location. A blank `Unit Cost` values the opening at the product's purchase price, which is exactly what the product form does — one rule, two entry points. **A file carries at most 2,000 rows**, because the whole file is one transaction and its size is how long that transaction holds its locks; a larger migration is split into files, which is also how a shopkeeper can tell which half failed. **Products, customers, suppliers and opening stock only:** §5.6 also names opening receivables, payables and cash/bank balances, which need Phase 4's posting services before they can become journal entries, and they are absent from the importer rather than accepted and ignored. Nothing about how a record is created changed: the importer calls the same product, party and stock-opening use cases the forms call, which is what keeps INV-02, INV-05 and INV-06 true of imported data. |
| 2026-08-21 | **Gate G2 is proven on the document types that exist, not deferred until Purchase and Sales arrive.** §5.11's headline scenarios (buy 10 @ 100, buy 10 @ 120, sell 15) need a purchase document and a sale, which are phases 5 and 6. Phase 3 can only move stock through opening stock and adjustments, and an adjustment increase takes its cost from the moving average — so two live lots at different costs cannot exist yet, and the multi-cost FIFO ladder cannot be exercised. The owner's decision is that the invariant harness lands now, over what can actually be posted, under **both** costing methods, and that §5.11's scenarios are added to that same harness verbatim when Purchase and Sales land. The alternative — holding the gate open until then — would leave the period in which the most costing code is written as the period with no invariant watching it. What the harness cannot yet reach is recorded in ledger row 3.5 as *Not implemented*, not as done. |
| 2026-08-21 | **The opening-stock CSV step waits for the guided importer it shares with Phase 2.4.** §6.1 puts a CSV step in Phase 3 and a guided product/party import in Phase 2.4; no import machinery exists for either. Building one importer with three callers — products, parties, opening stock — closes both, and building the Phase 3 half first would mean writing the same file parsing, preview, refusal and all-or-nothing rules twice (§5, one business action, one authoritative function). Order is therefore: invariants first, importer next. |
| 2026-08-20 | **The shell is mounted once, above the router, and page transitions are horizontal or a cross-fade — never vertical.** Every page used to mount its own copy of the shell, so each navigation destroyed and rebuilt the sidebar, top bar and footer: the screen blanked for a frame, the sidebar forgot whether it was collapsed, and the staggered top-to-bottom reveal restarted from nothing. `AppLayout` now holds the chrome for the whole session and only the page inside it changes. Moving **inside** a module slides sideways; moving **between** modules cross-fades; the two pages overlap in one grid cell so there is never an empty frame between them. The vertical stagger is removed outright. UI-43's reduced-motion rule is unchanged. Owner decision from the running app. |
| 2026-08-20 | **Page spacing is owned by the shell, not by each page.** Every list page had written its own `.filters` rule with its own bottom margin — 20px on Products and Customers, 16px on the Inventory Report, none on Audit — which the container's own 16px gap was then added to, so the same furniture sat at three different heights per module. One shared `.filters` and one `gap` on one column now decide it, and Audit's one-off grid variant is gone. Owner-reported as "not same gap". |
| 2026-08-20 | **A feature tab is named after the page it opens, not after every capability reachable from it.** The Products tab read "Products & Stock Adjustment & Lots/Batch" because contextual leaves sharing a route had their labels joined. Stock adjustment and lots are row actions on Products (UI-56), so they belong in the tab's hover text, not its label. Sidebar subcategory names shortened to match the caption above them: Product Management → Products, Inventory Report → Reports, Business Settings → Business, Account Security → Security. UI-55 unchanged; this is its short-name rule applied. |
| 2026-08-20 | **The module feature strip returns to the bilingual underlined tabs UI-55 already required.** It had drifted to a bordered segmented control, which put two boxes directly under the page title and competed with it. Restored to scrollable PrimeVue tabs with the English name, a short Bangla helper and a primary-colour active underline — the pattern approved earlier the same day. |
| 2026-08-20 | **A column that cannot be sorted is drawn exactly like one that can.** Stock and Stock value were plain `<th>` text beside `SortableHeader` columns, so the browser's own `button { text-transform: none }` reset cancelled the uppercase inside the sortable ones and the header row read `Product … STOCK VALUE`; the plain cells also lacked the button's line box, so their labels floated above the others' baseline. A shared `.th-label` box fixes both without implying a sort that the contract does not offer. |
| 2026-08-20 | **One module list, two frames.** The sidebar's navigation markup existed twice — once in the desktop rail, once inside the mobile drawer — which is how the two drifted apart. `AppSidebarNav` is now the single source rendered by both, and the off-canvas frame remains PrimeVue's `Drawer` (its `Sidebar` under the v4 name) so overlay, focus trap, escape and scroll lock stay the component library's job. |
| 2026-08-20 | **Owner UI asks recorded against modules Phase 3 has not built — not implemented, not designed away.** (a) Expense: the Add Expense form must create a category inline without leaving the form (UI-45's quick-add rule already binds it), and Expense Categories must be manageable from inside the Expense module so a category can be corrected where it is used. (b) Sales: the sales-invoice list and the return list each need their own significant row, not one shared column set. (c) A **payee ledger** is missing from SherERP entirely — the owner supplied the concept and it has no §5 home yet. Each needs its module before it can be built; none of it is authorized as new scope by this entry. |
| 2026-08-20 | **`STOCK_ADJUSTMENT` added to the closed account list (§2.4), by owner decision.** A stock adjustment moves the `INVENTORY` account and every entry must balance (INV-01), but no account on the closed list could take the other side: `OPENING_EQUITY` is for openings, `COGS` is for goods actually sold, and `EXPENSE:{cat}` cannot express a stock *gain* and would have blocked the feature behind the Phase 7 Expenses module. Without an account, a physical-count correction has nowhere to balance and `INVENTORY` permanently disagrees with the goods on the shelf — the identical argument that added `CASH_SHORT_OVER` on 2026-08-16, and it is deliberately the same shape: loss debits, gain credits, and the period balance is the shop's shrinkage. Raised as an R-H stop rather than decided by the agent, because a new account changes what every report means. |
| 2026-08-20 | **Products and per-product inventory merged into one working hub; Inventory becomes the Inventory Report.** Owner decision from the reference-build screenshots. §5.5 now gives the Products list a `⋯` row menu — Edit, Stock, Lots, Deactivate, Delete — with each action opening its own modal over the list (UI-50), and `Add Product` opening the same dialog in create mode; unpermitted actions are absent, not disabled (UI-09). §5.10 keeps only the cross-product reporting that has no single product to hang from, at `/inventory-report`: Stock Overview, Low Stock, Stock Lots, Stock Movements, Damaged & Written-off, Expiry, Cost Adjustments and Valuation. There is no second product list. Opening stock moves from an Inventory row action to the product dialog's one-time `Opening / Current Stock` field, calling the same unchanged stock-opening service. **`Delete` follows §3.6 and says which happened:** a product that has never moved is hard-deleted, one with any history is refused and directed to `Deactivate`, checked server-side inside the transaction. |
| 2026-08-20 | **Stock adjustment specified (§5.10).** Signed quantity, a closed reason list `DAMAGE | RECOUNT | THEFT_LOSS | OTHER` (note mandatory for `OTHER`), optional business date. Write class T on the full ten-step path. An increase creates a lot at the current cost basis posting `DR INVENTORY / CR STOCK_ADJUSTMENT`; a decrease consumes lots through the same FIFO/FEFO `ConsumeStockService` a sale uses, posting the reverse. A decrease beyond stock on hand follows the existing negative-stock policy (DR13.7) and its true-up — **no lot is ever written with a negative remaining quantity** (DR13.11/INV-03), which is where the reference build was wrong. A zero adjustment is refused, and adjustments are corrected by further adjustments rather than edited. |
| 2026-08-20 | **Purchase Order specified as a non-posting draft order list (§5.9), to be built in Phase 5.** Pick products and planned quantities — optionally seeded from Low Stock — then print or share to the supplier, including as an image. It creates no lot, movement, payable or journal entry. When goods arrive, `Create purchase` opens the **existing** New Purchase screen pre-filled from the PO's lines, where quantities, costs and extras are entered and the purchase posts through the same use case a from-scratch purchase uses (A14). The PO is a convenience seed for one posting path, never a second purchase engine. Recorded now, built in its phase, because Phase 5 depends on Phase 4's cash accounts (§6.2). |
| 2026-08-20 | **Sales performance and profit forecasting recorded in §5.20, not built.** Owner asked for units sold and profit per product, performance and target/forecast figures. Placed in Reports & Dashboard, which owns profit, rather than in Inventory, which has no sales data and must not grow a second profit figure (INV-10). Performance metrics are specified and buildable once Sales/POS supplies data. **The target/forecast feature is explicitly left undecided:** whether a target is manual or derived, its scope (shop, category, product) and the projection basis are all open, and inventing them would be a fabricated business rule (R-A5). Any forecast must be labelled an estimate and never shown as a posted figure. |
| 2026-08-20 | **Reuse and compact UI migration clarified.** One repeated business action now has one authoritative callable module/interface: invoice edit/correction from Customer Ledger, Sales Invoice History, Invoice Detail and Daybook is the explicit reference example. If currently built code duplicates or violates that seam, consolidate/refactor the affected module first and complete its final-UI acceptance before starting the next module. Bangla helper labels move to a subtle inline pattern (`Supplier — সাপ্লায়ার`) with 11px muted Bangla; compact surfaces use accessible PrimeVue tooltips when visible Bangla would harm layout. Party ledger overview defaults are fixed to Name, Phone, Address, current role balance and a `⋯` action menu; individual transaction ledgers retain their transaction columns. Added UI-72/UI-73 and revised UI-15/UI-16/UI-49/UI-58, §5.6 and §5.8. |
| 2026-08-20 | **Daily operations and reconciliation workflow finalized from owner screenshots.** Added D-42/D-43 and UI-67…UI-71. `Daily` sidebar now resolves POS, Counter, Daybook and Daily Cash. `Counter` is the UI name for Quick Transactions and centralizes manual Receive Voucher, Payment Voucher and Expense Voucher without owning a posting path. Customer/Supplier/Vendor ledgers are working hubs with immediate Receive/Pay actions and source-linked full history. Expense is clarified as Expense Category/Ledger + optional Payee, not a Party role. All ledgers default to Transaction Date (`business_date`) with optional Entry Date (`created_at`) audit view; changing transaction date never changes created date. Daybook is the universal notebook-review/correction launcher. Account Reconciliation may change transaction date, add missing entries, correct/reverse and mark reconciled through source use cases. Daily Cash shows immutable Expected vs Physical Count history and opens filtered Daybook for investigation. |
| 2026-08-20 | **UI conflict reconciliation: “simple outside, powerful inside / stay in context” becomes the governing interaction model.** Replaced the rigid four-screen interpretation, mandatory card-wrapping/fixed landing composition, desktop-first phone best-effort rule, mechanically duplicated Bangla-helper requirement, and the mistaken classification of Expense as master data. UI-52/UI-56 now define working hubs; UI-60…UI-66 bind stay-in-context, progressive disclosure, no re-search of known context, many entry points → one use case, preserved tab/filter/scroll state, simplicity-by-task-effort, and owner screenshot workflow authority. UI-36 now returns successful contextual actions to their origin instead of always landing on a document. Architecture/accounting/permission/reversal rules are unchanged. |
| 2026-08-20 | **Workflow-hub, Quick Transactions and in-place Daybook direction confirmed by owner screenshots and workflow description.** UI-52 makes Customer, Supplier and Vendor profiles the single role-relevant hub for summary, source-linked history, ledger and every authorized sale/purchase/payment/return/correction/reversal action, returning to the same profile context afterward. UI-53 adds one Finance / Quick Transactions workspace with Receive Voucher, Payment Voucher and Expense Voucher tabs for rapid physical-paper entry; it owns no balances or posting path and delegates to the existing receipt, supplier/vendor payment and expense services. Daybook row actions now explicitly open the owning module's authorized action over Daybook and return to the same range, filters and scroll position. Convenience and polish changed; accounting semantics, permissions, period locks, append-only journal rules and reversal history did not. §2.7, §5.6, §5.18 and §5.27 updated. |
| 2026-08-20 | **Master-data quick-add picker appearance and icon help revised by owner visual reference.** UI-51 now renders each applicable picker as one joined `[ PrimeVue Select | gear ]` control, with the gear kept as a separate accessible action that cannot trigger the Select. Icon-only actions carry concise PrimeVue tooltips on hover/focus and accessible names. This changes presentation and discoverability only; quick add/manage still uses the same permissions, validation, audit and write path required by UI-45/UI-51. |
| 2026-08-19 | **Add/edit screens become dialogs, pickers gain `Manage`, and the opening figure moves onto the create form. Owner decision with mockups.** **UI-50:** master data is created and edited in a modal over its list — the shopkeeper keeps their place and the new row appears behind the dialog, which is its own confirmation. Documents with lines (purchase, sale) stay full screens. **UI-51:** every master-data picker carries `Manage` beside it, opening that list with a `⋯` menu of `Edit`/`Delete` per row; the actions for a thing live where the thing is shown, not only on a settings screen. UI-45 and UI-51 are two halves of one idea and share one write path. **Opening stock and opening balance now appear on the create forms** — `Opening / Current Stock` on Add Product, `Opening Balance (Due)` on Add Customer — revising §5.5's "created with opening stock `0`" and adding a figure §5.6's customer field list does not name. **This changes where the figure is typed, and nothing about how it is stored.** INV-02, INV-06 and INV-10 are untouched: the dialog's save calls the stock-opening service and the posting service, so an opening quantity becomes a real stock movement and an opening due becomes a real journal entry against `OPENING_EQUITY`. A column on `products` or `parties` holding a number with no movement behind it remains forbidden — it would break INV-02 and INV-05 the moment it was written. **Consequence: these two fields cannot ship before Phase 3 (stock-opening service) and Phase 4 (posting kernel for AR/AP), which is why those phases are being built next.** |
| 2026-08-19 | **UX direction restated for the actual customer, and three UI rules changed by owner decision.** The buyer is a Bangladeshi shop owner who is not a graduate and whose computing experience is an Android phone, Facebook and YouTube; the five daily jobs (product, customer, supplier/vendor, expense, sale) must work without training. Recorded in §2.7 as binding on every screen. **UI-16 revised at that time (superseded by the 2026-08-20 UI reconciliation):** Bangla helper text then covered **every** field, button and column on every screen, replacing "do not mechanically translate every field on every back-office screen" — a field whose only explanation is its English label is unusable by this audience. **UI-14 deliberately unchanged:** the owner chose to keep English as the primary label with Bangla beneath it, rather than reversing the hierarchy or going Bangla-only. **UI-46 added:** every column header in every list sorts on tap, tap again to reverse, with an arrow showing the active sort — the model shop owners know from their phone's gallery and file apps — replacing any separate sort menu. §3.9's "fixed sort per endpoint" is replaced by a caller-selected sort drawn from a closed, indexed allow-list per endpoint, with the keyset cursor carrying the sort key **plus `id`** as a mandatory tiebreaker; without it, rows on a page boundary shuffle and a shopkeeper paging low stock sees one product twice and another never. **UI-47 added:** digits on screen are Western, matching the phone keypad, calculator, bKash/Nagad and price tags, including inside Bangla helper text. **UI-48 added:** printed sales invoices, purchase invoices and purchase orders carry both a Bangla and an English mode, defaulted per document type in printing settings (§5.21) and switchable in one tap at print time; switching is rendering only and never re-posts, re-numbers or changes a figure, and Bengali numerals are correct in Bangla mode — the one place they are. |
| 2026-08-19 | **Opening balances confirmed to stay on the posted path; no section changed.** Raised by the owner on acceptance of Phase 2: a customer, supplier or product can be created but what they are owed or how many are held cannot be recorded, so no real shop can be onboarded yet. Confirmed as a **sequencing gap, not a missing field**: §5.0 requires opening balances throughout, but §5.5 creates a product with opening stock `0`, §5.6's customer field list has no balance field, and §5.6's opening-data import states that opening balances use the normal journal/stock-opening services and must never be written directly — which INV-06 and INV-10 also require. The capability therefore lives in path 2.4's guided CSV import, which depends on the stock-opening service (Phase 3) and the posting kernel (Phase 4). **Owner decision: keep the planned order** — Phase 3 next, then Phase 4, then 2.4 completes onboarding across products/stock, customers, suppliers, cash and bank. Adding stored opening-balance columns to the party and product forms was considered and rejected: the figures would have no movement or journal line behind them and would have to be unwound once Phases 5–6 make those ledgers real. **Consequence accepted: SherERP cannot onboard a live shop until Phase 4 completes**, and that is the gate to watch, not Phase 2. |
| 2026-08-19 | **Per-product unit conversion specified by the owner (D-41, refining D-10).** One optional conversion unit and factor per product, replacing the earlier list of conversion rules; base unit remains the single storage and calculation unit; two quantity boxes in Purchase and POS; price entry/display switchable between base and conversion unit with the stored price always per base unit; stock displayed in mixed `5 Pipe + 5 Feet (105 Feet)` form. Applied immediately to the product form and migration 0010; the Purchase/POS two-box entry lands with Phase 5/6 and the mixed stock display with Phase 3, bound by this decision. No stored figure changes meaning — the conversion is an entry and display concern. §5.5, D-10 and §6.1.1 updated. |
| 2026-08-20 | **Opening stock is also an Inventory-row workflow action.** The owner asked to add opening stock and continue the product-centred workflow. §5.10 now permits an authorized user to open an Add opening stock modal from an existing never-stocked product, using the same posted opening service as Add Product/import and refreshing the Inventory hub in place. This adds a convenient entry point only; it does not create a second balance writer or weaken INV-02/INV-05. |
| 2026-08-20 | **PrimeVue 4 controls and categorized sidebar made system-wide UI standards.** UI-54 replaces native single-choice selectors and browser date inputs with PrimeVue `Select` and a shared date-only `DatePicker` adapter wherever semantically applicable. UI-55 adopts a compact data-driven category/subcategory presentation for real SRS modules. Empty or inaccessible groups remain absent under UI-09. This changes interaction and organization only, not routes, permissions, stored dates or accounting behaviour. |
| 2026-08-20 | **Navigation architecture refined to Category → Subcategory → Feature/Page, without feature-per-module sprawl.** Stable independently targetable IDs, permission/entitlement/feature filtering, persistent expansion and responsive PrimeVue PanelMenu/Drawer behavior apply to implemented SRS capabilities. The sidebar displays only Category → Subcategory; UI-56 keeps related feature leaves in their existing hub rather than creating duplicate routes. Overview remains solely to preserve Dashboard. |
| 2026-08-20 | **Correction: the supplied long sidebar list was a layout example, not new SherERP scope.** Removed speculative Sales/Purchasing/Finance/Reports/HR/Tax and other unbuilt entries from navigation configuration and revised UI-55 to forbid using an information-architecture example as a module backlog. Navigation now maps only existing SRS-approved implementations; D-05's removal of LIFO and D-09's removal of V1 tax remain untouched. |
| 2026-08-20 | **Customers, Suppliers and Vendors are independent sidebar categories.** Customers owns Customers/Customer Groups/Customer Ledger; Suppliers owns Suppliers/Supplier Ledger; Vendors owns Vendors/Consignment/Vendor Ledger. Selecting a category opens that role's existing shared Parties hub and top feature navigation, with the role list selected by default. This is navigation independence, not duplicated domains, tables, APIs or writers. Only implemented, permitted and enabled entries render; ledger/consignment leaves remain invisible until their SRS phases supply real data and actions. UI-55 clarified. |
| 2026-08-20 | **Related-module hub navigation adopts the owner-approved bilingual horizontal tab pattern.** UI-55 now requires scrollable PrimeVue feature tabs with the English name, a short Bangla helper label and a primary-colour active underline. This is a presentation standard over existing SRS-approved features and does not authorize copied or speculative modules. |
| 2026-08-20 | **Redundant module navigation removed.** UI-55 now forbids a one-item feature strip and removes the old Customer/Supplier/Vendor switcher from the shared Parties page because those roles are independent sidebar categories. Each role entry has its own heading; a bilingual feature strip appears only after at least two real, accessible features exist in that hub. |
| 2026-08-20 | **Customer and Purchase hub interactions clarified from owner references.** The Customer list uses a top-right modal Add action, customer-name profile/ledger drill-down and a permission-filtered row `⋯` action menu; unfinished ledger and financial actions stay absent. The future Purchase hub uses New Purchase, Purchase Invoice and Purchase Return as bilingual feature contexts over one transaction engine, appearing only as their real posting-backed capabilities ship. §5.6 and §5.9 updated. |
| 2026-08-20 | **Decorative form introduction cards removed.** UI-57 omits repeated icon/title/subtitle blocks above self-explanatory fields while preserving necessary field grouping, validation and consequence guidance. The Customer form is the first application of this compact standard. |
| 2026-08-20 | **Party ledger overviews prioritize current balances.** Customer Ledger will show each customer's journal-derived Due/Advance without opening the profile; Supplier/Vendor ledgers show Payable/Credit the same way. Credit Limit is removed from list/ledger columns and remains editable only in customer details because it is configuration, not a balance. No provisional due value is shown before journal-backed ledger services ship. §5.6 updated. |
| 2026-08-20 | **Compact default list columns and centralized future visibility adopted.** UI-58 requires each module to show only daily-use columns by default and later take optional visibility from one tenant Settings contract. The Product list removes permanent Code/Barcode, Unit and Reorder columns while keeping those values searchable/in details. Product Stock Qty/Value remain required, but their multi-location context must be confirmed and delivered by an application read model rather than summed or guessed in Vue. §5.5 updated. |
| 2026-08-20 | **Signed party balances and advances made symmetric across Customer, Supplier and Vendor.** Customer positive means Due and negative means Customer Advance; Supplier/Vendor positive means Payable and negative means Advance Paid. Opening amounts use the same signs and post atomically against `OPENING_EQUITY`; zero posts nothing. Added closed internal current-asset accounts `SUPPLIER_ADVANCE` and `VENDOR_ADVANCE` so advances are not misclassified as negative liabilities. No balance is stored on `parties`; all list/profile/ledger figures remain journal projections. §2.4, §5.6 and §5.15 updated. |
| 2026-08-20 | **Party navigation regrouped for Bangladesh business terminology.** `Parties (পার্টি)` is one sidebar category with Customers, Suppliers and enabled Vendors as subcategories over the shared Parties domain. Dealers stay a Customer Group; no speculative Other Contacts/address-book module is added. This supersedes the earlier same-day presentation of those roles as three top-level categories while preserving their independent entry contexts and stable feature IDs. UI-55 updated. |
| 2026-08-20 | **Overlapping sidebar active states fixed.** When routes share a prefix, navigation highlights only the most specific accessible route; `/settings/security` no longer also highlights `/settings`. Parent category highlighting remains intact. |
| 2026-08-20 | **Compact operational density made system-wide.** UI-59 reduces shared shell padding, vertical gaps, card/dialog padding and table-cell spacing through common tokens and the PrimeVue preset while preserving 40px controls/touch targets, responsive overflow, Bangla labels and required guidance. |
| 2026-08-20 | **Summary cards use compact responsive rows.** Shared statistic cards use smaller figure/icon spacing; Inventory's three reconciliation figures render three-across on desktop, two-across on tablet and one-across only on phone, replacing wasteful full-width stacked strips. UI-59 applied. |
| 2026-08-20 | **Sidebar hover/active icon alignment corrected.** Expanded navigation icons inherit the row's hover/active foreground, icon-to-label spacing is compact and consistent, and native browser title popups are removed from expanded rows. Descriptive tooltips remain in collapsed icon-only mode. |
| 2026-08-20 | **Sidebar categories open with a usable default.** Expanding an inactive category navigates to its first accessible subcategory, so a category is never opened with no selected destination. Permission and feature filtering run first; Parties defaults to Customers, Administration to Access Control and Settings to Business Settings only when those are the caller's first accessible children. |
| 2026-08-19 | **Quick add adopted as a system-wide UI rule by owner decision (D-39, UI-45).** Any form that picks an existing record must also create it inline, asking only for that record's mandatory fields and leaving the rest for its own screen later. Requested by the owner 2026-08-19 while accepting path 2.3, with purchase-entry supplier creation given as the motivating case. Applied immediately to the product form (unit, brand, category, subcategory) and the customer form (customer group); binding on every later module that offers a picker. No business rule, stored number, permission or write path changed — the inline path calls the same use case as the full form, which is the constraint that makes the rule safe. || 2026-08-18 | **§5.21 settings seeded up front by owner decision.** The full §5.21 key list is created with every tenant at slice 1.5 rather than each module adding its own key when it lands. Settings whose module does not exist yet are stored, audited and marked "takes effect with …" in the UI rather than rendered as live controls. **Excluded, and still open:** terminology, numbering prefixes, backdating policy, period-lock configuration, and invoice/dashboard visibility — §5.21 names these but nowhere states their permitted values, and seeding invented values would record a fabricated business rule under an SRS-shaped name (R-A5). Each needs its value set defined before it can be built; see open items |
| 2026-08-18 | **§2.7.I visual system revised from the owner-approved prototype set** (`design-system/prototypes`, `design-system/references`). The slate-only palette is replaced by a blue primary (`#2563eb`) with a white sidebar and cool-grey page; a **dark theme ships alongside light** as a per-device user choice, never `prefers-color-scheme`. Gradients are permitted **only** on summary-tile fills, the brand mark and the avatar. Six summary-tile tones are fixed by meaning (money in blue · cost slate · profit green · attention amber · receivable violet · payable rose). Geometry set to 12px cards, 8px/40px controls, 20px card padding; UI-08 updated for the sidebar toggle, theme toggle and the shell-owned page header. Shared implementation named: `design/tokens.css`, `design/components.css`, `design/theme.ts`, `design/preset.ts`, `AppShell`/`AppSidebar`/`AppTopBar`/`AppCard`/`StatCard`/`EmptyState`/`ErrorNotice`. No business rule, permission or number changed. Reason: the owner approved a concrete prototype after §2.7.I was first written, and §2.7.I itself requires an explicit edit before any accent-colour, card, navigation or composition change. |
| 2026-08-18 | **Master SRS v4.0 merged reconciliation.** Restored owner-confirmed product offers, mandatory product fields, customer NID/configurable optional fields, fixed/percentage POS discounts, barcode repeat-scan/serialized-unit behaviour, POS stock/filter rules, in-POS vendor creation, cosmetic invoice presentation edits, document design/JPG/WhatsApp/Business-Pad controls, manufacturer serial rules, serialized-unit/barcode labels/search, expiry policies, landed-cost categories, ledger/invoice/purchase UI actions and purchase notes. Loyalty/Premium dropped. Dashboard profit allowed only under feature+permission+reliable-costing gates. Roadmap set to Online-first → Sync → PWA Offline → Mobile → future Tauri → MCP. D-05 revised to separate inventory issue and sale accounting costing settings, FIFO/AVERAGE only. |
| 2026-08-18 | **Lean medium-business omissions added by owner approval without adding new modules.** Required onboarding CSV import, receivable/payable due dates and ageing, partial purchase-order receiving, supplier-credit application and invoice PDF/WhatsApp sharing extend the existing module paths. Quotation → sales order → invoice and customer-group pricing are included only as disabled-by-default, hidden wholesale/dealer controls; generic CRM, a generic promotion/rule engine, portals and configurable import machinery remain out of scope; the simple product offer/default-discount feature defined in M04 remains in scope. §5.6–§5.9, §5.20–§5.21 and §6.1 updated. |
| 2026-08-17 | **D-02 and POS guest-customer workflow revised by owner approval.** Fully paid new buyers use the system walk-in party while sales invoices retain immutable required name/phone and optional guardian/address snapshots searchable by phone. Due creates and links a registered customer atomically. A fully settled guest return continues using walk-in and does not create a party; a surviving due/advance/store credit requires a confirmed customer. §3.9, §5.6–§5.8 and §5.14 updated with UI behaviour, index and exact tests. POS cost-eye semantics now use the posting costing service: selected-quantity FIFO/FEFO estimated COGS or AVERAGE cost, permission-gated and provisional-labelled where applicable. |
| 2026-08-17 | **Natural Bangla UI wording clarified.** UI-15/UI-16 and §2.7.I now permit familiar shop phrases on high-frequency POS controls (`লগইন করুন`, `কাস্টমারের নাম`, `ক্যাশ কাউন্টার`) while retaining English primary labels and centralized i18n keys. |
| 2026-08-17 | **Development cadence revised for the one-month online-V1 target.** One-screen micro-slices are replaced by four large weekly module-scale vertical increments covering Phases 0–11. Focused risk-based tests run during implementation; full regression and owner UI acceptance run once at each module gate. Phases 12–15 remain post-V1. Critical accounting, inventory, tenant, security, idempotency, reversal and backup/restore coverage remains mandatory. §6 and `AI_CODING_INSTRUCTIONS.md` revised by owner request. |
| 2026-08-17 | **Binding visual system added to §2.7.I.** Fixed slate/white palette, 256px shared shell, typography, card/table/button/badge shapes and module page composition apply from the first screen. The supplied Tailwind/`lucide-react` wording was adapted to the existing Vue + PrimeVue stack without adding a second UI framework or React dependency. |
| 2026-08-17 | **Write path classified by mutation type.** The ten-step path remains mandatory for transactional money/stock/document writes; security/identity and master/configuration writes use explicit smaller paths instead of fake period/journal/stock steps. `AI_CODING_INSTRUCTIONS.md` R-D revised. |
| 2026-08-17 | **D-07 revised again — Google may now create a tenant**, reversing "Google alone never creates a tenant" in §5.3. An unknown verified Google email is offered a one-field signup (business name); `username` is derived from the email local-part and `password_hash`/`pin_hash` are left **NULL**, so the account can only be entered through Google until the user sets a password via forgot-password. Requested by the owner 2026-08-17 after Google OAuth went live; the owner chose "business name only, derive the rest" over collecting a password and PIN. Consequence accepted: a Google-created account has no password and no PIN, and PIN login is unavailable on it until slice 1.3 builds the set-a-first-credential flow. Slice 1.2c |
| 2026-08-16 | **D-05 historical revision, superseded in part by 2026-08-18.** LIFO remained removed; the later owner decision restored two separate FIFO/AVERAGE settings while preserving one accounting valuation basis. |
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
| 2026-08-16 | **D-20 historical revision, superseded in part by 2026-08-18.** Tauri was rejected as the primary offline architecture; the 2026-08-18 roadmap permits an optional future Tauri packaging phase after Mobile while PWA remains the canonical offline runtime. |
| 2026-08-16 | **D-07 revised.** OTP is for signup verification and password recovery only — **never daily login**. Signup takes one field (mobile or email), sends a 6-digit OTP to that channel, then sets username + password + PIN. Daily login is email/phone + password, PIN, or Google. Forgot password sends OTP to the registered email or phone. Full flows, OTP rules and identifier rules added to §5.3 M02; Phase 1 slices 1.1/1.2 updated. Reason: OTP-per-login makes SMS cost scale with daily usage |
| 2026-08-16 | **§2.7 added — frontend conventions UI-01…UI-44; D-37 and D-38 added.** Familiar consumer-app navigation patterns without visual imitation, English UI with selective Bangla helper text explaining business meaning (implements D-12, unchanged), the then-current four screen patterns (superseded by the 2026-08-20 stay-in-context model), four required states, mutation and POS rules, PrimeVue 4 as the component library. No business rule changed. Reason: the spec required every slice to ship a real UI and be accepted in the UI, but specified nothing about what a screen should look like or how it should behave — leaving each slice to invent its own, which is expensive to unwind at thirty screens |
| 2026-08-16 | **D-01 revised.** Single writer per tenant now bound to a **registered browser profile**, not a device — a different browser or cleared profile on the same PC is a different writer. Authority bound to a profile keypair, so copying OPFS files does not carry write authority. Sync matrix extended with SY-13…SY-16 |
