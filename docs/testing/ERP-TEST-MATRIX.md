# ERP Test Matrix

> **Generated — do not edit by hand.** Run `pnpm test:inventory`. Every figure below is
> read out of the source: the routes from `apps/web/src/router.ts`, the permissions each
> screen draws itself from, the endpoints from the controllers, and the coverage from the
> `@covers` lines the tests themselves carry. A screen added without a test appears here
> as `NOT TESTED` on the next run, which is the point — nothing silently stays untested.

## What this counts

| | Total |
| --- | ---: |
| Pages (routed screens) | 55 |
| Dialogs, drawers and forms | 57 |
| Fields | 392 |
| Required fields | 74 |
| Dropdowns | 94 |
| Buttons and row actions | 427 |
| Tables | 64 |
| HTTP endpoints | 229 |
| Permission codes | 119 |
| Cross-module workflows | 17 |

## Screens at a glance

| Screen | Route | Fields | Dropdowns | Actions | Mobile | Status |
| --- | --- | ---: | ---: | ---: | :---: | --- |
| AccountLedgerPage | `/finance/ledger` | 5 | 2 | 1 | — | 🟡 PARTIALLY TESTED |
| AccountReconcilePage | `/finance/accounts/:accountId/reconcile/:id` | 0 | 0 | 13 | — | 🟡 PARTIALLY TESTED |
| AuditPage | `/audit` | 5 | 3 | 4 | — | 🟡 PARTIALLY TESTED |
| CapitalLoansPage | `/finance/capital-loans` | 0 | 0 | 4 | — | ✅ TESTED |
| CatalogPage | `/catalog` | 1 | 0 | 10 | 📱 | 🟡 PARTIALLY TESTED |
| CounterPage | `/counter` | 1 | 1 | 4 | 📱 | 🟡 PARTIALLY TESTED |
| DailyCashPage | `/daily-cash` | 0 | 0 | 4 | 📱 | ✅ TESTED |
| DashboardPage | `/dashboard` | 0 | 0 | 2 | 📱 | ✅ TESTED |
| DaybookPage | `/daybook` | 4 | 1 | 10 | 📱 | 🟡 PARTIALLY TESTED |
| ExpensesPage | `/expenses` | 4 | 1 | 5 | 📱 | 🟡 PARTIALLY TESTED |
| FinanceOverviewPage | `/finance` | 1 | 0 | 2 | — | ✅ TESTED |
| FinanceReconciliationPage | `/finance/reconciliation` | 1 | 1 | 3 | — | 🟡 PARTIALLY TESTED |
| ForgotPasswordPage | `/forgot-password` | 3 | 0 | 6 | — | 🟡 PARTIALLY TESTED |
| GoogleCallbackPage | _(dialog)_ | 1 | 0 | 3 | — | ⬜ NOT APPLICABLE |
| ImportPage | `/import` | 2 | 1 | 3 | 📱 | 🟡 PARTIALLY TESTED |
| InventoryReportPage | `/inventory-report` | 2 | 0 | 8 | 📱 | 🟡 PARTIALLY TESTED |
| InvoiceDetailPage | `/sales/:id` | 0 | 0 | 3 | — | ✅ TESTED |
| InvoiceSettingsPage | `/settings/invoice-design` | 25 | 3 | 5 | — | 🟡 PARTIALLY TESTED |
| LoginPage | `/login` | 4 | 0 | 9 | — | 🟡 PARTIALLY TESTED |
| MoneyAccountsPage | `/finance/accounts` | 1 | 0 | 5 | — | ✅ TESTED |
| MoneyReportPage | `/reports/money` | 3 | 1 | 3 | — | 🟡 PARTIALLY TESTED |
| PartiesPage | `/parties` | 5 | 2 | 15 | — | 🟡 PARTIALLY TESTED |
| PartyFormPage | `/parties/:id` | 14 | 3 | 6 | — | 🟡 PARTIALLY TESTED |
| PartyLedgerPage | `/parties/:id/ledger` | 3 | 1 | 10 | — | 🟡 PARTIALLY TESTED |
| PeriodsPage | `/settings/periods` | 0 | 0 | 1 | — | ✅ TESTED |
| PosPage | `/pos` | 17 | 3 | 28 | 📱 | 🟡 PARTIALLY TESTED |
| ProductFormPage | `/products/:id` | 0 | 0 | 1 | — | ✅ TESTED |
| ProductsPage | `/products` | 6 | 5 | 11 | 📱 | 🟡 PARTIALLY TESTED |
| PurchaseDetailPage | `/purchases/:id` | 0 | 0 | 9 | — | 🟡 PARTIALLY TESTED |
| PurchaseFormPage | `/purchases/new` | 19 | 6 | 7 | — | 🟡 PARTIALLY TESTED |
| PurchasePlanDetailPage | `/purchase-plans/:id` | 0 | 0 | 2 | — | ✅ TESTED |
| PurchasePlanPage | `/purchase-plans` | 8 | 3 | 13 | — | 🟡 PARTIALLY TESTED |
| PurchaseReportPage | `/reports/purchases` | 0 | 0 | 0 | — | ✅ TESTED |
| PurchaseReturnsPage | `/purchase-returns` | 3 | 0 | 2 | — | ✅ TESTED |
| PurchasesPage | `/purchases` | 4 | 1 | 5 | — | 🟡 PARTIALLY TESTED |
| RegisterPage | `/register` | 6 | 0 | 5 | — | 🟡 PARTIALLY TESTED |
| RolesPage | `/roles` | 3 | 0 | 7 | — | 🟡 PARTIALLY TESTED |
| SalesPage | `/sales` | 1 | 0 | 3 | 📱 | ✅ TESTED |
| SalesReportPage | `/reports/sales` | 0 | 0 | 0 | — | ✅ TESTED |
| SalesReturnsPage | `/sales-returns` | 3 | 0 | 2 | 📱 | ✅ TESTED |
| SettingsBackupPage | `/settings/backup` | 1 | 0 | 6 | — | 🟡 PARTIALLY TESTED |
| SettingsLicensePage | `/settings/license` | 1 | 0 | 2 | — | 🟡 PARTIALLY TESTED |
| SettingsOfflinePage | `/settings/offline` | 0 | 0 | 10 | — | 🟡 PARTIALLY TESTED |
| SettingsPage | `/settings` | 4 | 2 | 4 | — | 🟡 PARTIALLY TESTED |
| SettingsSecurityPage | `/settings/security` | 4 | 0 | 4 | — | 🟡 PARTIALLY TESTED |
| StockCountPage | `/stock-count` | 5 | 0 | 4 | 📱 | 🟡 PARTIALLY TESTED |
| StorageCheckPage | `/settings/offline/storage-check` | 0 | 0 | 1 | — | ⬜ NOT APPLICABLE |
| SupplierOrderPage | `/supplier-orders/:id` | 0 | 0 | 2 | — | ✅ TESTED |
| SyncIssuesPage | `/sync` | 1 | 0 | 4 | — | ✅ TESTED |
| TransferMoneyPage | `/finance/transfers` | 3 | 0 | 5 | — | ✅ TESTED |
| UsersPage | `/users` | 6 | 1 | 6 | — | 🟡 PARTIALLY TESTED |
| VendorStockPage | `/vendor-stock` | 0 | 0 | 2 | — | ✅ TESTED |
| VendorWorkspacePage | `/vendors/workspace` | 1 | 1 | 9 | — | 🟡 PARTIALLY TESTED |
| WarrantyClaimPage | `/warranty/:id` | 0 | 0 | 1 | — | ✅ TESTED |
| WarrantyClaimsPage | `/warranty` | 5 | 0 | 3 | 📱 | 🟡 PARTIALLY TESTED |
| CancelDocumentDialog | _(dialog)_ | 1 | 0 | 2 | — | ❌ NOT TESTED |
| ConfirmDialog | _(dialog)_ | 0 | 0 | 2 | — | ❌ NOT TESTED |
| DateOnlyPicker | _(dialog)_ | 1 | 0 | 0 | — | 🟡 PARTIALLY TESTED |
| ManageListDialog | _(dialog)_ | 2 | 0 | 5 | — | 🟡 PARTIALLY TESTED |
| OtpInput | _(dialog)_ | 0 | 0 | 0 | — | ❌ NOT TESTED |
| ProductForm | _(dialog)_ | 28 | 6 | 7 | — | 🟡 PARTIALLY TESTED |
| QuickAddSelect | _(dialog)_ | 1 | 1 | 1 | — | 🟡 PARTIALLY TESTED |
| SearchField | _(dialog)_ | 1 | 0 | 1 | — | ❌ NOT TESTED |
| StockAdjustDialog | _(dialog)_ | 4 | 1 | 2 | — | ❌ NOT TESTED |
| StockLotsDialog | _(dialog)_ | 1 | 1 | 1 | — | ❌ NOT TESTED |
| ReplaceBackupSecretDialog | _(dialog)_ | 3 | 0 | 2 | — | ❌ NOT TESTED |
| ResetBusinessDialog | _(dialog)_ | 2 | 0 | 3 | — | ❌ NOT TESTED |
| RestoreDialog | _(dialog)_ | 2 | 0 | 2 | — | ❌ NOT TESTED |
| QuickAddProductDialog | _(dialog)_ | 6 | 2 | 2 | — | ❌ NOT TESTED |
| ChangeTransactionDateDialog | _(dialog)_ | 4 | 0 | 2 | — | ❌ NOT TESTED |
| DaybookSheet | _(dialog)_ | 0 | 0 | 0 | — | ❌ NOT TESTED |
| AmountInput | _(dialog)_ | 1 | 0 | 0 | — | ❌ NOT TESTED |
| ComboField | _(dialog)_ | 1 | 1 | 2 | — | ❌ NOT TESTED |
| SerialEntryDialog | _(dialog)_ | 2 | 0 | 5 | — | ❌ NOT TESTED |
| AccountFormDialog | _(dialog)_ | 7 | 1 | 2 | — | ❌ NOT TESTED |
| AddMissingEntryDialog | _(dialog)_ | 2 | 2 | 2 | — | ❌ NOT TESTED |
| CapitalLoanEntryDialog | _(dialog)_ | 8 | 2 | 1 | — | ❌ NOT TESTED |
| CompleteReconciliationDialog | _(dialog)_ | 2 | 0 | 2 | — | ❌ NOT TESTED |
| CounterAmountField | _(dialog)_ | 1 | 0 | 0 | — | ❌ NOT TESTED |
| CounterChoice | _(dialog)_ | 0 | 0 | 0 | — | ❌ NOT TESTED |
| EndDayDialog | _(dialog)_ | 2 | 0 | 3 | — | ❌ NOT TESTED |
| ImportStatementDialog | _(dialog)_ | 4 | 0 | 2 | — | ❌ NOT TESTED |
| ManageLoanAccountsDialog | _(dialog)_ | 0 | 0 | 4 | — | ❌ NOT TESTED |
| MoneyAccountPicker | _(dialog)_ | 1 | 0 | 1 | — | ❌ NOT TESTED |
| RecordExpenseDialog | _(dialog)_ | 7 | 3 | 2 | — | ❌ NOT TESTED |
| ReopenDayDialog | _(dialog)_ | 2 | 1 | 2 | — | ❌ NOT TESTED |
| StartDayDialog | _(dialog)_ | 3 | 1 | 2 | — | ❌ NOT TESTED |
| StartReconciliationDialog | _(dialog)_ | 2 | 0 | 2 | — | ❌ NOT TESTED |
| TransferMoneyDialog | _(dialog)_ | 7 | 2 | 2 | — | ❌ NOT TESTED |
| DeviceNameDialog | _(dialog)_ | 1 | 0 | 1 | — | ❌ NOT TESTED |
| ForceRevokeDialog | _(dialog)_ | 2 | 0 | 2 | — | ❌ NOT TESTED |
| OfflineBackupCard | _(dialog)_ | 3 | 0 | 2 | — | ❌ NOT TESTED |
| ReplaceWriterDialog | _(dialog)_ | 4 | 1 | 2 | — | ❌ NOT TESTED |
| PartyOpeningDialog | _(dialog)_ | 3 | 1 | 2 | — | ❌ NOT TESTED |
| AddLandedCostDialog | _(dialog)_ | 7 | 3 | 2 | — | ❌ NOT TESTED |
| PaySupplierDialog | _(dialog)_ | 4 | 1 | 3 | — | ❌ NOT TESTED |
| PurchaseReturnDialog | _(dialog)_ | 5 | 2 | 5 | — | ❌ NOT TESTED |
| ProfitTargetDialog | _(dialog)_ | 2 | 1 | 2 | — | ❌ NOT TESTED |
| ReportScreen | _(dialog)_ | 2 | 0 | 4 | — | ❌ NOT TESTED |
| WhyDialog | _(dialog)_ | 0 | 0 | 0 | — | ❌ NOT TESTED |
| InvoicePreviewDialog | _(dialog)_ | 0 | 0 | 11 | — | ⬜ NOT APPLICABLE |
| ReceivePaymentDialog | _(dialog)_ | 3 | 1 | 2 | — | ❌ NOT TESTED |
| SalesReturnDialog | _(dialog)_ | 9 | 2 | 6 | — | ❌ NOT TESTED |
| GlobalSearchDialog | _(dialog)_ | 1 | 0 | 0 | — | ❌ NOT TESTED |
| GiveProductsToVendorDialog | _(dialog)_ | 5 | 2 | 2 | — | ❌ NOT TESTED |
| PayVendorDialog | _(dialog)_ | 5 | 2 | 3 | — | ❌ NOT TESTED |
| ReceiveFromVendorDialog | _(dialog)_ | 5 | 2 | 2 | — | ❌ NOT TESTED |
| ReceiveProductsBackDialog | _(dialog)_ | 4 | 1 | 2 | — | ❌ NOT TESTED |
| VendorProductSettlementDrawer | _(dialog)_ | 15 | 4 | 5 | — | ❌ NOT TESTED |
| VendorStockReceiveDialog | _(dialog)_ | 8 | 2 | 2 | — | ❌ NOT TESTED |
| VendorStockReturnDialog | _(dialog)_ | 4 | 0 | 2 | — | ❌ NOT TESTED |
| ClaimStepDialog | _(dialog)_ | 6 | 3 | 2 | — | ❌ NOT TESTED |

## Pages

### AccountLedgerPage

| | |
| --- | --- |
| **Screen** | AccountLedgerPage |
| **Id** | `screen:account-ledger` |
| **File** | `apps/web/src/pages/AccountLedgerPage.vue` |
| **Kind** | PAGE |
| **Route** | `/finance/ledger` |
| **Roles** | cash.account.view, bank.account.view |
| **Fields** | ledger-account (SEARCHABLE_SELECT), ledger-from (DATE), ledger-to (DATE), ledger-kind (SELECT), ledger-search (TEXT) |
| **Required fields** | — |
| **Optional fields** | ledger-account, ledger-from, ledger-to, ledger-kind, ledger-search |
| **Dropdowns** | ledger-account (searchable), ledger-kind |
| **Primary action** | — |
| **Secondary actions** | MONEY_EN.reconciliation |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 6 columns, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | Could not load the accounts, Could not load the ledger |
| **Business effects** | fetchAccountStatement, fetchAccounts |
| **Permissions** | bank.reconciliation.view |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown ledger-account, dropdown ledger-kind |

### AccountReconcilePage

| | |
| --- | --- |
| **Screen** | AccountReconcilePage |
| **Id** | `screen:account-reconcile` |
| **File** | `apps/web/src/pages/AccountReconcilePage.vue` |
| **Kind** | PAGE |
| **Route** | `/finance/accounts/:accountId/reconcile/:id` |
| **Roles** | bank.reconciliation.perform, bank.reconciliation.reopen |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | Finish, Match these two, Confirm, Record it |
| **Secondary actions** | Back, Upload statement, Reopen, View original, Undo, Not cleared yet, Open, Not the same … (+1) |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | ImportStatementDialog, AddMissingEntryDialog, CompleteReconciliationDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | loadConfig, fetchAccounts, fetchReconciliation, openStatementFile, removeMatch, reopenReconciliation, saveMatch |
| **Permissions** | bank.reconciliation.perform, bank.reconciliation.reopen |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | action Finish, action Match these two, action Confirm, action Record it |

### AuditPage

| | |
| --- | --- |
| **Screen** | AuditPage |
| **Id** | `screen:audit` |
| **File** | `apps/web/src/pages/AuditPage.vue` |
| **Kind** | PAGE |
| **Route** | `/audit` |
| **Roles** | audit.event.view |
| **Fields** | filter-from (DATE), filter-to (DATE), filter-actor (SELECT), filter-entity (SELECT), filter-action (SELECT) |
| **Required fields** | — |
| **Optional fields** | filter-from, filter-to, filter-actor, filter-entity, filter-action |
| **Dropdowns** | filter-actor, filter-entity, filter-action |
| **Primary action** | Apply |
| **Secondary actions** | Clear, Try again, Show older |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 7 columns, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | — |
| **Business effects** | fetchAuditEvents |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown filter-actor, dropdown filter-entity, dropdown filter-action, action Apply |

### CapitalLoansPage

| | |
| --- | --- |
| **Screen** | CapitalLoansPage |
| **Id** | `screen:capital-loans` |
| **File** | `apps/web/src/pages/CapitalLoansPage.vue` |
| **Kind** | PAGE |
| **Route** | `/finance/capital-loans` |
| **Roles** | owner.capital.record, loan.movement.record, loan.account.manage |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | MONEY_EN.manageLoanAccounts, MONEY_EN.newEntry |
| **Row actions** | Edit, Cancel |
| **Destructive actions** | — |
| **Opens** | CapitalLoanEntryDialog, ManageLoanAccountsDialog, CancelDocumentDialog |
| **Tables** | 7 columns, empty state; 8 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load capital and loans |
| **Business effects** | fetchAccounts, fetchMovements, voidMovement |
| **Permissions** | owner.capital.record, loan.movement.record, loan.account.manage, cash.movement.void |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### CatalogPage

| | |
| --- | --- |
| **Screen** | CatalogPage |
| **Id** | `screen:catalog` |
| **File** | `apps/web/src/pages/CatalogPage.vue` |
| **Kind** | PAGE |
| **Route** | `/catalog` |
| **Roles** | catalog.product.view |
| **Fields** | catalog-name (TEXT) |
| **Required fields** | catalog-name |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | Add category, Add the first unit, Add the first brand, Add the first category, Add |
| **Secondary actions** | Try again, Rename, Add subcategory, Cancel |
| **Row actions** | — |
| **Destructive actions** | Remove |
| **Opens** | — |
| **Tables** | 2 columns, empty state; 2 columns, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | — |
| **Business effects** | createCatalogEntry, fetchCatalog, removeCatalogEntry, renameCatalogEntry |
| **Permissions** | catalog.unit.manage, catalog.brand.manage, catalog.category.manage |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | component, playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field catalog-name, action Add category, action Add the first unit, action Remove, action Add the first brand, action Add the first category, action Add |

### CounterPage

| | |
| --- | --- |
| **Screen** | CounterPage |
| **Id** | `screen:counter` |
| **File** | `apps/web/src/pages/CounterPage.vue` |
| **Kind** | PAGE |
| **Route** | `/counter` |
| **Roles** | sale.payment.record, purchase.payment.record, expense.record, cash.movement.record, cash.session.start |
| **Fields** | ctr-party (SEARCHABLE_SELECT) |
| **Required fields** | — |
| **Optional fields** | ctr-party |
| **Dropdowns** | ctr-party (searchable) |
| **Primary action** | Continue |
| **Secondary actions** | View all today, See the whole day, Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | ReceivePaymentDialog, PaySupplierDialog, RecordExpenseDialog, TransferMoneyDialog, StartDayDialog, EndDayDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | Could not load the counter |
| **Business effects** | fetchDaybook, fetchExpenses, fetchDayStatus, fetchParties |
| **Permissions** | — |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown ctr-party, action Continue |

### DailyCashPage

| | |
| --- | --- |
| **Screen** | DailyCashPage |
| **Id** | `screen:daily-cash` |
| **File** | `apps/web/src/pages/DailyCashPage.vue` |
| **Kind** | PAGE |
| **Route** | `/daily-cash` |
| **Roles** | cash.daily.view |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | MONEY_BN.startDay, MONEY_BN.endDay, MONEY_BN.reopenDay, … — … |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | StartDayDialog, EndDayDialog, ReopenDayDialog |
| **Tables** | 9 columns, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | Could not load Daily Cash |
| **Business effects** | fetchDailyCash, fetchDayStatus |
| **Permissions** | cash.session.start, cash.session.close |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### DashboardPage

| | |
| --- | --- |
| **Screen** | DashboardPage |
| **Id** | `screen:dashboard` |
| **File** | `apps/web/src/pages/DashboardPage.vue` |
| **Kind** | PAGE |
| **Route** | `/dashboard` |
| **Roles** | report.target.manage |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Try again, Set target |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | ProfitTargetDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchDashboardCards, saveTarget, fetchBackupStatus |
| **Permissions** | report.target.manage |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | component, playwright, playwright-mobile |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### DaybookPage

| | |
| --- | --- |
| **Screen** | DaybookPage |
| **Id** | `screen:daybook` |
| **File** | `apps/web/src/pages/DaybookPage.vue` |
| **Kind** | PAGE |
| **Route** | `/daybook` |
| **Roles** | daybook.view |
| **Fields** | daybook-from (DATE), daybook-to (DATE), daybook-kind (SELECT), daybook-note (TEXT) |
| **Required fields** | daybook-note (conditional) |
| **Optional fields** | daybook-from, daybook-to, daybook-kind |
| **Dropdowns** | daybook-kind |
| **Primary action** | — |
| **Secondary actions** | Previous day, Next day, By time it was typed, Print A4, Print roll, Check again, Go to today, Cancel … (+1) |
| **Row actions** | Actions |
| **Destructive actions** | — |
| **Opens** | CancelDocumentDialog, ChangeTransactionDateDialog, DaybookSheet |
| **Tables** | 5 columns, empty state; 4 columns, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | Could not load the daybook, Could not mark the day checked, Could not print the day-end report |
| **Business effects** | cancelDocument, canCancelKind, fetchDaybook, markDayReviewed, recordDaybookPrint, isRedatableKind |
| **Permissions** | daybook.review.mark, daybook.print, daybook.view.entry_date |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field daybook-note, dropdown daybook-kind |

### ExpensesPage

| | |
| --- | --- |
| **Screen** | ExpensesPage |
| **Id** | `screen:expenses` |
| **File** | `apps/web/src/pages/ExpensesPage.vue` |
| **Kind** | PAGE |
| **Route** | `/expenses` |
| **Roles** | expense.view |
| **Fields** | search (TEXT), categoryId (SELECT) ⚠ no accessible name, expenses-from (DATE) ⚠ no accessible name, expenses-to (DATE) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | search, categoryId, expenses-from, expenses-to |
| **Dropdowns** | categoryId |
| **Primary action** | — |
| **Secondary actions** | Categories, Record expense, Show more |
| **Row actions** | Edit, Cancel |
| **Destructive actions** | — |
| **Opens** | RecordExpenseDialog, CancelDocumentDialog, ManageListDialog |
| **Tables** | 5 columns, paginated, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | Could not load expenses |
| **Business effects** | addExpenseCategory, voidExpense, archiveExpenseCategory, fetchExpenses, renameExpenseCategory |
| **Permissions** | expense.record |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown categoryId |

### FinanceOverviewPage

| | |
| --- | --- |
| **Screen** | FinanceOverviewPage |
| **Id** | `screen:finance-overview` |
| **File** | `apps/web/src/pages/FinanceOverviewPage.vue` |
| **Kind** | PAGE |
| **Route** | `/finance` |
| **Roles** | cash.account.view, bank.account.view |
| **Fields** | finance-as-of (DATE) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | finance-as-of |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Refresh, View all |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 7 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the money position |
| **Business effects** | fetchAccounts, fetchMovements |
| **Permissions** | cash.account.view, bank.account.view, loan.account.manage, loan.movement.record, cash.movement.record, owner.capital.record, bank.reconciliation.view |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### FinanceReconciliationPage

| | |
| --- | --- |
| **Screen** | FinanceReconciliationPage |
| **Id** | `screen:finance-reconciliation` |
| **File** | `apps/web/src/pages/FinanceReconciliationPage.vue` |
| **Kind** | PAGE |
| **Route** | `/finance/reconciliation` |
| **Roles** | bank.reconciliation.view |
| **Fields** | reconcile-account (SEARCHABLE_SELECT) |
| **Required fields** | — |
| **Optional fields** | reconcile-account |
| **Dropdowns** | reconcile-account (searchable) |
| **Primary action** | — |
| **Secondary actions** | Start New |
| **Row actions** | Continue, Open |
| **Destructive actions** | — |
| **Opens** | StartReconciliationDialog |
| **Tables** | 3 columns, empty state; 4 columns, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | Could not load the accounts, Could not load the reconciliations |
| **Business effects** | fetchAccounts, fetchReconciliations |
| **Permissions** | bank.reconciliation.perform |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown reconcile-account |

### ForgotPasswordPage

| | |
| --- | --- |
| **Screen** | ForgotPasswordPage |
| **Id** | `screen:forgot-password` |
| **File** | `apps/web/src/pages/ForgotPasswordPage.vue` |
| **Kind** | PAGE |
| **Route** | `/forgot-password` |
| **Roles** | — |
| **Fields** | identifier (TEXT), otpCode (OTP) ⚠ no accessible name, password (TEXT) |
| **Required fields** | identifier, password |
| **Optional fields** | otpCode |
| **Dropdowns** | — |
| **Primary action** | Send code, Set new password, Go to sign in |
| **Secondary actions** | Back to sign in, Send a new code, Use a different number or email |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | requestPasswordResetOtp, resetPassword |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field identifier, required field password, action Send code, action Set new password, action Go to sign in |

### GoogleCallbackPage

| | |
| --- | --- |
| **Screen** | GoogleCallbackPage |
| **Id** | `screen:google-callback` |
| **File** | `apps/web/src/pages/GoogleCallbackPage.vue` |
| **Kind** | PAGE |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | businessName (TEXT) |
| **Required fields** | businessName |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | Create my business |
| **Secondary actions** | Cancel, Back to sign in |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | loginWithGoogle, registerWithGoogle |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ⬜ NOT APPLICABLE |
| **Gaps** | Completes a real Google OAuth redirect; the provider cannot be driven headlessly, and the token exchange behind it is covered by apps/api/test/google-registration.spec.ts. |

### ImportPage

| | |
| --- | --- |
| **Screen** | ImportPage |
| **Id** | `screen:import` |
| **File** | `apps/web/src/pages/ImportPage.vue` |
| **Kind** | PAGE |
| **Route** | `/import` |
| **Roles** | catalog.product.create |
| **Fields** | import-type (SELECT), import-file (FILE) |
| **Required fields** | — |
| **Optional fields** | import-type, import-file |
| **Dropdowns** | import-type |
| **Primary action** | — |
| **Secondary actions** | Download template, destination.label, s |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 2 columns |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | — |
| **Business effects** | commitImport, previewImport |
| **Permissions** | — |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | component, playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown import-type |

### InventoryReportPage

| | |
| --- | --- |
| **Screen** | InventoryReportPage |
| **Id** | `screen:inventory-report` |
| **File** | `apps/web/src/pages/InventoryReportPage.vue` |
| **Kind** | PAGE |
| **Route** | `/inventory-report` |
| **Roles** | catalog.product.view |
| **Fields** | report-from (DATE), report-to (DATE) |
| **Required fields** | — |
| **Optional fields** | report-from, report-to |
| **Dropdowns** | — |
| **Primary action** | Apply |
| **Secondary actions** | Clear, Try again, Expired, Expiring soon, Missing date |
| **Row actions** | Return to supplier, Open product |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 4 columns, empty state; 4 columns, empty state; 6 columns, empty state; 5 columns, empty state; 4 columns, empty state; 6 columns, empty state; 5 columns, empty state; 3 columns, empty state; 5 columns, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | That adjustment is outside the dates shown. Widen the range to see it., This source module is not available yet. |
| **Business effects** | fetchCostAdjustments, fetchInventory, fetchInventoryLots, fetchInventoryValuation, fetchOpeningStock, fetchStockAdjustments, fetchStockReport |
| **Permissions** | inventory.cost.view, inventory.lot.view |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | component, playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | action Apply |

### InvoiceDetailPage

| | |
| --- | --- |
| **Screen** | InvoiceDetailPage |
| **Id** | `screen:invoice-detail` |
| **File** | `apps/web/src/pages/InvoiceDetailPage.vue` |
| **Kind** | PAGE |
| **Route** | `/sales/:id` |
| **Roles** | sale.payment.record |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Receive Payment, Print / Share, Back to sales |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | InvoicePreviewDialog, ReceivePaymentDialog |
| **Tables** | 6 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load this invoice |
| **Business effects** | fetchSale |
| **Permissions** | sale.payment.record |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### InvoiceSettingsPage

| | |
| --- | --- |
| **Screen** | InvoiceSettingsPage |
| **Id** | `screen:invoice-settings` |
| **File** | `apps/web/src/pages/InvoiceSettingsPage.vue` |
| **Kind** | PAGE |
| **Route** | `/settings/invoice-design` |
| **Roles** | settings.setting.edit |
| **Fields** | settings.businessName (TEXT), settings.proprietorName (TEXT), settings.invoiceTitle (TEXT), settings.proprietorNote (TEXTAREA), settings.businessDescription (TEXTAREA), settings.businessAddress (TEXTAREA), phone.label (TEXT) ⚠ no accessible name, phone.number (TEXT) ⚠ no accessible name, settings.showHeaderText (TOGGLE) ⚠ no accessible name, settings.headerText (TEXTAREA), entry.label (TEXT) ⚠ no accessible name, entry.number (TEXT) ⚠ no accessible name, settings.terms[index] (TEXT) ⚠ no accessible name, settings.footerText (TEXTAREA), settings.paymentTermsDays (NUMBER), settings.paymentTermsLabel (TEXT), settings.language (SELECT), settings.defaultTemplate (SELECT), settings.thermalPaper (SELECT), settings.showSignatureLines (TOGGLE) ⚠ no accessible name … (+5) |
| **Required fields** | — |
| **Optional fields** | settings.businessName, settings.proprietorName, settings.invoiceTitle, settings.proprietorNote, settings.businessDescription, settings.businessAddress, phone.label, phone.number, settings.showHeaderText, settings.headerText, entry.label, entry.number, settings.terms[index], settings.footerText, settings.paymentTermsDays, settings.paymentTermsLabel, settings.language, settings.defaultTemplate, settings.thermalPaper, settings.showSignatureLines … (+5) |
| **Dropdowns** | settings.language, settings.defaultTemplate, settings.thermalPaper |
| **Primary action** | — |
| **Secondary actions** | Save, + Add phone number, + Add number, + Add term |
| **Row actions** | — |
| **Destructive actions** | Remove logo |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not save that logo, Could not remove the logo, Could not load invoice settings, Could not save invoice settings |
| **Business effects** | fetchInvoiceSettings, removeInvoiceLogo, saveInvoiceLogo, updateInvoiceSettings |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown settings.language, dropdown settings.defaultTemplate, dropdown settings.thermalPaper, action Remove logo |

### LoginPage

| | |
| --- | --- |
| **Screen** | LoginPage |
| **Id** | `screen:login` |
| **File** | `apps/web/src/pages/LoginPage.vue` |
| **Kind** | PAGE |
| **Route** | `/login` |
| **Roles** | — |
| **Fields** | offlinePin (OTP) ⚠ no accessible name, pin (OTP) ⚠ no accessible name, identifier (TEXT), password (TEXT) |
| **Required fields** | identifier, password |
| **Optional fields** | offlinePin, pin |
| **Dropdowns** | — |
| **Primary action** | Open the counter, Unlock, Sign in |
| **Secondary actions** | Try signing in instead, Use password instead, Sign in to a different account, Work without internet, Use PIN instead, Open this computer’s own copy |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | This computer’s copy no longer lists that person., Google sign-in is not configured on this server yet. |
| **Business effects** | loginWithPassword, loginWithPin |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field identifier, required field password, action Open the counter, action Unlock, action Sign in |

### MoneyAccountsPage

| | |
| --- | --- |
| **Screen** | MoneyAccountsPage |
| **Id** | `screen:money-accounts` |
| **File** | `apps/web/src/pages/MoneyAccountsPage.vue` |
| **Kind** | PAGE |
| **Route** | `/finance/accounts` |
| **Roles** | cash.account.view, bank.account.view |
| **Fields** | includeInactive (CHECKBOX) |
| **Required fields** | — |
| **Optional fields** | includeInactive |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Add Account, ( ) |
| **Row actions** | Ledger, Edit, Take out of use |
| **Destructive actions** | — |
| **Opens** | AccountFormDialog |
| **Tables** | 5 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the accounts, Could not take that account out of use |
| **Business effects** | deactivateAccount, fetchAccounts |
| **Permissions** | cash.account.manage, bank.account.manage, loan.account.manage |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### MoneyReportPage

| | |
| --- | --- |
| **Screen** | MoneyReportPage |
| **Id** | `screen:money-report` |
| **File** | `apps/web/src/pages/MoneyReportPage.vue` |
| **Kind** | PAGE |
| **Route** | `/reports/money` |
| **Roles** | report.money.view |
| **Fields** | money-from (DATE) ⚠ no accessible name, money-to (DATE) ⚠ no accessible name, view (SELECT) ⚠ no accessible name |
| **Required fields** | money-from (conditional), money-to (conditional), view (conditional) |
| **Optional fields** | — |
| **Dropdowns** | view |
| **Primary action** | — |
| **Secondary actions** | option.label, Print, CSV |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | WhyDialog |
| **Tables** | 6 columns, empty state; 5 columns, empty state; 3 columns, empty state; 0 columns, empty state; 0 columns, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | Could not load the money report |
| **Business effects** | fetchMoneyReport |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field money-from, required field money-to, required field view, dropdown view |

### PartiesPage

| | |
| --- | --- |
| **Screen** | PartiesPage |
| **Id** | `screen:parties` |
| **File** | `apps/web/src/pages/PartiesPage.vue` |
| **Kind** | PAGE |
| **Route** | `/parties` |
| **Roles** | party.customer.view |
| **Fields** | search (TEXT), filter-group (SELECT), filter-status (SELECT), new-group (TEXT), Rename … (TEXT) |
| **Required fields** | — |
| **Optional fields** | search, filter-group, filter-status, new-group, Rename … |
| **Dropdowns** | filter-group, filter-status |
| **Primary action** | Add, Add the first, Reactivate |
| **Secondary actions** | Customer groups, Import, Clear, Try again, Clear the filters, Show more, Cancel, Close |
| **Row actions** | Open …'s ledger, Actions for … |
| **Destructive actions** | Delete, Remove |
| **Opens** | PartyOpeningDialog |
| **Tables** | 5 columns, sortable, paginated, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | — |
| **Business effects** | createCustomerGroup, deleteParty, fetchParties, fetchPartySetup, removeCustomerGroup, renameCustomerGroup, setPartyStatus |
| **Permissions** | party.group.manage |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown filter-group, dropdown filter-status, action Add, action Add the first, action Delete, action Reactivate, action Remove |

### PartyFormPage

| | |
| --- | --- |
| **Screen** | PartyFormPage |
| **Id** | `screen:party-form` |
| **File** | `apps/web/src/pages/PartyFormPage.vue` |
| **Kind** | PAGE |
| **Route** | `/parties/:id` |
| **Roles** | party.group.manage |
| **Fields** | party-name (TEXT), party-guardian (TEXT), party-phone (TEXT), party-address (TEXT), Vendor (CHECKBOX), party-nid (TEXT), party-email (TEXT), customerGroupId (SEARCHABLE_SELECT), party-credit (MONEY), party-notes (TEXT), party-opening (MONEY), openingDirection (SELECT), party-opening-role (SELECT), party-opening-date (DATE) |
| **Required fields** | party-name, party-phone, party-credit, party-opening |
| **Optional fields** | party-guardian, party-address, Vendor, party-nid, party-email, customerGroupId, party-notes, openingDirection, party-opening-role, party-opening-date |
| **Dropdowns** | customerGroupId (searchable), openingDirection, party-opening-role |
| **Primary action** | Edit details, Save changes |
| **Secondary actions** | Back to the list, Back to list, Cancel |
| **Row actions** | — |
| **Destructive actions** | Delete |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Enter the credit limit as an amount, with at most two decimal places, Enter the opening balance as an amount greater than zero |
| **Business effects** | createCustomerGroup, createParty, deleteParty, fetchParty, fetchPartySetup, updateParty |
| **Permissions** | party.group.manage |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field party-name, required field party-phone, required field party-credit, required field party-opening, dropdown customerGroupId, dropdown openingDirection, dropdown party-opening-role, action Edit details, action Delete, action Save changes |

### PartyLedgerPage

| | |
| --- | --- |
| **Screen** | PartyLedgerPage |
| **Id** | `screen:party-ledger` |
| **File** | `apps/web/src/pages/PartyLedgerPage.vue` |
| **Kind** | PAGE |
| **Route** | `/parties/:id/ledger` |
| **Roles** | sale.payment.record, sale.invoice.create, party.vendor.view, purchase.payment.record, purchase.bill.create |
| **Fields** | ledger-from (DATE), ledger-to (DATE), ledger-page-size (SELECT) |
| **Required fields** | — |
| **Optional fields** | ledger-from, ledger-to, ledger-page-size |
| **Dropdowns** | ledger-page-size |
| **Primary action** | Vendor workspace, Receive payment, New sale, Pay supplier |
| **Secondary actions** | ← Back to list, New purchase, Edit details, Set opening balance, Print statement, Show more |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | PartyOpeningDialog, ReceivePaymentDialog, PaySupplierDialog |
| **Tables** | 6 columns, paginated, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | — |
| **Business effects** | fetchParty, fetchPartyLedger, fetchPartyOpening |
| **Permissions** | sale.payment.record, sale.invoice.create, party.vendor.view, purchase.payment.record, purchase.bill.create |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown ledger-page-size, action Vendor workspace, action Receive payment, action New sale, action Pay supplier |

### PeriodsPage

| | |
| --- | --- |
| **Screen** | PeriodsPage |
| **Id** | `screen:periods` |
| **File** | `apps/web/src/pages/PeriodsPage.vue` |
| **Kind** | PAGE |
| **Route** | `/settings/periods` |
| **Roles** | settings.setting.view |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | Close month |
| **Destructive actions** | — |
| **Opens** | ConfirmDialog |
| **Tables** | 3 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | closePeriod, fetchPeriods |
| **Permissions** | period.close |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### PosPage

| | |
| --- | --- |
| **Screen** | PosPage |
| **Id** | `screen:pos` |
| **File** | `apps/web/src/pages/PosPage.vue` |
| **Kind** | PAGE |
| **Route** | `/pos` |
| **Roles** | sale.invoice.create |
| **Fields** | pos-search (TEXT) ⚠ no accessible name, customerName (TEXT), customerPhone (TEXT), customerId (SEARCHABLE_SELECT) ⚠ no accessible name, guardianName (TEXT), address (TEXT), line.qty (MONEY) ⚠ no accessible name, line.price (MONEY) ⚠ no accessible name, line.lineDiscount (MONEY) ⚠ no accessible name, line.selectedOwnedSerialIds (CHECKBOX) ⚠ no accessible name, line.vendorPartyId (SEARCHABLE_SELECT) ⚠ no accessible name, line.vendorAllocation (MONEY) ⚠ no accessible name, line.selectedVendorSerialIds (CHECKBOX) ⚠ no accessible name, line.negativeAllocation (MONEY) ⚠ no accessible name, discount (MONEY) ⚠ no accessible name, payment.accountId (SELECT) ⚠ no accessible name, payment.amount (MONEY) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | pos-search, customerName, customerPhone, customerId, guardianName, address, line.qty, line.price, line.lineDiscount, line.selectedOwnedSerialIds, line.vendorPartyId, line.vendorAllocation, line.selectedVendorSerialIds, line.negativeAllocation, discount, payment.accountId, payment.amount |
| **Dropdowns** | customerId (searchable), line.vendorPartyId (searchable), payment.accountId |
| **Primary action** | Sell anyway, Confirm Allocation |
| **Secondary actions** | Clear (Esc), Drafts ( ), Add a product, Leave it alone, Grid, List, Add the first product, Show everything … (+15) |
| **Row actions** | — |
| **Destructive actions** | Remove …, Remove this payment, Delete this draft |
| **Opens** | ConfirmDialog, InvoicePreviewDialog, StartDayDialog, VendorStockReceiveDialog |
| **Tables** | — |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | That invoice is already cancelled |
| **Business effects** | fetchCatalog, fetchAccounts, fetchDayStatus, fetchParties, fetchVendorStock, fetchAvailableSerials, createSale, deleteSaleDraft, fetchCustomerStanding, fetchPosProducts, fetchSale, fetchSaleDrafts … (+1) |
| **Permissions** | sale.invoice.create, inventory.cost.view, sale.price.edit, sale.discount.apply, party.vendor.create, vendor.stock.manage, party.vendor.view, catalog.product.create |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown customerId, dropdown line.vendorPartyId, dropdown payment.accountId, action Sell anyway, action Remove …, action Confirm Allocation, action Remove this payment, action Delete this draft |

### ProductFormPage

| | |
| --- | --- |
| **Screen** | ProductFormPage |
| **Id** | `screen:product-form` |
| **File** | `apps/web/src/pages/ProductFormPage.vue` |
| **Kind** | PAGE |
| **Route** | `/products/:id` |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Back to products |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### ProductsPage

| | |
| --- | --- |
| **Screen** | ProductsPage |
| **Id** | `screen:products` |
| **File** | `apps/web/src/pages/ProductsPage.vue` |
| **Kind** | PAGE |
| **Route** | `/products` |
| **Roles** | catalog.product.view |
| **Fields** | search (TEXT), filter-brand (SEARCHABLE_SELECT), filter-category (SEARCHABLE_SELECT), filter-subcategory (SEARCHABLE_SELECT), filter-stock (SELECT), filter-status (SELECT) |
| **Required fields** | — |
| **Optional fields** | search, filter-brand, filter-category, filter-subcategory, filter-stock, filter-status |
| **Dropdowns** | filter-brand (searchable), filter-category (searchable), filter-subcategory (searchable), filter-stock, filter-status |
| **Primary action** | Add the first product, Reactivate |
| **Secondary actions** | Import, Add product, Clear, Try again, Clear the filters, Show more, Cancel |
| **Row actions** | Actions for … |
| **Destructive actions** | Delete |
| **Opens** | StockAdjustDialog, StockLotsDialog |
| **Tables** | 7 columns, sortable, paginated, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | — |
| **Business effects** | fetchCatalog, deleteProduct, fetchProducts, setProductStatus |
| **Permissions** | catalog.product.create, catalog.product.edit, catalog.product.deactivate, catalog.product.delete, inventory.lot.view, inventory.cost.view |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | component, playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown filter-brand, dropdown filter-category, dropdown filter-subcategory, dropdown filter-stock, dropdown filter-status, action Add the first product, action Reactivate, action Delete |

### PurchaseDetailPage

| | |
| --- | --- |
| **Screen** | PurchaseDetailPage |
| **Id** | `screen:purchase-detail` |
| **File** | `apps/web/src/pages/PurchaseDetailPage.vue` |
| **Kind** | PAGE |
| **Route** | `/purchases/:id` |
| **Roles** | purchase.payment.record, purchase.return.create, purchase.bill.edit, purchase.bill.void, purchase.bill.create |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | New purchase |
| **Secondary actions** | Back to the list, ← Back to list, Pay this bill, Return to supplier, Edit bill, Add extra cost, Enter serials |
| **Row actions** | — |
| **Destructive actions** | Cancel bill |
| **Opens** | ConfirmDialog, PurchaseReturnDialog, PaySupplierDialog, AddLandedCostDialog, SerialEntryDialog |
| **Tables** | 4 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not open this purchase |
| **Business effects** | fetchPurchase, voidPurchase, fetchAccounts, fetchSerialProgress |
| **Permissions** | purchase.payment.record, purchase.return.create, purchase.bill.edit, purchase.bill.void, purchase.bill.create |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | action New purchase, action Cancel bill |

### PurchaseFormPage

| | |
| --- | --- |
| **Screen** | PurchaseFormPage |
| **Id** | `screen:purchase-form` |
| **File** | `apps/web/src/pages/PurchaseFormPage.vue` |
| **Kind** | PAGE |
| **Route** | `/purchases/new` |
| **Roles** | purchase.bill.create |
| **Fields** | supplierId (SEARCHABLE_SELECT), purchase-date (DATE), purchase-ref (TEXT), purchase-due (DATE), productPick (SEARCHABLE_SELECT), categoryId (SEARCHABLE_SELECT) ⚠ no accessible name, line.qty (NUMBER) ⚠ no accessible name, line.rate (NUMBER) ⚠ no accessible name, `expiry-${index}` (DATE), discount (NUMBER) ⚠ no accessible name, cost.category (SELECT), cost.amount (NUMBER) ⚠ no accessible name, cost.method (SELECT), cost.description (TEXT) ⚠ no accessible name, cost.manual[lineIndex] (NUMBER) ⚠ no accessible name, purchase-paid (NUMBER), paidAccountId (SEARCHABLE_SELECT), purchase-due-amount (TEXT), purchase-notes (TEXTAREA) |
| **Required fields** | supplierId, paidAccountId |
| **Optional fields** | purchase-date, purchase-ref, purchase-due, productPick, categoryId, line.qty, line.rate, `expiry-${index}`, discount, cost.category, cost.amount, cost.method, cost.description, cost.manual[lineIndex], purchase-paid, purchase-due-amount, purchase-notes |
| **Dropdowns** | supplierId (searchable), productPick (searchable), categoryId (searchable), cost.category, cost.method, paidAccountId (searchable) |
| **Primary action** | — |
| **Secondary actions** | MONEY_BN.startDay, Add Another Product, Add Cost, Complete Purchase |
| **Row actions** | Expiry date for … |
| **Destructive actions** | Remove …, Remove landed cost … |
| **Opens** | StartDayDialog |
| **Tables** | 7 columns |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | Correcting a bill needs permission to see cost prices |
| **Business effects** | fetchCatalog, fetchAccounts, fetchDayStatus, fetchParties, fetchProducts, createPurchase, fetchPurchase |
| **Permissions** | purchase.bill.create, party.supplier.create, catalog.product.create |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field supplierId, required field paidAccountId, dropdown supplierId, dropdown productPick, dropdown categoryId, dropdown cost.category, dropdown cost.method, dropdown paidAccountId, action Remove …, action Remove landed cost … |

### PurchasePlanDetailPage

| | |
| --- | --- |
| **Screen** | PurchasePlanDetailPage |
| **Id** | `screen:purchase-plan-detail` |
| **File** | `apps/web/src/pages/PurchasePlanDetailPage.vue` |
| **Kind** | PAGE |
| **Route** | `/purchase-plans/:id` |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Approve, Reject |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 4 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | The plan could not be loaded. Try again., The plan could not be updated. Try again. |
| **Business effects** | decidePurchasePlan, fetchPurchasePlan |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### PurchasePlanPage

| | |
| --- | --- |
| **Screen** | PurchasePlanPage |
| **Id** | `screen:purchase-plan` |
| **File** | `apps/web/src/pages/PurchasePlanPage.vue` |
| **Kind** | PAGE |
| **Route** | `/purchase-plans` |
| **Roles** | purchase.plan.view |
| **Fields** | pp-scope (SELECT), pp-history (SELECT), pp-cover (MONEY), pp-budget (MONEY), pp-date (DATE), pp-add (SEARCHABLE_SELECT), pp-search (TEXT), pp-notes (TEXT) |
| **Required fields** | — |
| **Optional fields** | pp-scope, pp-history, pp-cover, pp-budget, pp-date, pp-add, pp-search, pp-notes |
| **Dropdowns** | pp-scope, pp-history, pp-add (searchable) |
| **Primary action** | — |
| **Secondary actions** | Planner, Saved Plans, Supplier Orders, Analyze Stock, Use All Suggested, Auto Fit Budget, Add New Product, Add Product … (+1) |
| **Row actions** | View, Approve, Reject |
| **Destructive actions** | Delete |
| **Opens** | QuickAddProductDialog, ConfirmDialog |
| **Tables** | 15 columns, empty state; 7 columns, empty state; 8 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Enter a purchase budget first, Tick at least one product and give it a quantity |
| **Business effects** | fetchParties, fetchCatalog, fetchProducts, createPurchasePlan, decidePurchasePlan, deletePurchasePlan, fetchPlannerSuggestions, fetchPurchasePlans, fetchSupplierOrders |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown pp-scope, dropdown pp-history, dropdown pp-add, action Delete |

### PurchaseReportPage

| | |
| --- | --- |
| **Screen** | PurchaseReportPage |
| **Id** | `screen:purchase-report` |
| **File** | `apps/web/src/pages/PurchaseReportPage.vue` |
| **Kind** | PAGE |
| **Route** | `/reports/purchases` |
| **Roles** | report.purchase.view |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | WhyDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the purchase report |
| **Business effects** | fetchPurchaseReport |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### PurchaseReturnsPage

| | |
| --- | --- |
| **Screen** | PurchaseReturnsPage |
| **Id** | `screen:purchase-returns` |
| **File** | `apps/web/src/pages/PurchaseReturnsPage.vue` |
| **Kind** | PAGE |
| **Route** | `/purchase-returns` |
| **Roles** | purchase.return.view |
| **Fields** | search (TEXT), purchase-returns-from (DATE) ⚠ no accessible name, purchase-returns-to (DATE) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | search, purchase-returns-from, purchase-returns-to |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Print, Show more |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 7 columns, paginated, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | Could not load supplier returns |
| **Business effects** | fetchPurchaseReturns |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### PurchasesPage

| | |
| --- | --- |
| **Screen** | PurchasesPage |
| **Id** | `screen:purchases` |
| **File** | `apps/web/src/pages/PurchasesPage.vue` |
| **Kind** | PAGE |
| **Route** | `/purchases` |
| **Roles** | purchase.bill.view |
| **Fields** | search (TEXT), purchase-settlement (SELECT), purchase-from (DATE), purchase-to (DATE) |
| **Required fields** | — |
| **Optional fields** | search, purchase-settlement, purchase-from, purchase-to |
| **Dropdowns** | purchase-settlement |
| **Primary action** | New purchase, Record the first purchase |
| **Secondary actions** | Clear, Clear the filters, Show more |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 5 columns, paginated, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | Could not load the purchases |
| **Business effects** | fetchPurchases |
| **Permissions** | purchase.bill.create, inventory.cost.view |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown purchase-settlement, action New purchase, action Record the first purchase |

### RegisterPage

| | |
| --- | --- |
| **Screen** | RegisterPage |
| **Id** | `screen:register` |
| **File** | `apps/web/src/pages/RegisterPage.vue` |
| **Kind** | PAGE |
| **Route** | `/register` |
| **Roles** | — |
| **Fields** | identifier (TEXT), otpCode (OTP) ⚠ no accessible name, business (TEXT), username (TEXT), password (TEXT), pin (NUMBER) |
| **Required fields** | identifier, business, username, password, pin |
| **Optional fields** | otpCode |
| **Dropdowns** | — |
| **Primary action** | Send code, Verify, Create account |
| **Secondary actions** | Send a new code, Use a different number or email |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Google sign-in is not configured on this server yet. |
| **Business effects** | completeRegistration, requestSignupOtp, verifySignupOtp |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field identifier, required field business, required field username, required field password, required field pin, action Send code, action Verify, action Create account |

### RolesPage

| | |
| --- | --- |
| **Screen** | RolesPage |
| **Id** | `screen:roles` |
| **File** | `apps/web/src/pages/RolesPage.vue` |
| **Kind** | PAGE |
| **Route** | `/roles` |
| **Roles** | user.role.view |
| **Fields** | role-name (TEXT), role-confirm (TEXT), delete-confirm (TEXT) |
| **Required fields** | role-name, role-confirm, delete-confirm |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | Add role, Save changes |
| **Secondary actions** | Try again, Edit, Cancel |
| **Row actions** | — |
| **Destructive actions** | Delete, Delete role |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | createRole, deleteRole, fetchRoles, updateRole |
| **Permissions** | user.role.manage |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field role-name, required field role-confirm, required field delete-confirm, action Add role, action Delete, action Save changes, action Delete role |

### SalesPage

| | |
| --- | --- |
| **Screen** | SalesPage |
| **Id** | `screen:sales` |
| **File** | `apps/web/src/pages/SalesPage.vue` |
| **Kind** | PAGE |
| **Route** | `/sales` |
| **Roles** | sale.invoice.view |
| **Fields** | search (TEXT) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | search |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | POS — New Sale, Show unpaid only |
| **Row actions** | What can be done with this invoice |
| **Destructive actions** | — |
| **Opens** | InvoicePreviewDialog, SalesReturnDialog, ReceivePaymentDialog, ConfirmDialog |
| **Tables** | 7 columns |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | Could not open that invoice, Could not cancel that invoice, Could not load sales |
| **Business effects** | cancelSale, fetchSale, fetchSales |
| **Permissions** | sale.invoice.create, sale.payment.record, sale.invoice.edit, sale.invoice.void, sales.return.create |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### SalesReportPage

| | |
| --- | --- |
| **Screen** | SalesReportPage |
| **Id** | `screen:sales-report` |
| **File** | `apps/web/src/pages/SalesReportPage.vue` |
| **Kind** | PAGE |
| **Route** | `/reports/sales` |
| **Roles** | report.sales.view |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | WhyDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the sales report |
| **Business effects** | fetchSalesReport |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### SalesReturnsPage

| | |
| --- | --- |
| **Screen** | SalesReturnsPage |
| **Id** | `screen:sales-returns` |
| **File** | `apps/web/src/pages/SalesReturnsPage.vue` |
| **Kind** | PAGE |
| **Route** | `/sales-returns` |
| **Roles** | sales.return.view |
| **Fields** | search (TEXT), returns-from (DATE) ⚠ no accessible name, returns-to (DATE) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | search, returns-from, returns-to |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Print, Show more |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 7 columns, paginated, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | Could not load returns |
| **Business effects** | fetchSalesReturns |
| **Permissions** | — |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### SettingsBackupPage

| | |
| --- | --- |
| **Screen** | SettingsBackupPage |
| **Id** | `screen:settings-backup` |
| **File** | `apps/web/src/pages/SettingsBackupPage.vue` |
| **Kind** | PAGE |
| **Route** | `/settings/backup` |
| **Roles** | backup.export |
| **Fields** | bk-password (TEXT) |
| **Required fields** | — |
| **Optional fields** | bk-password |
| **Dropdowns** | — |
| **Primary action** | Download, Download backup |
| **Secondary actions** | Set backup password, Cancel, Restore from a file |
| **Row actions** | — |
| **Destructive actions** | Reset business data |
| **Opens** | ReplaceBackupSecretDialog, RestoreDialog, ResetBusinessDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | — |
| **Business effects** | downloadBackup, fetchBackupStatus |
| **Permissions** | backup.restore, business.reset |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | action Download, action Download backup, action Reset business data |

### SettingsLicensePage

| | |
| --- | --- |
| **Screen** | SettingsLicensePage |
| **Id** | `screen:settings-license` |
| **File** | `apps/web/src/pages/SettingsLicensePage.vue` |
| **Kind** | PAGE |
| **Route** | `/settings/license` |
| **Roles** | license.term.view |
| **Fields** | keyText (TEXT) |
| **Required fields** | — |
| **Optional fields** | keyText |
| **Dropdowns** | — |
| **Primary action** | Install licence |
| **Secondary actions** | Copy |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | Could not read the licence |
| **Business effects** | fetchLicenseStatus, installLicense |
| **Permissions** | license.install |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | action Install licence |

### SettingsOfflinePage

| | |
| --- | --- |
| **Screen** | SettingsOfflinePage |
| **Id** | `screen:settings-offline` |
| **File** | `apps/web/src/pages/SettingsOfflinePage.vue` |
| **Kind** | PAGE |
| **Route** | `/settings/offline` |
| **Roles** | offline.device.register |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | Register this computer |
| **Secondary actions** | Check again, Storage check, Open sync, Try again |
| **Row actions** | Approve, Replace writer, Take permission back, Rename |
| **Destructive actions** | Cut off |
| **Opens** | DeviceNameDialog, ForceRevokeDialog, ReplaceWriterDialog |
| **Tables** | 3 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | This browser will not let the app keep an identity. Try a normal (not private) window., The browser did not agree to keep this shop’s data. Install the app and use it for a few days, then try again. |
| **Business effects** | approveDevice, fetchDevices, forceRevokeDevice, registerDevice, renameDevice, replaceWriter, requestOfflineWrite, revokeDevice |
| **Permissions** | settings.setting.edit, sync.status.view |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | action Register this computer, action Cut off |

### SettingsPage

| | |
| --- | --- |
| **Screen** | SettingsPage |
| **Id** | `screen:settings` |
| **File** | `apps/web/src/pages/SettingsPage.vue` |
| **Kind** | PAGE |
| **Route** | `/settings` |
| **Roles** | settings.setting.view |
| **Fields** | business-name (TEXT), business-timezone (SEARCHABLE_SELECT), `setting-${descriptor.key}` (SELECT), step-up-password (TEXT) |
| **Required fields** | — |
| **Optional fields** | business-name, business-timezone, `setting-${descriptor.key}`, step-up-password |
| **Dropdowns** | business-timezone (searchable), `setting-${descriptor.key}` |
| **Primary action** | Save, Confirm |
| **Secondary actions** | Try again, Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchSettings, saveBusinessProfile, saveSetting |
| **Permissions** | settings.setting.edit, settings.module.toggle |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown business-timezone, dropdown `setting-${descriptor.key}`, action Save, action Confirm |

### SettingsSecurityPage

| | |
| --- | --- |
| **Screen** | SettingsSecurityPage |
| **Id** | `screen:settings-security` |
| **File** | `apps/web/src/pages/SettingsSecurityPage.vue` |
| **Kind** | PAGE |
| **Route** | `/settings/security` |
| **Roles** | — |
| **Fields** | current-password (TEXT), new-password (TEXT), currentPin (OTP), newPin (OTP) |
| **Required fields** | current-password, new-password |
| **Optional fields** | currentPin, newPin |
| **Dropdowns** | — |
| **Primary action** | Set password, Set PIN |
| **Secondary actions** | Try again, Sign in again |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | changePassword, changePin, fetchSecuritySettings |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field current-password, required field new-password, action Set password, action Set PIN |

### StockCountPage

| | |
| --- | --- |
| **Screen** | StockCountPage |
| **Id** | `screen:stock-count` |
| **File** | `apps/web/src/pages/StockCountPage.vue` |
| **Kind** | PAGE |
| **Route** | `/stock-count` |
| **Roles** | stock.count.post |
| **Fields** | search (TEXT), Counted quantity for … (MONEY), count-date (DATE), backdateReason (TEXT), note (TEXT) |
| **Required fields** | — |
| **Optional fields** | search, Counted quantity for …, count-date, backdateReason, note |
| **Dropdowns** | — |
| **Primary action** | Post count |
| **Secondary actions** | Post against what the system says now, All correct here, Clear sheet |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | ConfirmDialog |
| **Tables** | 4 columns, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | — |
| **Business effects** | fetchInventory, postStockCount |
| **Permissions** | period.backdate |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | action Post count |

### StorageCheckPage

| | |
| --- | --- |
| **Screen** | StorageCheckPage |
| **Id** | `screen:storage-check` |
| **File** | `apps/web/src/pages/StorageCheckPage.vue` |
| **Kind** | PAGE |
| **Route** | `/settings/offline/storage-check` |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | Run the check |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ⬜ NOT APPLICABLE |
| **Gaps** | The O-6 storage spike measures this physical machine's disk and browser quota. Its whole purpose is to report what varies per device, so an assertion about the number would be an assertion about the CI runner. |

### SupplierOrderPage

| | |
| --- | --- |
| **Screen** | SupplierOrderPage |
| **Id** | `screen:supplier-order` |
| **File** | `apps/web/src/pages/SupplierOrderPage.vue` |
| **Kind** | PAGE |
| **Route** | `/supplier-orders/:id` |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Print / Save PDF, Convert to Purchase |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 3 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | The order could not be loaded. Try again. |
| **Business effects** | fetchSupplierOrder |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### SyncIssuesPage

| | |
| --- | --- |
| **Screen** | SyncIssuesPage |
| **Id** | `screen:sync-issues` |
| **File** | `apps/web/src/pages/SyncIssuesPage.vue` |
| **Kind** | PAGE |
| **Route** | `/sync` |
| **Roles** | sync.conflict.resolve, sync.conflict.discard |
| **Fields** | discardReason (TEXT) |
| **Required fields** | — |
| **Optional fields** | discardReason |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Sync now, All, Keep it waiting, Never post it |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | — |
| **Business effects** | fetchSyncConflicts, fetchSyncStatus, resolveSyncConflict |
| **Permissions** | sync.conflict.resolve, sync.conflict.discard |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### TransferMoneyPage

| | |
| --- | --- |
| **Screen** | TransferMoneyPage |
| **Id** | `screen:transfer-money` |
| **File** | `apps/web/src/pages/TransferMoneyPage.vue` |
| **Kind** | PAGE |
| **Route** | `/finance/transfers` |
| **Roles** | cash.movement.record |
| **Fields** | from-date (DATE), to-date (DATE), transfer-search (TEXT) |
| **Required fields** | — |
| **Optional fields** | from-date, to-date, transfer-search |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | MONEY_EN.newTransfer, Close |
| **Row actions** | View, Edit, Cancel |
| **Destructive actions** | — |
| **Opens** | TransferMoneyDialog, CancelDocumentDialog |
| **Tables** | 7 columns, empty state |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | Could not load the transfers |
| **Business effects** | fetchMovements, voidMovement |
| **Permissions** | cash.movement.record, cash.movement.void |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### UsersPage

| | |
| --- | --- |
| **Screen** | UsersPage |
| **Id** | `screen:users` |
| **File** | `apps/web/src/pages/UsersPage.vue` |
| **Kind** | PAGE |
| **Route** | `/users` |
| **Roles** | user.account.view |
| **Fields** | display-name (TEXT), username (TEXT), identifier (TEXT), role (SELECT), confirm (TEXT), confirm-toggle (TEXT) |
| **Required fields** | display-name, username, identifier, confirm, confirm-toggle |
| **Optional fields** | role |
| **Dropdowns** | role |
| **Primary action** | Add user, Save changes |
| **Secondary actions** | Try again, Cancel |
| **Row actions** | Edit |
| **Destructive actions** | Disable |
| **Opens** | — |
| **Tables** | 6 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | createUser, fetchUsers, setUserDisabled, updateUser |
| **Permissions** | user.account.create, user.account.edit, user.account.disable |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component, playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field display-name, required field username, required field identifier, required field confirm, required field confirm-toggle, dropdown role, action Add user, action Disable, action Save changes |

### VendorStockPage

| | |
| --- | --- |
| **Screen** | VendorStockPage |
| **Id** | `screen:vendor-stock` |
| **File** | `apps/web/src/pages/VendorStockPage.vue` |
| **Kind** | PAGE |
| **Route** | `/vendor-stock` |
| **Roles** | vendor.stock.manage |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Receive vendor stock |
| **Row actions** | Return |
| **Destructive actions** | — |
| **Opens** | VendorStockReceiveDialog, VendorStockReturnDialog |
| **Tables** | 8 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Vendor stock could not be loaded. Try again. |
| **Business effects** | fetchParties, fetchProducts, fetchVendorStock |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### VendorWorkspacePage

| | |
| --- | --- |
| **Screen** | VendorWorkspacePage |
| **Id** | `screen:vendor-workspace` |
| **File** | `apps/web/src/pages/VendorWorkspacePage.vue` |
| **Kind** | PAGE |
| **Route** | `/vendors/workspace` |
| **Roles** | party.vendor.view |
| **Fields** | workspace-vendor (SEARCHABLE_SELECT) |
| **Required fields** | — |
| **Optional fields** | workspace-vendor |
| **Dropdowns** | workspace-vendor (searchable) |
| **Primary action** | — |
| **Secondary actions** | Vendor ledger, Receive vendor stock, Return vendor stock, Pay vendor, Receive payment, Receive products as settlement, Give products, Receive products back … (+1) |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | PayVendorDialog, ReceiveFromVendorDialog, GiveProductsToVendorDialog, ReceiveProductsBackDialog, VendorStockReceiveDialog, VendorStockReturnDialog, VendorProductSettlementDrawer |
| **Tables** | 4 columns, empty state; 7 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchAccounts, fetchParties, fetchProducts, fetchVendorActivity, fetchVendorWorkspace |
| **Permissions** | vendor.payment.record, vendor.receipt.record, vendor.issue.manage, vendor.stock.manage, purchase.bill.create, purchase.bill.edit |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown workspace-vendor |

### WarrantyClaimPage

| | |
| --- | --- |
| **Screen** | WarrantyClaimPage |
| **Id** | `screen:warranty-claim` |
| **File** | `apps/web/src/pages/WarrantyClaimPage.vue` |
| **Kind** | PAGE |
| **Route** | `/warranty/:id` |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | statusLabels[next] |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | ClaimStepDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | The claim could not be loaded. Try again. |
| **Business effects** | fetchAccounts, fetchWarrantyClaim |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | playwright |
| **Status** | ✅ TESTED |
| **Gaps** | — |

### WarrantyClaimsPage

| | |
| --- | --- |
| **Screen** | WarrantyClaimsPage |
| **Id** | `screen:warranty-claims` |
| **File** | `apps/web/src/pages/WarrantyClaimsPage.vue` |
| **Kind** | PAGE |
| **Route** | `/warranty` |
| **Roles** | warranty.claim.view |
| **Fields** | wc-lookup (TEXT), wc-name (TEXT), wc-phone (TEXT), wc-complaint (TEXT), openOnly (CHECKBOX) |
| **Required fields** | wc-complaint |
| **Optional fields** | wc-lookup, wc-name, wc-phone, openOnly |
| **Dropdowns** | — |
| **Primary action** | Take it in |
| **Secondary actions** | Find, Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 5 columns, empty state |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Claims could not be loaded. Try again., Nothing found for that. Check the number, or take the claim in by hand., The lookup failed. Try again., Write what is wrong with it, The claim could not be saved. Try again. |
| **Business effects** | createWarrantyClaim, fetchWarrantyClaims, lookupWarranty |
| **Permissions** | — |
| **Desktop / mobile** | desktop + mobile layout guard |
| **Responsible tests** | playwright, playwright-mobile |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field wc-complaint, action Take it in |

## Dialogs, drawers and shared forms

### CancelDocumentDialog

| | |
| --- | --- |
| **Screen** | CancelDocumentDialog |
| **Id** | `dialog:cancel-document` |
| **File** | `apps/web/src/components/CancelDocumentDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | cancel-reason (TEXT) |
| **Required fields** | — |
| **Optional fields** | cancel-reason |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Keep it, Cancel it |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Say why this is being cancelled, Could not cancel this |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### ConfirmDialog

| | |
| --- | --- |
| **Screen** | ConfirmDialog |
| **Id** | `dialog:confirm` |
| **File** | `apps/web/src/components/ConfirmDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | Confirm |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, action Confirm |

### DateOnlyPicker

| | |
| --- | --- |
| **Screen** | DateOnlyPicker |
| **Id** | `dialog:date-only-picker` |
| **File** | `apps/web/src/components/DateOnlyPicker.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | inputId (DATE) ⚠ no accessible name |
| **Required fields** | inputId |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field inputId |

### ManageListDialog

| | |
| --- | --- |
| **Screen** | ManageListDialog |
| **Id** | `dialog:manage-list` |
| **File** | `apps/web/src/components/ManageListDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | newName (TEXT), draft (TEXT) |
| **Required fields** | newName (conditional), draft (conditional) |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Add, Save, Cancel, Actions for … |
| **Row actions** | — |
| **Destructive actions** | Remove |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field newName, required field draft, action Remove |

### OtpInput

| | |
| --- | --- |
| **Screen** | OtpInput |
| **Id** | `dialog:otp-input` |
| **File** | `apps/web/src/components/OtpInput.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### ProductForm

| | |
| --- | --- |
| **Screen** | ProductForm |
| **Id** | `dialog:product-form` |
| **File** | `apps/web/src/components/ProductForm.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | catalog.product.edit, catalog.product.create, catalog.product.delete, catalog.unit.manage, catalog.brand.manage, catalog.category.manage |
| **Fields** | product-name (TEXT), brandId (SEARCHABLE_SELECT), categoryId (SEARCHABLE_SELECT), baseUnitId (SEARCHABLE_SELECT), purchase-price (MONEY), selling-price (MONEY), min-stock (QUANTITY), opening-stock (QUANTITY), opening-expiry (DATE), product-description (TEXT), product-sku (TEXT), product-barcode (TEXT), discount-type (SELECT), discount-value (MONEY), offerEnabled (CHECKBOX), offer-price (MONEY), offer-start (DATE), offer-end (DATE), has-second-unit (CHECKBOX), conversionUnitId (SEARCHABLE_SELECT) … (+8) |
| **Required fields** | product-name, baseUnitId, purchase-price, selling-price, opening-stock, opening-expiry (conditional), discount-type, offerEnabled … (+1) |
| **Optional fields** | brandId, categoryId, min-stock, product-description, product-sku, product-barcode, discount-value, offer-price, offer-start, offer-end, has-second-unit, conversionUnitId, conversion-factor, tracksSerial, usual-supplier, min-order, warranty-months, supplier-warranty-months, `batch-expiry-${batch.id}` |
| **Dropdowns** | brandId (searchable), categoryId (searchable), baseUnitId (searchable), discount-type, conversionUnitId (searchable) ← baseUnitId, usual-supplier |
| **Primary action** | Save changes |
| **Secondary actions** | Back to products, Price is per, Generate a barcode, Cancel |
| **Row actions** | — |
| **Destructive actions** | Remove picture, Delete |
| **Opens** | — |
| **Tables** | 3 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not save that expiry date, Enter both prices as an amount, with at most two decimal places, Enter the reorder level as a quantity, with at most three decimal places, Enter opening stock as zero or a positive quantity, with at most three decimal places, Enter the expiry date for the opening batch, Enter the offer price … (+2) |
| **Business effects** | createCatalogEntry, fetchCatalog, removeCatalogEntry, renameCatalogEntry, fetchInventoryLots, recordOpeningStock, setLotExpiry, fetchParties, createProduct, deleteProduct, fetchProduct, generateProductBarcode … (+3) |
| **Permissions** | catalog.product.edit, catalog.product.create, catalog.product.delete, catalog.unit.manage, catalog.brand.manage, catalog.category.manage |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | required field product-name, required field baseUnitId, required field purchase-price, required field selling-price, required field opening-stock, required field opening-expiry, required field discount-type, required field offerEnabled, required field tracks-expiry, dropdown brandId … (+8) |

### QuickAddSelect

| | |
| --- | --- |
| **Screen** | QuickAddSelect |
| **Id** | `dialog:quick-add-select` |
| **File** | `apps/web/src/components/QuickAddSelect.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | fieldId (SEARCHABLE_SELECT) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | fieldId |
| **Dropdowns** | fieldId (searchable) |
| **Primary action** | — |
| **Secondary actions** | Add or manage … |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | ManageListDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | component |
| **Status** | 🟡 PARTIALLY TESTED |
| **Gaps** | dropdown fieldId |

### SearchField

| | |
| --- | --- |
| **Screen** | SearchField |
| **Id** | `dialog:search-field` |
| **File** | `apps/web/src/components/SearchField.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | fieldId (TEXT) |
| **Required fields** | — |
| **Optional fields** | fieldId |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Clear … |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | search / filters / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### StockAdjustDialog

| | |
| --- | --- |
| **Screen** | StockAdjustDialog |
| **Id** | `dialog:stock-adjust` |
| **File** | `apps/web/src/components/StockAdjustDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | stock-amount (QUANTITY), stock-reason (SELECT), stock-note (TEXT), stock-date (DATE) |
| **Required fields** | stock-amount, stock-note (conditional) |
| **Optional fields** | stock-reason, stock-date |
| **Dropdowns** | stock-reason |
| **Primary action** | Save adjustment |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Enter how much to add or remove — use a minus sign to remove, Write what happened — "Other" needs a note, The stock change could not be saved. Try again. |
| **Business effects** | adjustStock |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field stock-amount, required field stock-note, dropdown stock-reason, action Save adjustment |

### StockLotsDialog

| | |
| --- | --- |
| **Screen** | StockLotsDialog |
| **Id** | `dialog:stock-lots` |
| **File** | `apps/web/src/components/StockLotsDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | lot-status (SELECT) |
| **Required fields** | — |
| **Optional fields** | lot-status |
| **Dropdowns** | lot-status |
| **Primary action** | — |
| **Secondary actions** | Show more |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 8 columns, sortable, paginated, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | The batches could not be loaded. Try again. |
| **Business effects** | fetchInventoryLots |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown lot-status |

### ReplaceBackupSecretDialog

| | |
| --- | --- |
| **Screen** | ReplaceBackupSecretDialog |
| **Id** | `dialog:replace-backup-secret` |
| **File** | `apps/web/src/components/backup/ReplaceBackupSecretDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | secret-new (TEXT), secret-repeat (TEXT), secret-confirm (TEXT) |
| **Required fields** | secret-new (conditional), secret-confirm (conditional) |
| **Optional fields** | secret-repeat |
| **Dropdowns** | — |
| **Primary action** | Set password |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | The backup password could not be saved. |
| **Business effects** | replaceBackupSecret |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field secret-new, required field secret-confirm, action Set password |

### ResetBusinessDialog

| | |
| --- | --- |
| **Screen** | ResetBusinessDialog |
| **Id** | `dialog:reset-business` |
| **File** | `apps/web/src/components/backup/ResetBusinessDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | reset-phrase (TEXT), reset-password (TEXT) |
| **Required fields** | reset-phrase (conditional), reset-password (conditional) |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | Close |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | Delete all business data |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | The business data was not cleared. |
| **Business effects** | resetBusiness |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field reset-phrase, required field reset-password, action Close, action Delete all business data |

### RestoreDialog

| | |
| --- | --- |
| **Screen** | RestoreDialog |
| **Id** | `dialog:restore` |
| **File** | `apps/web/src/components/backup/RestoreDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | restore-file (FILE), restore-confirm (TEXT) |
| **Required fields** | — |
| **Optional fields** | restore-file, restore-confirm |
| **Dropdowns** | — |
| **Primary action** | Restore this backup |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | inspectArchive, restoreArchive |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, action Restore this backup |

### QuickAddProductDialog

| | |
| --- | --- |
| **Screen** | QuickAddProductDialog |
| **Id** | `dialog:quick-add-product` |
| **File** | `apps/web/src/components/catalog/QuickAddProductDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | qp-name (TEXT), qp-unit (SELECT), qp-min (QUANTITY), qp-buy (MONEY), qp-sell (MONEY), qp-supplier (SELECT) |
| **Required fields** | qp-name, qp-unit, qp-min |
| **Optional fields** | qp-buy, qp-sell, qp-supplier |
| **Dropdowns** | qp-unit, qp-supplier ← qp-name |
| **Primary action** | Add product |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Give the product a name, Choose the unit it is counted in, Enter a valid minimum stock, The product could not be saved. Try again. |
| **Business effects** | createProduct |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field qp-name, required field qp-unit, required field qp-min, dropdown qp-unit, dropdown qp-supplier, action Add product |

### ChangeTransactionDateDialog

| | |
| --- | --- |
| **Screen** | ChangeTransactionDateDialog |
| **Id** | `dialog:change-transaction-date` |
| **File** | `apps/web/src/components/corrections/ChangeTransactionDateDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | redate-date (DATE), redate-reason (TEXT), acknowledged (CHECKBOX), redate-password (TEXT) |
| **Required fields** | redate-date |
| **Optional fields** | redate-reason, acknowledged, redate-password |
| **Dropdowns** | — |
| **Primary action** | Change date |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not open this transaction, Could not change the date |
| **Business effects** | changeTransactionDate, fetchTransactionDateContext |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field redate-date, action Change date |

### DaybookSheet

| | |
| --- | --- |
| **Screen** | DaybookSheet |
| **Id** | `dialog:daybook-sheet` |
| **File** | `apps/web/src/components/daybook/DaybookSheet.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 0 columns; 0 columns; 4 columns; 0 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### AmountInput

| | |
| --- | --- |
| **Screen** | AmountInput |
| **Id** | `dialog:amount-input` |
| **File** | `apps/web/src/components/fields/AmountInput.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | inputId (NUMBER) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | inputId |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### ComboField

| | |
| --- | --- |
| **Screen** | ComboField |
| **Id** | `dialog:combo-field` |
| **File** | `apps/web/src/components/fields/ComboField.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | fieldId (SEARCHABLE_SELECT) |
| **Required fields** | — |
| **Optional fields** | fieldId |
| **Dropdowns** | fieldId (searchable) |
| **Primary action** | — |
| **Secondary actions** | a new one, this list |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown fieldId |

### SerialEntryDialog

| | |
| --- | --- |
| **Screen** | SerialEntryDialog |
| **Id** | `dialog:serial-entry` |
| **File** | `apps/web/src/components/inventory/SerialEntryDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | serial-box (TEXT), serial-paste (TEXT) |
| **Required fields** | — |
| **Optional fields** | serial-box, serial-paste |
| **Dropdowns** | — |
| **Primary action** | Add these |
| **Secondary actions** | Paste a list instead, Back, ×, Close |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | That is already as many serials as the quantity received, The serials could not be saved. Try again. |
| **Business effects** | recordSerials |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, action Add these |

### AccountFormDialog

| | |
| --- | --- |
| **Screen** | AccountFormDialog |
| **Id** | `dialog:account-form` |
| **File** | `apps/web/src/components/money/AccountFormDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | account-name (TEXT), account-type (SELECT), is-drawer (CHECKBOX), account-holder (TEXT), account-reference (TEXT), account-opening (MONEY), opening-date (DATE) |
| **Required fields** | — |
| **Optional fields** | account-name, account-type, is-drawer, account-holder, account-reference, account-opening, opening-date |
| **Dropdowns** | account-type |
| **Primary action** | Save account |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not save the account |
| **Business effects** | createAccount, updateAccount |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown account-type, action Save account |

### AddMissingEntryDialog

| | |
| --- | --- |
| **Screen** | AddMissingEntryDialog |
| **Id** | `dialog:add-missing-entry` |
| **File** | `apps/web/src/components/money/AddMissingEntryDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | missing-kind (SELECT), missing-party (SEARCHABLE_SELECT) |
| **Required fields** | — |
| **Optional fields** | missing-kind, missing-party |
| **Dropdowns** | missing-kind, missing-party (searchable) |
| **Primary action** | Continue |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | RecordExpenseDialog, ReceivePaymentDialog, PaySupplierDialog, TransferMoneyDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the list |
| **Business effects** | fetchExpenses, fetchParties |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown missing-kind, dropdown missing-party, action Continue |

### CapitalLoanEntryDialog

| | |
| --- | --- |
| **Screen** | CapitalLoanEntryDialog |
| **Id** | `dialog:capital-loan-entry` |
| **File** | `apps/web/src/components/money/CapitalLoanEntryDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | entry-loan (SEARCHABLE_SELECT), entry-owner (TEXT), entry-money (SEARCHABLE_SELECT), entry-amount (MONEY) ⚠ no accessible name, entry-date (DATE) ⚠ no accessible name, entry-reference (TEXT) ⚠ no accessible name, entry-note (TEXT) ⚠ no accessible name, entry-reason (TEXT) |
| **Required fields** | — |
| **Optional fields** | entry-loan, entry-owner, entry-money, entry-amount, entry-date, entry-reference, entry-note, entry-reason |
| **Dropdowns** | entry-loan (searchable), entry-money (searchable) |
| **Primary action** | Save entry |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the accounts, Could not record that entry |
| **Business effects** | correctMovement, fetchAccounts, recordMovement |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown entry-loan, dropdown entry-money, action Save entry |

### CompleteReconciliationDialog

| | |
| --- | --- |
| **Screen** | CompleteReconciliationDialog |
| **Id** | `dialog:complete-reconciliation` |
| **File** | `apps/web/src/components/money/CompleteReconciliationDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | closing-balance (MONEY), recon-note (TEXT) |
| **Required fields** | — |
| **Optional fields** | closing-balance, recon-note |
| **Dropdowns** | — |
| **Primary action** | Complete |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not complete the reconciliation |
| **Business effects** | completeReconciliation |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, action Complete |

### CounterAmountField

| | |
| --- | --- |
| **Screen** | CounterAmountField |
| **Id** | `dialog:counter-amount-field` |
| **File** | `apps/web/src/components/money/CounterAmountField.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | 0 (NUMBER) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | 0 |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### CounterChoice

| | |
| --- | --- |
| **Screen** | CounterChoice |
| **Id** | `dialog:counter-choice` |
| **File** | `apps/web/src/components/money/CounterChoice.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### EndDayDialog

| | |
| --- | --- |
| **Screen** | EndDayDialog |
| **Id** | `dialog:end-day` |
| **File** | `apps/web/src/components/money/EndDayDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | amount (MONEY) ⚠ no accessible name, reason (TEXT) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | amount, reason |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | MONEY_EN.cancel, MONEY_EN.confirm, MONEY_EN.endDay |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not close the day |
| **Business effects** | closeDay |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### ImportStatementDialog

| | |
| --- | --- |
| **Screen** | ImportStatementDialog |
| **Id** | `dialog:import-statement` |
| **File** | `apps/web/src/components/money/ImportStatementDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | statement-file (FILE), row.businessDate (TEXT) ⚠ no accessible name, row.description (TEXT) ⚠ no accessible name, row.reference (TEXT) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | statement-file, row.businessDate, row.description, row.reference |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | Remove |
| **Opens** | — |
| **Tables** | 4 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | confirmStatement, uploadStatement |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, action Remove |

### ManageLoanAccountsDialog

| | |
| --- | --- |
| **Screen** | ManageLoanAccountsDialog |
| **Id** | `dialog:manage-loan-accounts` |
| **File** | `apps/web/src/components/money/ManageLoanAccountsDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | loan.account.manage |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | Add loan account |
| **Secondary actions** | Edit this loan, Take out of use — fully repaid, Close |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | AccountFormDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the loan accounts, Could not take that loan out of use |
| **Business effects** | deactivateAccount, fetchAccounts |
| **Permissions** | loan.account.manage |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, action Add loan account |

### MoneyAccountPicker

| | |
| --- | --- |
| **Screen** | MoneyAccountPicker |
| **Id** | `dialog:money-account-picker` |
| **File** | `apps/web/src/components/money/MoneyAccountPicker.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | query (TEXT) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | query |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Choose an account |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | search / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### RecordExpenseDialog

| | |
| --- | --- |
| **Screen** | RecordExpenseDialog |
| **Id** | `dialog:record-expense` |
| **File** | `apps/web/src/components/money/RecordExpenseDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | period.backdate |
| **Fields** | categoryId (SELECT), amount (MONEY), accountId (SELECT), payeeId (SEARCHABLE_SELECT), expense-date (DATE), backdateReason (TEXT), note (TEXT) |
| **Required fields** | — |
| **Optional fields** | categoryId, amount, accountId, payeeId, expense-date, backdateReason, note |
| **Dropdowns** | categoryId, accountId, payeeId (searchable) ← categoryId+amount+accountId+backdateReason |
| **Primary action** | Save |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | StartDayDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | correctExpense, recordExpense, fetchAccounts, fetchDayStatus, fetchParties |
| **Permissions** | period.backdate |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown categoryId, dropdown accountId, dropdown payeeId, action Save |

### ReopenDayDialog

| | |
| --- | --- |
| **Screen** | ReopenDayDialog |
| **Id** | `dialog:reopen-day` |
| **File** | `apps/web/src/components/money/ReopenDayDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | picked (RADIO) ⚠ no accessible name, other (TEXT) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | picked, other |
| **Dropdowns** | picked |
| **Primary action** | — |
| **Secondary actions** | MONEY_EN.cancel, MONEY_EN.confirm |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not reopen the day |
| **Business effects** | reopenDay |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown picked |

### StartDayDialog

| | |
| --- | --- |
| **Screen** | StartDayDialog |
| **Id** | `dialog:start-day` |
| **File** | `apps/web/src/components/money/StartDayDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | amount (MONEY) ⚠ no accessible name, counterpart (RADIO) ⚠ no accessible name, note (TEXT) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | amount, counterpart, note |
| **Dropdowns** | counterpart |
| **Primary action** | — |
| **Secondary actions** | MONEY_EN.cancel, MONEY_EN.startDay |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not start the day |
| **Business effects** | fetchAccounts, startDay |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown counterpart |

### StartReconciliationDialog

| | |
| --- | --- |
| **Screen** | StartReconciliationDialog |
| **Id** | `dialog:start-reconciliation` |
| **File** | `apps/web/src/components/money/StartReconciliationDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | recon-from (DATE), recon-to (DATE) |
| **Required fields** | — |
| **Optional fields** | recon-from, recon-to |
| **Dropdowns** | — |
| **Primary action** | Start |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not start the reconciliation |
| **Business effects** | startReconciliation |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, action Start |

### TransferMoneyDialog

| | |
| --- | --- |
| **Screen** | TransferMoneyDialog |
| **Id** | `dialog:transfer-money` |
| **File** | `apps/web/src/components/money/TransferMoneyDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | transfer-from (SEARCHABLE_SELECT) ⚠ no accessible name, transfer-to (SEARCHABLE_SELECT) ⚠ no accessible name, transfer-amount (MONEY) ⚠ no accessible name, transfer-date (DATE) ⚠ no accessible name, transfer-reference (TEXT) ⚠ no accessible name, transfer-note (TEXT) ⚠ no accessible name, transfer-reason (TEXT) |
| **Required fields** | — |
| **Optional fields** | transfer-from, transfer-to, transfer-amount, transfer-date, transfer-reference, transfer-note, transfer-reason |
| **Dropdowns** | transfer-from (searchable), transfer-to (searchable) |
| **Primary action** | Confirm Transfer |
| **Secondary actions** | Swap the two accounts |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the accounts, Could not record that transfer |
| **Business effects** | correctMovement, fetchAccounts, recordMovement |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown transfer-from, dropdown transfer-to, action Confirm Transfer |

### DeviceNameDialog

| | |
| --- | --- |
| **Screen** | DeviceNameDialog |
| **Id** | `dialog:device-name` |
| **File** | `apps/web/src/components/offline/DeviceNameDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | device-name (TEXT) |
| **Required fields** | — |
| **Optional fields** | device-name |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### ForceRevokeDialog

| | |
| --- | --- |
| **Screen** | ForceRevokeDialog |
| **Id** | `dialog:force-revoke` |
| **File** | `apps/web/src/components/offline/ForceRevokeDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | force-reason (TEXT), force-password (TEXT) |
| **Required fields** | — |
| **Optional fields** | force-reason, force-password |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | Cut off this computer |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, action Cut off this computer |

### OfflineBackupCard

| | |
| --- | --- |
| **Screen** | OfflineBackupCard |
| **Id** | `dialog:offline-backup-card` |
| **File** | `apps/web/src/components/offline/OfflineBackupCard.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | passphrase (TEXT), confirmPassphrase (TEXT), restorePassphrase (TEXT) |
| **Required fields** | — |
| **Optional fields** | passphrase, confirmPassphrase, restorePassphrase |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | Save a copy, Put it back |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### ReplaceWriterDialog

| | |
| --- | --- |
| **Screen** | ReplaceWriterDialog |
| **Id** | `dialog:replace-writer` |
| **File** | `apps/web/src/components/offline/ReplaceWriterDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | replace-name (TEXT), oldMachineWorks (RADIO), replace-reason (TEXT), replace-password (TEXT) |
| **Required fields** | — |
| **Optional fields** | replace-name, oldMachineWorks, replace-reason, replace-password |
| **Dropdowns** | oldMachineWorks |
| **Primary action** | — |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | Move offline permission |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown oldMachineWorks, action Move offline permission |

### PartyOpeningDialog

| | |
| --- | --- |
| **Screen** | PartyOpeningDialog |
| **Id** | `dialog:party-opening` |
| **File** | `apps/web/src/components/parties/PartyOpeningDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | opening-direction (SELECT), opening-amount (MONEY), opening-date (DATE) |
| **Required fields** | opening-amount |
| **Optional fields** | opening-direction, opening-date |
| **Dropdowns** | opening-direction |
| **Primary action** | Post opening balance |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not reach the server., Enter an amount greater than zero, with at most two decimal places |
| **Business effects** | correctPartyOpening, fetchPartyOpening, setPartyOpening |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field opening-amount, dropdown opening-direction, action Post opening balance |

### AddLandedCostDialog

| | |
| --- | --- |
| **Screen** | AddLandedCostDialog |
| **Id** | `dialog:add-landed-cost` |
| **File** | `apps/web/src/components/purchasing/AddLandedCostDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | cost-category (SELECT), cost-description (TEXT), `cost-manual-${line.id}` (NUMBER) ⚠ no accessible name, cost-amount (MONEY), cost-method (SELECT), cost-account (SELECT), cost-date (DATE) |
| **Required fields** | cost-category (conditional), cost-description (conditional), cost-amount, cost-method |
| **Optional fields** | `cost-manual-${line.id}`, cost-account, cost-date |
| **Dropdowns** | cost-category, cost-method, cost-account ← cost-category+cost-description+cost-method |
| **Primary action** | Add cost |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Enter how much the extra cost was, Describe what this Other cost was for, The cost could not be saved. Try again. |
| **Business effects** | addLandedCost |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field cost-category, required field cost-description, required field cost-amount, required field cost-method, dropdown cost-category, dropdown cost-method, dropdown cost-account, action Add cost |

### PaySupplierDialog

| | |
| --- | --- |
| **Screen** | PaySupplierDialog |
| **Id** | `dialog:pay-supplier` |
| **File** | `apps/web/src/components/purchasing/PaySupplierDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | pay-amount (MONEY), pay-account (SELECT), pay-date (DATE), pay-note (TEXT) |
| **Required fields** | — |
| **Optional fields** | pay-amount, pay-account, pay-date, pay-note |
| **Dropdowns** | pay-account |
| **Primary action** | — |
| **Secondary actions** | MONEY_BN.startDay, MONEY_BN.cancel, Pay … |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | StartDayDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchAccounts, fetchDayStatus, fetchSupplierDue, paySupplier |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown pay-account |

### PurchaseReturnDialog

| | |
| --- | --- |
| **Screen** | PurchaseReturnDialog |
| **Id** | `dialog:purchase-return` |
| **File** | `apps/web/src/components/purchasing/PurchaseReturnDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | Quantity going back for … (MONEY), reason (SELECT), note (TEXT), received (MONEY), accountId (SELECT) |
| **Required fields** | — |
| **Optional fields** | Quantity going back for …, reason, note, received, accountId |
| **Dropdowns** | reason, accountId |
| **Primary action** | Send Back |
| **Secondary actions** | Keep as credit, Money back now, Cancel |
| **Row actions** | All |
| **Destructive actions** | — |
| **Opens** | ConfirmDialog, StartDayDialog |
| **Tables** | 4 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchAccounts, fetchDayStatus, createPurchaseReturn, fetchReturnableBill |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown reason, dropdown accountId, action Send Back |

### ProfitTargetDialog

| | |
| --- | --- |
| **Screen** | ProfitTargetDialog |
| **Id** | `dialog:profit-target` |
| **File** | `apps/web/src/components/reports/ProfitTargetDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | target-basis (SELECT), target-amount (MONEY) |
| **Required fields** | — |
| **Optional fields** | target-basis, target-amount |
| **Dropdowns** | target-basis |
| **Primary action** | — |
| **Secondary actions** | Cancel, Save target |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown target-basis |

### ReportScreen

| | |
| --- | --- |
| **Screen** | ReportScreen |
| **Id** | `dialog:report-screen` |
| **File** | `apps/web/src/components/reports/ReportScreen.vue` |
| **Kind** | COMPONENT |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | report-from (DATE) ⚠ no accessible name, report-to (DATE) ⚠ no accessible name |
| **Required fields** | — |
| **Optional fields** | report-from, report-to |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | option.label, Print, CSV |
| **Row actions** | Why? |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 8 columns, empty state |
| **Search / filters / tabs** | — / filters / — |
| **Validation rules** | — |
| **Business effects** | — |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### WhyDialog

| | |
| --- | --- |
| **Screen** | WhyDialog |
| **Id** | `dialog:why` |
| **File** | `apps/web/src/components/reports/WhyDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | 4 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not load the details |
| **Business effects** | fetchWhy |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### InvoicePreviewDialog

| | |
| --- | --- |
| **Screen** | InvoicePreviewDialog |
| **Id** | `dialog:invoice-preview` |
| **File** | `apps/web/src/components/sales/InvoicePreviewDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | sale.invoice.edit, sale.invoice.void, sales.return.create |
| **Fields** | — |
| **Required fields** | — |
| **Optional fields** | — |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | English, A4, 80mm, Edit Sale, Return, Thermal Print, Save as JPG, Share … (+2) |
| **Row actions** | — |
| **Destructive actions** | Cancel Sale |
| **Opens** | SalesReturnDialog, ConfirmDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchImageDataUrl, cancelSale, fetchInvoiceSettings, fetchSale |
| **Permissions** | sale.invoice.edit, sale.invoice.void, sales.return.create |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ⬜ NOT APPLICABLE |
| **Gaps** | Renders the invoice for a printer. What reaches paper is a browser print pipeline, not application behaviour; the figures on it are asserted where they are computed. |

### ReceivePaymentDialog

| | |
| --- | --- |
| **Screen** | ReceivePaymentDialog |
| **Id** | `dialog:receive-payment` |
| **File** | `apps/web/src/components/sales/ReceivePaymentDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | amount (NUMBER), accountId (SELECT), note (TEXT) |
| **Required fields** | — |
| **Optional fields** | amount, accountId, note |
| **Dropdowns** | accountId |
| **Primary action** | — |
| **Secondary actions** | Cancel, Receive |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | ConfirmDialog, StartDayDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchAccounts, fetchDayStatus, fetchCustomerStanding, receiveCustomerPayment |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown accountId |

### SalesReturnDialog

| | |
| --- | --- |
| **Screen** | SalesReturnDialog |
| **Id** | `dialog:sales-return` |
| **File** | `apps/web/src/components/sales/SalesReturnDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | Quantity returning for … (MONEY), selectedSerials[line.saleLineId] (CHECKBOX), reason (SELECT), note (TEXT), refund (MONEY), accountId (SELECT), customerName (TEXT), customerPhone (TEXT), approvalPin (TEXT) |
| **Required fields** | — |
| **Optional fields** | Quantity returning for …, selectedSerials[line.saleLineId], reason, note, refund, accountId, customerName, customerPhone, approvalPin |
| **Dropdowns** | reason, accountId |
| **Primary action** | Take Return, Approve |
| **Secondary actions** | Keep on account, Refund now, Cancel |
| **Row actions** | All |
| **Destructive actions** | — |
| **Opens** | ConfirmDialog, StartDayDialog |
| **Tables** | 4 columns |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchAccounts, fetchDayStatus, createSalesReturn, fetchReturnableInvoice |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown reason, dropdown accountId, action Take Return, action Approve |

### GlobalSearchDialog

| | |
| --- | --- |
| **Screen** | GlobalSearchDialog |
| **Id** | `dialog:global-search` |
| **File** | `apps/web/src/components/shell/GlobalSearchDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | query (TEXT) |
| **Required fields** | — |
| **Optional fields** | query |
| **Dropdowns** | — |
| **Primary action** | — |
| **Secondary actions** | — |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | search / — / — |
| **Validation rules** | — |
| **Business effects** | globalSearch |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself |

### GiveProductsToVendorDialog

| | |
| --- | --- |
| **Screen** | GiveProductsToVendorDialog |
| **Id** | `dialog:give-products-to-vendor` |
| **File** | `apps/web/src/components/vendors/GiveProductsToVendorDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | give-mode (SELECT), give-product (SEARCHABLE_SELECT), give-qty (MONEY), give-date (DATE), give-note (TEXT) |
| **Required fields** | — |
| **Optional fields** | give-mode, give-product, give-qty, give-date, give-note |
| **Dropdowns** | give-mode, give-product (searchable) |
| **Primary action** | — |
| **Secondary actions** | Cancel, Issue temporarily |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not record this |
| **Business effects** | giveProductsToVendor |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown give-mode, dropdown give-product |

### PayVendorDialog

| | |
| --- | --- |
| **Screen** | PayVendorDialog |
| **Id** | `dialog:pay-vendor` |
| **File** | `apps/web/src/components/vendors/PayVendorDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | vendor-pay-intent (SELECT), vendor-pay-amount (MONEY), vendor-pay-account (SELECT), vendor-pay-date (DATE), vendor-pay-note (TEXT) |
| **Required fields** | — |
| **Optional fields** | vendor-pay-intent, vendor-pay-amount, vendor-pay-account, vendor-pay-date, vendor-pay-note |
| **Dropdowns** | vendor-pay-intent, vendor-pay-account |
| **Primary action** | — |
| **Secondary actions** | MONEY_BN.startDay, MONEY_BN.cancel, Pay … |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | StartDayDialog |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchAccounts, fetchDayStatus, payVendor |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown vendor-pay-intent, dropdown vendor-pay-account |

### ReceiveFromVendorDialog

| | |
| --- | --- |
| **Screen** | ReceiveFromVendorDialog |
| **Id** | `dialog:receive-from-vendor` |
| **File** | `apps/web/src/components/vendors/ReceiveFromVendorDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | vendor-receive-intent (SELECT), vendor-receive-amount (MONEY), vendor-receive-account (SELECT), vendor-receive-date (DATE), vendor-receive-note (TEXT) |
| **Required fields** | — |
| **Optional fields** | vendor-receive-intent, vendor-receive-amount, vendor-receive-account, vendor-receive-date, vendor-receive-note |
| **Dropdowns** | vendor-receive-intent, vendor-receive-account |
| **Primary action** | — |
| **Secondary actions** | MONEY_BN.cancel, Receive … |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | — |
| **Business effects** | fetchAccounts, receiveFromVendor |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown vendor-receive-intent, dropdown vendor-receive-account |

### ReceiveProductsBackDialog

| | |
| --- | --- |
| **Screen** | ReceiveProductsBackDialog |
| **Id** | `dialog:receive-products-back` |
| **File** | `apps/web/src/components/vendors/ReceiveProductsBackDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | back-issue (SELECT), back-qty (MONEY), back-date (DATE), back-note (TEXT) |
| **Required fields** | — |
| **Optional fields** | back-issue, back-qty, back-date, back-note |
| **Dropdowns** | back-issue |
| **Primary action** | — |
| **Secondary actions** | Cancel, Receive back |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Could not record this return |
| **Business effects** | receiveProductsBack |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, dropdown back-issue |

### VendorProductSettlementDrawer

| | |
| --- | --- |
| **Screen** | VendorProductSettlementDrawer |
| **Id** | `dialog:vendor-product-settlement` |
| **File** | `apps/web/src/components/vendors/VendorProductSettlementDrawer.vue` |
| **Kind** | DRAWER |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | settlement-date (DATE), supplierBillRef (TEXT), line.productId (SEARCHABLE_SELECT) ⚠ no accessible name, line.qty (MONEY) ⚠ no accessible name, line.price (MONEY) ⚠ no accessible name, `settlement-expiry-${index}` (DATE) ⚠ no accessible name, line.serialText (TEXTAREA) ⚠ no accessible name, discount (MONEY), cost.category (SELECT) ⚠ no accessible name, cost.amount (MONEY) ⚠ no accessible name, cost.method (SELECT) ⚠ no accessible name, cost.paidAccountCode (SELECT) ⚠ no accessible name, cost.description (TEXT) ⚠ no accessible name, { cost.manual[lineIndex] = value }" /> (MONEY), notes (TEXTAREA) |
| **Required fields** | line.productId (conditional), line.qty (conditional), line.price (conditional), `settlement-expiry-${index}`, cost.category (conditional), cost.amount (conditional), cost.method (conditional), cost.paidAccountCode (conditional) … (+1) |
| **Optional fields** | settlement-date, supplierBillRef, line.serialText, discount, { cost.manual[lineIndex] = value }" />, notes |
| **Dropdowns** | line.productId (searchable), cost.category, cost.method, cost.paidAccountCode |
| **Primary action** | Post settlement |
| **Secondary actions** | + Add product, + Add cost, Cancel |
| **Row actions** | — |
| **Destructive actions** | Remove |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Complete every product line, Net product value must be positive and cannot exceed the vendor receivable, Complete every landed-cost row; manual Remaining must be zero, The product settlement could not be posted |
| **Business effects** | settleVendorWithProducts |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field line.productId, required field line.qty, required field line.price, required field `settlement-expiry-${index}`, required field cost.category, required field cost.amount, required field cost.method, required field cost.paidAccountCode, required field cost.description … (+6) |

### VendorStockReceiveDialog

| | |
| --- | --- |
| **Screen** | VendorStockReceiveDialog |
| **Id** | `dialog:vendor-stock-receive` |
| **File** | `apps/web/src/components/vendors/VendorStockReceiveDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | vs-vendor (SEARCHABLE_SELECT), vs-product (SEARCHABLE_SELECT), vs-qty (MONEY), vs-serials (TEXTAREA), vs-cost (MONEY), vs-date (DATE), vs-expiry (DATE), vs-note (TEXT) |
| **Required fields** | vs-vendor (conditional), vs-product (conditional), vs-qty |
| **Optional fields** | vs-serials, vs-cost, vs-date, vs-expiry, vs-note |
| **Dropdowns** | vs-vendor (searchable), vs-product (searchable) |
| **Primary action** | Receive stock |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Choose the vendor and the product, Enter how many they left, The vendor stock could not be saved. Try again. |
| **Business effects** | receiveVendorStock |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field vs-vendor, required field vs-product, required field vs-qty, dropdown vs-vendor, dropdown vs-product, action Receive stock |

### VendorStockReturnDialog

| | |
| --- | --- |
| **Screen** | VendorStockReturnDialog |
| **Id** | `dialog:vendor-stock-return` |
| **File** | `apps/web/src/components/vendors/VendorStockReturnDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | vr-qty (MONEY), selectedSerialIds (CHECKBOX) ⚠ no accessible name, vr-date (DATE), vr-note (TEXT) |
| **Required fields** | vr-qty (conditional), selectedSerialIds (conditional) |
| **Optional fields** | vr-date, vr-note |
| **Dropdowns** | — |
| **Primary action** | Return stock |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Select exactly one serial for every unit going back, The return could not be saved. Try again. |
| **Business effects** | returnVendorStock, fetchAvailableSerials |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field vr-qty, required field selectedSerialIds, action Return stock |

### ClaimStepDialog

| | |
| --- | --- |
| **Screen** | ClaimStepDialog |
| **Id** | `dialog:claim-step` |
| **File** | `apps/web/src/components/warranty/ClaimStepDialog.vue` |
| **Kind** | DIALOG |
| **Route** | opened from its parent screen |
| **Roles** | — |
| **Fields** | cs-settlement (SELECT), cs-unit (SELECT), cs-amount (MONEY), cs-account (SELECT), cs-note (TEXT), cs-date (DATE) |
| **Required fields** | cs-amount (conditional) |
| **Optional fields** | cs-settlement, cs-unit, cs-account, cs-note, cs-date |
| **Dropdowns** | cs-settlement, cs-unit, cs-account |
| **Primary action** | Save |
| **Secondary actions** | Cancel |
| **Row actions** | — |
| **Destructive actions** | — |
| **Opens** | — |
| **Tables** | — |
| **Search / filters / tabs** | — / — / — |
| **Validation rules** | Say how much the supplier credited, The claim could not be updated. Try again. |
| **Business effects** | fetchAvailableSerials, moveWarrantyClaim |
| **Permissions** | — |
| **Desktop / mobile** | desktop |
| **Responsible tests** | — |
| **Status** | ❌ NOT TESTED |
| **Gaps** | the screen itself, required field cs-amount, dropdown cs-settlement, dropdown cs-unit, dropdown cs-account, action Save |

## Endpoints

> Backend validation is authoritative (§6). A request that bypasses the UI must still be
> refused, so every endpoint is listed whether or not a screen calls it.

| Method | Path | Controller | Permissions its module requires | Status |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/audit-events` | AuditController | AUDIT_VIEW | ✅ TESTED |
| GET | `/api/v1/backup/status` | BackupController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ✅ TESTED |
| POST | `/api/v1/backup/export` | BackupController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ✅ TESTED |
| POST | `/api/v1/backup/inspect` | BackupController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ✅ TESTED |
| POST | `/api/v1/backup/restore` | BackupController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ✅ TESTED |
| POST | `/api/v1/backup/reset` | BackupController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ❌ NOT TESTED |
| POST | `/api/v1/backup/secret` | BackupController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ❌ NOT TESTED |
| POST | `/api/v1/license` | LicenseController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ❌ NOT TESTED |
| GET | `/api/v1/license` | LicenseController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ❌ NOT TESTED |
| GET | `/api/v1/license/notice` | LicenseController | BACKUP_EXPORT, BACKUP_RESTORE, BUSINESS_RESET | ❌ NOT TESTED |
| GET | `/api/v1/catalog` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| POST | `/api/v1/catalog/units` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| PATCH | `/api/v1/catalog/units/:id` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| POST | `/api/v1/catalog/units/:id/remove` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| POST | `/api/v1/catalog/brands` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| PATCH | `/api/v1/catalog/brands/:id` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| POST | `/api/v1/catalog/brands/:id/remove` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| POST | `/api/v1/catalog/categories` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| PATCH | `/api/v1/catalog/categories/:id` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| POST | `/api/v1/catalog/categories/:id/remove` | CatalogController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| GET | `/api/v1/products` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| GET | `/api/v1/products/:id` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| POST | `/api/v1/products` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| PATCH | `/api/v1/products/:id` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| POST | `/api/v1/products/:id/status` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| POST | `/api/v1/products/:id/barcode` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| DELETE | `/api/v1/products/:id` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ✅ TESTED |
| GET | `/api/v1/products/:id/image` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| POST | `/api/v1/products/:id/image` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| DELETE | `/api/v1/products/:id/image` | ProductsController | BRAND_MANAGE, CATEGORY_MANAGE, COST_VIEW, PRODUCT_CREATE … (+5) | ❌ NOT TESTED |
| GET | `/api/v1/corrections/transaction-date/:documentType/:documentId` | CorrectionsController | TRANSACTION_DATE_CHANGE, TRANSACTION_DATE_CHANGE_LOCKED | ✅ TESTED |
| POST | `/api/v1/corrections/transaction-date` | CorrectionsController | TRANSACTION_DATE_CHANGE, TRANSACTION_DATE_CHANGE_LOCKED | ✅ TESTED |
| GET | `/api/v1/daybook` | DaybookController | CASH_MOVEMENT_RECORD, CASH_MOVEMENT_VOID, CUSTOMER_EDIT, DAYBOOK_PRINT … (+20) | ❌ NOT TESTED |
| POST | `/api/v1/daybook/review` | DaybookController | CASH_MOVEMENT_RECORD, CASH_MOVEMENT_VOID, CUSTOMER_EDIT, DAYBOOK_PRINT … (+20) | ❌ NOT TESTED |
| POST | `/api/v1/daybook/print` | DaybookController | CASH_MOVEMENT_RECORD, CASH_MOVEMENT_VOID, CUSTOMER_EDIT, DAYBOOK_PRINT … (+20) | ❌ NOT TESTED |
| GET | `/api/v1/daybook/prints` | DaybookController | CASH_MOVEMENT_RECORD, CASH_MOVEMENT_VOID, CUSTOMER_EDIT, DAYBOOK_PRINT … (+20) | ❌ NOT TESTED |
| GET | `/api/v1/offline/status` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/offline/devices` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/devices/register` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/devices/request` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/devices/gate` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/devices/approve` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/devices/rename` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/devices/revoke` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/devices/force-revoke` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/devices/replace-writer` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/offline/snapshot` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/offline/snapshot/report` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/offline/:id/offline-users` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| PUT | `/api/v1/offline/:id/offline-users` | DevicesController | COST_VIEW, CUSTOMER_VIEW, DEVICE_APPROVE, DEVICE_FORCE_REVOKE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/expenses` | ExpensesController | EXPENSE_RECORD, EXPENSE_VIEW, EXPENSE_VOID, PERIOD_BACKDATE | ✅ TESTED |
| POST | `/api/v1/expenses` | ExpensesController | EXPENSE_RECORD, EXPENSE_VIEW, EXPENSE_VOID, PERIOD_BACKDATE | ✅ TESTED |
| PATCH | `/api/v1/expenses/:id` | ExpensesController | EXPENSE_RECORD, EXPENSE_VIEW, EXPENSE_VOID, PERIOD_BACKDATE | ❌ NOT TESTED |
| POST | `/api/v1/expenses/:id/void` | ExpensesController | EXPENSE_RECORD, EXPENSE_VIEW, EXPENSE_VOID, PERIOD_BACKDATE | ✅ TESTED |
| POST | `/api/v1/expenses/categories` | ExpensesController | EXPENSE_RECORD, EXPENSE_VIEW, EXPENSE_VOID, PERIOD_BACKDATE | ✅ TESTED |
| PUT | `/api/v1/expenses/categories/:id` | ExpensesController | EXPENSE_RECORD, EXPENSE_VIEW, EXPENSE_VOID, PERIOD_BACKDATE | ❌ NOT TESTED |
| DELETE | `/api/v1/expenses/categories/:id` | ExpensesController | EXPENSE_RECORD, EXPENSE_VIEW, EXPENSE_VOID, PERIOD_BACKDATE | ❌ NOT TESTED |
| GET | `/health` | HealthController | — | ❌ NOT TESTED |
| POST | `/api/v1/imports/preview` | ImportsController | CUSTOMER_CREATE, PRODUCT_CREATE, SUPPLIER_CREATE | ✅ TESTED |
| POST | `/api/v1/imports` | ImportsController | CUSTOMER_CREATE, PRODUCT_CREATE, SUPPLIER_CREATE | ✅ TESTED |
| GET | `/api/v1/inventory/lots` | InventoryLotsController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| PUT | `/api/v1/inventory/lots/:id/expiry` | InventoryLotsController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ❌ NOT TESTED |
| GET | `/api/v1/inventory/valuation` | InventoryValuationController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| GET | `/api/v1/inventory` | InventoryController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| GET | `/api/v1/inventory/adjustments` | InventoryController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| GET | `/api/v1/inventory/cost-adjustments` | InventoryController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| POST | `/api/v1/inventory/adjustments` | InventoryController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| GET | `/api/v1/inventory/openings/:id` | InventoryController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| POST | `/api/v1/inventory/openings` | InventoryController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| POST | `/api/v1/inventory/adjustments/:id/void` | InventoryController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ❌ NOT TESTED |
| GET | `/api/v1/stock-counts` | StockCountsController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| POST | `/api/v1/stock-counts` | StockCountsController | COST_VIEW, INVENTORY_LOT_VIEW, PERIOD_BACKDATE, PRODUCT_CREATE … (+6) | ✅ TESTED |
| GET | `/api/v1/provider/status` | ManagementStatusController | — | ❌ NOT TESTED |
| GET | `/api/v1/management/status` | ManagementController | — | ❌ NOT TESTED |
| POST | `/api/v1/management/diagnostics` | ManagementController | — | ❌ NOT TESTED |
| POST | `/api/v1/management/licence` | ManagementController | — | ❌ NOT TESTED |
| POST | `/api/v1/management/backup` | ManagementController | — | ❌ NOT TESTED |
| POST | `/api/v1/management/feature-flags` | ManagementController | — | ❌ NOT TESTED |
| POST | `/api/v1/management/support-session` | ManagementController | — | ❌ NOT TESTED |
| GET | `/api/v1/money/accounts` | AccountsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ❌ NOT TESTED |
| GET | `/api/v1/money/accounts/:id/statement` | AccountsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ❌ NOT TESTED |
| POST | `/api/v1/money/accounts` | AccountsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| PATCH | `/api/v1/money/accounts/:id` | AccountsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ❌ NOT TESTED |
| POST | `/api/v1/money/accounts/:id/deactivate` | AccountsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ❌ NOT TESTED |
| GET | `/api/v1/money/day` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| GET | `/api/v1/money/daily-cash` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/day/start` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/day/:id/close` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/day/:id/reopen` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ❌ NOT TESTED |
| GET | `/api/v1/money/movements` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/movements` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| PATCH | `/api/v1/money/movements/:id` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ❌ NOT TESTED |
| POST | `/api/v1/money/movements/:id/void` | CashSessionsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ❌ NOT TESTED |
| GET | `/api/v1/money/reconciliations` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ❌ NOT TESTED |
| GET | `/api/v1/money/reconciliations/:id` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/reconciliations` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/reconciliations/:id/statement` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/reconciliations/:id/statement/confirm` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| GET | `/api/v1/money/reconciliations/:id/statement/:fileId/file` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/reconciliations/:id/matches` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| DELETE | `/api/v1/money/reconciliations/:id/matches/:matchId` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/reconciliations/:id/complete` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/money/reconciliations/:id/reopen` | ReconciliationsController | BANK_ACCOUNT_MANAGE, BANK_ACCOUNT_VIEW, CASH_ACCOUNT_MANAGE, CASH_ACCOUNT_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/notes` | NotesController | NOTE_CREATE, NOTE_VIEW | ✅ TESTED |
| GET | `/api/v1/notes/:id` | NotesController | NOTE_CREATE, NOTE_VIEW | ✅ TESTED |
| GET | `/api/v1/parties` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ✅ TESTED |
| GET | `/api/v1/parties/:id` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ✅ TESTED |
| GET | `/api/v1/parties/:id/ledger` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/parties` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ✅ TESTED |
| GET | `/api/v1/parties/:id/opening` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ❌ NOT TESTED |
| POST | `/api/v1/parties/:id/opening` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ❌ NOT TESTED |
| PATCH | `/api/v1/parties/:id/opening` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ❌ NOT TESTED |
| PATCH | `/api/v1/parties/:id` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ✅ TESTED |
| POST | `/api/v1/parties/:id/status` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ✅ TESTED |
| DELETE | `/api/v1/parties/:id` | PartiesController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ✅ TESTED |
| GET | `/api/v1/party-setup` | PartyGroupsController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ❌ NOT TESTED |
| POST | `/api/v1/party-setup/groups` | PartyGroupsController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ✅ TESTED |
| PATCH | `/api/v1/party-setup/groups/:id` | PartyGroupsController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ❌ NOT TESTED |
| DELETE | `/api/v1/party-setup/groups/:id` | PartyGroupsController | CUSTOMER_CREATE, CUSTOMER_DEACTIVATE, CUSTOMER_EDIT, CUSTOMER_VIEW … (+9) | ❌ NOT TESTED |
| GET | `/api/v1/periods` | PeriodsController | PERIOD_CLOSE, SETTING_VIEW | ❌ NOT TESTED |
| POST | `/api/v1/periods/close` | PeriodsController | PERIOD_CLOSE, SETTING_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/purchase-plans/suggestions` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/purchase-plans` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/purchase-plans/:id` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/purchase-plans` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/purchase-plans/:id` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/purchase-plans/:id/decide` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/purchase-plans/:id/delete` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/purchase-plans` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/purchase-plans/:id` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/purchase-plans` | PurchasePlansController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/purchases` | PurchasesController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ✅ TESTED |
| GET | `/api/v1/purchases/:id` | PurchasesController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ✅ TESTED |
| POST | `/api/v1/purchases` | PurchasesController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ✅ TESTED |
| POST | `/api/v1/purchases/:id/void` | PurchasesController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ✅ TESTED |
| GET | `/api/v1/suppliers/:id/due` | SupplierPaymentsController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/suppliers/payments` | SupplierPaymentsController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ✅ TESTED |
| PATCH | `/api/v1/suppliers/payments/:id` | SupplierPaymentsController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| POST | `/api/v1/suppliers/payments/:id/void` | SupplierPaymentsController | BANK_ACCOUNT_VIEW, CASH_ACCOUNT_VIEW, COST_VIEW, PURCHASE_CREATE … (+7) | ❌ NOT TESTED |
| GET | `/api/v1/dashboard/summary` | DashboardController | — | ✅ TESTED |
| POST | `/api/v1/auth/login` | LoginController | — | ✅ TESTED |
| POST | `/api/v1/auth/login/google` | LoginController | — | ✅ TESTED |
| POST | `/api/v1/auth/login/pin` | LoginController | — | ✅ TESTED |
| POST | `/api/v1/auth/refresh` | LoginController | — | ✅ TESTED |
| POST | `/api/v1/auth/logout` | LoginController | — | ✅ TESTED |
| GET | `/api/v1/me` | MeController | — | ✅ TESTED |
| POST | `/api/v1/auth/password/otp` | PasswordRecoveryController | — | ✅ TESTED |
| POST | `/api/v1/auth/password/reset` | PasswordRecoveryController | — | ✅ TESTED |
| POST | `/api/v1/auth/registration/otp` | RegistrationController | — | ✅ TESTED |
| POST | `/api/v1/auth/registration/otp/verify` | RegistrationController | — | ✅ TESTED |
| POST | `/api/v1/auth/registration` | RegistrationController | — | ✅ TESTED |
| POST | `/api/v1/auth/registration/google` | RegistrationController | — | ✅ TESTED |
| GET | `/api/v1/settings/security` | SecurityController | — | ✅ TESTED |
| POST | `/api/v1/settings/security/password` | SecurityController | — | ✅ TESTED |
| POST | `/api/v1/settings/security/pin` | SecurityController | — | ✅ TESTED |
| GET | `/api/v1/reports/sales` | ReportsController | — | ❌ NOT TESTED |
| GET | `/api/v1/reports/purchases` | ReportsController | — | ❌ NOT TESTED |
| GET | `/api/v1/reports/stock` | ReportsController | — | ❌ NOT TESTED |
| GET | `/api/v1/reports/money` | ReportsController | — | ❌ NOT TESTED |
| GET | `/api/v1/reports/performance` | ReportsController | — | ❌ NOT TESTED |
| GET | `/api/v1/reports/why` | ReportsController | — | ❌ NOT TESTED |
| GET | `/api/v1/reports/target` | TargetsController | — | ❌ NOT TESTED |
| PUT | `/api/v1/reports/target` | TargetsController | — | ❌ NOT TESTED |
| GET | `/api/v1/dashboard/cards` | TargetsController | — | ❌ NOT TESTED |
| GET | `/api/v1/purchase-returns/returnable/:purchaseId` | PurchaseReturnsController | PERIOD_BACKDATE, PURCHASE_RETURN_CREATE, PURCHASE_RETURN_VIEW, PURCHASE_RETURN_VOID … (+3) | ✅ TESTED |
| GET | `/api/v1/purchase-returns` | PurchaseReturnsController | PERIOD_BACKDATE, PURCHASE_RETURN_CREATE, PURCHASE_RETURN_VIEW, PURCHASE_RETURN_VOID … (+3) | ✅ TESTED |
| POST | `/api/v1/purchase-returns` | PurchaseReturnsController | PERIOD_BACKDATE, PURCHASE_RETURN_CREATE, PURCHASE_RETURN_VIEW, PURCHASE_RETURN_VOID … (+3) | ✅ TESTED |
| POST | `/api/v1/purchase-returns/:id/void` | PurchaseReturnsController | PERIOD_BACKDATE, PURCHASE_RETURN_CREATE, PURCHASE_RETURN_VIEW, PURCHASE_RETURN_VOID … (+3) | ❌ NOT TESTED |
| GET | `/api/v1/sales-returns/returnable/:saleId` | SalesReturnsController | PERIOD_BACKDATE, PURCHASE_RETURN_CREATE, PURCHASE_RETURN_VIEW, PURCHASE_RETURN_VOID … (+3) | ✅ TESTED |
| GET | `/api/v1/sales-returns` | SalesReturnsController | PERIOD_BACKDATE, PURCHASE_RETURN_CREATE, PURCHASE_RETURN_VIEW, PURCHASE_RETURN_VOID … (+3) | ✅ TESTED |
| POST | `/api/v1/sales-returns` | SalesReturnsController | PERIOD_BACKDATE, PURCHASE_RETURN_CREATE, PURCHASE_RETURN_VIEW, PURCHASE_RETURN_VOID … (+3) | ✅ TESTED |
| POST | `/api/v1/sales-returns/:id/void` | SalesReturnsController | PERIOD_BACKDATE, PURCHASE_RETURN_CREATE, PURCHASE_RETURN_VIEW, PURCHASE_RETURN_VOID … (+3) | ❌ NOT TESTED |
| GET | `/api/v1/customers/:id/standing` | CustomerPaymentsController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| POST | `/api/v1/customer-payments` | CustomerPaymentsController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| PATCH | `/api/v1/customer-payments/:id` | CustomerPaymentsController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| POST | `/api/v1/customer-payments/:id/void` | CustomerPaymentsController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| GET | `/api/v1/quotations` | QuotationsController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| GET | `/api/v1/quotations/:id` | QuotationsController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| POST | `/api/v1/quotations` | QuotationsController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| GET | `/api/v1/sales/pos-products` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| GET | `/api/v1/sales/invoice-settings` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| PUT | `/api/v1/sales/invoice-settings` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| GET | `/api/v1/sales/invoice-logo` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| POST | `/api/v1/sales/invoice-logo` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| DELETE | `/api/v1/sales/invoice-logo` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| GET | `/api/v1/sales/drafts` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| POST | `/api/v1/sales/drafts` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| DELETE | `/api/v1/sales/drafts/:id` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| GET | `/api/v1/sales` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ✅ TESTED |
| GET | `/api/v1/sales/:id` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ✅ TESTED |
| POST | `/api/v1/sales` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ✅ TESTED |
| PUT | `/api/v1/sales/:id/presentation` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ❌ NOT TESTED |
| POST | `/api/v1/sales/:id/cancel` | SalesController | COST_VIEW, CUSTOMER_VIEW, RECEIPT_VOID, SALE_CREATE … (+8) | ✅ TESTED |
| GET | `/api/v1/search` | SearchController | CUSTOMER_VIEW, PRODUCT_VIEW, PURCHASE_VIEW, SALE_VIEW … (+2) | ❌ NOT TESTED |
| GET | `/api/v1/settings` | SettingsController | SETTING_EDIT, SETTING_TOGGLE, SETTING_VIEW | ✅ TESTED |
| POST | `/api/v1/settings/value` | SettingsController | SETTING_EDIT, SETTING_TOGGLE, SETTING_VIEW | ✅ TESTED |
| PATCH | `/api/v1/settings/business` | SettingsController | SETTING_EDIT, SETTING_TOGGLE, SETTING_VIEW | ✅ TESTED |
| POST | `/api/v1/sync/push` | SyncController | SYNC_CONFLICT_DISCARD, SYNC_CONFLICT_RESOLVE, SYNC_STATUS_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/sync/pull` | SyncController | SYNC_CONFLICT_DISCARD, SYNC_CONFLICT_RESOLVE, SYNC_STATUS_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/sync/status` | SyncController | SYNC_CONFLICT_DISCARD, SYNC_CONFLICT_RESOLVE, SYNC_STATUS_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/sync/conflicts` | SyncController | SYNC_CONFLICT_DISCARD, SYNC_CONFLICT_RESOLVE, SYNC_STATUS_VIEW | ❌ NOT TESTED |
| POST | `/api/v1/sync/conflicts/:id/resolve` | SyncController | SYNC_CONFLICT_DISCARD, SYNC_CONFLICT_RESOLVE, SYNC_STATUS_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/roles` | RolesController | ROLE_MANAGE, ROLE_VIEW, USER_CREATE, USER_DISABLE … (+2) | ✅ TESTED |
| POST | `/api/v1/roles` | RolesController | ROLE_MANAGE, ROLE_VIEW, USER_CREATE, USER_DISABLE … (+2) | ✅ TESTED |
| PATCH | `/api/v1/roles/:id` | RolesController | ROLE_MANAGE, ROLE_VIEW, USER_CREATE, USER_DISABLE … (+2) | ✅ TESTED |
| DELETE | `/api/v1/roles/:id` | RolesController | ROLE_MANAGE, ROLE_VIEW, USER_CREATE, USER_DISABLE … (+2) | ✅ TESTED |
| GET | `/api/v1/users` | UsersController | ROLE_MANAGE, ROLE_VIEW, USER_CREATE, USER_DISABLE … (+2) | ✅ TESTED |
| POST | `/api/v1/users` | UsersController | ROLE_MANAGE, ROLE_VIEW, USER_CREATE, USER_DISABLE … (+2) | ✅ TESTED |
| PATCH | `/api/v1/users/:id` | UsersController | ROLE_MANAGE, ROLE_VIEW, USER_CREATE, USER_DISABLE … (+2) | ✅ TESTED |
| POST | `/api/v1/users/:id/disabled` | UsersController | ROLE_MANAGE, ROLE_VIEW, USER_CREATE, USER_DISABLE … (+2) | ✅ TESTED |
| POST | `/api/v1/vendor-workspace/product-settlements` | VendorWorkspaceController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| GET | `/api/v1/vendor-workspace/summary/:vendorPartyId` | VendorWorkspaceController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| GET | `/api/v1/vendor-workspace/activity/:vendorPartyId` | VendorWorkspaceController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| POST | `/api/v1/vendor-workspace/payments` | VendorWorkspaceController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| POST | `/api/v1/vendor-workspace/receipts` | VendorWorkspaceController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| POST | `/api/v1/vendor-workspace/issues` | VendorWorkspaceController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| POST | `/api/v1/vendor-workspace/issues/returns` | VendorWorkspaceController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| GET | `/api/v1/vendor-stock` | VendorStockController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| GET | `/api/v1/vendor-stock/settlement/:vendorPartyId` | VendorStockController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| POST | `/api/v1/vendor-stock` | VendorStockController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| POST | `/api/v1/vendor-stock/returns` | VendorStockController | COST_VIEW, SUPPLIER_VIEW, VENDOR_ISSUE_MANAGE, VENDOR_PAYMENT_RECORD … (+3) | ❌ NOT TESTED |
| POST | `/api/v1/serials` | SerialsController | COST_VIEW, WARRANTY_CLAIM_MANAGE, WARRANTY_CLAIM_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/serials/progress/:purchaseId` | SerialsController | COST_VIEW, WARRANTY_CLAIM_MANAGE, WARRANTY_CLAIM_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/serials/available/:productId` | SerialsController | COST_VIEW, WARRANTY_CLAIM_MANAGE, WARRANTY_CLAIM_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/serials/lookup` | SerialsController | COST_VIEW, WARRANTY_CLAIM_MANAGE, WARRANTY_CLAIM_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/serials` | SerialsController | COST_VIEW, WARRANTY_CLAIM_MANAGE, WARRANTY_CLAIM_VIEW | ❌ NOT TESTED |
| GET | `/api/v1/serials/:id` | SerialsController | COST_VIEW, WARRANTY_CLAIM_MANAGE, WARRANTY_CLAIM_VIEW | ❌ NOT TESTED |
| POST | `/api/v1/serials` | SerialsController | COST_VIEW, WARRANTY_CLAIM_MANAGE, WARRANTY_CLAIM_VIEW | ❌ NOT TESTED |
| POST | `/api/v1/serials/:id/move` | SerialsController | COST_VIEW, WARRANTY_CLAIM_MANAGE, WARRANTY_CLAIM_VIEW | ❌ NOT TESTED |

## Permission codes

> A hidden menu is not security (§11). `TESTED` here means a test signed in without the
> code and watched the API refuse — not that a button was hidden.

| Code | Module | Status |
| --- | --- | --- |
| `demo.note.create` | demo | ✅ TESTED |
| `demo.note.view` | demo | ✅ TESTED |
| `user.account.view` | user | ✅ TESTED |
| `user.account.create` | user | ✅ TESTED |
| `user.account.edit` | user | ✅ TESTED |
| `user.account.disable` | user | ✅ TESTED |
| `user.role.view` | user | ✅ TESTED |
| `user.role.manage` | user | ✅ TESTED |
| `settings.setting.view` | settings | ✅ TESTED |
| `settings.setting.edit` | settings | ✅ TESTED |
| `settings.module.toggle` | settings | ✅ TESTED |
| `audit.event.view` | audit | ✅ TESTED |
| `catalog.product.view` | catalog | ✅ TESTED |
| `catalog.product.create` | catalog | ✅ TESTED |
| `catalog.product.edit` | catalog | ✅ TESTED |
| `catalog.product.deactivate` | catalog | ✅ TESTED |
| `catalog.product.delete` | catalog | ✅ TESTED |
| `catalog.brand.manage` | catalog | ✅ TESTED |
| `catalog.category.manage` | catalog | ✅ TESTED |
| `catalog.unit.manage` | catalog | ✅ TESTED |
| `inventory.cost.view` | inventory | ✅ TESTED |
| `inventory.lot.view` | inventory | ✅ TESTED |
| `inventory.cost.recompute` | inventory | ✅ TESTED |
| `party.customer.view` | party | ✅ TESTED |
| `party.customer.create` | party | ✅ TESTED |
| `party.customer.edit` | party | ✅ TESTED |
| `party.customer.deactivate` | party | ✅ TESTED |
| `party.supplier.view` | party | ✅ TESTED |
| `party.supplier.create` | party | ✅ TESTED |
| `party.supplier.edit` | party | ✅ TESTED |
| `party.supplier.deactivate` | party | ✅ TESTED |
| `party.vendor.view` | party | ✅ TESTED |
| `party.vendor.create` | party | ✅ TESTED |
| `party.vendor.edit` | party | ✅ TESTED |
| `party.vendor.deactivate` | party | ✅ TESTED |
| `party.group.manage` | party | ✅ TESTED |
| `data.import.run` | data | ✅ TESTED |
| `cash.account.view` | cash | ✅ TESTED |
| `cash.account.manage` | cash | ✅ TESTED |
| `cash.session.start` | cash | ✅ TESTED |
| `cash.session.close` | cash | ✅ TESTED |
| `cash.session.reopen` | cash | ✅ TESTED |
| `cash.movement.record` | cash | ✅ TESTED |
| `cash.daily.view` | cash | ✅ TESTED |
| `cash.daily.investigate` | cash | ✅ TESTED |
| `bank.account.view` | bank | ✅ TESTED |
| `bank.account.manage` | bank | ✅ TESTED |
| `owner.capital.record` | owner | ✅ TESTED |
| `loan.movement.record` | loan | ✅ TESTED |
| `loan.account.manage` | loan | ✅ TESTED |
| `bank.reconciliation.view` | bank | ✅ TESTED |
| `bank.reconciliation.perform` | bank | ✅ TESTED |
| `bank.reconciliation.reopen` | bank | ✅ TESTED |
| `purchase.bill.view` | purchase | ✅ TESTED |
| `purchase.bill.create` | purchase | ✅ TESTED |
| `purchase.payment.record` | purchase | ✅ TESTED |
| `sale.invoice.view` | sale | ✅ TESTED |
| `sale.invoice.create` | sale | ✅ TESTED |
| `sale.invoice.edit` | sale | ✅ TESTED |
| `sale.invoice.void` | sale | ✅ TESTED |
| `sale.payment.record` | sale | ✅ TESTED |
| `sale.price.edit` | sale | ✅ TESTED |
| `sale.discount.apply` | sale | ✅ TESTED |
| `invoice.presentation.edit` | invoice | ✅ TESTED |
| `sale.quotation.manage` | sale | ✅ TESTED |
| `sale.order.manage` | sale | ✅ TESTED |
| `sales.return.view` | sales | ✅ TESTED |
| `sales.return.create` | sales | ✅ TESTED |
| `purchase.return.view` | purchase | ✅ TESTED |
| `purchase.return.create` | purchase | ✅ TESTED |
| `purchase.bill.edit` | purchase | ✅ TESTED |
| `purchase.bill.void` | purchase | ✅ TESTED |
| `expense.view` | expense | ✅ TESTED |
| `expense.record` | expense | ✅ TESTED |
| `stock.count.post` | stock | ✅ TESTED |
| `period.close` | period | ✅ TESTED |
| `period.backdate` | period | ✅ TESTED |
| `purchase.plan.view` | purchase | ✅ TESTED |
| `purchase.plan.manage` | purchase | ✅ TESTED |
| `warranty.claim.view` | warranty | ✅ TESTED |
| `warranty.claim.manage` | warranty | ✅ TESTED |
| `vendor.stock.manage` | vendor | ✅ TESTED |
| `vendor.payment.record` | vendor | ✅ TESTED |
| `vendor.receipt.record` | vendor | ✅ TESTED |
| `vendor.issue.manage` | vendor | ✅ TESTED |
| `report.sales.view` | report | ✅ TESTED |
| `report.purchase.view` | report | ✅ TESTED |
| `report.stock.view` | report | ✅ TESTED |
| `report.money.view` | report | ✅ TESTED |
| `report.profit.view` | report | ✅ TESTED |
| `report.target.manage` | report | ✅ TESTED |
| `dashboard.card.view` | dashboard | ✅ TESTED |
| `daybook.view` | daybook | ✅ TESTED |
| `daybook.view.all_users` | daybook | ✅ TESTED |
| `daybook.view.entry_date` | daybook | ✅ TESTED |
| `daybook.review.mark` | daybook | ✅ TESTED |
| `daybook.print` | daybook | ✅ TESTED |
| `sale.receipt.void` | sale | ✅ TESTED |
| `purchase.payment.void` | purchase | ✅ TESTED |
| `expense.void` | expense | ✅ TESTED |
| `cash.movement.void` | cash | ✅ TESTED |
| `stock.adjustment.void` | stock | ✅ TESTED |
| `sales.return.void` | sales | ✅ TESTED |
| `purchase.return.void` | purchase | ✅ TESTED |
| `finance.transaction_date.change` | finance | ✅ TESTED |
| `finance.transaction_date.change_locked` | finance | ✅ TESTED |
| `offline.device.register` | offline | ✅ TESTED |
| `offline.device.approve` | offline | ✅ TESTED |
| `offline.device.rename` | offline | ✅ TESTED |
| `offline.device.revoke` | offline | ✅ TESTED |
| `offline.device.force_revoke` | offline | ✅ TESTED |
| `sync.status.view` | sync | ✅ TESTED |
| `sync.conflict.resolve` | sync | ✅ TESTED |
| `sync.conflict.discard` | sync | ✅ TESTED |
| `license.term.view` | license | ✅ TESTED |
| `license.install` | license | ✅ TESTED |
| `backup.export` | backup | ✅ TESTED |
| `backup.restore` | backup | ✅ TESTED |
| `business.reset` | business | ✅ TESTED |

## Cross-module workflows

| Workflow | Steps | Status |
| --- | --- | --- |
| Manager trading day | login → open day → purchase → stock check → POS sale → customer due → receive payment → expense → daybook → daily cash → close day | ✅ TESTED |
| Cash sale at the counter | open day → POS sale paid in full → stock falls → cash rises | ✅ TESTED |
| Credit sale and collection | POS sale on account → customer due rises → receive payment → due clears | ✅ TESTED |
| Purchase and supplier payment | purchase on credit → payable rises → pay supplier → payable clears | ✅ TESTED |
| Purchase return | purchase → return to supplier → stock falls → payable falls | ✅ TESTED |
| Sales return | sale → return from customer → stock rises → refund or credit | ✅ TESTED |
| Correction of a posted document | post document → correct it → audit history preserved | ✅ TESTED |
| Void or cancel | post document → cancel it → no financial effect remains | ✅ TESTED |
| Stock count | start count → enter counted → post variance → stock matches | ✅ TESTED |
| Serial-tracked product | receive with serials → sell one serial → serial no longer sellable | ❌ NOT TESTED |
| Expiry-tracked product | receive with expiry → expiring report → sell oldest first | ❌ NOT TESTED |
| Vendor stock out and back | give products to vendor → vendor settles → receive back | ❌ NOT TESTED |
| Money transfer between accounts | transfer → source falls → destination rises → no P&L effect | ✅ TESTED |
| Bank reconciliation | start → import statement → match → complete | ❌ NOT TESTED |
| Permission-sensitive action | role without code → UI hides → route refuses → API returns 403 | ✅ TESTED |
| Offline trading and sync | go offline → sell → come back → queue drains | ❌ NOT TESTED |
| Report generation | sales report → purchase report → stock report → money report | ❌ NOT TESTED |
