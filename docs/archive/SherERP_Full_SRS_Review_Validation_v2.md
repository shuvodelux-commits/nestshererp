# SherERP Software Requirements Specification (SRS)

**Project:** SherERP\
**Document:** Full Software Requirements Specification\
**Version:** 2.0 Draft for Review & Validation\
**Date:** 14 August 2026\
**Status:** Review / Validation Baseline\
**Primary Target:** Retail and battery-distribution ERP/POS\
**Architecture:** Modular Monolith\
**Frontend:** React + TypeScript\
**Backend:** NestJS + TypeScript\
**Database:** PostgreSQL

> **Important:** This document consolidates the requirements developed
> so far. It is a review baseline, not a final frozen specification. A
> module becomes **Confirmed** only after explicit review/confirmation.
> Items marked **TBD / Validate** must be reviewed before
> implementation.

------------------------------------------------------------------------

# 1. Purpose

SherERP is a business management and ERP/POS application designed for
retail and distribution businesses, with particular support for battery
distribution, inventory lots, FIFO consumption, customer/vendor ledgers,
cash management, purchasing, sales, returns, warranty, serial tracking,
bank reconciliation, reporting, and SaaS feature controls.

The system must provide a simple operational interface while maintaining
reliable transaction, inventory, financial, audit, and permission logic.

## Core principle

> **Simple UI, reliable business engine, traceable transactions.**

------------------------------------------------------------------------

# 2. Product Scope

## 2.1 In Scope

-   Business/tenant management
-   Authentication and users
-   Roles and permissions
-   Customers
-   Suppliers
-   Vendors
-   Products, categories and brands
-   Sales and POS
-   Purchases
-   Inventory and lots
-   Inventory valuation and stock issue methods
-   Landed cost
-   Customer receivable
-   Vendor payable/receivable
-   Cash and POS sessions
-   Bank accounts
-   Bank reconciliation
-   Returns
-   Warranty
-   Serial numbers
-   Reports
-   Audit history
-   Feature controls
-   Subscription entitlements
-   Offline/local data and synchronization where enabled
-   Invoice generation and printing

## 2.2 Out of Initial Scope

Unless separately confirmed:

-   HR/payroll
-   Manufacturing/MRP
-   Restaurant management
-   Hospital management
-   School management
-   Hotel management
-   Project management
-   Full CRM
-   Microservices
-   Advanced BI platform
-   Complex accounting ERP beyond the required transactional finance
    layer
-   Large workflow-engine platform

------------------------------------------------------------------------

# 3. Product Goals

1.  Make daily retail transactions fast.
2.  Prevent product duplication caused by suppliers or different
    purchase prices.
3.  Maintain lot-level inventory traceability.
4.  Support FIFO, LIFO and average valuation/stock configuration as
    approved.
5.  Keep purchase cost separate from actual landed cost.
6.  Maintain accurate customer and vendor balances.
7.  Provide controlled backdated transaction entry.
8.  Preserve audit history.
9.  Make important totals explainable through source transactions.
10. Control feature visibility through plan, business settings and
    permissions.
11. Support future SaaS expansion without rebuilding the transaction
    engine.
12. Allow module-by-module implementation and validation.

------------------------------------------------------------------------

# 4. Definitions

  Term                  Meaning
  --------------------- -------------------------------------------------------------
  Tenant                A business/company using SherERP
  Product               Sellable catalog item
  Lot                   A specific inventory receipt with quantity, source and cost
  Purchase Cost         Cost recorded from the purchase itself
  Actual Cost           Purchase cost plus allocated additional costs
  Transaction Date      Date the business event actually occurred
  Created Date          Date/time the record was entered
  Customer              Party buying from the business
  Supplier              Party supplying goods through normal purchasing
  Vendor                External party associated with vendor/consignment sourcing
  POS Session           A cash-register operating session
  Due                   Amount owed by a customer
  Payable               Amount owed by the business to a vendor/supplier
  Feature Entitlement   Feature allowed by a subscription plan
  Feature Setting       Business-level on/off control
  Permission            User-level authorization

------------------------------------------------------------------------

# 5. Fundamental Business Rules

1.  Product, inventory lot, transaction and ledger are separate
    concepts.
2.  One product can have many inventory lots.
3.  Different purchase prices must create different lots, not duplicate
    products.
4.  Supplier/vendor linkage must not create duplicate POS products.
5.  Every stock movement must have a traceable source transaction.
6.  Every financial movement must have a traceable source transaction.
7.  Purchase cost and actual landed cost are separate values.
8.  Inventory valuation method and physical stock issue method are
    separate settings.
9.  Customer/vendor statements default to transaction date.
10. Created date remains available for audit and late-entry
    investigation.
11. Authorized users may create backdated transactions.
12. Backdated and corrected transactions must be auditable.
13. Reconciled periods must be flagged when later backdated changes
    affect them.
14. Financial history must not be silently deleted.
15. Corrections should use controlled edit, reversal, cancellation or
    adjustment mechanisms.
16. Backend/database rules are authoritative. Frontend validation is not
    a security boundary.
17. Subscription entitlement is checked before business feature
    settings.
18. Business feature settings are checked before user permissions.
19. Vendor/Consignment is Advanced-plan functionality.
20. Cost visibility in POS is permission controlled.
21. Product search must not expose restricted purchase cost without
    permission.
22. Historical data must not be deleted merely because a subscription
    expires.
23. Important dashboard/report values must be traceable to source
    records.
24. Critical multi-step transactions must be atomic.
25. Concurrency must be handled by the backend/database.

------------------------------------------------------------------------

# 6. Module Map: 31 Modules

  --------------------------------------------------------------------------
                            \# Module                Validation Status
  ---------------------------- --------------------- -----------------------
                            01 Platform / Tenant &   Review
                               Business              

                            02 Authentication        Review

                            03 Users, Roles &        Review
                               Permissions           

                            04 Sales & POS           **Confirmed baseline**

                            05 Purchasing            **Confirmed baseline**

                            06 Inventory             Current module under
                                                     implementation/review

                            07 Products & Catalog    Confirmed requirements,
                                                     detailed validation

                            08 Customers             Review

                            09 Suppliers             Review

                            10 Vendors & Consignment Review

                            11 Inventory Lots &      Review
                               Costing               

                            12 Landed Cost           Review

                            13 Stock Reconciliation  Review
                               & Adjustments         

                            14 Sales Returns         Review

                            15 Purchase Returns      Review

                            16 Customer Receivable & Review
                               Ledger                

                            17 Vendor                Review
                               Payable/Receivable &  
                               Ledger                

                            18 Cash Management       Review

                            19 POS Session / Day     Review
                               Open-Close            

                            20 Bank Accounts         Review

                            21 Bank Reconciliation   Review

                            22 Expenses & Other      Review
                               Money Movements       

                            23 Warranty              Review

                            24 Serial Number         Review
                               Tracking              

                            25 Invoices, Printing &  Review
                               Documents             

                            26 Reports & Dashboard   Review

                            27 Audit / Transaction   Review
                               History               

                            28 Settings & Feature    Review
                               Controls              

                            29 Subscription / SaaS   Review
                               Entitlements          

                            30 Offline / Local Data  Review
                               / Sync                

                            31 Technical             Review
                               Architecture,         
                               Security & Quality    
  --------------------------------------------------------------------------

------------------------------------------------------------------------

# 7. Module 01: Platform / Tenant & Business

## Requirements

-   Support a business/tenant identity.
-   All tenant-owned data must be isolated.
-   Store business name and core business settings.
-   Support business status.
-   Support business-level feature configuration.
-   All protected API requests must resolve tenant context.
-   Tenant filtering must not depend only on frontend code.

## Acceptance Criteria

-   User from Tenant A cannot read Tenant B data.
-   Tenant ID is enforced at service/repository/database access
    boundaries.
-   Tenant context is available to audit logs and transactions.

------------------------------------------------------------------------

# 8. Module 02: Authentication

## Requirements

-   Secure login.
-   Session/token management.
-   Logout.
-   Password security.
-   Authentication failure handling.
-   Session expiry/refresh according to selected authentication design.
-   Authentication must not grant authorization automatically.

## Security

-   Passwords must never be stored in plaintext.
-   Tokens/sessions must be protected.
-   Sensitive endpoints require authentication.

------------------------------------------------------------------------

# 9. Module 03: Users, Roles & Permissions

## Model

``` text
Tenant
  ↓
User
  ↓
Role
  ↓
Permission
  ↓
Module / Action
```

## Actions

At minimum consider:

-   view
-   create
-   edit
-   delete
-   approve
-   cancel
-   print
-   export
-   collect_payment
-   adjust_stock
-   reveal_cost
-   reconcile
-   backdate
-   correct_transaction

## Requirements

-   Multiple roles.
-   User-role assignment.
-   Permission-based module visibility.
-   Backend permission enforcement.
-   Sensitive financial and cost functions must have explicit
    permission.
-   A single application should serve different roles instead of
    separate applications unless technically necessary.

------------------------------------------------------------------------

# 10. Module 04: Sales & POS

**Status: Confirmed baseline**

## POS Requirements

-   Fast product search.
-   Grid/list product presentation.
-   Barcode scanning.
-   Category filtering.
-   Brand filtering.
-   Other useful filters/metrics as finalized.
-   Customer selection.
-   Walk-in customer support.
-   Quantity editing.
-   Selling price editing where permitted.
-   Line discount.
-   Invoice-level discount where enabled.
-   Grand total.
-   Multiple payment methods.
-   Cash paid.
-   Due calculation.
-   Invoice creation.
-   Invoice printing/export.
-   Sale cancellation/correction according to permissions.

## Customer

A walk-in customer must be a real customer record rather than an
invisible anonymous transaction.

## Cost Visibility

-   Purchase cost can be shown through a protected eye/action control.
-   Visibility requires permission.
-   Temporary cost display is approximately 2000 ms where this behavior
    is retained.

## Negative Stock

Negative selling behavior must be configurable.

Candidate policy:

-   Block
-   Warn
-   Allow

Final policy must be explicitly validated.

## Vendor/Consignment Sourcing

POS may provide sourcing options:

``` text
Own Stock
Vendor/Consignment
Other approved source
```

For Vendor/Consignment:

-   Select vendor.
-   Record sourced quantity.
-   Record vendor cost.
-   Record payable amount.
-   Do not incorrectly reduce owned inventory for vendor-owned stock.
-   Vendor/Consignment is Advanced-plan functionality.

## Sale Transaction Atomicity

Sale completion should atomically handle:

``` text
Sale
→ Sale Items
→ Stock Consumption
→ Stock Movement
→ Payment
→ Customer Ledger
→ Cash/Bank Movement
→ Audit Event
```

------------------------------------------------------------------------

# 11. Module 05: Purchasing

**Status: Confirmed baseline**

## Purchase Requirements

-   Supplier selection.
-   Purchase date.
-   Reference/invoice number.
-   Product selection.
-   Quantity.
-   Purchase price.
-   Discount.
-   Additional purchase costs.
-   Payment information.
-   Due/payable information.
-   Lot creation.
-   Inventory increase.
-   Supplier ledger update.
-   Payment/cash/bank update.
-   Purchase return support.

## Multiple Prices

Same product purchased at different prices must produce separate
inventory lots.

Example:

``` text
Product: Battery X

Lot A = 10 units @ 10,000
Lot B = 20 units @ 10,500
```

POS still shows one Product X.

------------------------------------------------------------------------

# 12. Module 06: Inventory

## Requirements

-   Current stock.
-   Stock movement history.
-   Lot tracking.
-   Stock issue method.
-   Inventory valuation method.
-   Stock adjustment.
-   Stock reconciliation.
-   Low-stock status.
-   Out-of-stock status.
-   Inventory value where costing is available.
-   Stock drill-down.

## Core Model

``` text
Product
 ├── Lot 1
 ├── Lot 2
 └── Lot 3

Transaction
 └── Stock Movement
```

## Stock Movement

A movement should identify:

-   product
-   lot where applicable
-   quantity signed
-   source transaction
-   transaction date
-   created timestamp
-   user
-   cost where applicable

## Concurrency

Database-level concurrency controls are required for:

-   simultaneous sales
-   lot consumption
-   adjustments
-   returns

Frontend checks alone are insufficient.

------------------------------------------------------------------------

# 13. Module 07: Products & Catalog

## Product Fields

-   Product ID
-   Brand
-   Product Name
-   Display Name
-   SKU/code
-   Barcode
-   Product group/category
-   Unit
-   Selling price
-   Reorder level
-   Status
-   Description
-   Image
-   Expiry configuration where applicable
-   Warranty configuration
-   Serial tracking setting

## Brand Rule

Brand and Product Name are separate fields.

Display name:

``` text
Brand + Product Name
```

If no brand exists, display Product Name.

## Product Creation

Required fields should remain minimal for fast setup.

## Barcode

-   Search by barcode.
-   Scan barcode in POS.
-   Barcode generation may be supported.
-   Barcode uniqueness rules must be enforced.

------------------------------------------------------------------------

# 14. Module 08: Customers

## Fields

-   Name
-   Phone
-   Address
-   Status
-   Notes
-   Customer group where enabled
-   Loyalty/premium classification where enabled

## Rules

-   Phone is mandatory where established.
-   Duplicate phone numbers are not allowed under the current
    requirement.
-   Walk-in customer is a valid customer record.

------------------------------------------------------------------------

# 15. Module 09: Suppliers

## Requirements

-   Supplier master.
-   Contact information.
-   Supplier status.
-   Purchase history.
-   Supplier payable.
-   Supplier payments.
-   Purchase returns.
-   Supplier statement.
-   Supplier ledger.

Supplier and vendor are related but should not be treated as identical
concepts where business ownership differs.

------------------------------------------------------------------------

# 16. Module 10: Vendors & Consignment

## Requirements

Support vendor/consignment sourcing where enabled.

A vendor may:

-   Provide goods that the business physically holds but does not own.
-   Have payable balances.
-   Receive payments.
-   Have returns.
-   Have vendor-specific transaction history.

The system must distinguish:

``` text
Owned Inventory
vs
Vendor-Owned Inventory
```

Vendor/Consignment is Advanced-plan only.

------------------------------------------------------------------------

# 17. Module 11: Inventory Lots & Costing

## Lot Fields

-   Lot ID
-   Product
-   Source transaction
-   Supplier/vendor
-   Quantity received
-   Quantity remaining
-   Purchase cost
-   Actual cost
-   Transaction date
-   Created date
-   Optional expiry
-   Optional serial linkage

## Cost Rule

Store:

``` text
Purchase Cost
Actual Cost
```

Actual Cost may include allocated landed costs.

## Issue Method

Support configurable stock issue method:

-   FIFO
-   LIFO
-   Other approved method if explicitly finalized

## Valuation

Support configured valuation methods as approved:

-   Average
-   FIFO
-   LIFO

The exact relationship between valuation and stock issue method must
remain explicit. They are not automatically the same setting.

------------------------------------------------------------------------

# 18. Module 12: Landed Cost

## V1 Allocation Methods

Only:

1.  By Purchase Value
2.  By Quantity
3.  Manual

Do not add weight/volume allocation or complex cost classes in V1.

## Cost Components

Examples:

-   Transport
-   Loading/unloading
-   Labor
-   Other approved purchase-related costs

## Rule

Allocated landed cost updates Actual Cost, not Purchase Cost.

------------------------------------------------------------------------

# 19. Module 13: Stock Reconciliation & Adjustments

## Requirements

-   Physical count entry.
-   Expected quantity.
-   Actual quantity.
-   Difference.
-   Adjustment reason.
-   Authorized approval where required.
-   Audit trail.
-   Stock movement generated for approved adjustment.

## Rules

No direct silent mutation of stock without a traceable adjustment.

------------------------------------------------------------------------

# 20. Module 14: Sales Returns

## Requirements

-   Reference original sale where possible.
-   Customer.
-   Product.
-   Quantity.
-   Return reason.
-   Stock disposition.
-   Refund/credit handling.
-   Customer ledger update.
-   Cash/bank update if refund occurs.
-   Audit trail.

Returned stock must not automatically be treated as sellable without the
applicable condition/disposition rule.

------------------------------------------------------------------------

# 21. Module 15: Purchase Returns

## Requirements

-   Reference original purchase where possible.
-   Supplier.
-   Product.
-   Quantity.
-   Lot.
-   Return reason.
-   Stock reduction.
-   Supplier payable/receivable adjustment.
-   Payment/refund handling.
-   Audit trail.

------------------------------------------------------------------------

# 22. Module 16: Customer Receivable & Ledger

## Ledger Entries

-   Sales
-   Payments
-   Returns
-   Adjustments
-   Other approved receivable movements

## Statement

Fields:

-   Date
-   Reference
-   Description
-   Debit
-   Credit
-   Running balance

Default statement mode:

``` text
Transaction Date
```

Also support:

``` text
Created Date
```

for audit and late-entry analysis.

------------------------------------------------------------------------

# 23. Module 17: Vendor Payable/Receivable & Ledger

A vendor may have both:

``` text
Payable
Receivable
```

Support:

-   Purchases/source transactions
-   Payments
-   Receipts
-   Returns
-   Adjustments
-   Running balance
-   Statement

The ledger must preserve transaction provenance.

------------------------------------------------------------------------

# 24. Module 18: Cash Management

## Cash In

Examples:

-   Cash sale
-   Customer payment
-   Other receipt

## Cash Out

Examples:

-   Expense
-   Vendor payment
-   Withdrawal

## Balance

``` text
Cash Balance =
Opening Cash
+ Cash In
- Cash Out
```

Cash movements must be traceable.

------------------------------------------------------------------------

# 25. Module 19: POS Session / Day Open-Close

## Opening

Opening cash is mandatory where POS cash management is enabled.

Store:

-   Opening time
-   Opening amount
-   User/session

## Closing

Show:

``` text
Expected Drawer
Actual Drawer
Difference
```

## Session Model

``` text
POS Session
→ Opening
→ Sales
→ Payments
→ Cash Movements
→ Closing
```

Do not rely only on calendar dates.

------------------------------------------------------------------------

# 26. Module 20: Bank Accounts

## Fields

-   Bank name
-   Account name
-   Account number/reference
-   Opening balance
-   Current book balance

## Requirements

-   Bank transactions.
-   Payment/receipt linkage.
-   Statement import support for reconciliation.
-   Transaction history.
-   Balance calculation.
-   Audit trail.

------------------------------------------------------------------------

# 27. Module 21: Bank Reconciliation

## Purpose

Compare bank statement transactions with SherERP transactions and
identify:

-   matched transactions
-   missing book transactions
-   bank-only transactions
-   wrong dates
-   wrong parties
-   exceptions

## Initial Import

-   CSV
-   Excel

## Statuses

``` text
UNMATCHED
MATCHED
RECONCILED
BANK_ONLY
BOOK_ONLY
EXCEPTION
```

## Actions

-   Match
-   Create missing transaction
-   Edit existing transaction
-   Correct date
-   Correct party
-   Correct allowed fields
-   Ignore bank-only item where appropriate
-   Mark reconciled

## Transaction Date Rule

If a transaction happened on 08 Aug but was entered on 13 Aug:

``` text
transaction_date = 08 Aug
created_at = 13 Aug
```

Statements use the transaction date.

## Reconciled Period

If a reconciled period is affected later:

``` text
Requires Review
```

The system must not silently alter reconciled history.

------------------------------------------------------------------------

# 28. Module 22: Expenses & Other Money Movements

## Expense Fields

-   Category
-   Amount
-   Transaction date
-   Payment method
-   Description
-   Reference
-   User

## Requirements

-   Expense history.
-   Cash/bank linkage.
-   Audit.
-   Transaction-date and created-date views.

------------------------------------------------------------------------

# 29. Module 23: Warranty

## Requirements

For applicable products:

-   Product
-   Customer
-   Invoice
-   Warranty start
-   Warranty end
-   Serial number where applicable
-   Status

Warranty claims/workflow can be expanded later.

## Battery Use Case

Warranty must support battery products and serial-linked sales where
serial tracking is enabled.

------------------------------------------------------------------------

# 30. Module 24: Serial Number Tracking

## Requirements

Optional/plan-controlled for tracked products.

Serial relationship:

``` text
Serial
 → Purchase
 → Inventory
 → Sale
 → Customer
 → Warranty
 → Return
```

## Rules

-   Serial numbers must be unique within the appropriate business scope.
-   A serial-tracked product cannot be sold without the required serial
    information.
-   Serial movement must remain traceable.

------------------------------------------------------------------------

# 31. Module 25: Invoices, Printing & Documents

## Requirements

-   Multiple invoice formats.
-   Bangla/English support.
-   PDF generation.
-   JPG/image export where required.
-   Thermal printer format.
-   A4 format.
-   Business-pad printing.
-   Invoice search.
-   Reprint.
-   Invoice reference/numbering.
-   Multi-payment display.
-   Customer and transaction information.
-   Product and quantity details.
-   Discount and totals.
-   Paid and due amounts.

Invoice templates should be configurable without changing core
transaction logic.

------------------------------------------------------------------------

# 32. Module 26: Reports & Dashboard

## Dashboard Cards

Configurable cards may include:

-   Today's sales
-   Stock value
-   Purchase orders/purchases
-   Low-stock count
-   Recent sales
-   Due collection
-   Payable amount
-   Cash/bank balances where enabled

Do not show profit on the dashboard unless the costing model provides
reliable data and the feature is explicitly enabled.

## Sales Reports

-   Sales summary
-   Sales by date
-   Product
-   Customer
-   Cashier/user
-   Payment method

## Purchase Reports

-   Purchase summary
-   Supplier
-   Product
-   Date

## Inventory Reports

-   Current stock
-   Low stock
-   Out of stock
-   Stock movement
-   Lot details
-   Inventory valuation

## Finance Reports

-   Customer due
-   Vendor payable
-   Vendor receivable
-   Cash
-   Bank
-   Expenses
-   Profit/margin where reliable cost data exists

## Reconciliation Reports

-   Unmatched
-   Reconciled periods
-   Late entries
-   Corrections

------------------------------------------------------------------------

# 33. Module 27: Audit / Transaction History

## Audit Fields

-   User
-   Action
-   Entity
-   Entity ID
-   Old value
-   New value
-   Timestamp
-   Reason where required
-   Source transaction/reference

## Indicators

Use simple indicators where useful:

-   ON TIME
-   LATE ENTRY
-   BACKDATED
-   CORRECTED

## Rule

Do not silently delete financial history.

Prefer:

-   reversal
-   cancellation
-   controlled correction
-   adjustment

------------------------------------------------------------------------

# 34. Module 28: Settings & Feature Controls

## Business-Level Features

Examples:

``` text
Warranty        OFF
Bank Recon      ON
Vendor Source   OFF
Serial Numbers  OFF
```

Only enabled features should normally appear in navigation and screens.

## Feature Dependencies

Example:

``` text
Vendor/Consignment
→ Vendor Management
→ Vendor Ledger
```

``` text
Serial Tracking
→ Warranty
```

Invalid combinations must be prevented.

------------------------------------------------------------------------

# 35. Module 29: Subscription / SaaS Entitlements

## Access Chain

``` text
Subscription Plan
→ Feature Entitlement
→ Business Feature Setting
→ User Permission
→ Actual Access
```

## Example Plans

### Basic

-   Core POS
-   Products
-   Customers
-   Purchases
-   Basic inventory

### Medium

-   Core plus expanded finance
-   Reconciliation
-   Reporting

### Advanced

-   Vendor/Consignment
-   Advanced inventory
-   Serial/warranty
-   Advanced reporting/workflows

Exact package contents remain subject to final validation.

## Expiry

On expiry:

-   Restricted new actions are blocked according to policy.
-   Historical data is retained.
-   Upgrade restores access.
-   Backend enforces entitlement.

------------------------------------------------------------------------

# 36. Module 30: Offline / Local Data / Sync

## Requirement Status

**Requires explicit architecture validation before implementation.**

The target requirement is that SherERP can support working without
internet where offline mode is enabled, with synchronization when
connectivity returns.

## Requirements

-   Local data store for enabled offline workflows.
-   Offline transactions queue locally.
-   Automatic synchronization when online.
-   Visible sync status.
-   Last synchronized timestamp.
-   Pending transaction count.
-   No silent conflict overwrite.
-   Server remains authoritative for shared/business-critical state.
-   Sync operations must be idempotent.
-   Offline-created IDs must not depend on server auto-increment IDs.
-   Local data must be protected.
-   Cache/data loss behavior must be clearly communicated.

## UI Examples

``` text
Online
Last synced: 20 seconds ago
```

or

``` text
Offline
5 transactions waiting to sync
```

## Important Validation Questions

-   Exactly which modules are offline-enabled?
-   Whether POS sales are offline-enabled.
-   Conflict resolution policy.
-   Device registration.
-   Device replacement.
-   Browser cache clearing behavior.
-   Local database retention.
-   Subscription enforcement while offline.
-   Manual vs automatic sync controls.

These must be frozen before production offline implementation.

------------------------------------------------------------------------

# 37. Module 31: Technical Architecture, Security & Quality

## Architecture

Initial architecture:

``` text
React + TypeScript
        ↓
NestJS Modular Monolith
        ↓
PostgreSQL
```

Do not start with microservices.

## Frontend

Recommended logical structure:

``` text
src/
├── app/
├── modules/
│   ├── dashboard/
│   ├── pos/
│   ├── sales/
│   ├── customers/
│   ├── purchases/
│   ├── suppliers/
│   ├── vendors/
│   ├── inventory/
│   ├── finance/
│   ├── reconciliation/
│   ├── warranty/
│   ├── reports/
│   ├── settings/
│   └── subscription/
├── components/
├── layouts/
├── hooks/
├── services/
├── lib/
├── types/
└── utils/
```

## Backend

Logical modules:

``` text
AuthModule
UsersModule
RolesModule
SubscriptionsModule
FeatureFlagsModule

ProductsModule
CustomersModule
SuppliersModule
VendorsModule

SalesModule
PurchasesModule
ReturnsModule

InventoryModule
InventoryLotsModule
InventoryMovementsModule

PaymentsModule
CustomerLedgerModule
VendorLedgerModule

CashModule
BankModule
BankReconciliationModule
ExpensesModule

WarrantyModule
ReportsModule
AuditModule
SettingsModule
```

Boundaries may be adjusted during detailed design without changing
business requirements.

------------------------------------------------------------------------

# 38. Database Requirements

## Core Principles

-   PostgreSQL is the transactional source of truth.
-   Tenant-owned records must carry tenant scope directly or through an
    enforced ownership relationship.
-   Foreign keys should preserve referential integrity.
-   Monetary values require fixed-precision numeric types, not floating
    point.
-   Quantities require suitable numeric precision.
-   Transaction records need timestamps and audit metadata.
-   Critical transaction operations must use database transactions.

## Minimum Transaction Metadata

``` text
id
transaction_date
created_at
updated_at
created_by
updated_by
status
reference
description
```

Entity-specific fields are added as required.

------------------------------------------------------------------------

# 39. Transaction Integrity

Example sale:

``` text
BEGIN
  Create Sale
  Create Sale Items
  Consume Inventory
  Create Stock Movements
  Create Payment
  Create Customer Ledger Entry
  Create Cash/Bank Movement
  Create Audit Event
COMMIT
```

If a critical operation fails:

``` text
ROLLBACK
```

Partial financial or inventory transactions are unacceptable.

------------------------------------------------------------------------

# 40. Concurrency Requirements

Must handle:

-   Two users selling the same product.
-   Two users consuming the same lot.
-   Concurrent payments.
-   Concurrent stock adjustments.
-   Concurrent customer balance updates.
-   Concurrent vendor balance updates.

Use appropriate PostgreSQL transaction isolation/locking strategies.

Frontend validation must never be the only protection.

------------------------------------------------------------------------

# 41. API Requirements

API style:

``` text
REST
/api/v1/...
```

Requirements:

-   Authentication.
-   Tenant context.
-   Authorization.
-   DTO/schema validation.
-   Consistent errors.
-   Pagination.
-   Filtering.
-   Sorting.
-   Search.
-   Idempotency for retry-sensitive operations where required.
-   Transaction boundaries.
-   Audit events.
-   API versioning.

Example logical endpoints:

``` text
POST   /api/v1/sales
GET    /api/v1/sales
GET    /api/v1/sales/:id
POST   /api/v1/sales/:id/cancel

POST   /api/v1/purchases
GET    /api/v1/inventory
GET    /api/v1/inventory/movements

POST   /api/v1/payments
GET    /api/v1/customers/:id/ledger

POST   /api/v1/bank-reconciliation/import
POST   /api/v1/bank-reconciliation/:id/match
```

Exact endpoint design is a technical design task and must follow the
domain boundaries.

------------------------------------------------------------------------

# 42. Security Requirements

-   Authentication required for protected operations.
-   Backend authorization required.
-   Tenant isolation enforced server-side.
-   Password hashing.
-   Secure session/token handling.
-   Input validation.
-   Protection against unauthorized cost visibility.
-   Audit logging.
-   Database access control.
-   Secure file/document access.
-   Rate limiting where appropriate.
-   Secure secrets management.
-   HTTPS in production.
-   Backup and recovery strategy.
-   Sensitive data must not leak across tenants.

------------------------------------------------------------------------

# 43. UI/UX Requirements

## General

-   Modern.
-   Clean.
-   Professional.
-   Fast.
-   Responsive.
-   Desktop-first for ERP operations.
-   Keyboard-friendly.
-   Retail-optimized.
-   Dense but readable.

## POS

-   Minimal clicks.
-   Fast search.
-   Barcode-first workflow.
-   Keyboard shortcuts where practical.
-   Clear totals.
-   Clear paid/due state.
-   Quick customer selection.
-   Clear payment methods.

## Navigation

Navigation visibility depends on:

1.  Subscription entitlement
2.  Business feature setting
3.  User permission

Do not show unavailable functionality.

------------------------------------------------------------------------

# 44. Explainable ERP

Important totals should support source drill-down.

Examples:

``` text
Stock: 127
[Why?]

Customer Due: ৳80,000
[Why?]

Vendor Payable: ৳65,000
[Why?]

Bank Difference: ৳11,500
[Why?]
```

The user should be able to trace important totals back to source
transactions.

------------------------------------------------------------------------

# 45. Data Integrity Rules

## Stock

Never change stock without a movement/source.

## Money

Never change cash/bank balance without a movement/source.

## Ledger

Every balance-affecting event must have a ledger source.

## Backdating

Backdated transactions must preserve:

-   original transaction date
-   creation timestamp
-   creator
-   correction history

## Deletion

Financial and inventory history must not be silently destroyed.

------------------------------------------------------------------------

# 46. Invoice Requirements

Invoice should contain, as applicable:

-   Business identity
-   Invoice number
-   Date
-   Customer
-   Product lines
-   Quantity
-   Unit price
-   Discount
-   Total
-   Payment breakdown
-   Paid
-   Due
-   Reference
-   Footer/business information

Support:

-   Bangla
-   English
-   Thermal
-   A4
-   Business-pad
-   PDF
-   Image/JPG where required

------------------------------------------------------------------------

# 47. Reporting Date Semantics

For normal business statements:

``` text
Use Transaction Date
```

For audit/data-entry analysis:

``` text
Use Created Date
```

The UI should make the selected date basis obvious.

------------------------------------------------------------------------

# 48. Implementation & Validation Method

SherERP must be built **module by module**.

For each module:

1.  Requirement review.
2.  Business rule validation.
3.  Entity/domain design.
4.  Database schema.
5.  Backend services.
6.  API.
7.  Permissions.
8.  UI.
9.  Automated tests.
10. Manual transaction testing.
11. Integration testing.
12. Edge-case testing.
13. User acceptance validation.
14. Fix/retest.
15. Explicit confirmation.

## Gate Rule

Do not move to the next module until the current module is explicitly
confirmed.

------------------------------------------------------------------------

# 49. Testing Requirements

Testing is not only AI-generated tests.

Each module must be tested through:

### A. Automated Tests

-   Unit tests
-   Service tests
-   API tests
-   Database/integration tests

### B. Manual Transaction Tests

The owner/user must perform realistic workflows manually.

Example:

``` text
Create product
→ Purchase product
→ Confirm lot
→ Sell product
→ Take payment
→ Verify stock
→ Verify customer ledger
→ Verify cash
→ Print invoice
```

### C. Negative Tests

Examples:

-   Unauthorized user attempts cost access.
-   Duplicate phone.
-   Invalid quantity.
-   Insufficient stock.
-   Duplicate barcode.
-   Invalid payment.
-   Cross-tenant access attempt.
-   Incorrect backdated entry.
-   Concurrent stock consumption.

### D. Regression

A new module must not break confirmed modules.

------------------------------------------------------------------------

# 50. Acceptance Criteria

A module is accepted only when:

-   Functional requirements pass.
-   Business rules pass.
-   Permissions pass.
-   Database integrity passes.
-   UI behavior passes.
-   API behavior passes.
-   Manual workflow passes.
-   Edge cases pass.
-   Audit behavior passes.
-   Regression tests pass.
-   Known defects are resolved or explicitly accepted.
-   User explicitly confirms the module.

------------------------------------------------------------------------

# 51. Implementation Priority

## Phase 1

-   Platform/tenant
-   Authentication
-   Users/roles
-   Products
-   Customers
-   Suppliers
-   Sales/POS
-   Purchases
-   Basic inventory
-   Customer due
-   Cash

## Phase 2

-   Inventory lots
-   Valuation
-   Stock issue methods
-   FIFO
-   Stock movements
-   Reconciliation
-   Landed cost
-   Vendor ledger
-   Bank
-   Bank reconciliation
-   Audit

## Phase 3

-   Vendor/Consignment
-   Serial numbers
-   Warranty
-   Advanced reports
-   Advanced subscription controls

## Phase 4

-   Additional integrations
-   Expansion features
-   Multi-branch/multi-warehouse if later required

------------------------------------------------------------------------

# 52. Non-Functional Requirements

## Performance

-   POS interactions should feel immediate.
-   Product search should be optimized for large catalogs.
-   Common dashboard/report queries should be indexed and optimized.
-   Long reports should support pagination/filtering/export.

## Reliability

-   Transactions must be atomic.
-   Failed operations must not leave partial financial/inventory state.
-   Backups must be available according to deployment policy.

## Maintainability

-   Modular NestJS boundaries.
-   Reusable React components.
-   Strong typing.
-   Clear domain services.
-   Database migrations.
-   Automated tests.
-   No unnecessary microservices.

## Scalability

The initial architecture must support multi-tenant growth without
requiring a rewrite of core transaction logic.

------------------------------------------------------------------------

# 53. Domain Model Overview

``` text
Tenant
├── Users
├── Roles
├── Feature Settings
├── Products
│   ├── Categories
│   ├── Brands
│   └── Lots
├── Customers
│   └── Customer Ledger
├── Suppliers
├── Vendors
│   └── Vendor Ledger
├── Sales
│   ├── Sale Items
│   └── Stock Consumption
├── Purchases
│   └── Purchase Items
├── Inventory Movements
├── Returns
├── Payments
├── Cash Sessions
├── Cash Movements
├── Bank Accounts
├── Bank Transactions
├── Reconciliations
├── Expenses
├── Warranties
├── Serial Numbers
└── Audit Logs
```

------------------------------------------------------------------------

# 54. Key End-to-End Workflow

``` text
Open POS
  ↓
Search/scan product
  ↓
Select customer
  ↓
Add quantity
  ↓
Apply permitted price/discount
  ↓
Select sourcing if applicable
  ↓
Calculate total
  ↓
Take payment / record due
  ↓
Create sale
  ↓
Consume correct inventory
  ↓
Create stock movement
  ↓
Update customer ledger
  ↓
Update cash/bank
  ↓
Generate invoice
```

Purchase workflow:

``` text
Create Purchase
  ↓
Select Supplier
  ↓
Add Products
  ↓
Record Purchase Cost
  ↓
Record Additional Costs
  ↓
Allocate Landed Cost
  ↓
Create Lot
  ↓
Set Actual Cost
  ↓
Increase Inventory
  ↓
Update Supplier/Vendor Ledger
  ↓
Update Cash/Bank
```

Reconciliation workflow:

``` text
Import Bank Statement
  ↓
Match Transactions
  ↓
Find Missing / Wrong Entries
  ↓
Create or Correct
  ↓
Use Original Transaction Date
  ↓
Audit Change
  ↓
Mark Reconciled
```

------------------------------------------------------------------------

# 55. Critical Decisions Requiring Validation

Before implementation is frozen, explicitly validate:

1.  Exact final list and ordering of the 31 modules.
2.  Exact stock issue methods.
3.  Exact inventory valuation methods.
4.  Negative stock policy.
5.  Whether multi-UoM is required in V1.
6.  Exact offline-enabled modules.
7.  Offline conflict policy.
8.  Local database technology.
9.  Subscription behavior while offline.
10. Exact subscription package entitlements.
11. Whether full double-entry accounting is included now or later.
12. Exact vendor/consignment accounting behavior.
13. Return stock disposition rules.
14. Exact invoice numbering rules.
15. Exact permission matrix.
16. Exact bank import formats.
17. Exact correction/reversal workflow.
18. Exact multi-tenant database isolation strategy.
19. Backup/recovery targets.
20. Final API conventions.

------------------------------------------------------------------------

# 56. Requirements Traceability

Every implemented feature should map to:

``` text
Requirement
→ Module
→ Business Rule
→ Database Model
→ API
→ Permission
→ UI
→ Automated Test
→ Manual Test
→ Acceptance Result
```

This prevents implementation from drifting away from the approved
specification.

------------------------------------------------------------------------

# 57. Change Control

After a module is confirmed:

-   Changes must be explicitly documented.
-   Existing behavior must not be changed accidentally.
-   A changed requirement must identify affected modules.
-   Regression tests must be updated.
-   Dependent modules must be revalidated where necessary.

------------------------------------------------------------------------

# 58. Definition of Done

A SherERP module is not considered complete merely because the code
compiles.

It is complete when:

``` text
Requirement
✓
Business rule
✓
Database
✓
Backend
✓
API
✓
Permissions
✓
UI
✓
Automated tests
✓
Manual transaction tests
✓
Edge cases
✓
Regression
✓
Audit
✓
User validation
✓
Explicit confirmation
```

------------------------------------------------------------------------

# 59. Final Product Principle

> **SherERP should be simple enough for a shopkeeper, powerful enough
> for an accountant, and transparent enough for the owner.**

------------------------------------------------------------------------

# 60. Review Instructions

Use this document as the master SRS review baseline.

For each module:

1.  Review requirements.
2.  Identify missing requirements.
3.  Identify incorrect requirements.
4.  Identify conflicting requirements.
5.  Identify unnecessary complexity.
6.  Finalize business rules.
7.  Finalize acceptance criteria.
8.  Mark the module **CONFIRMED** only after explicit approval.

**No implementation should treat unresolved TBD items as final
requirements.**
