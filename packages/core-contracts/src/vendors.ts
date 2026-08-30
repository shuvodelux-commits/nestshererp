import { z } from 'zod';

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Stock the shop holds but does not own (Phase 8, §5.6 M07, DR13.10, owner
 * decision 2026-08-26).
 *
 * **Receiving it posts no money.** A vendor leaving fifty shirts has not sold
 * the shop anything: the lot carries `owner_type = 'VENDOR'`, is excluded from
 * valuation and COGS, and nobody is owed a taka. When one sells, the sale
 * converts that lot to owned at the agreed vendor cost inside the same
 * transaction — the deemed purchase of DR13.10 — and *that* is what creates the
 * vendor payable.
 *
 * **Returning it posts no money either**, for the same reason: the shop never
 * bought it, so there is nothing to unpay.
 *
 * The vendor is paid through the ordinary Pay Supplier flow against their
 * party ledger. There is no second payment engine here.
 */

export const receiveVendorStockRequestSchema = z
  .object({
    vendorPartyId: ULID,
    productId: ULID,
    qty: z.number().int().positive(),
    /** What the vendor is owed per unit when one sells, in poisha. */
    vendorUnitCostMinor: z.number().int().nonnegative(),
    note: z.string().trim().max(300).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type ReceiveVendorStockRequest = z.infer<typeof receiveVendorStockRequestSchema>;

export const returnVendorStockRequestSchema = z
  .object({
    receiptId: ULID,
    qty: z.number().int().positive(),
    note: z.string().trim().max(300).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type ReturnVendorStockRequest = z.infer<typeof returnVendorStockRequestSchema>;

export const vendorStockReceiptResponseSchema = z
  .object({
    id: ULID,
    receiptNumber: z.string(),
    vendorPartyId: ULID,
    vendorName: z.string(),
    productId: ULID,
    displayName: z.string(),
    unitName: z.string(),
    businessDate: BUSINESS_DATE,
    note: z.string().nullable(),
    /** The four quantities the settlement summary is built from. */
    receivedQty: z.number().int(),
    soldQty: z.number().int(),
    returnedQty: z.number().int(),
    onHandQty: z.number().int(),
    vendorUnitCostMinor: z.number().int().optional(),
    /** What selling this receipt's goods has made the shop owe. */
    dueMinor: z.number().int().optional(),
    version: z.number().int(),
  })
  .strict();
export type VendorStockReceiptResponse = z.infer<typeof vendorStockReceiptResponseSchema>;

/**
 * `Received 50 · Sold 30 · Returned 20 · Due · Paid · Balance` — the line the
 * owner asked for on the vendor's hub.
 *
 * `paidMinor` and `balanceMinor` come from the vendor's ledger, not from these
 * receipts: money is the ledger's business, and a second tally of it here would
 * eventually disagree with the accounts.
 */
export const vendorSettlementResponseSchema = z
  .object({
    vendorPartyId: ULID,
    vendorName: z.string(),
    receivedQty: z.number().int(),
    soldQty: z.number().int(),
    returnedQty: z.number().int(),
    onHandQty: z.number().int(),
    dueMinor: z.number().int(),
    paidMinor: z.number().int(),
    balanceMinor: z.number().int(),
    receipts: z.array(vendorStockReceiptResponseSchema),
  })
  .strict();
export type VendorSettlementResponse = z.infer<typeof vendorSettlementResponseSchema>;
