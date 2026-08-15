# SherERP Requirements Updates and Decisions

## 1. Daybook Module

Add a **Daybook Module** that shows all transactions within a selected date range.

* Date range picker: start date to end date.
* Show all transactions in one place.
* Allow authorized users to edit, update, or delete transactions directly from the Daybook.
* Users should not need to open different modules to correct transactions.
* At the end of the day, users can review all transactions from the Daybook.
* Allow printing/exporting the Daybook as a physical record.
* The final printout must include all relevant transactions before and after the selected period where required for context.

## 2. Internal Accounting Journal

Add an internal double-entry accounting backbone:

* `journal_entry`
* `journal_line`

The UI will continue to show simple Customer, Supplier, Vendor, Cash, Bank, and other ledgers.

**Status: Agreed.**

## 3. Browser-Based Temporary Offline Mode

The current focus is the **online browser-based system**.

The browser will use **IndexedDB** for temporary offline transactions when the internet is unavailable.

Rules:

* Only one user-selected device can have write access for offline transactions.
* Other devices become read-only while offline write mode is enabled.
* The user can select which device has offline write authority.
* This is mainly intended for businesses using one device, such as a single shop using one laptop.
* When internet connection returns, offline transactions automatically sync to the server.
* A full standalone Tauri desktop offline system will be implemented later.

## 4. Customer Phone Number

Customer phone numbers must be unique within the Customer role.

* Two customers cannot share the same phone number.
* This is required because POS uses the phone number to search customer invoices.
* The same party may have multiple roles, such as Customer, Supplier, Vendor, or Expense Party.
* Phone uniqueness applies only to customers.

## 5. Invoice Delete and Invoice Templates

If a posted invoice is deleted, the system must reverse all related transactions instead of simply removing their effects.

This includes:

* Stock
* Customer balance/due
* Cash
* Expense
* Other related transactions

Draft invoices can be deleted normally.

Add an **Invoice Template** system so users can create, reuse, and modify templates for recurring types of sales.

## 6. Internal Party System

Use one internal **Party** system with role-based identities.

A party can have multiple roles:

* Customer
* Supplier
* Vendor
* Expense Party

The UI will still provide separate:

* Customer Ledger
* Supplier Ledger
* Vendor Ledger
* Expense Ledger

If a transaction involves a party in another role, the user must explicitly select the appropriate transaction type.

Example:

If a product is sold to a Supplier, that transaction must appear in both the party's sales/customer history and supplier history.

Each party should have a complete history showing purchases, sales, payments, returns, and balances.

## 7. Separate Inventory Valuation and Sales Costing

Inventory must have two separate settings:

1. **Inventory valuation/cost calculation method**
2. **Sales/lot consumption method**

Example:

* Inventory valuation: Average Cost
* POS sales: FIFO

These methods must work independently.

## 8. Negative Stock Costing

When a product is sold while stock is negative:

* If the actual product cost becomes available later, use the actual cost for profit calculation.
* Until the actual cost is available, use the product's latest known purchase price at the time of the negative-stock sale.

The system must update profit/cost calculations when the actual cost becomes available.

## 9. Backdated Transactions and Re-Costing

Backdated purchases and transaction edits are allowed because they are required for the business environment.

When an old transaction is edited:

1. Recalculate affected inventory and costing from that transaction forward.
2. Recalculate affected COGS and profit.
3. Do not silently change a closed accounting period.

## 10. Period Lock

Support accounting period locking.

Example:

```text
January 2026
🔒 CLOSED
```

If someone edits a January purchase in February:

* January Profit must not silently change.
* January Stock must not silently change.
* January COGS must not silently change.

Only an authorized user can:

```text
Unlock
   ↓
Edit
   ↓
Recalculate
   ↓
Create Audit Log
```

## 11. VAT/Tax

Implement a **minimal VAT/Tax system in V1** with the required database fields and transaction support.

## 12. Warehouse / Location

Enable the Warehouse/Location system.

* If the business has only one warehouse, automatically use a default warehouse.
* The user does not need to manually create a warehouse for a single-location business.
* If multiple warehouses are created, each warehouse maintains its own stock.

## 13. Units and Unit Conversion

Support purchasing and selling using different units.

Example:

```text
1 Carton = 24 Pieces
```

When purchasing:

* Select Carton or Piece.
* Define how many pieces are contained in one carton.

When selling:

* Sell by Carton or Piece.

Also support manually defined units such as:

```text
1 Pipe = 20 Feet
```

The user can define the conversion manually.

## 14. Offline Invoice Numbering

During temporary offline operation:

* Offline transactions must receive unique offline-safe invoice numbers.
* Only the selected offline-write device can create offline transactions.
* When the internet returns, transactions automatically sync to the server.
* When offline write mode is enabled, other devices cannot write to the database.

## 15. Opening Balances

Opening balances are required throughout the system.

Support opening balances for:

* Customers
* Suppliers
* Products/Stock
* Vendors
* Cash/Bank
* Other applicable ledgers

Opening balances must be editable with proper audit tracking.

## 16. Advanced Customer and Supplier Balances

Customer and Supplier ledgers must support:

* Current balance
* Due balance
* Advance balance
* Partial payments
* Sales returns
* Purchase returns
* Cash refunds/payments
* Invoice-based payment allocation

When receiving a customer payment:

1. Select the invoice(s) being paid.
2. Apply the payment to those invoices.
3. If the customer pays more than the invoice amount, keep the extra amount as an advance.
4. The advance can later be applied against the customer's due balance.

## 17. Credit Limit

Allow users to configure a credit limit for a customer.

During sales:

* If the new transaction exceeds the credit limit, show a warning.
* Do not block the sale.

## 18. Stock Transfer

If a business creates multiple warehouses, support stock transfers between warehouses.

## 19. Money Precision

Store monetary values internally using integer minor units, such as:

```text
৳100.10 = 10010 paisa
```

This avoids floating-point money calculation errors.

**Status: Agreed.**

## 20. Shared Business Logic

Business rules must live in a shared, platform-independent **Domain/Core layer**.

The same Core must be usable by:

* Web
* Tauri
* Mobile
* MCP

The current implementation will focus on the online browser system. Tauri and other offline clients will be added later.

## 21. Server Authority and Security

NestJS remains the final authority for:

* Authentication
* Authorization
* Server-side validation
* Transactions
* Security
* Important business-operation verification

The safe model is:

```text
Shared Domain/Core
    ↓
Local business-rule validation
    ↓
Web / Tauri / Mobile / MCP

NestJS
    ↓
Final server-side validation
    ↓
PostgreSQL
    ↓
Final persistence and integrity
```

Therefore:

* **Shared Core = common business logic everywhere**
* **NestJS = final authority and security boundary**
* **PostgreSQL = final persistence layer with constraints and transactions**

## 22. Attachments and Product Photos

Products can have photos.

Other modules can also support attachments, such as purchase documents and receipts.

Attachment limits must depend on the customer's subscription/package.

## 23. Overall Architecture

```text
                 SherERP
                    │
        ┌───────────┼───────────┐
        ↓           ↓           ↓
   Accounting     Stock       Sync
        │           │           │
        └───────────┼───────────┘
                    ↓
              Audit / Lock
```

The system must maintain accounting integrity, stock integrity, synchronization integrity, and a complete audit trail.
