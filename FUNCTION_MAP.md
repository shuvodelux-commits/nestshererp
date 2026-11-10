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

### Phase 8.2 inventory origins and vendor settlement

| Intent | Authoritative implementation | Reuse / extension point |
|---|---|---|
| Post a normal, vendor-credit or mixed-source sale | `core-application/src/sales/create-sale-service.ts` — `CreateSaleService.create`, private `mixedStockLine` | Always call this sale writer. Non-serial owned lots are forced first; exact serial selection overrides quantity; one vendor and permitted negative remainder may complete the line. Vendor role alone is accepted, but payment on that sale is refused so the receipt remains separate. |
| Persist/read/reverse exact sale origins | `core-application/src/sales/sale-repository.ts`; `adapter-postgres/src/sale-repository.ts` | `sale_line_source_allocations` is immutable. `reverseSale` restores owned/vendor lots, negative owned position and exact serials, then appends `SALE_CANCELLATION` reversal rows. `listOpenInvoices` includes vendor-product settlement allocations in its derived outstanding. |
| Correct a sale | `CreateSaleService.create({ correctionOf, correctionVersion })` + `CancelSaleService.cancelWithin` | One transaction reverses the old authoritative allocations and creates the replacement sale/allocation rows. POS passes the old source split and serial labels; never cancel first from the UI. |
| Return or void-return a mixed sale | `returns/create-sales-return-service.ts`; `adapter-postgres/src/sales-return-repository.ts` | `sourceAllocations` apportions a partial return across unreversed origins. Return restores the same owned lot/vendor receipt lot/serial and appends reversal rows; void reads those rows and restores the captured serial lifecycle, refusing when exact goods moved again. |
| Allocate landed cost | `core-domain/src/purchasing/landed-cost.ts` — `rejectLandedCost`, `allocateLandedCost`; `core-application/src/purchasing/landed-cost-service.ts` — `add` / `addWithin` | Purchase Value, Quantity and Manual use one allocator. Manual requires one exact share per purchase line. `AddLandedCostService.addWithin` is the composable Class-T writer used by vendor settlement. |
| Create purchase inside a larger transaction | `core-application/src/purchasing/create-purchase-service.ts` — `createWithin` | Normal purchase, lot receipt, inventory valuation, AP and serial purchase linkage. `vendorSettlement: true` accepts Vendor role without adding Supplier role; normal purchase permissions remain authoritative. |
| Receive vendor-owned stock/serials from POS | `VendorStockService.receive`; `VendorStockRepository.listSellableLots`; `SerialService.available` | Inline vendor creation creates no inventory. Post stock through the existing vendor receipt endpoint, then refresh. Vendor serial rows retain vendor + receipt + lot linkage. |
| Receive products against vendor receivable | `vendors/vendor-product-settlement-service.ts` — `VendorProductSettlementService.create`; `vendor-workspace-repository.ts` | One UOW composes `CreatePurchaseService.createWithin`, exact purchase serial insertion, `AddLandedCostService.addWithin`, AP/AR offset and oldest-first sale allocations. Net product value is capped by receivable; landed costs are separately funded and excluded from the cap. API: `POST /api/v1/vendor-workspace/product-settlements`. UI: `VendorProductSettlementDrawer.vue`. |

**Schema:** `0045_phase_8_2_inventory_origins.sql` adds manual landed-cost shares, source allocations/reversals, vendor serial provenance and vendor-product settlement allocations. `0046_phase_8_2_origin_hardening.sql` makes serial history reusable after return and tightens new origin rows.

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
- Gates: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:boundaries`. Run `pnpm test` only when the owner explicitly asks in the current conversation.

---

## 11. Purchasing extras — Phase 8 (§5.9 · §5.12 · §5.19 · §5.6 M07)

**Domain.** `purchasing/purchase-plan.ts` — `suggestFor` (the hybrid rule: velocity × cover days
less stock less what is on order, falling back to the reorder level under `MIN_SELLING_DAYS`),
`priorityOf`, `roundToPack`, `affordableQty`, `allocateBudget`, `comparePlanLines`, `planTotals`.
`purchasing/landed-cost.ts` — `allocateLandedCost`, `splitLateLandedCost`,
`DEFAULT_LANDED_COST_METHOD`. `inventory/serial-unit.ts` — `normalizeSerial`, `rejectSerialBatch`,
`serialsOutstanding`. `warranty/warranty-claim.ts` — `canMoveClaim`, `rejectClaimMove`,
`warrantyEndDate`, `warrantyCoversOn`. **Call these rather than writing the arithmetic again**: the
planner screen and the plan service both run `allocateBudget` and `planTotals` on the same numbers,
which is what stops the browser and the server disagreeing about a total.

**Application.** `PlannerService.plan` (read-only, posts nothing) · `PurchasePlanService`
(save/update/**decide**/remove/detail/list/**listOrders**/order — no idempotency key anywhere,
because a plan makes no financial write) · `AddLandedCostService.add` (Class T) · `SerialService`
(record/progress/available) · `WarrantyService` (lookup/create/move/detail/list) ·
`VendorStockService` (receive/returnStock/settlement/listReceipts).

**The plan's real flow (owner rework 2026-08-26), and the one to hold in mind:**

```
Planner  --Save-->  DRAFT plan  --Approve-->  APPROVED + one supplier order per supplier
                                --Reject-->   REJECTED
supplier order (OPEN)  --View-->  print / PDF / share
                       --Convert-->  seeds New Purchase  --save-->  order CONVERTED, names the bill
```

**There is no "send".** Approving is what creates the orders; nothing is transmitted anywhere, so
an order has no sent-at and no delivery state. `purchases.supplier_order_id` and
`supplier_purchase_orders.purchase_id` point at each other, written in the bill's own transaction.

**Two things are derived, never stored as counters:** how much of a plan line has been bought is a
SUM over posted purchase lines carrying `plan_line_id`, and a plan's status follows from that SUM
plus `closed_at`. Voiding a bill therefore makes the plan right again with nothing to unwind.

**Accounting.** A plan and a supplier order post nothing at all. A late landed cost posts
`DR INVENTORY` (by what the valuation actually moved) `+ DR COGS` (the share belonging to units
already sold) `+ ROUNDING` `/ CR AP or CASH`, dated **the day it is recorded** so a closed period is
never rewritten. Warranty posts through existing paths only: a replacement from own stock is
`ManageInventoryService.adjustStockWithin` with `counterAccount: WARRANTY_EXPENSE` (the new optional
parameter on `stockAdjustmentPosting`), and a cash settlement credits `WARRANTY_EXPENSE` back.
**No warranty receivable is ever created.** Vendor stock posts no journal entry in either direction;
the payable is created by the sale's deemed purchase (DR13.10), which already existed.

**Permissions (5):** `purchase.plan.view/manage`, `warranty.claim.view/manage`,
`vendor.stock.manage`. Entering serials rides on `purchase.bill.create`; adding a landed cost rides
on `purchase.bill.edit`. Cost, profit, margin and the budget are **absent** from planner responses
without `inventory.cost.view`.

**Web.** `PurchasePlanPage` is one page with three tabs — Planner · Saved Plans · Supplier
Orders — and is the only route (`/purchase-plans`); `PurchasePlanDetailPage` and
`SupplierOrderPage` are its detail views. Also `WarrantyClaimsPage`, `WarrantyClaimPage`,
`VendorStockPage`. Dialogs `AddLandedCostDialog`, `SerialEntryDialog`, `ClaimStepDialog`,
`VendorStockReceiveDialog`, `VendorStockReturnDialog`, `QuickAddProductDialog` (D-39 inline
create, mandatory fields only, same `createProduct` endpoint). API clients
`api/purchase-plans.ts`, `api/warranty.ts`, `api/vendors.ts`.

**Three UI rules settled while building this, binding beyond Phase 8:**

- **`qtyText(raw)`** (`components/money/money-text.ts`) is how a quantity is drawn: `12`, not
  `12.000`; at most two decimals; trailing zeros trimmed. It wraps `formatForDisplay` in
  `shared-utils/scaled.ts`. `Qty(x).format()` is the **storage** form — the exact inverse of
  `parseScaled` — and belongs in tests and round-trips, never on a screen. `taka()` already did
  the same for paisa. Sentences a shopkeeper reads use it too; audit `before`/`after` values
  deliberately keep the storage form.
- **A `Select` option's value is never `null`.** PrimeVue cannot match a `null` model to a
  `null` option, so the control draws blank and reopens instead of closing. "All"/"Unassigned"/
  "on account" get a real sentinel string, converted back to `null` where the request is built.
- **A list reloads from the control's own `@change`**, never from a `watch` on the bound ref, and
  a load must not write back into the ref a `Select` is bound to.

**`addDays(businessDate, days)` is now in `shared-utils/src/clock.ts`** — the only file allowed to
touch `Date` (R-C8). Three callers wanted it; use it rather than parsing a date string again.

**A cash account cannot pay out what it does not hold.** `resolvePaymentAccount` takes an optional
`outflowMinor`; when it is set and the account is `CASH`, a payment larger than the live balance is
refused with `CASH_ACCOUNT_SHORT`. Passed by the five outflow paths (purchase paid-now, pay
supplier, expense, customer refund, landed cost) and by nothing that takes money **in** — a receipt
must not be refused because the drawer is empty, and a bank account may legitimately be overdrawn.

**Raw SQL is not typechecked.** Two Phase 8 queries shipped with column names that do not exist
(`purchases.number`, `purchase_lines.location_id`) and only failed at runtime. After writing raw
SQL, check the columns against `information_schema` rather than against the Drizzle schema.

---

## 12. Reporting, dashboard and Daybook — Phase 9 (§5.20 · §5.27 · D-27)

**Domain.** `reporting/ageing.ts` — `reportAgeingBucket` (from the **document
date**, 0–30/31–60/61–90/90+), `isOverdue`, `daysOutstanding`, `ageingTotals`,
`REPORT_AGEING_BUCKETS`. `reporting/performance.ts` — `grossProfitMinor`,
`marginBp`, `stockTurnBp`, `productPerformance`, `rankMovers`, `PERCENT_BASIS`.
`reporting/target.ts` — `targetProgress` (run-rate projection). `sales/sale.ts`'s
older `ageingBucket` answers a **different** question (what one invoice's header
says about itself) and is deliberately untouched.

**shared-utils.** `daysInMonth`, `monthOf`, `monthRange`, `weekdayOf` joined
`addDays` in `clock.ts` — the only file allowed to touch `Date` (R-C8).

**Application.** `ReportQueryService` (`sales`/`purchases`/`stock`/`money`/
`performance`/`why`) · `ProfitTargetService` (`get`/`set`, WRITE CLASS M) ·
`DashboardService` · `GetDaybookService` · `MarkDayReviewedService` ·
`PrintDaybookService`. **None of them can post a business document**: they are
constructed without a period guard, numbering service, outbox or idempotency
store, which is the structural version of §5.27's "if `DaybookUpdateSaleService`
ever appears, the module has become a back door".

**Where a figure comes from — the rule to hold in mind.** Every *amount* is read
from `journal_lines` with the posting kernel's sign convention (debit positive,
so `SALES` and `AP` are negative). The journal has no product dimension, so the
groupings that need one read the sale/purchase lines that produced those journal
lines. Ageing is built from the **control account's lines**, oldest-debit-first
against each party's credits — which is why the rows equal `AR`/`AP` exactly
rather than approximately, and why the reconciliation line on the screen is a
real check rather than decoration.

**Repositories.** `ReportRepository`/`PostgresReportRepository`,
`DaybookRepository`/`PostgresDaybookRepository`. Raw `db.execute(sql\`…\`)` for
the aggregates; **bigints come back as strings** — `int()` in both files is the
only sanctioned conversion, and `instant()` normalises `created_at`, which
arrives as a `Date` from the builder and a string from a raw statement.

**Permissions (12).** `report.sales.view` · `report.purchase.view` ·
`report.stock.view` · `report.money.view` · `report.profit.view` ·
`report.target.manage` · `dashboard.card.view` · `daybook.view` ·
`daybook.view.all_users` · `daybook.view.entry_date` · `daybook.review.mark` ·
`daybook.print`. Cost columns need `inventory.cost.view` and profit columns
`report.profit.view`; both are **omitted from the response**, never blanked.

**API.** `/api/v1/reports/{sales,purchases,stock,money,performance,why,target}`
(`PUT` on target — one month, one target, no idempotency key), 
`/api/v1/dashboard/cards`, `/api/v1/daybook` (+ `review`, `print`, `prints`).

**Web.** Pages `SalesReportPage`, `PurchaseReportPage`, `MoneyReportPage`,
`DaybookPage`, and the filled `DashboardPage`. **There is no stock report page**:
`InventoryReportPage` is the stock report and gained cost-of-goods-sold and
margin sections; `/reports/stock` redirects to it. `components/reports/`:
`ReportScreen.vue` (the one filter-bar → tiles → table screen all the grouped
reports share), `WhyDialog.vue`, `ProfitTargetDialog.vue`, `report-range.ts`
(the preset buttons), `report-csv.ts` (reuses the domain's `toCsv`).
`components/daybook/DaybookSheet.vue` is the A4/80mm day-end report, printed
through the existing `printNode`. API clients `api/reports.ts`, `api/daybook.ts`.

**A Daybook row's menu is built from `row.actions`, decided by the server** —
the browser cannot know a document's status, its lot draw-down, the period lock
and the user's permissions. A kind whose module has no correction path yet
carries `blockedReason` naming where the shop does it instead, rather than a
menu item the server cannot honour (`daybook/daybook-kinds.ts`).

---

## 13. Corrections and cancellations — Phase 9.2 (§2.5)

**The rule the whole module is built on.** A posted document is **never**
mutated and **never** deleted. "Edit" reverses what was posted and re-posts the
corrected figures **under the same number**, in one transaction; "Delete" posts
one reversing entry and leaves the document standing, marked `VOIDED` with a
reason. Both facts stay in the journal, which is the only way a shopkeeper can
be shown what a figure used to be, that it was corrected, and what it became.

**Domain.** `corrections/correction-window.ts` — `correctionWindow(originalDate,
today, originalPeriodOpen)` decides where a correction lands and whether a
reason is compulsory; `cancellationDate(today)`. The owner's closed-period rule
lives here and nowhere else: **open month → the original date; closed month →
today, as a `PRIOR_PERIOD` adjustment carrying the original date**; a
cancellation always carries the day it was made. `inventory/costing.ts` gained
`averageUnitCostFrom(valueMinor, qtyRaw)` — the inverse of `stockValueMinor`,
which every reversal needs to wind a cached average back.

**Application.** `corrections/document-reversal-repository.ts` (port) and
`corrections/reverse-money-document.ts` (the shared half of a cancellation).
**One port for four document types** — expense, customer receipt, supplier
payment, cash movement — because each posted exactly one balanced entry and
moved no stock, so undoing any of them is the same three steps. It is a helper
called *from* the owning service, not a service: each module still checks its
own permission, applies its own refusals and writes its own audit entry, so
there is no second writer (A11).

**Who owns what:**

| Document | Correct | Cancel | Where |
|---|---|---|---|
| Expense | ✓ | ✓ | `ManageExpensesService.correct` / `.void` |
| Cash movement | ✓ | ✓ | `CashMovementService.correct` / `.void` |
| Customer receipt | ✓ | ✓ | `ReceiveCustomerPaymentService.correct` / `.void` |
| Supplier payment | ✓ | ✓ | `PaySupplierService.correct` / `.void` |
| Stock adjustment | — | ✓ | `ManageInventoryService.voidAdjustment` |
| Sales return | — | ✓ | `CreateSalesReturnService.void` |
| Purchase return | — | ✓ | `CreatePurchaseReturnService.void` |
| Purchase | ✓ (Phase 7) | ✓ (Phase 7) | `CreatePurchaseService.correctionOf` / `VoidPurchaseService` |
| Sale | — | ✓ (Phase 6) | `CancelSaleService` |

**Stock-bearing documents are not in the shared port and must not be.** A stock
adjustment, a sales return and a purchase return each unwind lots and cost
states as well, from the **stored** figures — an adjustment cancelled next
month at today's average would take a different value off `INVENTORY` than it
put on, and the account would stop equalling the valuation (INV-05). Their
repository methods are `reverseAdjustment`, `reverseSalesReturn` and
`reversePurchaseReturn`, each the mirror of its own insert.

**Two refusals worth knowing**: cancelling an increase whose stock has been sold,
and cancelling a customer return whose goods have been sold again — in both
cases the goods are not there to take back, and the message says so.

**Migrations 0037 and 0038.** 0037 adds `void_reason`, `correction_reason` and
`original_business_date` to the nine document tables. **0038 fixes a latent
Phase 7 bug**: `journal_entries_source_unique` allowed a document exactly one
journal entry, which would have refused the first correction of a bill; it is
replaced by a partial index over **original** postings only, so reversals
(`*_REVERSAL`) and corrections (`*_CORRECTION`) are additive. Document numbers
became unique among **live** rows only, which is what lets a corrected document
keep the number on the paper the shop filed.

**Permissions (7 new).** `sale.receipt.void` · `purchase.payment.void` ·
`expense.void` · `cash.movement.void` · `stock.adjustment.void` ·
`sales.return.void` · `purchase.return.void`. Correcting rides on the code that
recorded the document; cancelling is separate (§5.26). Owner and Manager hold
all seven, Accountant the four money ones, Cashier none.

**API.** `PATCH …/:id` corrects and `POST …/:id/void` cancels, on
`/api/v1/expenses`, `/api/v1/money/movements`, `/api/v1/customer-payments`,
`/api/v1/suppliers/payments`, plus `POST` void on `/api/v1/inventory/adjustments`,
`/api/v1/sales-returns` and `/api/v1/purchase-returns`.

**Web.** `components/CancelDocumentDialog.vue` — one modal for every
cancellation: what is being cancelled, what it will do in the shopkeeper's
words, one compulsory reason. `RecordExpenseDialog` takes an optional
`existing` and becomes a correction. `api/daybook.ts` holds `VOID_ROUTES`, the
map from a daybook row's kind to the owning module's endpoint — Daybook opens
the dialog and posts nothing itself (DR1). A row carries `documentVersion`, so a
cancellation started there carries D-32's optimistic lock.

**Migration 0039** adds `PRIOR_PERIOD` to the entry-mode check on eight tables.
A correction into a closed month is not an ordinary `CORRECTED` entry and must
not read as one: "why does August contain something that happened in July?" is
the first question anybody asks of a prior-period adjustment, and the mode is
what answers it.

**A period guard covers the day a reversal posts on, and only that day.** The
document's own month may be closed — that is precisely why the correction is
dated today — so guarding it as well would refuse the case the rule exists for.
`VoidPurchaseService` (Phase 7) still guards both and is the one path that
behaves differently; it is recorded in §6.1.1 row 9.2 as an open question.

**`period-repository` normalises `closed_at` through `parseInstant`.** It was
typed as a `Date` and arrives as a string from a raw statement, so **closing a
month crashed** before this. Any repository reading an instant out of raw SQL
needs the same treatment — see `instant()` in `report-repository.ts`.

---

## 14. Account reconciliation — Phase 11 (§5.17 · UI-70 · D-43)

**The rule to know before touching anything here: this module compares and links, and never posts.**
Its service takes no posting service, no numbering service and no period guard; its repository has no
write path to `journal_entries`, `journal_lines` or any document table. If reconciliation seems to
need to create, correct, re-date or cancel a transaction, the answer is always the owning module's
use case, called from the screen — never a new method on `ReconciliationRepository`.

### Domain — pure, `packages/core-domain/src/reconciliation/`

| Name | Location | What it does | When to reuse |
|---|---|---|---|
| `parseStatement` | `statement-parser.ts` | Positioned PDF text lines → `ParsedStatementLine[]` + problems + opening/closing/date range. Direction is read from the **running balance**, then a printed sign, then a keyword; a row nothing answers becomes a problem, never a guess | Any statement format work. Extend the patterns here, not in the extractor |
| `ExtractedTextLine` | `statement-parser.ts` | `{ page, y, text }` — the whole contract between the PDF library and the domain | Writing another extractor (a CSV importer feeds `ParsedStatementLine` directly instead) |
| `matchStatement` | `matching.ts` | Ledger rows × statement rows → `{ auto, suggested, conflicts }`, each pair carrying the reasons that produced it. Gates: equal amount **and** same direction; auto also needs reference-or-date agreement **and** uniqueness on both sides | Any matching. There is no second matcher |
| `MATCH_RULES` | `matching.ts` | Every threshold and weight in one constant | Tuning confidence — change it here, and no UI moves |
| `daysBetween`, `describeSimilarity` | `matching.ts` | Whole days between ISO dates; shared-word similarity 0…1 | Reusable, but similarity is a *supporting* signal only (never enough for a match) |

### Application — `packages/core-application/src/reconciliation/`

| Name | What it does | Notes |
|---|---|---|
| `ReconcileAccountService` | `start` · `workspace` · `list` · `saveMatch` · `removeMatch` · `complete` · `reopen` | Refuses CASH accounts (Daily Cash owns those), one draft per account, and every state a person may set. Auto matches are **computed on each read** and frozen only at completion |
| `ImportStatementService` | `upload` (store + parse + preview) · `confirm` (import the approved rows) · `readFile` | Extraction runs outside the transaction; a file that cannot be opened is refused, one with no text is kept and reported `UNREADABLE` |
| `StatementExtractor` (port) | Bytes → text lines | Implemented by `PdfTextExtractor` in `apps/api/src/infrastructure` |
| `ReconciliationRepository` (port) | Reads the ledger; writes only the four Phase 11 tables | `listLedger` returns `postingCount` — the version snapshot the later-edit rule compares |

### API and web

| Where | What |
|---|---|
| `apps/api/src/money/reconciliations.controller.ts` | `POST /api/v1/money/reconciliations`, `GET /:id`, `POST /:id/statement`, `POST /:id/statement/confirm`, `GET /:id/statement/:fileId/file`, `POST /:id/matches`, `DELETE /:id/matches/:matchId`, `POST /:id/complete`, `POST /:id/reopen` |
| `apps/api/src/infrastructure/pdf-text-extractor.ts` | pdf.js behind the port; groups text runs into visual lines by their y position. Loaded through a dynamic `import()` (the library is ESM, the API is CJS) |
| `apps/api/src/main.ts` | JSON body limit raised to 12 MB — statements and CSV imports travel in the body |
| `apps/web/src/pages/AccountReconcilePage.vue` | The two-pane workspace: our ledger left, the bank right, icon **plus word** for every status, sticky summary, click-to-highlight |
| `apps/web/src/components/money/StartReconciliationDialog.vue` | Dates only — the closing balance is confirmed at the end |
| `.../ImportStatementDialog.vue` | Upload → **editable preview** → import |
| `.../AddMissingEntryDialog.vue` | Picks the right owning workflow for a statement-only row and opens **that** dialog prefilled; posts nothing itself |
| `.../CompleteReconciliationDialog.vue` | Typed closing balance, live difference, and the blockers still in the way |
| `prefill` props on `RecordExpenseDialog`, `ReceivePaymentDialog`, `PaySupplierDialog`, `MoveMoneyDialog` | Optional and additive — how a statement's figures reach an owning form without reconciliation writing anything |

**Permissions:** `bank.reconciliation.view` · `bank.reconciliation.perform` · `bank.reconciliation.reopen`.

**Fixtures:** `apps/api/test/support/fixtures/{statement,scanned,corrupt}.pdf` — a text statement, a
scan with no text layer, and a file that is not a PDF. Reuse them rather than generating new ones.

---

## 12. Licence, backup and recovery — Phase 10 (§5.25 · §5.4 · D-15 · D-36)

**The owner's reframing of 2026-08-30 governs this whole section.** V1 is a **single-business
installation product**, not a shared SaaS service: one deployment, one database, one business, with
many users, roles and locations. `tenant_id`, `TenantContext` and the tenant-scoped repository
boundaries are untouched and must stay — they are architectural safety and future SaaS readiness.
SaaS signup, platform-operator tooling, central subscriptions and the SMS wallet are **deferred**,
disabled by configuration rather than deleted (§4.4).

**Domain.** `backup/archive.ts` — `archiveCompatibility` (SAME · FORWARD_MIGRATE · TOO_NEW ·
UNSUPPORTED_FORMAT), `archivesToDelete` (the 14-deep retention window), `archiveFileName`,
`ARCHIVE_VERSION`, `MANUAL_EXPORT_REMINDER_DAYS`. **Contracts.** `modules.ts` —
`LICENSED_MODULES`, `moduleOwning`, `licenceIncludes`. Most of SherERP is *not* in that registry
and cannot be: selling, buying, stock, money, people, settings and backup are core, and no licence
takes them away.

**Application.** `BackupService` (status · exportNow · runAutomatic · replaceSecret) ·
`RestoreService` (inspect · restore) · `ResetBusinessService.reset` · `LicenseStatusService`
(status · notice). Four ports in `backup/backup-ports.ts`: `ArchiveCodec`, `BackupFileStore`,
`BackupSecretStore`, `DatabaseDumpTool`. **None of these services posts a journal entry, allocates
a number or consults a period guard** — like reconciliation, they are constructed without the
collaborators that would let them.

**Two backup mechanisms, and they are not alternatives:**

```
.sherdb   encrypted · versioned · logical · the owner's portable copy
          restores across a version gap, refuses only into an empty installation
pg_dump   automatic · exact · same-version-only · never the owner's copy
          taken and verified before every migration and before every reset
```

**The archive's table list is discovered, never compiled in.** `PostgresBackupRepository` asks the
database which tables carry a `tenant_id` and exports every one except an explicit exclusion list —
ephemeral runtime state (`otp_codes`, `refresh_tokens`, `idempotency_keys`, `outbox`) and this
module's own machine-local bookkeeping (`backup_runs`, `restore_events`). **The exclusions are what
must justify themselves, not the inclusions**: a hand-kept include list is the list that silently
omits next month's module, and the omission surfaces mid-recovery. `backup.spec.ts` asserts it.

Write order comes from `pg_constraint` at run time, parents before children. A real cycle — a
purchase naming the supplier order it came from, that order naming the purchase it became — is
broken on a nullable column, written null, and filled by a second pass. Deleting walks it backwards.

**Forward migration is the import loop, not a registry of steps.** A column the archive has and this
build dropped is skipped; a column this build added takes its default; a column this build requires
that the archive cannot supply stops the restore **by name**, not as a constraint violation.

**Restore never deletes.** It refuses unless the installation is empty — "empty" meaning nothing
outside the set of tables provisioning writes — and names Reset Business Data as the separate step.
Restore adopts the archive's tenant inside one transaction via `runWithoutTenant`/`adoptTenant`, so
every inserted row satisfies the same RLS policy as everything else; nothing escapes row-level
security. Identity, users and credential hashes come from the archive; **entitlement comes only from
the licence on the destination machine** (D-08).

**Encryption.** AES-256-GCM, per-file salt and nonce, scrypt from one installation-level secret held
in a key file **outside PostgreSQL**. Never in a row, an archive, a log, a diagnostic bundle or an
API response, and never displayed. `WRONG_SECRET` / `DAMAGED` / `NOT_AN_ARCHIVE` are kept apart
because they send a shopkeeper to three different places.

**Where `modules[]` finally bites:** `PostgresAccessControl`, in one place, before the role check.
Unlicensed + never used → hidden (`permissionsOf` withholds it, so navigation stops rendering it,
UI-09). Unlicensed + holds data → readable, writes refused. Nothing else in the codebase asks about
entitlement, and nothing else should.

**Permissions (4):** `license.term.view` (permission only) · `backup.export`, `backup.restore`,
`business.reset` (permission **and** step-up; reset also demands the typed phrase). Seeded to the
**Owner alone**.

**Web.** `SettingsBackupPage` (`/settings/backup`) and `SettingsLicensePage` (`/settings/license`),
two plainly named Settings subcategories. Dialogs `RestoreDialog`, `ResetBusinessDialog`,
`ReplaceBackupSecretDialog`. `LicenseNotice` sits under the top bar in `AppLayout` and draws nothing
while the licence is healthy. Two dashboard warnings read `GET /api/v1/backup/status`.

**Operations.** `pnpm db:upgrade` (`apps/api/src/upgrade.ts`) is the only sanctioned upgrade path:
validate → dump and verify → migrate forward-only → health-check → automatic rollback on failure.
The API refuses to boot when its schema version and the database's disagree, in **both** directions.
It needs the PostgreSQL client tools (`pg_dump`, `pg_restore`) on the machine — as does Reset
Business Data, which refuses rather than clearing anything if they are missing. New environment
variables: `BACKUP_DIR`, `BACKUP_KEY_PATH`, `RECOVERY_DUMP_DIR`, `BACKUP_HOUR`.

---

## 15. Offline trading and sync — Phase 12.4 (§5.23 · D-01 · R-C10)

**One posting implementation, reached two ways.** Nothing under `core-application/src/sync/` posts,
numbers, computes a total or opens a transaction around a document. Replay parses the queued payload
with the online endpoint's own schema and calls the online endpoint's own service with the device's
`operationId`. If a replayed sale could differ from a counter sale, it would only be because the
service differed from itself.

| Intent | Authoritative implementation | Reuse / extension point |
|---|---|---|
| Turn a queued command into a posted document | `core-application/src/sync/operation-registry.ts` — `replayOperation` | The single map from the 13 `SyncOpType`s to their owning services. **A new offline-capable operation is added here and nowhere else**: give it the endpoint's schema and the endpoint's service. Never write a document from sync. |
| Take in a device's outbox | `sync/replay-service.ts` — `ReplayService.push` | Wire version first (a mismatch refuses the whole batch, nothing written), then dependency order, then one service call per operation. Records `IN_FLIGHT` → `APPLIED`/`DUPLICATE`/`QUARANTINED`/`BLOCKED` in short transactions **around** the service's own, never wrapping it. |
| Decide about a refused operation | `sync/resolve-conflict-service.ts` — `ResolveConflictService.resolve` | `RETRY` · `MERGE` · `KEEP_BOTH_EDIT` · `DISCARD_WITH_REASON`. The three that post go back through `replayOperation` against live state; there is no direct-write path and adding one would break the module's only safety argument. |
| Read the queue, serve a pull | `sync/sync-read-service.ts` — `status` · `conflicts` · `pull` | Pull is served from the master tables' own `updated_at` against the device's `sync_cursor`, composing `ManageProductsService.list` / `ManagePartiesService.list` as 12.3's snapshot does, so permissions are inherited rather than re-implemented. |
| Persist what was sent and what became of it | `sync/sync-repository.ts`; `adapter-postgres/src/sync-repository.ts` | `sync_operations` (kept forever, `UNIQUE (tenant_id, operation_id)` and `UNIQUE (tenant_id, device_id, local_seq)`) and `sync_conflicts` (one open row per operation). `OP_DOCUMENT_TABLE` maps an op type to the document table whose own `operation_id` index is the permanent idempotency guarantee. |
| Number a sale made on a device | `adapter-postgres/src/numbering-service.ts` | `S-{YEAR}-{DEVICE}-{SEQUENCE}`, counter keyed per (tenant, doc type, year, device code). `0` is central and device codes are letters, so the sets cannot collide. **Only `SALE` is per device**; every other doc type keeps its central counter. |
| Assign a device its permanent code | `apps/api/src/sync/device-code.ts`; `apps/api/src/backfill-seed-roles.ts` | Assigned once at registration, `^[A-Z]{1,3}$`, unique per tenant, never reused — it is printed on paper the shop files. ULIDs and per-tenant sequences come from application code (R-C1), which is why the backfill and not the migration assigns them. |
| Say who may work a machine while it is disconnected | `devices/manage-devices-service.ts` — `offlineUsers` · `setOfflineUsers`; `device_user_access` | Kept apart from roles deliberately: a role says what a person may do, this says where they may do it unwatched. The snapshot carries those users with their PIN hash and permissions. |
| Write at the counter with no line | `apps/web/src/offline/local-writer.ts` | The fallback lives in the **API layer**, where 12.3 put the read fallback — screens hold one write path. Only `NETWORK_UNREACHABLE` queues, only the `OFFLINE_RW` holder queues, and the local commit completes before the call returns. |
| Show work that is queued but not posted | `apps/web/src/offline/queued-documents.ts` — `QUEUED_NOTICE` | Shaped like the online responses so no form learns a second rendering path; server-filled fields are genuinely absent rather than faked. Queued is not failure and is never styled as one. |
| Send and catch up | `apps/web/src/offline/sync.ts` — `useSync` | Automatic the moment the line is steady, in typed order, 50 per batch, 30 s retry. **A network failure retries; a refusal does not** — retrying a refusal would hide the one thing Sync Issues exists to show. |
| Take the machine's day off the machine | `packages/adapter-sqlite-wasm/src/local-backup.ts`; `components/offline/OfflineBackupCard.vue` | `.sherbak` — the whole live database plus an authenticated manifest, AES-256-GCM, PBKDF2 310,000 rounds. Restoring returns the queue, operation ids, printed numbers and device sequence, and does **not** make the machine the offline writer. |

**API.** `apps/api/src/sync/sync.controller.ts` — `POST /api/v1/sync/push`, `GET /sync/pull`,
`GET /sync/status`, `GET /sync/conflicts`, `POST /sync/conflicts/:id/resolve`. Push carries the
**device key** in its body and pull takes it from an `x-device-key` header — a machine that is not
registered has nothing the shop can accept, whoever is signed in on it.

**Permissions (3), split by what the act costs when it is wrong:** `sync.status.view` (seeing the
queue costs nothing) · `sync.conflict.resolve` (hands the document back to a server that re-checks
every rule, so it can never post what the counter could not have posted online — a manager)
· `sync.conflict.discard` (**Owner alone**: the only action that leaves the books without a record
of something that happened; a CHECK constraint requires the reason).

**Web.** `pages/SyncIssuesPage.vue` at **`/sync`** — not under Settings, because an outage ending
with three refused documents is floor work during a shift. Tiles read *Waiting to send* ·
*Need review* · *Gone into the books*. `components/offline/SyncStatusChip.vue` keeps the count in
the top bar until the list is empty.

**Origin trail.** `origin_mode` · `origin_device_id` · `device_created_at` · `synced_at` ·
`device_seq` on thirteen document tables, never cleared, informational only. A synced offline
document is an ordinary posted document: same journal, Phase 9.2's correction paths, counted in
every report without qualification. `origin_device_id` alone could not carry the fact — an online
sale from the counter PC also names a device.

**Schema:** `0047_offline_sync.sql` (`sync_operations`, `sync_conflicts`, `device_user_access`,
device code + pull cursor, per-device numbering, origin trail on twelve tables) ·
`0048_offline_origin_cash_movements.sql` (the thirteenth) · `0049_sync_in_flight.sql` (the
`IN_FLIGHT` status that makes an interrupted replay detectable) · `0050_return_operation_uniqueness.sql`
(the two `operation_id` indexes both return tables were missing).

## 16. Licence key, cold offline sign-in, and the pre-release hardening — 2026-09-02

**Operator-side licence tooling — `tools/licence/`.** `keygen.ts` makes an
Ed25519 keypair; `issue.ts` signs a licence payload. Run them as
`pnpm licence:keygen -- …` / `pnpm licence:issue -- …`. **Never on a customer
machine.** `keyfile.ts` writes the private key to `~/.sher/licence-keys/`
(dir 0700, file 0600) — it must never reach the repository, a customer, or a
backup.

**Verifying and installing a licence — `apps/api/src/deployment/`.**
`license-codec.ts` → `Ed25519LicenseVerifier`; verify over
`SHERLIC1.` + the payload **re-canonicalised from the Zod-parsed object**
(`canonicalLicensePayload` in `packages/core-contracts/src/license-key.ts`),
never over the pasted text. `license-key-store.ts` → `FileLicenseKeyStore`
(read/install). `license-keys.ts` → `EMBEDDED_KEYS` (empty until the production
keypair exists). `license-machine-state.ts` → `MachineLicenseState.observe`,
the anti-rollback high-water mark, held **outside PostgreSQL and outside the
`.sherdb`**; it refuses a forward jump beyond 400 days rather than clamping.
Application side: `packages/core-application/src/licensing/` —
`LicenseInstallService.install` (audits a rejection in its own committed
transaction before throwing), `license-ports.ts`, `entitlement-binding.ts`.
Domain: `packages/core-domain/src/licensing/` — `license-clock.ts`
(`effectiveLicenseNow`, `clockBehindMs`, `advancedHighWater`),
`license-regression.ts` (`replacement_of` is the only signed way down),
`license-state.ts`. Web: `apps/web/src/api/license.ts`,
`apps/web/src/pages/SettingsLicensePage.vue`. Permission: `license.install`.

**READ_ONLY enforcement.** `apps/api/src/deployment/read-only.guard.ts` is the
one place a lapsed licence blocks a write. It allowlists read methods only —
**`/api/v1/sync/` is no longer exempt**, so `POST push` and
`POST conflicts/:id/resolve` refuse while READ_ONLY and the `GET`s stay open in
every state. Do not re-add the exemption; nothing in the replay path checks
entitlement.

**Cold offline sign-in — `apps/web/src/offline/`.**
`offline-session.ts` → `offlineSignInOptions()` (returns `users`, or an
`OfflineSignInBlock` with `NO_COPY` / `NO_USERS` / `ONLINE` that LoginPage
renders), `signInOffline()`, `startOfflineSessionWatch()` (hands the session
back when the line returns; wired in `AppLayout.vue`), `rememberFeatures()`.
`pin.ts` → `verifyPin(pin, encoded)` and `scrypt(...)`, a hand-written RFC 7914
implementation because `crypto.subtle` has no scrypt; the encoding is the
server's own `scrypt$N$r$p$salt$key` from
`apps/api/src/auth/password-hasher.ts`, and the two are verified to agree.
`useSession().signInOffline()` **always clears the online tokens** —
`isOfflineSession()` is `accessToken === null && offlineUser !== null`, and the
handover watch depends on it. `loadMyAccess()` returns
`'LOADED' | 'SKIPPED' | 'REFUSED' | 'UNREACHABLE'`: on `UNREACHABLE` it does
**not** blank permissions, because an offline session carries its own.

**Replay actor check.** `ReplayService.push` loads the device's permitted users
(`DeviceRepository.listDeviceUsers`) once per batch and quarantines any
operation whose `op.context.userId` is not among them, with reason
`PERMISSION_REVOKED`. An **empty list checks nothing**, deliberately — see the
comment in `replay-service.ts`.

**Offline reads with a local fallback.** Only two exist: `fetchProducts`
(`apps/web/src/api/products.ts` → `localProducts`) and `fetchParties`
(`api/parties.ts` → `localParties`), both through
`apps/web/src/api/offline-fallback.ts`, and **only** on
`NETWORK_UNREACHABLE` — never on a 403, because serving cached rows over a
refusal turns "you may not see this" into "here it is". **`fetchPosProducts`
and `fetchAccounts` have no local read**, which is why an offline sale is
currently due-only (`docs/NEXT_TASKS.md` TD-1).

**Serial unit statuses.** `packages/core-domain/src/inventory/serial-unit.ts` —
`IN_STOCK · SOLD · WITH_SUPPLIER · WRITTEN_OFF · RETURNED_TO_VENDOR ·
WARRANTY_REPLACEMENT`, matching the CHECK constraint (migrations 0033, 0051,
0052). `ACTIVE_SERIAL_STATUSES = ['IN_STOCK', 'WITH_SUPPLIER']` and must match
the partial unique index. `setStatus` takes the domain type, so a new status is
a one-line change in one place; it cannot enforce that `SOLD` requires a row
that already names its sale — the caller must.

**Security headers.** `apps/api/src/common/security-headers.ts`, mounted in
`main.ts` before every route: `nosniff`, `DENY`, `no-referrer`, and HSTS only
when the request arrived over TLS. No CSP — that belongs on the origin serving
the app.

**Environment.** `apps/api/.env.example` documents every variable **name** the
code reads, with its default. Required: `DATABASE_URL`, `JWT_SECRET`.

## 17. The vendor control plane and secure remote support — Phase 17 (2026-09-03)

**The one distinction that governs the whole module.** SherERP is still an
independently deployable installed product; the vendor now has a *management*
plane beside it. Four processes, and the line between them is enforced by
`pnpm test:boundaries` (`control-plane-no-erp-data-plane`): `apps/control-plane`,
`apps/agent` and `apps/admin` may not import `@sher/core-domain`,
`@sher/core-application` or either adapter. They manage installations; they do
not read a shop's books. `@sher/core-contracts` is the deliberate exception —
the licence format has to be byte-identical on both sides, and a second copy of
`canonicalLicensePayload` is how a vendor ends up signing keys customers cannot
verify (`apps/control-plane/src/licences/licence-payload.ts` says so in place).

| Process | Where | What it is |
|---|---|---|
| Control plane | `apps/control-plane` | Vendor backend. **Its own Postgres database** (`sher_control`), its own migrations, its own pool — never a shop's. |
| Operator console | `apps/admin` | Vue 3, port 5175, distinct dark/amber theme and a **persistent tenant banner**, so a live customer ERP embedded in an iframe can never be mistaken for the console around it. |
| Sidecar | `apps/agent` | A **separate process** on the shop's machine. Separate because a process cannot cleanly overwrite the files it is running from, and because it can report that the ERP is down. |
| Signer | `tools/signer` | Loopback-only, bearer-authenticated, one operation: sign. **The only process that ever reads a private key.** |

**The channel is outbound, always** (§1, §16). The sidecar POSTs a signed
check-in and its pending commands ride back on the response; a WSS reverse
tunnel is raised *only* while a support session is live and dropped when it
ends. No customer configures a port, a forwarding rule or a public URL, and an
installation with no live session has no channel into it at all.

**Shared contracts — `packages/control-contracts/`.** Types and canonical bytes,
no crypto, no I/O (the `@sher/core-contracts` discipline, same reasons).
`canonical.ts` → `canonicalJson` (sorted keys, no whitespace) and the four
signing prefixes `SHERCMD1` · `SHERAGT1` · `SHERSUP1` · `SHERREL1`, each **inside**
the signed bytes so a signature can never be lifted from one message type to
another. `command.ts` → `commandTypeSchema`, the eleven things a vendor may ask
for; **that enum is the security boundary**, there is no general case, and the
agent's switch has no `default`. `states.ts` · `identity.ts` · `support.ts` ·
`release.ts` · `flags.ts` · `operators.ts` (`ROLE_PERMISSIONS` written out as a
table, not derived).

**Identity — §3.** The dashboard mints a single-use enrolment token (72 h, only
its SHA-256 stored); the agent generates its **own** Ed25519 keypair on the
shop's machine and posts the public half; the control plane binds it and burns
the token, all in one transaction. The vendor never holds a customer's private
key. Identity binds to the ERP's own `tenant_id`, never a domain name (§2).
`agent-auth.guard.ts` checks five things in order — installation exists and is
not revoked · signature verifies against *that installation's* key · the body
hash inside the signed document matches the body received · the clock is within
five minutes · the nonce is unseen. The nonce insert *is* the replay check, and
it runs before any handler, so protection does not depend on an endpoint
happening to be idempotent.

**Commands — §17, §18.** Signed envelope carrying tenant, installation, type,
payload, issued-at, expires-at and an idempotency key. Idempotency is the unique
index `commands_idempotent`, not a convention. The agent refuses on
`TENANT_MISMATCH` · `INSTALLATION_MISMATCH` · `SIGNATURE_INVALID` ·
`UNTRUSTED_KEY` · `EXPIRED` · `UNKNOWN_TYPE`, canonicalising from the **parsed**
envelope rather than the received text. A machine handed work comes back in 10
seconds instead of 180 — on the other end of every command is an operator
watching a screen.

**Licences — §4, and nothing about verification changed.** `LicencesService`
asks the signer for a signature and queues a `LICENCE_REFRESH`; the sidecar
hands the key to the **existing** `LicenseInstallService`. Same signature check,
same business binding, same anti-rollback rules, same audit row as a pasted key.
`MachineLicenseState`, the grace ladder and `read-only.guard.ts` are untouched.
The Settings → Licence paste box stays exactly as it was — the offline renewal
path for a shop with no line. Delivery is tracked `ISSUED → DELIVERED →
INSTALLED → FAILED`. A vendor-side revocation stops renewal and marks the fleet
view; it **cannot** stop a paid-up shop trading (§20).

**Signing keys — §5.** `tools/signer/src/keys.ts`. Licence key stays where
`tools/licence` already writes it (`~/.sher/licence-keys/`); command, support and
release keys live in `~/.sher/control-keys/`, 0600 in a 0700 directory. Not in
the repository, not in the control-plane database, not in an environment
variable, not returned by any route. Every signature is appended to
`signer-audit.log` beside the keys, so the log and the database can be compared
after a compromise of either. `SignerClient` has **no fallback path** — no
local key, no "sign in-process for development"; the signer being down is a
plain refusal.

**Releases and deployment — §9, §10, §11.** A release is a `.tar.gz` of built
artifacts, hashed **from disk by the control plane** and Ed25519-signed. The
agent verifies signature *then* hash — the hash catches the truncated download,
the signature catches the substituted artifact. Pre-flight order is deliberate:
identity, version compatibility, then a real pre-update backup (through the
ERP's own `runAutomatic`, so it is an archive the restore path has actually been
exercised against). Then unpack to a versioned directory → migrate → **symlink
flip** → restart → health check, every stage reported. A migration failure keeps
the old build on the old schema, reports `MIGRATION_FAILED` with the failing
file, and **halts the whole job** — no queued target moves until an operator
clears it with a written reason. Rollback is offered only where it is genuinely
possible; a release that changed the database says so instead of pretending.

**Support — §12–§15, owner decisions 2026-09-03.** Access is **pre-authorized**
by the support arrangement: a Platform Owner opens a session without asking the
shop. That places the whole of containment on three things, so all three are
checked by the *installation*, on every request: the signature, the expiry, and
revocation. 30-minute sliding inactivity, **4-hour absolute ceiling** clamped by
`Math.min` on every renewal. The principal is **not a user row** — no password,
no PIN, nothing left behind — and it is recognised in exactly two places:
`apps/api/src/management/support-grant.ts` (`verifySupportGrant`, called from
`TenantContextGuard` so every existing route works unchanged) and
`packages/adapter-postgres/src/access-control.ts` (`SUPPORT_PRINCIPAL_PREFIX`).
It holds owner-equivalent reach **except** identity and erasure —
`SUPPORT_FORBIDDEN_PERMISSIONS` and `SUPPORT_FORBIDDEN_ROUTE_PREFIXES`, the same
list at both fences, because a route that forgot to declare a permission would
otherwise inherit the ceiling by omission.

**The grant carries two tenant ids and they are different things.**
`tenant_id` is the vendor's customer record; `erp_tenant_id` is the shop's own,
and it is the one the ERP acts on. Overloading one field cost a debugging cycle
during verification and would eventually have pointed a session at the wrong
business.

**Corrections go the ordinary way** (§14). The gateway attaches the grant and
forwards; the shop's ERP applies its own permissions, its own domain rules and
its own `AuditWriter`. There is no database connection anywhere in `apps/agent`
or in `apps/api/src/management/`, so there is no shortcut to take by accident.
Audit rows carry `support:<operatorId>`, permanently distinguishable from the
owner's own actions.

**What the shop sees.** `ProviderSupportNotice.vue` under the top bar — a small
non-blocking "Software Provider Support active", naming the operator and the
reason, polled once a minute. No Support History screen (the owner declined
one); the authoritative immutable record is `support_sessions` +
`support_actions` in the control plane, both append-only by database trigger.

**Diagnostics — §7, §22.** Hooked into `AppErrorFilter`, the one place every
failure passes through. Code · module · route **pattern** · status · correlation
id · versions · count. **There is no message field**, so redaction is structural
rather than a pattern list somebody has to keep current, and
`FORBIDDEN_DIAGNOSTIC_FIELDS` fails a future contributor loudly at the boundary.
4xx refusals are not reported — a shop's typing mistakes are not the vendor's
signal.

**Feature flags — §19.** Visibility and optional features only, from
`KNOWN_FEATURE_FLAGS`. Unknown or unreachable resolves to **enabled**
(`ManagementState.isEnabled`), so a vendor outage can never switch a customer's
features off. Costing, posting, VAT, period and ledger rules contain no flag
lookup at all — a switch that does not exist cannot be thrown.

**New ERP surface.** `apps/api/src/management/` — six token-guarded endpoints
(`status`, `diagnostics`, `licence`, `backup`, `feature-flags`,
`support-session`) plus `/api/v1/provider/status` for the shop's own shell.
Empty `MANAGEMENT_TOKEN` means the whole surface 404s, which is simply true of
an install sold without remote management (D-34's reasoning). New port
`ManagementProfileRepository` (`packages/core-application/src/ports/management-profile.ts`)
reads six deployment facts and **cannot** reach a business table.

**Environment.** ERP: `MANAGEMENT_TOKEN`, `SUPPORT_PUBLIC_KEY`, `APP_VERSION` —
all empty by default, and empty means off. Control plane: `CONTROL_DATABASE_URL`,
`CONTROL_JWT_SECRET`, `CONTROL_SECRET_KEY` (32 bytes base64, seals TOTP
secrets), `CONTROL_SIGNER_TOKEN`, `CONTROL_SIGNER_URL` (**refuses a non-loopback
host at boot**), `CONTROL_RELEASE_DIR`, `CONTROL_PUBLIC_BASE_URL`. Sidecar:
`SHER_CONTROL_URL`, `SHER_ERP_URL`, `SHER_ERP_MANAGEMENT_TOKEN`,
`SHER_RELEASES_DIR`, `SHER_RESTART_COMMAND`.

**Commands to run it.** `pnpm signer:keygen` · `pnpm signer` ·
`pnpm control:migrate` · `pnpm control:operator -- --email … --name … --password …` ·
`pnpm control:dev` (console) · `pnpm agent:enrol -- --token …` · `pnpm agent`.

---

## 18. Daily-first workflow UI, Global Search and E2E — Phase 18 (2026-09-03)

**No accounting, stock, permission or business-logic change.** Every screen
calls the use case it called before. Nothing under `packages/core-domain` was
touched, and the only new thing in `packages/core-application` reads.

### Global Search (18.1)

| Piece | Location | Notes for callers |
|---|---|---|
| `GlobalSearchService` | `core-application/src/search/global-search-service.ts` | **One transaction, one endpoint.** Reads `accessControl.permissionsOf` once and calls `ProductRepository.list`, `PartyRepository.list`, `SaleRepository.listSales` and `PurchaseRepository.listPurchases` with the same filter structs the owning lists pass — no query logic is duplicated, and products are ranked by the same `searchProducts` the POS uses. A caller missing a permission gets **no group**, never an empty one or a 403 |
| `globalSearchQuerySchema`, `GlobalSearchResponse` | `core-contracts/src/search.ts` | Hits carry `kind` + `id`, never a route: where a hit opens is the client's business |
| `SearchController` | `apps/api/src/search/` | `GET /api/v1/search?q=…` |
| `globalSearch()` | `apps/web/src/api/search.ts` | **Deliberately not cancellable** — `request()` reads a failed `fetch` as the line being down, so aborting a stale keystroke would flip the whole app offline. The palette drops out-of-order answers by sequence number |
| `GlobalSearchDialog.vue` | `components/shell/` | The `Ctrl K` palette. Records first, then a separately grouped `Go to…` built client-side from `resolveNavigation` — the two kinds never interleave |

### Navigation and the shared shapes (18.1–18.4)

- **`navigation.ts` reordered**: `Daily` is first and Dashboard is its first
  entry; the `overview` category is **gone** (feature id `daily.dashboard.page`).
  `settings.sync` is gone too — `/sync` is still a route and is now an
  `activePrefix` of `settings.offline.page`, so the sidebar lights up on it.
- **The list pattern** every daily screen now follows: page-level
  `<form class="filters">` above the card, `.field.grow` around `SearchField`,
  a `Clear` ghost button when filters are active, and **two** empty states —
  "nothing yet" with a create button, "Nothing matched" with a clear button.
  `design/components.css` owns `.filters`; a page must not redefine it.
- **`.list-cards` / `.list-card`** (`design/components.css`) is the phone shape
  below 640px. Put the `<ul class="list-cards">` immediately before a
  `.table-wrap`, or mark the desktop table `phone-hidden` when it is a
  PrimeVue `DataTable`. The same media query makes `.p-dialog` full-screen and
  stacks `.filters` one field per line.
- **`AmountInput`** now pins `inputmode="decimal"` through `pt.pcInputText`.
  PrimeVue defaulted it to `numeric` — the keypad with **no decimal point** —
  so no amount or quantity in the application could be typed on a phone.
  `SearchField` gained `inputmode="search"` and `enterkeyhint="search"`.

### E2E — `apps/web/e2e` (18.5)

**The only test files an agent may write here.** R-0 §1 forbids them outright;
the owner authorised **Playwright specs only**, in conversation, on 2026-09-03.
No vitest suite may be added alongside them.

| Piece | What it does |
|---|---|
| `support/database.ts` | `assertE2eDatabase` **aborts unless the database is exactly `sher_e2e`** — parsed from the URL, not pattern-matched. Never weaken this |
| `support/stack.ts` | `prepareDatabase` (drop → migrate → backfill) · `runUpgradeSteps` (migrate → backfill, no drop — the upgrade spec needs a traded database) · `startApi`/`stopApi` on port 3100 |
| `support/seed.ts` | The baseline, **created through the ERP's own HTTP API**. Opening stock goes through the real opening workflow; opening cash is a money account's opening balance. No balance is ever written by SQL |
| `support/ui.ts` | `signIn`, `baseline()`, `today()`. Selectors are roles and visible text (owner decision 13) |
| Specs | `manager-daily-flow` · `cashier-permissions` (menu **and** route **and** API) · `mobile-daily-screens` (no screenshot baselines) · `upgrade-safety` |

`VITE_PORT` and `VITE_API_TARGET` in `vite.config.ts` let the suite run its own
Vite and API while the owner drives the development stack on 5173/3000.

**Commands.** `pnpm test:e2e` (root) or `pnpm --filter @sher/web test:e2e`.
Requires `pnpm --filter "@sher/api..." build` first — the E2E API runs from
`dist`, not from source.

## 19. The test inventory and coverage report — Phase 19 (owner request 2026-09-03)

`tools/test-inventory` reads the application and writes `docs/testing/`. Run it
with **`pnpm test:inventory`**. Nothing under `docs/testing/` is edited by hand;
it is regenerated, and a stale entry there is a bug in the scanner rather than
in the file.

| Where | What it does |
| --- | --- |
| `src/tokens.ts` | `tokenize(template)` — a quote-aware tag reader for Vue templates, with nesting. Use it rather than a regex over `<tag[^>]*>`: attributes on this codebase contain `>` (`v-if="drafts.length > 0"`), and the naive form misreads the POS. |
| `src/sfc.ts` | `fields`, `dropdowns`, `actions`, `tables`, `opensDialogs`, `validationMessages`, `apiCalls`, `permissionsUsed` — everything on one screen. Reads all three field idioms this codebase uses: `<label for>`, a wrapping `<label>`, and a control named only by its placeholder (which it reports as unlabelled rather than skipping). |
| `src/scan.ts` | `buildInventory(root)` — routes from `router.ts`, nav permissions from `navigation.ts`, endpoints from the controllers, permission codes from `core-contracts`, and `WORKFLOWS`, the one hand-maintained list. |
| `src/coverage.ts` | `readClaims` / `buildCoverage` — links `@covers` lines in the specs to inventory ids. `NOT_APPLICABLE` carries the reason each exclusion is defensible. |
| `src/render.ts` | `renderMatrix`, `renderCoverage`. |

**How a test claims coverage.** A block comment at the top of the spec, one line
per thing it is answerable for:

```
 * @covers screen:products
 * @covers dialog:stock-adjust
 * @covers endpoint:POST /api/v1/products
 * @covers permission:catalog.product.create
 * @covers workflow:cash-sale
```

Nothing is inferred from a filename. A claim naming something the inventory no
longer contains is reported and fails `--check`, so a screen renamed out from
under a test cannot leave the report quietly overstating itself.

### The accounting and business-rule suites — `apps/api/test` (Phase 19)

Six suites added on 2026-09-03, all built the same way and worth copying rather
than inventing a seventh style:

| Suite | What it holds the line on |
| --- | --- |
| `sales.spec.ts` | Cash and credit sales, advance vs change, discounts reaching the ledger, cancellation (INV-08), and the API refusing what the screen would not send. |
| `purchases.spec.ts` | Payables, part payment, landed cost going into stock value rather than expenses, supplier payment, voiding a bill. |
| `returns.spec.ts` | Goods back in both directions — refund out of the drawer, or left on account — and refusing more than was sold or bought. |
| `cash-day.spec.ts` | Day open and close, the short/over reaching `CASH_SHORT_OVER` (INV-07b), expenses, transfers and owner capital. |
| `stock-count.spec.ts` | Variance to `STOCK_ADJUSTMENT`, never `COGS`; per-product adjustments; refusing to write off more than exists. |
| `corrections.spec.ts` | A correction adds and never overwrites — the original entry, its reversal and the new posting all stand — plus the append-only audit trail. |

**The three rules they all follow.**

1. **Assert the ledger, not the response.** Each file has a local `ledger()` that
   sums `journal_lines` per account and an `onHand()` that nets
   `stock_movements`, both read through RLS as the tenant. A document that
   returns the right total and posts the wrong journal is the failure worth
   catching, and it is invisible to a test that trusts the API's own arithmetic.
2. **`afterEach` calls `assertGoldenInvariants`.** Whatever the case set out to
   prove, §3.11 still has to hold when it finishes.
3. **Setup uses `must(response, what)`.** A silent setup failure reads as a
   baffling assertion failure three steps later; `must` names the step that
   actually broke. `seedWalkInCustomer` is in `support/database.ts` for the same
   reason — `seedTenant` does not run tenant provisioning, so a shop it creates
   has no walk-in party and every guest sale fails until one is added.


## Agent workflow tools — `.agents/`

| Entry | Location | Reuse |
|---|---|---|
| Build lane | `.agents/skills/super-build/SKILL.md` | Implement one curated GitHub card in its own worktree; hand a draft PR to QA |
| Codex wave launcher | `.agents/bin/super-board-codex-wave.sh` | Board-controlled Codex build/QA/review dispatch after preflight |
| Helper resolution | `.agents/bin/super-board-skills-ready.py` | Verify actual host-visible skills before claiming or dispatching cards |
| Verification configuration | `.agents/bin/super-board-verification-ready.py` | Check the selected repository has real verification commands |
| Project card operations | `.agents/bin/super-board-card.sh` | Read or move a card on the configured adoption project |
| Pipeline snapshot | `.agents/bin/super-board-status.py` | Read-only status; optional positional config slug |
