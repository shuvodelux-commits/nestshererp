import type { PurchaseResponse } from '@sher/core-contracts';

import type { PurchaseDetail } from './purchase-repository';

/**
 * One posted bill as a screen sees it (UI-40, R-E8).
 *
 * Cost is **omitted** rather than blanked for a caller without
 * `inventory.cost.view`: a hidden column is a column somebody can still read
 * off the wire, and §5.5 already decided this shape for products. What such a
 * caller gets is a real bill — supplier, date, what arrived and how much of it —
 * with every money figure absent.
 */
export function toPurchaseResponse(
  detail: PurchaseDetail,
  showCost: boolean,
  warnings: readonly string[] = [],
): PurchaseResponse {
  const base = {
    id: detail.id,
    number: detail.number,
    supplierPartyId: detail.supplierPartyId,
    supplierName: detail.supplierName,
    supplierBillRef: detail.supplierBillRef,
    businessDate: detail.businessDate,
    dueDate: detail.dueDate,
    status: detail.status,
    notes: detail.notes,
    warnings: [...warnings],
    version: detail.version,
    createdAt: detail.createdAt.toISOString(),
  };

  const lines = detail.lines.map((line) => ({
    id: line.id,
    productId: line.productId,
    productName: line.productName,
    unitName: line.unitName,
    qty: line.qty,
    expiryDate: line.expiryDate,
    lotId: line.lotId,
    ...(showCost
      ? {
          unitPriceMinor: line.unitPriceMinor,
          lineTotalMinor: line.lineTotalMinor,
          discountShareMinor: line.discountShareMinor,
          extraCostShareMinor: line.extraCostShareMinor,
          actualUnitCost: line.actualUnitCost,
        }
      : {}),
  }));

  if (!showCost) return { ...base, lines };

  return {
    ...base,
    lines,
    itemsTotalMinor: detail.itemsTotalMinor,
    discountMinor: detail.discountMinor,
    extraCostMinor: detail.extraCostMinor,
    landedCosts: detail.landedCosts.map((cost) => ({
      ...cost,
      addedLater: false,
      allocations: cost.allocations.map((allocation) => ({ ...allocation })),
    })),
    grandTotalMinor: detail.grandTotalMinor,
    paidMinor: detail.paidMinor,
    dueMinor: detail.dueMinor,
    paidAccountCode: detail.paidAccountCode,
    paidAccountName: detail.paidAccountName,
    payments: detail.payments.map((payment) => ({
      id: payment.id,
      number: payment.number,
      businessDate: payment.businessDate,
      accountName: payment.accountName,
      amountMinor: payment.amountMinor,
    })),
  };
}
