import { ageingBucket } from '@sher/core-domain';
import type { SaleListItem, SaleResponse } from '@sher/core-contracts';

import type { SaleDetail, SaleRow } from './sale-repository';

/**
 * One posted invoice as a screen sees it (UI-40, R-E8).
 *
 * **Selling prices and totals are not cost data.** A cashier must read the whole
 * invoice to hand it over, so everything the customer can see on paper is here
 * for everyone. What is omitted without `inventory.cost.view` is what the goods
 * *cost* — the line cost, the COGS total and the profit — omitted rather than
 * blanked, because a hidden field is one somebody can still read off the wire.
 */
export function toSaleResponse(
  detail: SaleDetail,
  showCost: boolean,
  warnings: readonly string[] = [],
  asOf?: string,
): SaleResponse {
  const lines = detail.lines.map((line) => ({
    id: line.id,
    productId: line.productId,
    productName: line.productName,
    displayName: line.displayName,
    unitName: line.unitName,
    qty: line.qty,
    unitPriceMinor: line.unitPriceMinor,
    lineDiscountMinor: line.lineDiscountMinor,
    lineTotalMinor: line.lineTotalMinor,
    discountShareMinor: line.discountShareMinor,
    netAmountMinor: line.netAmountMinor,
    source: line.source,
    vendorPartyId: line.vendorPartyId,
    vendorName: line.vendorName,
    isProvisionalCost: line.isProvisionalCost,
    tracksSerial: line.tracksSerial,
    allocations: line.allocations.map((allocation) => ({
      id: allocation.id,
      sourceType: allocation.sourceType,
      qty: allocation.qty,
      vendorPartyId: allocation.vendorPartyId,
      serialUnitIds:
        allocation.inventoryUnitId === null ? [] : [allocation.inventoryUnitId],
      ownedLotId: allocation.ownedLotId,
      vendorStockReceiptId: allocation.vendorStockReceiptId,
      vendorLotId: allocation.vendorLotId,
      inventoryUnitId: allocation.inventoryUnitId,
      serialNo: allocation.serialNo,
      unitCostUsed: allocation.unitCostUsed,
    })),
    ...(showCost ? { costMinor: line.costMinor } : {}),
  }));

  const base = {
    id: detail.id,
    number: detail.number,
    partyId: detail.partyId,
    isWalkIn: detail.isWalkIn,
    customerName: detail.customerName,
    customerPhone: detail.customerPhone,
    customerGuardianName: detail.customerGuardianName,
    customerAddress: detail.customerAddress,
    businessDate: detail.businessDate,
    dueDate: detail.dueDate,
    status: detail.status,
    notes: detail.notes,
    lines,
    payments: detail.payments.map((payment) => ({
      id: payment.id,
      accountCode: payment.accountCode,
      accountName: payment.accountName,
      accountType: payment.accountType,
      amountMinor: payment.amountMinor,
    })),
    itemsTotalMinor: detail.itemsTotalMinor,
    discountMinor: detail.discountMinor,
    grandTotalMinor: detail.grandTotalMinor,
    paidMinor: detail.paidMinor,
    dueMinor: detail.dueMinor,
    // Change was handed back at the counter and never posted; an advance is
    // money the shop is holding. Both are the same subtraction, so the sale
    // reports what it kept and the difference is already out of `paidMinor`.
    changeMinor: 0,
    advanceMinor: Math.max(detail.paidMinor - detail.grandTotalMinor, 0),
    ageing: ageingBucket(asOf ?? detail.businessDate, detail.businessDate, detail.dueDate),
    version: detail.version,
    presentation:
      detail.presentation === null
        ? null
        : {
            ...detail.presentation,
            lineNames: [...detail.presentation.lineNames],
          },
    receipts: detail.receipts.map((receipt) => ({
      id: receipt.id,
      number: receipt.number,
      businessDate: receipt.businessDate,
      accountName: receipt.accountName,
      amountMinor: receipt.amountMinor,
    })),
    warnings: [...warnings],
    /*
     * Phase 12.4 (§18). Carried through unchanged, and read by nothing that
     * decides anything: the invoice screen draws a quiet "Made offline" tag
     * from it, and the sales list filters on it. A synced offline invoice is an
     * ordinary posted invoice in every other respect.
     */
    originMode: detail.originMode,
    originDeviceName: detail.originDeviceName,
    originDeviceCode: detail.originDeviceCode,
    deviceCreatedAt: detail.deviceCreatedAt?.toISOString() ?? null,
  };

  if (!showCost) return base;

  return {
    ...base,
    cogsMinor: detail.cogsMinor,
    profitMinor: detail.grandTotalMinor - detail.cogsMinor,
  };
}

export function toSaleListItem(row: SaleRow, asOf: string): SaleListItem {
  return {
    originMode: row.originMode,
    id: row.id,
    number: row.number,
    partyId: row.partyId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    businessDate: row.businessDate,
    dueDate: row.dueDate,
    status: row.status,
    grandTotalMinor: row.grandTotalMinor,
    paidMinor: row.paidMinor,
    dueMinor: row.dueMinor,
    ageing: ageingBucket(asOf, row.businessDate, row.dueDate),
  };
}
