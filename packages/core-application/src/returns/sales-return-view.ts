import type { ReturnReason, SalesReturnResponse } from '@sher/core-contracts';

import type { SalesReturnRow } from './sales-return-repository';

/**
 * A stored return → what the API hands back.
 *
 * One mapper, used by the create path and the list alike, so a return reads the
 * same in the confirmation as it does in the history a week later.
 */
export function toSalesReturnResponse(row: SalesReturnRow): SalesReturnResponse {
  return {
    id: row.id,
    number: row.number,
    saleId: row.saleId,
    saleNumber: row.saleNumber,
    partyId: row.partyId,
    customerName: row.customerName,
    businessDate: row.businessDate,
    reason: row.reason as ReturnReason,
    note: row.note,
    returnValueMinor: row.returnValueMinor,
    refundMinor: row.refundMinor,
    creditMinor: row.creditMinor,
    refundAccountCode: row.refundAccountCode,
    refundAccountName: row.refundAccountName,
    approvedByName: row.approvedByName,
    lines: row.lines.map((line) => ({
      id: line.id,
      saleLineId: line.saleLineId,
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      qty: line.qty,
      valueMinor: line.valueMinor,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}
