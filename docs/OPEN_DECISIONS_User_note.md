# Open Discussion / Decisions

**D-01: Offline Writer**
In V1, only one selected/authorized device can write while offline. Other devices are read-only. Multiple offline writers can be added later if the sync and conflict system can safely support them.

**D-02: Customer Phone Number**
Invoice search will use the customer’s phone number, so each customer must have a unique phone number. A party can have different roles, such as Customer, Supplier, Vendor, or Expense Party.

**D-03: Invoice Deletion**
Posted invoices cannot be permanently deleted. They must be reversed/voided while keeping the history. Draft invoices can be permanently deleted.

**D-04: Party System**
Use one internal Party system with multiple roles. A single Party can be a Customer, Supplier, Vendor, Expense Party, or several roles at the same time. The UI should show separate role-based ledgers, such as Customer Ledger, Supplier Ledger, Vendor Ledger, and Expense Ledger.

**D-05: Stock and Valuation**
Physical stock and accounting valuation must remain separate concepts, with independent settings and calculations.

**D-06: Negative Stock Cost**
For a sale made from negative stock, use the last known cost as a provisional cost. When the actual purchase cost becomes available, recalculate the affected COGS and profit according to the configured costing method. Profit should be marked as reliable only after the cost is finalized.

**D-07: Login and Authentication**
The first account verification uses phone OTP. After verification, users can set a PIN for quick daily login or use email/password or Google OAuth. Sensitive actions require stronger authentication and permission.

**D-08: Backup Restore**
Restore all compatible business data from a backup. Subscription and permissions must always follow the current account/tenant. Data related to unavailable features should remain preserved but read-only until the required plan is activated.

**D-09: VAT/Tax**
V1 will include a minimal VAT/tax system.

**D-10: Unit of Measure (UOM)**
V1 will support manual UOM conversion. Products can be purchased, stocked, and sold using different units such as Carton, Box, Piece, Pipe, Feet, Kg, or Liter. Each product can have its own conversion rules.

**D-11: Customer Credit Limit**
If a customer exceeds the credit limit, show a warning only. Do not block the sale.

**D-12: Language**
The default UI will be English with optional Bangla helper text. The system must support full multilingual UI from V1. Invoices and printed financial documents must support both Bangla and English from V1. Full Bangla UI translation can be added in V1.1.

**D-13: Attachments**
Attachments such as product photos, purchase bills, and expense receipts will be stored separately in online media storage, not inside the `.sherdb` backup. Storage will be subject to the customer’s subscription plan.

The database will store attachment metadata and references, while the actual files remain in media storage. V1 offline backups and offline sync will not include attachments.

If an attachment is unavailable offline, the system should clearly show that it is available online only without affecting the related transaction or record.

**D-14: Repository Architecture**
SherERP will use a lightweight Repository pattern from the beginning. Business logic must remain independent of Drizzle, PostgreSQL, and SQLite.

```text
Domain / Application
        ↓
Repository Interface
        ↓
Drizzle Repository
        ↓
PostgreSQL (Online)
SQLite (Offline)
```

### Rules

* Business rules such as Sales, Purchase, FIFO, Stock, COGS, Profit, Payment, Ledger, Return, and Warranty must not depend directly on Drizzle or any database.
* Repositories are responsible only for data access and persistence, not business calculations.
* Use business-specific repositories such as `ProductRepository`, `InventoryRepository`, `SaleRepository`, `PurchaseRepository`, `PaymentRepository`, and `LedgerRepository`.
* Do not create unnecessary `GenericRepository`, `BaseRepository`, `RepositoryFactory`, or similar abstractions unless there is a real requirement.
* Drizzle is the database implementation layer.
* PostgreSQL is the primary online database.
* SQLite is the offline database.
* The same Domain/Application business logic must work with both databases.
* NestJS is the final server authority for authentication, authorization, validation, financial integrity, and server-side transactions.
* Offline operations may use SQLite locally, but synchronized transactions must be validated by NestJS before becoming authoritative server data.
* Repository interfaces should contain only the operations required by the Domain/Application layer.
* Database-specific SQL must remain inside repository implementations.
* Repository interfaces must not expose Drizzle-specific types.
* Domain code must not import NestJS, Drizzle, PostgreSQL, or SQLite packages.

### Example

```text
sales/
├── domain/
│   └── sale.ts
├── application/
│   └── create-sale.ts
├── repositories/
│   └── sale.repository.ts
└── infrastructure/
    └── drizzle-sale.repository.ts
```

The Domain/Application layer can call:

```text
saleRepository.save()
saleRepository.findById()
inventoryRepository.getAvailableStock()
```

It must not contain:

```text
db.select(...)
db.insert(...)
DrizzleTable
PostgreSQL-specific SQL
SQLite-specific SQL
```

### Core Principle

**Business logic decides what SherERP should do. Repositories decide how data is stored and retrieved. Drizzle handles database access. PostgreSQL and SQLite are replaceable storage implementations.**

The architecture must remain simple enough for a solo, AI-assisted development workflow and must not introduce abstractions that do not solve a real SherERP requirement.

**D-15: Backup Encryption Password**
SherERP backups will be encrypted using a customer-controlled backup password. Optional server-managed recovery will be available but **OFF by default** and enabled only with customer consent. If both the backup password and recovery option are unavailable, the backup is permanently unrecoverable.

**D-16: bKash/Nagad Payment Verification**
SherERP will support bKash and Nagad personal-account payments without requiring a merchant account. The customer submits the Transaction ID, and the admin manually verifies the payment. If official API support becomes available later, automatic verification can be added while keeping manual verification as a fallback.

**D-17: Inventory by Location**
Inventory quantity, lots, cost, and valuation must be tracked by **Product + Location**. V1 may show only one location in the UI, but the database and business logic must support multiple locations from the beginning.

**D-18: Serial Number Uniqueness**
The same active serial number cannot be used for the same product within the same tenant. If the old item is retired, the serial number may be reused later with a warning.

**D-19: Negative Stock Cost**
Negative stock sales are allowed. When the cost is unknown, use the product’s last known cost as a **provisional cost**. When the actual purchase cost becomes available, automatically recalculate the affected COGS and profit.

**D-20: Future Tauri Offline Architecture**
Future Tauri offline support will use a local NestJS/Node process so the existing application and service logic can be reused. Business logic must not be rewritten in Rust. This is not required for V1, which will use browser-based IndexedDB for temporary offline support.

## Final Decisions

| ID       | Decision                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------- |
| **D-01** | V1: one selected device can write offline; others are read-only                                      |
| **D-02** | One Customer = one unique phone number                                                               |
| **D-03** | Posted invoices are reversed/voided; history remains                                                 |
| **D-04** | One Party with multiple roles                                                                        |
| **D-05** | Physical stock and accounting valuation are separate                                                 |
| **D-06** | Profit remains provisional until costing is finalized                                                |
| **D-07** | First login: phone OTP; daily login: PIN/password/Google; sensitive actions: stronger authentication |
| **D-08** | Restore all compatible data; unavailable features remain read-only                                   |
| **D-09** | Minimal V1 VAT/tax system                                                                            |
| **D-10** | Manual UOM conversion, such as Carton/Piece/Feet/Kg                                                  |
| **D-11** | Credit limit exceeded = warning only; do not block sales                                             |
| **D-12** | English UI + Bangla helper; bilingual invoices; multilingual-ready                                   |
| **D-13** | Separate online attachment storage with plan-based limits                                            |
| **D-14** | Drizzle + Repository pattern; PostgreSQL online, SQLite offline                                      |
| **D-15** | Password-encrypted backup; optional server recovery, OFF by default                                  |
| **D-16** | bKash/Nagad personal account + Transaction ID + manual verification                                  |
| **D-17** | Costing and inventory tracked by Product + Location                                                  |
| **D-18** | Active serial number must be unique per Product and Tenant                                           |
| **D-19** | Negative stock uses last known cost, then recalculates when actual cost is known                     |
| **D-20** | Future Tauri uses a local Node/NestJS process; no Rust business-logic rewrite                        |

## Architecture Rules

| Rule                       | Decision                                      |
| -------------------------- | --------------------------------------------- |
| **Business Logic**         | Shared Domain/Core only                       |
| **Database Access**        | Business-specific Repository                  |
| **ORM**                    | Drizzle                                       |
| **Online DB**              | PostgreSQL                                    |
| **Offline DB**             | SQLite                                        |
| **Server Authority**       | NestJS                                        |
| **Offline Business Logic** | Same shared Domain/Core                       |
| **Duplicate Logic**        | Never duplicate online/offline business rules |
| **Domain Dependencies**    | No NestJS, Drizzle, PostgreSQL, or SQLite     |

## Important: Read Before Coding

1. Business rules must live only in the shared Domain/Core layer.
2. Domain/Core must never import NestJS, Drizzle, Prisma, PostgreSQL, or SQLite.
3. Database access must happen through business-specific repository interfaces.
4. Drizzle implements those repositories.
5. PostgreSQL is the online database.
6. SQLite is the offline database.
7. NestJS is the final server authority for authentication, authorization, validation, and transactions.
8. Never duplicate business rules between online and offline implementations.
