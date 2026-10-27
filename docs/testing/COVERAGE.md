# Automated Coverage Report

> **Generated — do not edit by hand.** Run `pnpm test:inventory`.
>
> This counts *claims*, and a claim is a `@covers` line a test author wrote on purpose.
> It does not count passing assertions, so it can only ever be an upper bound on what is
> proved — which is why the untested list at the bottom, not the percentage at the top,
> is the part worth reading.

| | Total | Covered | |
| --- | ---: | ---: | ---: |
| Routes | 54 | 19 | 35% |
| Forms, dialogs and drawers | 57 | 0 | 0% |
| Fields | 392 | 175 | — |
| Dropdowns | 94 | 0 | — |
| Business actions | 106 | — | — |
| Endpoints | 229 | 102 | 45% |
| Permission codes | 119 | 119 | 100% |
| Critical workflows | 17 | 11 | 65% |
| Mobile-relevant screens | 14 | 14 | 100% |

## Screens by status

- ✅ TESTED — 19
- 🟡 PARTIALLY TESTED — 38
- ❌ NOT TESTED — 52
- ⬜ NOT APPLICABLE — 3

## Everything not fully covered

| Screen | Status | What is missing |
| --- | --- | --- |
| AccountLedgerPage | 🟡 PARTIALLY TESTED | dropdown ledger-account, dropdown ledger-kind |
| AccountReconcilePage | 🟡 PARTIALLY TESTED | action Finish, action Match these two, action Confirm, action Record it |
| AuditPage | 🟡 PARTIALLY TESTED | dropdown filter-actor, dropdown filter-entity, dropdown filter-action, action Apply |
| CatalogPage | 🟡 PARTIALLY TESTED | required field catalog-name, action Add category, action Add the first unit, action Remove, action Add the first brand, action Add the first category, action Add |
| CounterPage | 🟡 PARTIALLY TESTED | dropdown ctr-party, action Continue |
| DaybookPage | 🟡 PARTIALLY TESTED | required field daybook-note, dropdown daybook-kind |
| ExpensesPage | 🟡 PARTIALLY TESTED | dropdown categoryId |
| FinanceReconciliationPage | 🟡 PARTIALLY TESTED | dropdown reconcile-account |
| ForgotPasswordPage | 🟡 PARTIALLY TESTED | required field identifier, required field password, action Send code, action Set new password, action Go to sign in |
| ImportPage | 🟡 PARTIALLY TESTED | dropdown import-type |
| InventoryReportPage | 🟡 PARTIALLY TESTED | action Apply |
| InvoiceSettingsPage | 🟡 PARTIALLY TESTED | dropdown settings.language, dropdown settings.defaultTemplate, dropdown settings.thermalPaper, action Remove logo |
| LoginPage | 🟡 PARTIALLY TESTED | required field identifier, required field password, action Open the counter, action Unlock, action Sign in |
| MoneyReportPage | 🟡 PARTIALLY TESTED | required field money-from, required field money-to, required field view, dropdown view |
| PartiesPage | 🟡 PARTIALLY TESTED | dropdown filter-group, dropdown filter-status, action Add, action Add the first, action Delete, action Reactivate, action Remove |
| PartyFormPage | 🟡 PARTIALLY TESTED | required field party-name, required field party-phone, required field party-credit, required field party-opening, dropdown customerGroupId, dropdown openingDirection, dropdown party-opening-role, action Edit details, action Delete, action Save changes |
| PartyLedgerPage | 🟡 PARTIALLY TESTED | dropdown ledger-page-size, action Vendor workspace, action Receive payment, action New sale, action Pay supplier |
| PosPage | 🟡 PARTIALLY TESTED | dropdown customerId, dropdown line.vendorPartyId, dropdown payment.accountId, action Sell anyway, action Remove …, action Confirm Allocation, action Remove this payment, action Delete this draft |
| ProductsPage | 🟡 PARTIALLY TESTED | dropdown filter-brand, dropdown filter-category, dropdown filter-subcategory, dropdown filter-stock, dropdown filter-status, action Add the first product, action Reactivate, action Delete |
| PurchaseDetailPage | 🟡 PARTIALLY TESTED | action New purchase, action Cancel bill |
| PurchaseFormPage | 🟡 PARTIALLY TESTED | required field supplierId, required field paidAccountId, dropdown supplierId, dropdown productPick, dropdown categoryId, dropdown cost.category, dropdown cost.method, dropdown paidAccountId, action Remove …, action Remove landed cost … |
| PurchasePlanPage | 🟡 PARTIALLY TESTED | dropdown pp-scope, dropdown pp-history, dropdown pp-add, action Delete |
| PurchasesPage | 🟡 PARTIALLY TESTED | dropdown purchase-settlement, action New purchase, action Record the first purchase |
| RegisterPage | 🟡 PARTIALLY TESTED | required field identifier, required field business, required field username, required field password, required field pin, action Send code, action Verify, action Create account |
| RolesPage | 🟡 PARTIALLY TESTED | required field role-name, required field role-confirm, required field delete-confirm, action Add role, action Delete, action Save changes, action Delete role |
| SettingsBackupPage | 🟡 PARTIALLY TESTED | action Download, action Download backup, action Reset business data |
| SettingsLicensePage | 🟡 PARTIALLY TESTED | action Install licence |
| SettingsOfflinePage | 🟡 PARTIALLY TESTED | action Register this computer, action Cut off |
| SettingsPage | 🟡 PARTIALLY TESTED | dropdown business-timezone, dropdown `setting-${descriptor.key}`, action Save, action Confirm |
| SettingsSecurityPage | 🟡 PARTIALLY TESTED | required field current-password, required field new-password, action Set password, action Set PIN |
| StockCountPage | 🟡 PARTIALLY TESTED | action Post count |
| UsersPage | 🟡 PARTIALLY TESTED | required field display-name, required field username, required field identifier, required field confirm, required field confirm-toggle, dropdown role, action Add user, action Disable, action Save changes |
| VendorWorkspacePage | 🟡 PARTIALLY TESTED | dropdown workspace-vendor |
| WarrantyClaimsPage | 🟡 PARTIALLY TESTED | required field wc-complaint, action Take it in |
| CancelDocumentDialog | ❌ NOT TESTED | the screen itself |
| ConfirmDialog | ❌ NOT TESTED | the screen itself, action Confirm |
| DateOnlyPicker | 🟡 PARTIALLY TESTED | required field inputId |
| ManageListDialog | 🟡 PARTIALLY TESTED | required field newName, required field draft, action Remove |
| OtpInput | ❌ NOT TESTED | the screen itself |
| ProductForm | 🟡 PARTIALLY TESTED | required field product-name, required field baseUnitId, required field purchase-price, required field selling-price, required field opening-stock, required field opening-expiry, required field discount-type, required field offerEnabled, required field tracks-expiry, dropdown brandId … (+8) |
| QuickAddSelect | 🟡 PARTIALLY TESTED | dropdown fieldId |
| SearchField | ❌ NOT TESTED | the screen itself |
| StockAdjustDialog | ❌ NOT TESTED | the screen itself, required field stock-amount, required field stock-note, dropdown stock-reason, action Save adjustment |
| StockLotsDialog | ❌ NOT TESTED | the screen itself, dropdown lot-status |
| ReplaceBackupSecretDialog | ❌ NOT TESTED | the screen itself, required field secret-new, required field secret-confirm, action Set password |
| ResetBusinessDialog | ❌ NOT TESTED | the screen itself, required field reset-phrase, required field reset-password, action Close, action Delete all business data |
| RestoreDialog | ❌ NOT TESTED | the screen itself, action Restore this backup |
| QuickAddProductDialog | ❌ NOT TESTED | the screen itself, required field qp-name, required field qp-unit, required field qp-min, dropdown qp-unit, dropdown qp-supplier, action Add product |
| ChangeTransactionDateDialog | ❌ NOT TESTED | the screen itself, required field redate-date, action Change date |
| DaybookSheet | ❌ NOT TESTED | the screen itself |
| AmountInput | ❌ NOT TESTED | the screen itself |
| ComboField | ❌ NOT TESTED | the screen itself, dropdown fieldId |
| SerialEntryDialog | ❌ NOT TESTED | the screen itself, action Add these |
| AccountFormDialog | ❌ NOT TESTED | the screen itself, dropdown account-type, action Save account |
| AddMissingEntryDialog | ❌ NOT TESTED | the screen itself, dropdown missing-kind, dropdown missing-party, action Continue |
| CapitalLoanEntryDialog | ❌ NOT TESTED | the screen itself, dropdown entry-loan, dropdown entry-money, action Save entry |
| CompleteReconciliationDialog | ❌ NOT TESTED | the screen itself, action Complete |
| CounterAmountField | ❌ NOT TESTED | the screen itself |
| CounterChoice | ❌ NOT TESTED | the screen itself |
| EndDayDialog | ❌ NOT TESTED | the screen itself |
| ImportStatementDialog | ❌ NOT TESTED | the screen itself, action Remove |
| ManageLoanAccountsDialog | ❌ NOT TESTED | the screen itself, action Add loan account |
| MoneyAccountPicker | ❌ NOT TESTED | the screen itself |
| RecordExpenseDialog | ❌ NOT TESTED | the screen itself, dropdown categoryId, dropdown accountId, dropdown payeeId, action Save |
| ReopenDayDialog | ❌ NOT TESTED | the screen itself, dropdown picked |
| StartDayDialog | ❌ NOT TESTED | the screen itself, dropdown counterpart |
| StartReconciliationDialog | ❌ NOT TESTED | the screen itself, action Start |
| TransferMoneyDialog | ❌ NOT TESTED | the screen itself, dropdown transfer-from, dropdown transfer-to, action Confirm Transfer |
| DeviceNameDialog | ❌ NOT TESTED | the screen itself |
| ForceRevokeDialog | ❌ NOT TESTED | the screen itself, action Cut off this computer |
| OfflineBackupCard | ❌ NOT TESTED | the screen itself |
| ReplaceWriterDialog | ❌ NOT TESTED | the screen itself, dropdown oldMachineWorks, action Move offline permission |
| PartyOpeningDialog | ❌ NOT TESTED | the screen itself, required field opening-amount, dropdown opening-direction, action Post opening balance |
| AddLandedCostDialog | ❌ NOT TESTED | the screen itself, required field cost-category, required field cost-description, required field cost-amount, required field cost-method, dropdown cost-category, dropdown cost-method, dropdown cost-account, action Add cost |
| PaySupplierDialog | ❌ NOT TESTED | the screen itself, dropdown pay-account |
| PurchaseReturnDialog | ❌ NOT TESTED | the screen itself, dropdown reason, dropdown accountId, action Send Back |
| ProfitTargetDialog | ❌ NOT TESTED | the screen itself, dropdown target-basis |
| ReportScreen | ❌ NOT TESTED | the screen itself |
| WhyDialog | ❌ NOT TESTED | the screen itself |
| ReceivePaymentDialog | ❌ NOT TESTED | the screen itself, dropdown accountId |
| SalesReturnDialog | ❌ NOT TESTED | the screen itself, dropdown reason, dropdown accountId, action Take Return, action Approve |
| GlobalSearchDialog | ❌ NOT TESTED | the screen itself |
| GiveProductsToVendorDialog | ❌ NOT TESTED | the screen itself, dropdown give-mode, dropdown give-product |
| PayVendorDialog | ❌ NOT TESTED | the screen itself, dropdown vendor-pay-intent, dropdown vendor-pay-account |
| ReceiveFromVendorDialog | ❌ NOT TESTED | the screen itself, dropdown vendor-receive-intent, dropdown vendor-receive-account |
| ReceiveProductsBackDialog | ❌ NOT TESTED | the screen itself, dropdown back-issue |
| VendorProductSettlementDrawer | ❌ NOT TESTED | the screen itself, required field line.productId, required field line.qty, required field line.price, required field `settlement-expiry-${index}`, required field cost.category, required field cost.amount, required field cost.method, required field cost.paidAccountCode, required field cost.description … (+6) |
| VendorStockReceiveDialog | ❌ NOT TESTED | the screen itself, required field vs-vendor, required field vs-product, required field vs-qty, dropdown vs-vendor, dropdown vs-product, action Receive stock |
| VendorStockReturnDialog | ❌ NOT TESTED | the screen itself, required field vr-qty, required field selectedSerialIds, action Return stock |
| ClaimStepDialog | ❌ NOT TESTED | the screen itself, required field cs-amount, dropdown cs-settlement, dropdown cs-unit, dropdown cs-account, action Save |

## Not applicable, with the reason

| Screen | Why no automated test |
| --- | --- |
| GoogleCallbackPage | Completes a real Google OAuth redirect; the provider cannot be driven headlessly, and the token exchange behind it is covered by apps/api/test/google-registration.spec.ts. |
| StorageCheckPage | The O-6 storage spike measures this physical machine's disk and browser quota. Its whole purpose is to report what varies per device, so an assertion about the number would be an assertion about the CI runner. |
| InvoicePreviewDialog | Renders the invoice for a printer. What reaches paper is a browser print pipeline, not application behaviour; the figures on it are asserted where they are computed. |

## Claims that name nothing

_None._
