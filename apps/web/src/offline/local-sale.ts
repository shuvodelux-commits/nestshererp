import { localProducts } from '@sher/adapter-sqlite-wasm';
import type { CreateSaleRequest, SaleResponse } from '@sher/core-contracts';
import { saleTotals } from '@sher/core-domain';
import { SystemClock } from '@sher/shared-utils';

/** Time comes from the Clock port, here as everywhere else (B-clock). */
const clock = new SystemClock();

/**
 * The invoice the counter prints while the line is down (§4, §5, Phase 12.4).
 *
 * **Every figure a customer is shown is real.** The line totals, the bill
 * discount spread, the grand total, what was paid, the change and the due all
 * come from `saleTotals` — the same domain function the posting service runs on
 * the server — so the slip is not provisional and does not need reprinting when
 * the line comes back. The server arrives at the same number because it runs
 * the same code, and if it ever does not, that is a Sync Issue for a person and
 * never a quiet correction to what the customer was charged.
 *
 * **Every figure only the books can know is absent.** No cost, no COGS, no
 * profit, no lot: `cogsMinor` and `profitMinor` are left off exactly as they
 * are for a cashier without `inventory.cost.view`, so the invoice screen
 * already knows how to draw an invoice without them and nothing had to learn a
 * new state. What the screen adds is one quiet line — *Profit available after
 * sync* — because a shopkeeper who sees no profit figure deserves to be told
 * why rather than left wondering.
 */
export async function localSaleResponse(
  payload: CreateSaleRequest,
  saleNumber: string,
  operationId: string,
  businessDate: string,
  deviceCode: string,
): Promise<SaleResponse> {
  const totals = saleTotals({
    lines: payload.lines.map((line) => ({
      productId: line.productId,
      qty: line.qty,
      unitPriceMinor: line.unitPriceMinor,
      lineDiscountMinor: line.lineDiscountMinor,
    })),
    discountMinor: payload.discountMinor,
    paidMinor: payload.payments.reduce((sum, payment) => sum + payment.amountMinor, 0),
  });

  const names = await productNames(payload.lines.map((line) => line.productId));

  return {
    /*
     * The operation id doubles as the document's local identity. That is not a
     * shortcut: it is what lets a later operation refer to this one before the
     * server has given it a real id, and what lets replay rewrite that
     * reference afterwards (see `remapLocalReferences`).
     */
    id: operationId,
    number: saleNumber,
    partyId: payload.partyId ?? operationId,
    isWalkIn: payload.partyId === null,
    customerName: payload.customerName ?? 'Walk-in customer',
    customerPhone: payload.customerPhone,
    customerGuardianName: payload.customerGuardianName,
    customerAddress: payload.customerAddress,
    businessDate,
    dueDate: payload.dueDate,
    status: 'POSTED',
    notes: payload.notes,
    lines: totals.lines.map((line, index) => {
      const source = payload.lines[index];
      return {
        id: `${operationId}${String(index).padStart(2, '0')}`.slice(0, 26),
        productId: line.productId,
        productName: names.get(line.productId) ?? 'Item',
        displayName: null,
        unitName: '',
        qty: line.qty,
        unitPriceMinor: line.unitPriceMinor,
        lineDiscountMinor: line.lineDiscountMinor,
        lineTotalMinor: line.lineTotalMinor,
        discountShareMinor: line.discountShareMinor,
        netAmountMinor: line.netAmountMinor,
        source: source?.source ?? 'OWN_STOCK',
        vendorPartyId: source?.vendorPartyId ?? null,
        vendorName: null,
        // True in the most literal sense: the shop's own books have not costed
        // this line yet, and will when it reaches them.
        isProvisionalCost: true,
        tracksSerial: false,
        allocations: [],
      };
    }),
    payments: payload.payments.map((payment, index) => ({
      id: `${operationId}P${String(index).padStart(2, '0')}`.slice(0, 26),
      accountCode: payment.accountCode,
      accountName: payment.accountCode,
      accountType: 'CASH',
      amountMinor: payment.amountMinor,
    })),
    itemsTotalMinor: totals.itemsTotalMinor,
    discountMinor: totals.discountMinor,
    grandTotalMinor: totals.grandTotalMinor,
    paidMinor: totals.paidMinor,
    dueMinor: totals.dueMinor,
    changeMinor: payload.overpaymentHandling === 'CHANGE' ? totals.changeMinor : 0,
    advanceMinor: payload.overpaymentHandling === 'ADVANCE' ? totals.changeMinor : 0,
    ageing: 'NOT_DUE',
    version: 1,
    presentation: null,
    receipts: [],
    warnings: [
      'Made on this computer while the internet was down. It goes into the shop’s books when the line is back — the amounts above do not change.',
    ],
    /*
     * The origin trail (§18), filled in here so the slip the counter prints
     * already says what the server will say after replay. The device *name* is
     * the server's own record of this authorisation and is not in the local
     * copy, so it stays null until the sale comes back from a sync.
     */
    originMode: 'OFFLINE',
    originDeviceName: null,
    originDeviceCode: deviceCode,
    deviceCreatedAt: clock.now().toISOString(),
  };
}

async function productNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  try {
    const page = await localProducts({ limit: 200, sort: 'name' });
    for (const product of page.data) {
      if (ids.includes(product.id)) names.set(product.id, product.name);
    }
  } catch {
    // A copy that cannot be read is not a reason to refuse a sale. The line
    // prints as "Item", which is wrong on the slip and right in the ledger,
    // and the ledger is the one that has to be right.
  }
  return names;
}
