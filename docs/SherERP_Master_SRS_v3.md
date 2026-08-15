# SherERP Master SRS v3.0

**Document:** Software Requirements Specification  
**Product:** SherERP  
**Version:** 3.0  
**Status:** Consolidated Master Requirements for Validation  
**Date:** 2026-08-14

---

## 1. Document Purpose

SherERP is a business management, POS, inventory, purchasing, finance, reporting, SaaS and offline ERP platform.

This document consolidates the previously reviewed 31-module SherERP requirements together with subsequent confirmed decisions.

This version is intended to become the single requirements baseline for:

- Requirements validation
- Architecture validation
- AI planning
- Implementation
- Testing
- Acceptance
- Future MCP/AI integration

A requirement is not considered finally frozen until explicitly marked **CONFIRMED** by the product owner.

---

# 2. Product Goals

SherERP must provide:

1. Fast retail/business operation.
2. Accurate inventory and financial records.
3. Strong tenant isolation and security.
4. Configurable business behavior.
5. Extensive operational freedom with controlled permissions and auditability.
6. Online operation.
7. Full offline business operation through a desktop application.
8. Synchronization between online and offline operation.
9. Mobile access.
10. Future AI/MCP control.
11. Data portability and encrypted backup/restore.
12. Reusable architecture for future SaaS products.

Primary principle:

> **Maximum legitimate business freedom, while security, data integrity, accounting correctness, inventory correctness, auditability, API quality, performance and reliability remain mandatory.**

---

# 3. Product Operating Modes

SherERP supports two operational modes.

## 3.1 Online Mode

The tenant operates through the online ERP.

Primary data store:

- PostgreSQL

The online server is authoritative for cloud data.

## 3.2 Offline Mode

A tenant may enable one designated device for full offline read/write operation.

The offline application is a Tauri desktop application using a local SQLite database.

Offline operation must support approved business operations, including:

- Sales
- POS
- Purchasing
- Inventory
- Inventory lots
- Costing
- Customers
- Suppliers
- Payments
- Expenses
- Ledgers
- Returns
- Reports
- Other operations explicitly marked offline-capable

The offline device must not become a second independent ERP implementation.

Business/application logic must be designed for reuse between online and offline execution.

---

# 4. Offline Device Policy

A tenant may designate **only one device** as the offline read/write device.

Example:

```text
Tenant
├── Device A: Offline Read/Write = ON
├── Device B: Read Only
├── Device C: Read Only
└── Device D: Read Only
```

## 4.1 Settings

The tenant/admin can configure:

**Offline Read/Write Device**

Only one device may hold this capability at a time.

## 4.2 Other Devices

All other devices may access synchronized online data in **read-only mode** when the tenant's offline mode policy requires it.

They must not perform conflicting write operations against the offline operating dataset.

## 4.3 Device Transfer

The system must safely support changing the designated offline device.

Before transferring the role:

1. Current offline device must synchronize pending changes where possible.
2. Server must record device state.
3. Previous device must lose write authority.
4. New device must receive the appropriate synchronized dataset.
5. Device authorization must be auditable.

The system must prevent two devices from simultaneously believing they have offline read/write authority.

---

# 5. Online/Offline Synchronization

Synchronization is a core product capability.

## 5.1 Direction

```text
Online PostgreSQL
        ↕
   Sync API/Engine
        ↕
Offline SQLite
```

The offline device downloads required tenant data and uploads local transactions.

## 5.2 Offline Transaction

When offline:

```text
User
 ↓
Tauri UI
 ↓
Application/Domain Logic
 ↓
SQLite Transaction
 ↓
Local Sync Queue
```

When connectivity returns:

```text
Local Sync Queue
 ↓
Sync Engine
 ↓
Server API
 ↓
PostgreSQL
```

## 5.3 Requirements

Synchronization must support:

- Reliable upload
- Reliable download
- Idempotency
- Retry
- Resume after interruption
- Duplicate protection
- Transaction ordering where required
- Sync status
- Last synchronization time
- Pending operation count
- Failed operation visibility
- Error recovery
- Audit trail

## 5.4 Conflict Policy

The system must not silently overwrite conflicting business transactions.

Conflicts must be detected and handled according to defined domain rules.

For financial and inventory operations, automatic conflict resolution must never compromise:

- Stock integrity
- Ledger integrity
- Payment integrity
- Audit integrity

---

# 6. Development Strategy

The approved development strategy is:

```text
Online-first
    ↓
Synchronization
    ↓
Tauri Offline
    ↓
Mobile
    ↓
MCP / AI
```

This is the product development sequence.

## 6.1 Online-first

Build and stabilize the online ERP first.

## 6.2 Synchronization

Design and implement synchronization after the online business workflows are stable enough to define authoritative transactions.

## 6.3 Tauri Offline

Build the full offline desktop operation using the same business/application concepts and SQLite persistence.

## 6.4 Mobile

Build mobile applications on top of the stable backend API.

## 6.5 MCP

Expose safe ERP capabilities through MCP after the underlying application services and permissions are stable.

---

# 7. Architecture Requirements

The initial architecture shall be a **modular monolith**.

Avoid microservices unless a future requirement clearly justifies them.

Recommended baseline:

```text
Frontend
Vue 3 + Vite + TypeScript

Backend
NestJS + TypeScript

Cloud Database
PostgreSQL

Desktop
Tauri

Offline Database
SQLite

Mobile
React Native + Expo

API
REST + OpenAPI

MCP
TypeScript
```

## 7.1 Business Logic

Business logic must not be trapped inside HTTP controllers.

Preferred structure:

```text
UI
 ↓
Application Services
 ↓
Domain Logic
 ↓
Repository / Infrastructure Adapters
```

Online:

```text
Application/Domain
 ↓
PostgreSQL Adapter
```

Offline:

```text
Application/Domain
 ↓
SQLite Adapter
```

This allows the same business rules to operate in both environments.

---

# 8. Multi-Tenant Security

Every protected operation must execute in tenant context.

Requirements:

- Tenant isolation
- Server-side authorization
- Role-based permissions
- Resource ownership validation
- Cross-tenant access prevention
- Secure authentication
- Audit logging

A user must never access another tenant's data by modifying IDs, URLs, payloads or API requests.

---

# 9. Account Creation & Authentication

First account creation requires:

```text
Mobile Number
 ↓
OTP Verification
 ↓
Account Creation
 ↓
Trial Account
```

Trial users authenticate using the verified mobile number.

Authentication and authorization must remain separate concerns.

---

# 10. Subscription & Entitlements

Access follows:

```text
Subscription Plan
 ↓
Feature Entitlement
 ↓
Business Feature Setting
 ↓
User Permission
 ↓
Actual Access
```

Plans may control:

- Modules
- Features
- Usage limits
- Vendor/consignment
- Advanced inventory
- Warranty/serial functionality
- Reporting
- Offline capability
- SMS services

The exact package matrix remains configurable and must be validated before release.

---

# 11. Module 01: Business / Tenant Setup

Requirements:

- Business profile
- Business name
- Phone
- Address
- Currency
- Timezone
- Status
- Business identity
- Tenant configuration
- Business-level settings

Tenant data must be isolated.

---

# 12. Module 02: Authentication, Users, Roles & Permissions

Requirements:

- Login
- Logout
- OTP
- User management
- Role management
- Permission management
- Session/token handling
- Password security where applicable
- Session expiry
- Authentication failure handling

Permissions include, where applicable:

- View
- Create
- Edit
- Delete
- Approve
- Cancel
- Reverse
- Print
- Export
- Payment
- Stock adjustment
- Reconciliation
- Cost visibility
- Transaction date editing
- Transaction correction
- Settings management

Dashboard/view access is also permission-controlled.

---

# 13. Module 03: Subscription & Plan Entitlements

Requirements:

- Trial
- Subscription plans
- Monthly plans
- Yearly plans
- Feature entitlements
- Package restrictions
- Renewal
- Expiry
- Offline licensing
- Offline license period

Offline ERP licenses may be monthly or yearly according to purchased package.

---

# 14. Module 04: Product & Catalog

Requirements:

- Product
- Brand
- Category/group
- SKU/code
- Barcode
- Unit
- Selling price
- Reorder level
- Status
- Description
- Image
- Expiry configuration
- Warranty configuration
- Serial tracking

Brand and Product Name are separate fields.

Display name:

```text
Brand + Product Name
```

when a brand exists.

Product operations:

- Add
- Edit
- Update
- Delete where permitted
- Search
- Filter
- Brand filtering
- Category filtering
- Barcode search
- Barcode scanning
- Barcode generation where enabled

Different supplier purchase prices must create inventory lots, not duplicate products.

---

# 15. Module 05: Customer Management

Requirements:

- Customer creation
- Edit/update
- Delete where permitted
- Search
- Filter
- Phone
- Address
- Group
- Loyalty/premium classification where enabled
- Notes
- Status
- Customer history
- Customer ledger

Phone is mandatory.

Duplicate phone numbers are not allowed under the confirmed requirement.

Walk-in Customer is a real customer record.

---

# 16. Module 06: Supplier Management

Requirements:

- Supplier master
- Add/edit/update/delete where permitted
- Contact information
- Status
- Purchase history
- Payable
- Payments
- Purchase returns
- Statement
- Ledger
- Search/filter

---

# 17. Module 07: Vendor / Consignment

Requirements:

- Vendor management
- Vendor-owned stock
- Vendor/consignment sourcing
- Vendor cost
- Vendor payable
- Vendor payment
- Vendor return
- Source transaction history

Inventory must distinguish:

```text
Owned Stock
vs
Vendor-Owned Stock
```

Vendor/Consignment is an entitlement-controlled feature.

---

# 18. Module 08: Sales & POS

Requirements:

- Fast product search
- Grid/list display
- Barcode scan
- Brand filter
- Category filter
- Other useful filters
- Customer selection
- Walk-in customer
- Quantity editing
- Price editing according to permission
- Discount
- Grand total
- Multiple payment methods
- Cash paid
- Due
- Invoice generation
- Printing
- Reprint
- Sale cancellation/correction
- Permission-controlled transaction editing

POS source selection:

```text
Own Stock
Vendor/Consignment
Other approved source
```

Vendor/consignment requires:

- Vendor
- Quantity
- Vendor cost

Vendor payable must be created correctly.

Negative selling/stock behavior is configurable.

---

# 19. Module 09: Sales Invoice & Payments

Requirements:

- Invoice creation
- Invoice numbering
- Payment allocation
- Multiple payment methods
- Cash
- Bank
- Due
- Customer balance
- Invoice search
- Reprint
- Cancellation/correction
- Payment history

Critical sale transaction must maintain consistency between:

- Sale
- Inventory
- Payment
- Customer ledger
- Cash/bank
- Audit

---

# 20. Module 10: Purchase Management

Requirements:

- Supplier
- Purchase date
- Reference/invoice
- Product
- Quantity
- Purchase price
- Discount
- Additional costs
- Payment
- Due
- Lot creation
- Inventory increase
- Supplier ledger
- Cash/bank movement
- Purchase return

Different purchase prices create separate lots.

---

# 21. Module 11: Purchase Orders

Requirements:

- Create purchase order
- Supplier
- Products
- Quantities
- Expected cost
- Status
- Approval where enabled
- Conversion to purchase
- Search/filter
- Edit/update
- Cancellation
- Audit

Purchase order itself must not incorrectly increase physical stock.

---

# 22. Module 12: Inventory & Stock

Requirements:

- Current stock
- Stock search
- Filters
- Low stock
- Out of stock
- Stock movement
- Stock adjustment
- Stock reconciliation
- Inventory history
- Source transaction
- Concurrency protection

Every stock movement must identify:

- Product
- Lot where applicable
- Quantity
- Source transaction
- Transaction date
- Created timestamp
- User
- Cost where applicable

No silent stock mutation.

---

# 23. Module 13: Inventory Lots & Costing

Requirements:

- Lot creation
- Lot quantity
- Remaining quantity
- Purchase cost
- Actual cost
- Supplier/vendor
- Source transaction
- Transaction date
- Created date
- Expiry
- Serial linkage

Costing options:

- FIFO
- Average
- LIFO

Default inventory calculation method is configured under Product-related Settings.

Physical stock issue rules and valuation method must remain conceptually separate.

---

# 24. Module 14: Landed Cost

V1 allocation methods:

1. Purchase Value
2. Quantity
3. Manual

Cost categories may include:

- Transport
- Loading/unloading
- Labor
- Other approved costs

Actual cost:

```text
Purchase Cost + Allocated Landed Cost
```

Original purchase cost must remain traceable.

---

# 25. Module 15: Stock Reconciliation & Adjustments

Requirements:

- Physical count
- System quantity
- Physical quantity
- Difference
- Adjustment reason
- Authorization
- Audit
- Stock movement

No direct silent quantity manipulation.

---

# 26. Module 16: Returns

Support:

- Sales returns
- Purchase returns
- Original transaction reference
- Product
- Quantity
- Lot
- Return reason
- Stock disposition
- Refund/credit
- Ledger adjustment
- Cash/bank adjustment
- Audit

Returned inventory must have explicit disposition.

---

# 27. Module 17: Customer Ledger & Receivables

Ledger supports:

- Sales
- Payments
- Returns
- Adjustments
- Other approved receivable movements

Statement:

```text
Date
Reference
Description
Debit
Credit
Running Balance
```

Default reporting uses transaction date.

Created date remains available for audit/reconciliation.

Terminology is configurable.

Possible display:

- Debit/Credit
- Cash In/Cash Out
- পাবো/দিব
- Other configured labels

Underlying accounting semantics must not change.

---

# 28. Module 18: Vendor Ledger & Payables

Support:

- Purchases
- Vendor/consignment sourcing
- Payments
- Receipts
- Returns
- Adjustments
- Payable
- Receivable
- Statements
- Filters
- Transaction date
- Created date
- Audit

---

# 29. Module 19: Cash Management & POS Sessions

Opening cash is mandatory where cash-session functionality is enabled.

Flow:

```text
Open Session
 ↓
Sales
 ↓
Payments
 ↓
Cash In/Out
 ↓
Close Session
```

Closing calculation:

```text
Expected Cash =
Opening Cash + Cash In - Cash Out
```

Show:

- Expected
- Actual
- Difference

Session must be based on actual session state, not merely calendar date.

---

# 30. Module 20: Bank Accounts & Transactions

Requirements:

- Bank account
- Bank name
- Account name
- Reference/account number
- Opening balance
- Transactions
- Payments
- Receipts
- Statement
- Balance
- Audit
- Source transaction linkage

---

# 31. Module 21: Bank Reconciliation

Support:

- CSV import
- Excel import
- Unmatched
- Matched
- Reconciled
- Bank-only
- Book-only
- Exception

Actions:

- Match
- Create missing transaction
- Edit
- Correct transaction date
- Correct allowed fields
- Mark reconciled

Transaction date and created timestamp remain separate.

Changes to reconciled transactions must trigger review and must not silently rewrite reconciliation history.

---

# 32. Module 22: Expenses & Other Money Movements

Expense fields:

- Category
- Amount
- Transaction date
- Payment method
- Description
- Reference
- User

Requirements:

- Add
- Edit
- Update
- Delete where permitted
- Search
- Filter
- Audit
- Cash/bank linkage
- Transaction-date reporting
- Created-date reporting

Expense categories include examples such as:

- Salary
- Transport Cost
- Other Expense

Categories must be configurable.

Example:

```text
Salary paid to Belal
        ↓
Belal party ledger
        +
Salary expense
        +
Cash/Bank movement
        +
Audit
```

---

# 33. Module 23: Warranty & Serial Tracking

Warranty:

- Product
- Customer
- Invoice
- Start date
- End date
- Serial
- Status

Serial relationship:

```text
Purchase
 ↓
Inventory
 ↓
Sale
 ↓
Customer
 ↓
Warranty
 ↓
Return
```

Serials must be unique within the appropriate tenant scope.

---

# 34. Module 24: Reports & Statements

Reports include:

### Sales

- Sales summary
- Date
- Product
- Customer
- Cashier
- Brand
- Category
- Payment method

### Purchasing

- Purchase summary
- Supplier
- Product
- Date

### Inventory

- Current stock
- Low stock
- Out of stock
- Stock movement
- Lot
- Valuation

### Finance

- Customer due
- Vendor payable
- Vendor receivable
- Cash
- Bank
- Expenses
- Profit/margin when reliable

### Reconciliation

- Unmatched
- Reconciled
- Late entries
- Corrections

Reports must use structured transactional data rather than duplicated manual calculations.

---

# 35. Module 25: Dashboard & Explainable Metrics

Dashboard cards are configurable.

Examples:

- Today's sales
- Stock value
- Purchase orders
- Low stock
- Recent sales
- Due collection
- Payable amount
- Cash/bank balance where enabled

Dashboard visibility requires permission.

Metrics must be explainable through underlying transactions.

Profit must not be shown unless costing/accounting data is sufficiently reliable and the feature is enabled.

---

# 36. Module 26: Settings & Feature Controls

Central Settings contains:

## Product-related settings

- Inventory calculation method
- FIFO
- Average
- LIFO
- Stock behavior
- Product behavior

## Party-related settings

- Customer behavior
- Supplier behavior
- Vendor behavior
- Party defaults

## Permission settings

- Roles
- Permissions
- Module permissions
- Dashboard/view permissions
- Action permissions

## Module feature controls

Features can be enabled/disabled according to entitlement and business configuration.

Examples:

- Warranty
- Serial tracking
- Vendor/consignment
- Bank reconciliation
- Advanced reports

## Terminology

Financial terminology can be changed globally without changing accounting semantics.

---

# 37. Module 27: Audit & Transaction History

Audit requirements:

- User
- Action
- Entity
- Entity ID
- Old value
- New value
- Timestamp
- Reason where required
- Source transaction

Transaction history must preserve evidence of corrections.

Supported authorized freedom:

- Edit
- Update
- Delete where allowed
- Change transaction date
- Correct transaction
- Reverse
- Cancel

The system must never make a financially meaningful historical event disappear without an auditable trail.

Indicators may include:

- ON TIME
- LATE ENTRY
- BACKDATED
- CORRECTED

---

# 38. Module 28: Offline-first & Synchronization

This module implements the complete online/offline architecture.

## Online

PostgreSQL is server-side authoritative.

## Offline

Tauri + SQLite provides full operation.

## Device policy

Only one designated device may have:

**Offline Read/Write = ON**

All other devices are:

**Read Only**

according to tenant offline policy.

## Synchronization

Must synchronize:

- Master data
- Transactions
- Inventory
- Ledgers
- Payments
- Expenses
- Relevant reports/data
- Audit information

The sync engine must be:

- Idempotent
- Retryable
- Resumable
- Observable
- Conflict-aware
- Secure

## Offline backup

Offline user may securely export local business data.

After clean installation:

```text
Install Tauri
 ↓
Import encrypted backup
 ↓
Restore local database
 ↓
Continue operation
```

---

# 39. Module 29: Notifications, Documents & Printing

Requirements:

- Invoice printing
- Thermal printing
- A4 printing
- Business pad printing
- PDF
- Image/JPG where required
- Bangla/English invoice
- Multiple invoice templates
- Reprint
- Document search

SMS:

Tenant can purchase SMS credits.

Example package:

```text
100 SMS = 70 BDT
```

Payment flow:

```text
Select SMS package
 ↓
Pay via bKash
 ↓
Enter bKash number
 ↓
Enter transaction number
 ↓
Payment verification
 ↓
SMS credits added
```

SMS balance and usage must be tracked.

---

# 40. Module 30: SaaS, Multi-Tenancy & Platform Architecture

Requirements:

- Tenant isolation
- Tenant lifecycle
- Subscription
- Entitlements
- Trial
- Upgrade
- Renewal
- Expiry
- Account closure
- Data export
- Data deletion
- Restore

## Encrypted backup

Tenant can export encrypted data as:

```text
tenantname.sherdb
```

Requirements:

- Encryption
- Integrity protection
- Versioning
- Import validation
- Restore
- Migration
- Tenant ownership validation

A tenant may:

1. Download backup.
2. Close account.
3. Delete server data.
4. Return later.
5. Create/restore an account.
6. Upload backup.
7. Continue operation.

---

# 41. Module 31: Technical Architecture, Security, API, Testing & AI Readiness

## API

REST + OpenAPI.

Requirements:

- Consistent resource naming
- HTTP semantics
- Validation
- Authentication
- Authorization
- Pagination
- Filtering
- Sorting
- Search
- Error format
- Versioning
- Idempotency where required

## Security

- Tenant isolation
- Server-side authorization
- Secure sessions
- Input validation
- Rate limiting where appropriate
- Audit
- Secure secrets
- Encryption at rest where appropriate
- Encryption in transit
- Backup encryption

## Performance

The system must remain responsive for:

- POS
- Product search
- Inventory
- Large transaction history
- Reports
- Filters
- API requests

## Testing

Every module requires:

- Unit tests
- Integration tests
- API tests
- End-to-end tests where applicable
- Regression tests

Additionally, the product owner manually tests real transactions.

---

# 42. AI / MCP Readiness

MCP is a future interface to the same ERP application services.

Architecture:

```text
ChatGPT / AI
     ↓
MCP
     ↓
Authentication
     ↓
Tenant Context
     ↓
Permission Check
     ↓
Application Service
     ↓
Domain Logic
     ↓
Database
```

MCP must not bypass:

- Permissions
- Tenant isolation
- Audit
- Business rules
- Validation

AI actions must be auditable.

Examples of future capabilities:

- Ask for today's sales.
- Find unpaid customers.
- Create approved transactions.
- Explain inventory.
- Generate reports.
- Search invoices.
- Perform permitted business operations.

---

# 43. Standard Transaction Integrity

Critical transactions must be atomic.

Example Sale:

```text
Sale
 ↓
Sale Items
 ↓
Inventory Consumption
 ↓
Stock Movement
 ↓
Payment
 ↓
Customer Ledger
 ↓
Cash/Bank
 ↓
Audit
```

If a critical part fails, the operation must not leave inconsistent financial/inventory state.

Purchasing follows equivalent atomic principles.

---

# 44. Data Model Principles

The system must distinguish:

```text
Product
Lot
Transaction
Stock Movement
Ledger Entry
Payment
Audit Event
```

These are not interchangeable records.

Historical transaction data must remain traceable.

---

# 45. Freedom vs Control

SherERP intentionally allows business users significant control.

Authorized users may:

- Edit
- Update
- Delete where permitted
- Change dates
- Correct transactions
- Backdate
- Configure features
- Configure terminology
- Configure inventory costing
- Configure module behavior

But freedom never means:

- Bypass authorization
- Bypass tenant isolation
- Silently alter historical records
- Break inventory integrity
- Break ledger integrity
- Bypass audit
- Create invalid accounting states

---

# 46. Module Development & Validation Workflow

Every module follows:

```text
Requirement
 ↓
Requirement Review
 ↓
CONFIRM
 ↓
Technical Plan
 ↓
Database
 ↓
Domain/Application
 ↓
API
 ↓
UI
 ↓
Automated Tests
 ↓
AI Review
 ↓
Manual Real-Transaction Testing
 ↓
Fix
 ↓
Regression Testing
 ↓
CONFIRM
```

No module should be considered complete merely because AI reports that coding is finished.

---

# 47. AI Development Strategy

AI is the primary implementation assistant.

Recommended roles:

### GPT-5.6 Luna

- Architecture
- Planning
- Requirement reasoning
- Difficult business logic
- Technical decisions

### GPT-5.6 Sol

- Independent review
- Requirement challenge
- Security review
- Architecture review
- Bug/edge-case review

### Codex / Claude Code

- Implementation
- Refactoring
- Tests
- Debugging
- Documentation

AI coding agents must:

1. Read the master SRS.
2. Read relevant module specification.
3. Follow architecture.
4. Avoid unrelated modifications.
5. Not silently change confirmed requirements.
6. Write tests.
7. Run tests.
8. Preserve existing functionality.
9. Report assumptions.
10. Never hide failing tests.

---

# 48. Manual Validation

The product owner does not need to write application code.

The product owner validates through actual business operation.

Example:

```text
Create Product
 ↓
Purchase Product
 ↓
Check Stock
 ↓
Sell Product
 ↓
Receive Payment
 ↓
Check Customer Ledger
 ↓
Check Cash
 ↓
Check Inventory
 ↓
Check Reports
```

Edge cases must also be manually tested.

A module reaches final acceptance only after manual validation and explicit confirmation.

---

# 49. Cross-Module Consistency Rules

Every module must support applicable:

- Search
- Filter
- Sort
- Add
- Edit
- Update
- Delete
- Audit
- Permissions
- Dashboard/view permission
- Transaction date
- Created timestamp
- Export/print where appropriate
- API access
- Future AI readiness

Not every action applies to every entity. Financial and inventory integrity rules override generic CRUD freedom.

---

# 50. Non-Functional Requirements

## Security

Professional security standards are mandatory.

## Performance

Fast POS, search, filtering and transaction processing.

## Reliability

No silent transaction loss.

## Maintainability

Simple, conventional architecture preferred.

## Scalability

Tenant and transaction growth must be supported.

## Observability

Logs, errors, audit events and synchronization state must be observable.

## Compatibility

Database and backup formats must be versioned.

## Availability

Online operation should be resilient.

## Offline Reliability

Offline operation must continue without internet within licensed and authorized scope.

---

# 51. Requirements Status Model

Each requirement should ultimately be marked:

- `CONFIRMED`
- `VALIDATE`
- `TBD`
- `REJECTED`

No `TBD` or `VALIDATE` requirement should silently become implementation behavior.

---

# 52. Final Product Architecture Direction

```text
                    SherERP
                       │
          ┌────────────┴────────────┐
          │                         │
       Online                    Offline
          │                         │
      Vue + Vite                 Tauri
          │                         │
      NestJS API              SQLite
          │                         │
      PostgreSQL             Local Business
          │                    Operation
          └────────────┬────────────┘
                       │
                  Sync Engine
                       │
                 Online Database
                       │
             ┌─────────┴─────────┐
             │                   │
          Mobile              Future MCP
             │                   │
        React Native        AI Interface
```

The implementation must avoid creating separate business logic implementations for online and offline operation wherever practical.

---

# 53. Final Development Sequence

The approved sequence is:

```text
1. Requirements validation
        ↓
2. Architecture validation
        ↓
3. Foundation
        ↓
4. Online ERP
        ↓
5. Synchronization
        ↓
6. Tauri full offline ERP
        ↓
7. Mobile
        ↓
8. MCP / AI
        ↓
9. Reusable Business Core
        ↓
10. Future SaaS products
```

---

# 54. Final Acceptance Principle

SherERP is not considered production-ready because:

- The code compiles.
- AI says it is complete.
- Automated tests pass.

Production readiness requires:

```text
Requirements
    ✓
Architecture
    ✓
Implementation
    ✓
Automated tests
    ✓
Security validation
    ✓
AI review
    ✓
Manual transaction testing
    ✓
Regression testing
    ✓
Offline/sync validation
    ✓
Business acceptance
    ✓
```

Only then is the relevant scope considered confirmed.

---

# 55. Current Status

**This document is SherERP Master SRS v3.0, consolidated from the previous 31-module baseline and subsequent confirmed decisions.**

It is now the candidate master document for external AI validation.

The next validation should specifically look for:

- Missing requirements
- Contradictions
- Ambiguous business rules
- Accounting/inventory risks
- Offline/synchronization risks
- Security risks
- Tenant isolation problems
- Permission gaps
- Data integrity problems
- Performance risks
- Requirements that need explicit product-owner decisions

It must not silently redesign confirmed business requirements.
