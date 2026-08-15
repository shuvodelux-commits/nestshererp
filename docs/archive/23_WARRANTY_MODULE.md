# M23 — Warranty Module

## 1. Purpose

The Warranty module manages simple warranty claims for products sold by SherERP.

There are two main ways a warranty case can happen:

1. Customer brings the product directly to the shop.
2. Customer sends the product to the shop by courier.

The module records the claim, warranty decision, supplier/manufacturer handling, replacement or repair, and final result.

The module should remain simple and should not become a separate service-management system.

---

## 2. Warranty Claim

A warranty claim should record the basic information needed to track the case:

- Claim ID
- Customer/Party
- Product
- Serial number, when applicable
- Invoice/reference
- Warranty card information
- Warranty start/end date
- Claim method: Direct Shop or Courier
- Customer complaint/problem
- Received date
- Current status
- Notes
- Final result

---

## 3. Direct Shop Warranty

When a customer brings a product directly to the shop:

1. Find the product/customer/transaction.
2. Check the warranty card and warranty date.
3. Check the reported problem.
4. Decide whether the problem can be claimed under warranty.

### If warranty is accepted

The shop may replace the product from its own stock when appropriate.

The replacement must be recorded against the warranty claim.

If the supplier/manufacturer is still responsible for providing a replacement, repair, or adjustment, the claim remains linked to the supplier pending record.

### If warranty is not possible

Record that the warranty cannot be claimed and the reason.

The customer is informed that the warranty is not applicable.

The claim history remains stored.

---

## 4. Courier Warranty

When a customer sends a product by courier:

1. Create/locate the warranty claim.
2. Record the courier and receive the product.
3. Check the product, serial number, warranty card, and warranty date.
4. Send the product to the supplier/manufacturer for warranty handling.
5. Track the supplier/manufacturer response.
6. If warranty is accepted:
   - Receive a repaired or replacement product.
   - Record the result.
   - Send the repaired/replacement product to the customer.
7. If warranty is not accepted:
   - Receive the customer's original product back.
   - Send the original product back to the customer.
8. Close the warranty claim after the customer-side result is completed.

---

## 5. Supplier Warranty Tracking

SherERP may have many warranty products sent to the same supplier/manufacturer.

The system must therefore support grouping multiple warranty claims/products into a **Supplier Warranty Send**.

A Supplier Warranty Send should record:

- Supplier/Manufacturer
- Send date
- Reference/challan number
- Products
- Serial numbers where applicable
- Quantities
- Related warranty claims
- Notes
- Current status

Example:

```text
Supplier: ABC Electronics
Warranty Send: WB-001
Products Sent: 17

Returned/Resolved:
- 8 replacement products
- 3 repaired products
- 2 warranty rejected/original products returned
- 4 pending
```

This allows the business to quickly see what is still pending with each supplier.

---

## 6. Customer Replacement From Our Stock

Sometimes the customer needs a replacement before the supplier/manufacturer provides a replacement.

In that case, SherERP must allow the business to record:

```text
Customer gives defective product
        ↓
Warranty accepted
        ↓
Replacement not yet received from supplier
        ↓
Replacement given from our stock
        ↓
Supplier still owes replacement/repair/adjustment
```

The warranty claim must show that:

- The customer already received a replacement.
- The replacement came from our stock.
- The supplier/manufacturer responsibility is still pending.

This is important because the customer-side warranty case may be completed while the supplier-side recovery is still pending.

---

## 7. Supplier Response / Settlement

After receiving a warranty product, the supplier/manufacturer may provide one of the following:

### A. Replacement Product

The supplier provides a replacement product.

Record the supplier replacement against the related warranty claim or supplier warranty send.

### B. Repaired Product

The supplier repairs the product and returns it.

Record the repaired product against the related warranty claim or supplier warranty send.

### C. Cash / Account Adjustment

The supplier does not provide a physical replacement but provides a cash or supplier-account adjustment.

The adjustment must be linked to the warranty claim or supplier warranty send.

Financial posting must use the existing Party/Supplier Ledger business logic. Warranty must not create a separate accounting system.

### D. Warranty Rejected

The supplier rejects the warranty.

The supplier may return the original product.

Record:

- Rejection
- Reason
- Returned original product
- Date received
- Customer return

---

## 8. Supplier Pending Responsibility

The system should clearly show what the business is still waiting to receive from suppliers.

For example:

| Warranty | Customer Result | Supplier Result | Status |
|---|---|---|---|
| W-001 | Replacement from our stock | Replacement received | Closed |
| W-002 | Replacement from our stock | Cash/account adjustment | Closed |
| W-003 | Product sent to supplier | Waiting | Pending |
| W-004 | Product sent to supplier | Rejected/original returned | Closed |

The main purpose is to prevent warranty products or supplier obligations from being forgotten.

---

## 9. Warranty Status

Keep the status system simple.

Suggested statuses:

- Received
- Checking Warranty
- Sent to Supplier
- Waiting for Supplier
- Supplier Approved
- Supplier Rejected
- Repaired
- Replacement Received
- Customer Replacement Given
- Returned to Customer
- Completed

The exact final status names may be adjusted during implementation if needed, but the workflow must remain simple.

---

## 10. Warranty History

Each warranty claim should keep a simple history of important events, such as:

```text
Claim Created
      ↓
Product Received
      ↓
Warranty Checked
      ↓
Sent to Supplier
      ↓
Supplier Response
      ↓
Replacement / Repair / Adjustment / Rejection
      ↓
Customer Product Returned or Replacement Given
      ↓
Completed
```

The history should make it clear where the product is and what has already happened.

---

## 11. Inventory Integration

Warranty must use the existing Inventory business logic.

Warranty must not create separate stock calculations.

Examples:

### Customer replacement from our stock

```text
Warranty
    ↓
Approved replacement
    ↓
Inventory business operation
    ↓
Stock updated
```

### Supplier replacement received

```text
Supplier warranty response
    ↓
Replacement received
    ↓
Inventory business operation
    ↓
Stock updated
```

### Repaired/original product received

The appropriate inventory movement must be recorded through the existing Inventory business rules.

All costing, valuation, stock, serial-number, and ledger rules remain controlled by the shared Domain/Application logic.

---

## 12. Supplier / Party Ledger Integration

If a supplier provides a cash or account adjustment for a warranty case, the Warranty module should create or request the appropriate operation through the existing Supplier/Party Ledger business logic.

Warranty must not implement separate balance or accounting calculations.

The relationship should be:

```text
Warranty Settlement
        ↓
Payment / Supplier Ledger Business Logic
        ↓
Repository
        ↓
Database
```

---

## 13. Serial Number

Warranty claims should be linked to the product serial number when the product is serial-numbered.

The existing SherERP serial-number rule remains applicable:

**The same active serial number cannot be used for the same product within the same tenant.**

Warranty must preserve the serial-number and transaction history.

---

## 14. Architecture

The Warranty module follows the final SherERP architecture.

```text
Warranty Domain/Application
        ↓
Business-specific Repository Interface
        ↓
Drizzle PostgreSQL Repository
        ↓
PostgreSQL
```

Business rules must remain in the shared Domain/Application layer.

Drizzle calls must not be placed directly inside business logic.

Database-specific code must remain inside infrastructure/repositories.

Repository interfaces must be designed so that a future Drizzle + SQLite implementation can be added without changing the Warranty business logic.

The module should use only the business-specific repositories that are actually required. Do not introduce unnecessary `GenericRepository`, `BaseRepository`, or `RepositoryFactory` abstractions.

---

## 15. Scope

The Warranty module should provide:

- Simple warranty claim registration
- Direct-shop warranty handling
- Courier warranty handling
- Warranty card/date checking
- Supplier/manufacturer tracking
- Grouping many warranty products sent to a supplier
- Supplier pending tracking
- Customer replacement from our stock
- Supplier replacement tracking
- Supplier repair tracking
- Supplier cash/account adjustment tracking
- Warranty rejection tracking
- Customer return tracking
- Serial-number linkage
- Simple warranty history

The module should not duplicate Sales, Inventory, Party, Supplier Ledger, Product, or Accounting business logic.
