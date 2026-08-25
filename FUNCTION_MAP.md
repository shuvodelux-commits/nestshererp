# FUNCTION_MAP.md — what already exists and how to call it

**Read this before searching the codebase** (`AI_CODING_INSTRUCTIONS.md` R-T, `AGENTS.md`). Search
the source only for what this file does not answer, and then only in the area it points at.

**Update it at the end of every coding session**, in the same commit as the work: new entries,
changed behaviour, deleted entries for code that is gone.

**Scope.** An index of reusable code: where a thing lives and when to call it. Requirements live in
`SRS_AND_BUILD_GUIDE.md`, rules in `AI_CODING_INSTRUCTIONS.md`, the delivery record in §6.1.1. No
progress notes here. **If this file and the code disagree, the code is right** — fix the entry.

Started 2026-08-22, from the codebase as it stands at the end of the guided-CSV-import module. It
covers what is built (Phases 0–3 plus Phase 2's import); it is not yet a complete census of every
helper, so a `grep` that finds something reusable and unlisted should end with an entry added here.

---

## 1. Shared primitives — `packages/shared-utils/src/`

The bottom of the dependency graph; depends on nothing. **Never do arithmetic on money or quantity
without these** (R-C2/R-C3: floats on money or stock are forbidden).

| Name | Location | What it does | When to reuse |
|---|---|---|---|
| `Money`, `MONEY_SCALE` | `money.ts` | Integer poisha, scale 2: `add`, `subtract`, `multiply(Qty)`, `allocate(ratios)`, `format()` | Any amount of money, anywhere, including test expectations |
| `parseMoney` | `money.ts` | Text → exact poisha, or `null`. Refuses a third decimal rather than rounding it away | Reading a typed or imported amount |
| `Qty`, `QTY_SCALE`, `parseQty` | `qty.ts` | Scale-3 quantity, same operation set and the same refusals | Any stock quantity or reorder level |
| `UnitCost`, `UNIT_COST_SCALE` | `unit-cost.ts` | Scale-4 unit cost | Costing arithmetic; never store a cost at money scale |
| `divideRoundHalfUp`, `multiplyScaled`, `formatScaled`, `parseScaled` | `scaled.ts` | D-31's half-up rounding, applied once | Any new scaled arithmetic — do **not** write a second rounding rule |
| `Ulid.generate(clock)`, `Ulid.isValid` | `ulid.ts` | Application-generated ids (R-C1) | Every primary key and every `operation_id`; no autoincrement anywhere |
| `Clock`, `SystemClock`, `FixedClock` | `clock.ts` | The only file allowed to call `new Date()` (R-C8) | Inject it; `FixedClock` in tests |
| `businessDateAt`, `startOfBusinessDay`, `endOfBusinessDay`, `parseInstant`, `addSeconds` | `clock.ts` | Tenant-local day ↔ UTC instant (§3.5) | Any date filter or stored day boundary — convert server-side, never in SQL or the browser |

## 2. Domain — `packages/core-domain/src/` (pure; imports only shared-utils and zod)

| Name | Location | What it does | When to reuse |
|---|---|---|---|
| `fixedAccount`, `parameterisedAccount`, `parseAccountCode`, `FIXED_ACCOUNTS` | `accounting/account.ts` | §2.4's **closed** account list as a branded type | Every journal line. A code not on the list is an R-H stop, not a new string |
| `rejectEntry`, `entryTotalMinor`, `reverseEntry` | `accounting/journal-entry.ts` | Balanced-entry rule (INV-01); reversal negates every line | Posting or reversing anything |
| `openingStockPosting` | `inventory/opening-stock.ts` | Opening quantity + unit cost → movement/lot/journal figures | Any opening-stock path |
| `stockAdjustmentPosting`, `rejectStockAdjustment`, `STOCK_ADJUSTMENT_REASONS` | `inventory/stock-adjustment.ts` | §5.10 corrections; `DR/CR INVENTORY ↔ STOCK_ADJUSTMENT` | Damage, recount, theft, found stock |
| `costIssue`, `allocateLots`, `averageAfterReceipt`, `stockValueMinor`, `unitCostFromMoneyMinor` | `inventory/costing.ts` | FIFO/FEFO allocation and moving average (DR13.x) | Consuming stock or valuing it — the **only** costing implementation |
| `stockStatus` | `inventory/stock-status.ts` | Qty + reorder level → `IN_STOCK`/`LOW_STOCK`/`ZERO_STOCK`/`NEGATIVE_STOCK` | Any stock-level badge or filter; never re-derive in Vue |
| `toBaseQty`, `splitToMixed`, `pricePerConversionUnit`, `pricePerBaseUnit`, `rejectConversion` | `catalog/unit-conversion.ts` | D-41's one optional conversion unit; `5 Pipe + 5 Feet (105 Feet)` | Two-box quantity entry (Purchase/POS) and mixed stock display |
| `rejectPricing`, `offerAppliesAt`, `displayNameOf`, `blankToNull` | `catalog/product.ts` | Price/discount/offer validity; `Brand + Name` display rule | Product create/edit and any price proposal |
| `rejectParty`, `normalizePhone`, `customerPhoneKey`, `isPhoneShaped`, `PARTY_ROLES` | `parties/party.ts` | D-02 customer-phone rule and party shape | Any party write |
| `isValidCatalogName`, `normalizeCatalogName`, `catalogNameKey` | `catalog/catalog-name.ts` | One naming rule for units/brands/categories/groups | Any master-data name |
| `parseCsv`, `toCsv` | `import/csv.ts` | CSV as Excel writes it: BOM, CRLF, quoted commas/newlines, doubled quotes; spreadsheet row numbers preserved across blank lines | Reading or generating any CSV |
| `IMPORT_COLUMNS`, `importTemplate`, `missingColumns`, `valuesOf`, `readProductRow`, `readCustomerRow`, `readSupplierRow`, `readOpeningStockRow`, `isCalendarDate` | `import/templates.ts` | The closed column template per import type, and one row → typed draft + per-cell errors | Adding an import type, or rendering the template/preview in the UI |
| `licenseStateAt`, `licenseAllowsWrites` | `licensing/license-state.ts` | D-36's `ACTIVE → GRACE → READ_ONLY` ladder | Deployment/licence questions |

## 3. Cross-cutting ports — `packages/core-application/src/ports/`

Interfaces here, PostgreSQL implementations in `packages/adapter-postgres/src/`. Every Class T write
uses all of them in R-D's ten steps, in one transaction.

`TenantContext` · `AccessControl.require/permissionsOf` · `PeriodGuard.assertOpen` ·
`AuditWriter.append/appendPlatform` · `IdempotencyStore.find/save` · `Outbox.append` (D7 — never
remove) · `NumberingService.allocate` · `UnitOfWork.run/runWithoutTenant` · `EntitlementProvider` ·
`IdentityVerifier` · `GoogleVerifier` · `PasswordHasher` · `TokenIssuer` · `OtpCodeGenerator`.

`CreateNoteService` (`notes/create-note-service.ts`) is the **reference ten-step use case** — copy
its shape for a new Class T write. `entryModeFor` from the same file classifies backdated entries.

## 4. Application services (use cases) — `packages/core-application/src/`

**One owning service per business action; a new screen is a caller, never a second writer**
(A11/A14). All are exported from `packages/core-application/src/index.ts`.

| Service | Location | Owns | Notes for callers |
|---|---|---|---|
| `ManageProductsService` | `catalog/manage-products-service.ts` | Product list/get/create/update/status/delete/barcode | `create` (own transaction, idempotent) · **`createWithin(tx, ctx, input, source)`** for a caller that already owns the transaction · `validate(tx, ctx, input, selfId)` is public and reusable for a dry run |
| `ManageCatalogService` | `catalog/manage-catalog-service.ts` | Units, brands, categories: add/rename/remove with §3.6 delete-or-archive | Tells the caller which of delete/archive happened |
| `ManagePartiesService` | `parties/manage-parties-service.ts` | Customers/suppliers/vendors over one `parties` table, **and their opening balances** | `create` · **`createWithin(tx, ctx, input, source)`** · `validate(...)`. Enforces D-02, hidden-field rules, walk-in immutability. Openings: `getOpening` · **`setOpening`** (a party created without one; refuses a second opening for the same role) · **`correctOpening`** (§2.5 reversal-and-repost, D-32 version, both business dates period-guarded). Any later screen that opens or corrects a party balance calls these — never a second posting path |
| `ManagePartyGroupsService` | `parties/manage-party-groups-service.ts` | Customer groups (§3.6 rules) | Behind the `customer_groups_enabled` setting |
| `ManageInventoryService` | `inventory/manage-inventory-service.ts` | Opening stock, stock adjustment, stock/lot/movement/valuation reads | `recordOpening` · **`recordOpeningWithin(tx, ctx, input)`** (accepts an optional `unitCostMinor`; `null` = product purchase price) · `adjustStock` · `valuation()` proves INV-05 |
| `ImportDataService` | `imports/import-data-service.ts` | Guided CSV import: `preview` (writes nothing) and `commit` (whole file, one transaction) | Creates nothing itself — routes every row to the three services above. Add an import type here plus a template in `core-domain/import/templates.ts` |
| `ManageUsersService`, `ManageRolesService`, `GetMyAccessService` | `users/`, `auth/get-my-access-service.ts` | Staff accounts, roles, permission matrix | Class S/M paths; step-up is the caller's own password. `GetMyAccessService` also returns **`features`** — the §5.21 toggles that are on, read through `effectiveSettings` so an untouched setting reports its default — because the shell must hide Vendors/Customer Groups without `settings.setting.view` |
| `ManageSettingsService` | `settings/manage-settings-service.ts` | §5.21 settings; `feature-dependencies.ts` holds `effectiveSettings`/`settingValuesOf`/`isFeatureOn` | **Use `isFeatureOn` for any feature gate** rather than reading a row |
| `LoginService`, `CompleteRegistrationService`, `RegisterWithGoogleService`, `RequestSignupOtpService`, `VerifySignupOtpService`, `RequestPasswordResetService`, `ResetPasswordService`, `ChangeCredentialsService` | `auth/` | Signup, login, OTP, password/PIN (D-07) | Class S: no period guard, no journal, never audit a secret |
| `provisionTenant` | `auth/tenant-provisioning.ts` | Everything a new tenant is seeded with (roles, units, walk-in customer) | Anything every tenant must own from day one goes here **and** into `backfill-seed-roles.ts` |
| `ListAuditEventsService`, `RecordPermissionDenialService` | `audit/` | §5.22 audit trail and denial auditing | Denials are written in their own transaction |
| `GetDashboardSummaryService` | `auth/get-dashboard-summary-service.ts` | Dashboard tiles | — |

## 5. Repositories — interfaces in `core-application`, PostgreSQL in `adapter-postgres`

Business-specific by design (D-14, R-B7): **no `BaseRepository`, no generic CRUD**. They contain no
business rules (R-B6).

| Interface | Useful methods |
|---|---|
| `ProductRepository` | `list`/`count` (keyset, sort allow-list) · `findById` · `findIdBySku` · `findIdByBarcode` · **`findIdsByName`** (returns *every* match — two products may share a name) · `insert`/`update` (optimistic lock returns false on stale version) · `setStatus`/`setBarcode`/`deleteUnused` · `countUsingUnit|Brand|Category` |
| `CatalogRepository` | `listUnits`/`listBrands`/`listCategories` (use these for name→id resolution, one query per import, not per row) · `find*` · `insert*`/`rename*`/`delete*`/`archive*` · `countSubcategories` |
| `PartyRepository` | `list`/`count` (rows carry the INV-06 `balanceNetMinor` **and `hasLedgerEntries`**, both from the journal in the row's own query; `balance` is a sort key ordered by that same subquery) · `findById` · `findCustomerIdByPhone` · `insert`/`update`/`setStatus`/`deleteUnused` · **`findOpening`** (returns `PartyOpeningRow` — id, number, direction, amount, business date, version) · **`correctOpening`** (`PartyOpeningCorrection`; document takes the new figure, one four-line journal entry reverses and reposts; returns `false` on a stale version) · `listLedgerLines` · `listGroups`/`findGroup`/`insertGroup`/`renameGroup`/`archiveGroup`/`countInGroup` |
| `InventoryRepository` | `findDefaultLocation`/`createDefaultLocation` · `insertOpening`/`findOpeningBy{Id,Product,OperationId}` · `insertAdjustment`/`findAdjustmentByOperationId` · `findStockPosition` · `listCostLayers` · `listStock`/`listMovements`/`listLots`/`listCostStates`/`listValuationLots`/`listInventoryJournalAmounts`/`listCostAdjustments`/`listAdjustments` · `productHasStockHistory` |
| `SettingsRepository`, `AuditQueryRepository`, `NoteRepository`, `OtpRepository`, `SessionRepository`, `RegistrationRepository` (tenants/users/roles/identifiers) | as named |

Shared adapter helpers: `keyset-sort.ts` (`afterCursor`, `orderBy`, `joinedName` — §3.9 keyset
paging, `OFFSET` is banned), `unit-of-work.ts` (`txOf` unwraps the opaque `Tx`), `schema.ts` (every
Drizzle table), `migrator.ts`.

## 6. Contracts — `packages/core-contracts/src/`

Zod schemas and DTOs shared by API and web; money fields carry a `Minor` suffix and are integers.
`errors.ts` holds `AppError`, `ErrorCode` and `httpStatusFor` — **throw `AppError` from application
code**, never a framework exception. `permissions.ts` holds every permission code (add one → update
`SEED_ROLES` → run `pnpm db:backfill`). `sorting.ts` holds the per-endpoint sort allow-lists.
Files: `auth`, `users`, `roles`, `settings`, `audit`, `catalog`, `products`, `parties`,
`inventory`, `imports`, `notes`.

## 7. HTTP API — `apps/api/src/`

Controllers are ≤20 lines: parse DTO → call use case → map result (R-B5). Guards/filters worth
knowing: `TenantContextGuard` + `@Ctx()` (tenant from JWT, never from the body), `AppErrorFilter`,
`DenialAuditInterceptor`, `ReadOnlyLicenseGuard` (refuses non-GET in D-36 `READ_ONLY`),
`TraceIdMiddleware`, `common/cors.ts` (**the allowed-header list; `idempotency-key` must stay**).

Current routes — auth/registration `/api/v1/auth/*`, `/api/v1/me`, `/api/v1/dashboard/summary`,
`/api/v1/users`, `/api/v1/roles`, `/api/v1/settings*`, `/api/v1/audit-events`, `/api/v1/catalog*`,
`/api/v1/products*`, `/api/v1/parties*` (including `/parties/:id/ledger` and
`GET|POST|PATCH /parties/:id/opening`), `/api/v1/party-setup*`, `/api/v1/inventory*` (overview,
adjustments, cost-adjustments, lots, openings, valuation), `/api/v1/imports` + `/imports/preview`,
`/health`. Creates take the operation id from the `Idempotency-Key` header.

## 8. Web — `apps/web/src/`

| Piece | Location | When to reuse |
|---|---|---|
| `request()`, `ApiError`, `loadConfig()` | `api/client.ts` | Every call. Handles the runtime `/config.json` base URL (UI-07), token renewal and the error envelope |
| Typed API modules | `api/{auth,users,roles,settings,audit,catalog,products,parties,inventory,imports}.ts` | One module per resource; add functions here, never `fetch` from a component |
| `useSession()` | `auth/session.ts` | Token, username, `can(permission)` — the source for hiding actions (UI-09) — and **`featureEnabled(settingKey)`** / `setFeatures`, the same hint for a §5.21 feature. Both draw the screen; neither gates anything, because every endpoint re-checks |
| `AppShell` / `AppLayout` / `AppSidebar` / `AppSidebarNav` / `AppTopBar` / `ModuleFeatureNav` | `components/shell/` | Every page. `AppShell` owns title, breadcrumb, Bangla helper line, actions slot **and page spacing** — never add page-level margins |
| `navigation.ts` | `components/shell/` | The single navigation source (category → subcategory → feature), permission/feature filtered. A new route is registered here and in `router.ts` |
| `AppCard`, `StatCard`, `EmptyState`, `ErrorNotice`, `SearchField`, `SortableHeader`, `HelpTip`, `DateOnlyPicker`, `QuickAddSelect`, `ManageListDialog` | `components/` | The four states, sortable headers (UI-46), inline quick-add (D-39/UI-45), picker management (UI-51) |
| `ProductForm`, `StockAdjustDialog`, `StockLotsDialog` | `components/` | The product dialog is one component used by the list and `/products/:id` |
| `PartyOpeningDialog` | `components/parties/` | Set or correct a party's opening balance. It reads the posted opening back before it opens, so a correction starts on the real figure, and it carries the D-32 version through — reuse it wherever an opening balance is edited |
| Design system | `design/{tokens,components,preset,theme,tones}.ts/css` | Colours are tokens (`--sher-ok/warn/bad/info`, tile tones); PrimeVue 4 preset. Do not write page-specific control CSS |
| `design/print.css` | `design/` | **The global print rules** — hides the shell (sidebar, top bar, bottom nav, footer, breadcrumb), PrimeVue overlays and anything marked `no-print`, unclips the fixed-height scroller so a long document flows over pages, and drops to black on white. Any printable surface reuses it and marks its own controls `no-print`; a scoped `@media print` block in a page **cannot** reach the shell, which is the bug this file exists to prevent |
| Pages | `pages/` | Dashboard · Login/Register/ForgotPassword/GoogleCallback · Users · Roles · Audit · Catalog · Products · ProductForm · Parties · PartyForm · **PartyLedger** (the party working hub: balance header, statement, opening, contextual actions) · InventoryReport · **Import** · Settings · SettingsSecurity |

### Selling (Phase 6, §5.7 · §5.8)

**Domain — `core-domain/src/sales/sale.ts`.** `saleTotals(draft)` totals a cart (line discount, bill discount spread by value per §3.3, grand total, due, change) and is called **from the browser too**, which is what keeps the POS and the posting service arithmetically identical. Also `rejectSale`, `salePosting` (one entry: cash/bank per account, AR, SALES, COGS/INVENTORY, CUSTOMER_ADVANCE, VENDOR_PAYABLE), `receiptPosting`, `allocateReceipt` (delegates to `allocateOldestFirst`; the remainder becomes an advance), `ageingBucket`.

**shared-utils.** `amountInWords(minor, 'EN' | 'BN')`, `toBengaliDigits(text)` — the printed invoice only; the app stays in Western digits (UI-47).

**Application — `core-application/src/sales/`.** `CreateSaleService` (WRITE CLASS T), `ReceiveCustomerPaymentService` (both entry points, oldest-first), `CancelSaleService` (§2.5 reversal, never a delete), `InvoicePresentationService` (display-only overrides + invoice settings + logo), `SaleQueryService` (list, detail, customer standing, POS grid), `QuotationService`.
`ManagePartiesService.createWithin` is what a due sale calls to create the customer inside its own transaction — there is one party writer.
`PartyRepository.findWalkInCustomer` — the party a fully paid guest sale posts against.
`ManageProductsService.saveImage` / `.image` — the product thumbnail.
`resolvePaymentAccount` (in `purchasing/payment-account.ts`) is shared by every money path and refuses a cash payment on a day nobody started with `reason: CASH_DAY_NOT_STARTED`.

**Repository.** `SaleRepository` / `PostgresSaleRepository` — what an invoice still owes is always `grand_total − paid_minor − Σ receipt_allocations`, computed in the same statement as the row.

**Contracts.** `core-contracts/src/sales.ts`; `ErrorCode.INSUFFICIENT_STOCK` (422) carries `NEGATIVE_STOCK_BLOCKED` or `NEGATIVE_STOCK_CONFIRM`.

**API.** `/api/v1/sales` (+ `pos-products`, `invoice-settings`, `invoice-logo`, `:id/presentation`, `:id/cancel`), `/api/v1/customer-payments`, `/api/v1/customers/:id/standing`, `/api/v1/quotations`, `/api/v1/products/:id/image`.

**Web.** Pages `PosPage`, `SalesPage`, `InvoiceDetailPage`, `InvoiceSettingsPage`.
`components/sales/`: `InvoiceDocument.vue` (one renderer for preview, A4, 80mm and the shared JPG; bilingual by `settings.language`), `InvoicePreviewDialog.vue`, `ReceivePaymentDialog.vue`, `cart.ts` (`cartTotals`), `invoice-output.ts` (`printNode`, `saveNodeAsImage`, `shareNodeAsImage` — no PDF library), `image-upload.ts` (`resizeImage`, shrinks in the browser, never on the server).
`components/fields/AmountInput.vue` — the number box that emits on **every keystroke**; PrimeVue's `InputNumber` commits on blur, which is why totals lagged.
`components/ConfirmDialog.vue` — the last look before money posts, showing the amount in Bangla words.
`state/data-freshness.ts` — `markDataChanged()` is raised by `request` after every non-GET, and `onDataChanged(fn)` re-reads any screen showing a journal-derived figure.

### Corrections and adjustments (Phase 7, §5.11 · §5.12 · §5.13 · §5.19)

**Domain.** `sales/sales-return.ts` — `salesReturnTotals` (apportions a sold line by quantity, last returnable unit carrying the remainder), `salesReturnPosting`, `refillLots` (newest consumption first). `purchasing/purchase-return.ts` — `purchaseReturnTotals` and `purchaseReturnPosting`, where the gap between the lot's `actual_unit_cost` and what the supplier billed lands in `STOCK_ADJUSTMENT`. `inventory/stock-count.ts` — `countTotals`. All three are called **from the browser too**, which is what keeps a modal's figures and the server's identical.

**Application — `core-application/src/returns/`.** `CreateSalesReturnService` (WRITE CLASS T; refund caps read off the role, PIN approval through the same `PasswordHasher` a login uses), `CreatePurchaseReturnService`, their query services and repositories. `purchasing/void-purchase-service.ts` — cancelling a bill. `CreatePurchaseService.correctionOf` — **a correction is the create path**, so there is one purchase writer; it reverses the original and keeps its number. `ManageInventoryService.adjustStockWithin` — one stock change inside somebody else's transaction, which is how the count sheet posts N differences atomically (the split the importer made with `createWithin`). `expenses/manage-expenses-service.ts`, `inventory/stock-count-service.ts`, `periods/manage-periods-service.ts` (close only — there is no reopen).

**Contracts.** `returns.ts`, `expenses.ts`, `periods.ts`, count schemas in `inventory.ts`; `ErrorCode.APPROVAL_REQUIRED` (403) is what opens the PIN dialog and nothing else raises it. `roles.ts` carries `cashRefundPerReturnMinor` / `cashRefundPerDayMinor`.

**API.** `/api/v1/sales-returns` (+ `returnable/:saleId`), `/api/v1/purchase-returns` (+ `returnable/:purchaseId`), `/api/v1/purchases/:id/void`, `/api/v1/expenses` (+ `categories`), `/api/v1/stock-counts`, `/api/v1/periods` (+ `close`).

**Web.** Pages `SalesReturnsPage`, `PurchaseReturnsPage`, `ExpensesPage`, `StockCountPage`, `PeriodsPage`. `components/sales/SalesReturnDialog.vue` and `components/purchasing/PurchaseReturnDialog.vue` — opened from the invoice and the bill, never from a menu of their own. `components/money/RecordExpenseDialog.vue`. The count sheet is **the one Phase 7 screen that is a page**: one product is a dialog, the whole shelf is not.

## 9. Business rules worth knowing before writing code

- **Ten-step write path** for money/stock/document writes, in one transaction (R-D). Master data and
  security writes use the smaller Class M/S paths — never fake a period or journal step.
- **A whole import posts in one transaction**; that is why the three owning services expose
  `createWithin`/`recordOpeningWithin`. Any other batch operation should do the same rather than
  looping over a public `create`.
- **Cost is never in a response body without `inventory.cost.view`** — omitted, not blanked
  (UI-40); assert against the serialized body.
- **Cross-tenant reads return 404**, never 403.
- **§3.6 delete-or-archive**: master data nothing refers to is deleted, anything in use is archived
  or refused, and the caller is told which happened.
- **A product has exactly one opening**; later corrections are stock adjustments.
- **A party has at most one opening per role**, and correcting it never edits the journal: one
  entry reverses the old posting and posts the new one, so the statement shows what the figure was,
  that it was corrected, and what it became (§2.5). Corrections are numbered `OBC-<year>-<seq>`.
- **The optional party fields are per-shop toggles, not per-role.** `guardianName`, `nid`, `email`
  and `notes` (labelled **Description**) apply to customers, suppliers and vendors alike, gated by
  the `customer_field_*_visible` settings; guardian and description default **on**, NID and email
  **off**. A hidden field is never cleared — supplying one is refused on create and ignored on edit.
- **A party with any journal line cannot be hard-deleted** — `hasLedgerEntries`, not a settled
  balance, is the §3.6 test, and the row menu and the server answer it the same way. Any later
  module that refers to a party *without* posting must add its own check to `assertNeverUsed`.
- **Golden invariants** INV-01…INV-05 are asserted in `apps/api/test/support/invariants.ts` via
  `assertGoldenInvariants(pool, tenantId)` — call it in an `afterEach` of any spec that posts money
  or stock.
- **Test support**: `apps/api/test/support/database.ts` (`prepareTestDatabase`, `resetDatabase`,
  `seedTenant`, `asTenant`, `todayIn`) and `support/auth.ts` (`signToken`). `seedTenant` inserts
  rows directly and does **not** run `provisionTenant`, so seeded units and the walk-in customer are
  absent unless the test creates them.

## 10. Operational

- `pnpm dev` (root) builds the API workspace and runs it; it does **not** load `apps/api/.env` —
  see `DEV_SERVER_START_GUIDE.md`. Rebuild with the workspace (`pnpm --filter "@sher/api..." build`),
  never `apps/api` alone, or the server runs against a stale `core-contracts/dist`.
- `pnpm db:migrate` after a new migration; `pnpm db:backfill` after adding a permission code or
  anything else `provisionTenant` seeds.
- Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test:boundaries`, `pnpm test`.
