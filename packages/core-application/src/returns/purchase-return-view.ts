import type { PurchaseReturnResponse, ReturnReason } from '@sher/core-contracts';

import type { PurchaseReturnRow } from './purchase-return-repository';

/** A stored supplier return → what the API hands back. One mapper, both paths. */
export function toPurchaseReturnResponse(row: PurchaseReturnRow): PurchaseReturnResponse {
  return {
    id: row.id,
    number: row.number,
    purchaseId: row.purchaseId,
    purchaseNumber: row.purchaseNumber,
    supplierPartyId: row.supplierPartyId,
    supplierName: row.supplierName,
    businessDate: row.businessDate,
    reason: row.reason as ReturnReason,
    note: row.note,
    returnValueMinor: row.returnValueMinor,
    receivedMinor: row.receivedMinor,
    creditMinor: row.creditMinor,
    receiptAccountCode: row.receiptAccountCode,
    receiptAccountName: row.receiptAccountName,
    lines: row.lines.map((line) => ({
      id: line.id,
      purchaseLineId: line.purchaseLineId,
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      qty: line.qty,
      valueMinor: line.valueMinor,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}
