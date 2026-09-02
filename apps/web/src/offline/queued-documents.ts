/**
 * What the counter shows for work that is queued but not yet in the books
 * (§25, Phase 12.4).
 *
 * **These are not documents.** They are the screen's own view of a command the
 * shop has committed to locally and the server has not seen: the figures the
 * person in front of the till was told, and nothing else. No id the server
 * issued, no journal, no cost, no balance — those exist only once the operation
 * has been replayed.
 *
 * They are shaped like the online responses on purpose, so a form that has just
 * saved can show what it saved without learning a second rendering path. Each
 * one is cast to its response type at the end, and the cast is the honest part
 * of the design rather than a shortcut around it: the fields a shop's books
 * fill in are genuinely absent, and a screen that reads one gets a zero rather
 * than a wrong number. The operation id stands in as the identity, which is
 * also what a later operation refers to it by until replay rewrites it.
 *
 * Nothing here is styled as a failure. Queued work succeeded — it is simply
 * waiting for the line, and §25 is explicit that those are different things.
 */

import { SystemClock } from '@sher/shared-utils';

/** Time comes from the Clock port, here as everywhere else (B-clock). */
const clock = new SystemClock();

/** The one sentence every queued document carries. */
export const QUEUED_NOTICE =
  'Saved on this computer while the internet is down. It goes into the shop’s books when the line is back.';

interface QueuedShape {
  readonly operationId: string;
  readonly businessDate: string;
  readonly amountMinor?: number;
  readonly partyId?: string | null;
  readonly partyName?: string | null;
  readonly number?: string | null;
}

/**
 * The common core every queued document has.
 *
 * `status: 'POSTED'` is deliberate and, read carefully, true of the shop rather
 * than of the ledger: the sale happened, the money changed hands, and the slip
 * is in a customer's pocket. What has not happened is the posting, and the
 * screens say so through the offline notice and the Sync count — not by calling
 * a completed transaction a draft, which would invite somebody to do it again.
 */
function base(shape: QueuedShape): Record<string, unknown> {
  return {
    id: shape.operationId,
    number: shape.number ?? 'Number when this reaches the books',
    businessDate: shape.businessDate,
    entryMode: 'ON_TIME',
    status: 'POSTED',
    version: 1,
    amountMinor: shape.amountMinor ?? 0,
    note: QUEUED_NOTICE,
    createdAt: clock.now().toISOString(),
    voidReason: null,
    correctionReason: null,
    originalBusinessDate: null,
  };
}

export function queuedReceipt<T>(
  payload: { readonly customerPartyId: string; readonly amountMinor: number; readonly accountCode: string },
  operationId: string,
  businessDate: string,
): T {
  return {
    ...base({ operationId, businessDate, amountMinor: payload.amountMinor }),
    partyId: payload.customerPartyId,
    partyName: '',
    accountCode: payload.accountCode,
    accountName: payload.accountCode,
    advanceMinor: 0,
    settledMinor: payload.amountMinor,
    allocations: [],
  } as unknown as T;
}

export function queuedExpense<T>(
  payload: { readonly amountMinor: number; readonly categoryId: string; readonly accountCode: string },
  operationId: string,
  businessDate: string,
): T {
  return {
    ...base({ operationId, businessDate, amountMinor: payload.amountMinor }),
    categoryId: payload.categoryId,
    categoryName: '',
    accountCode: payload.accountCode,
    accountName: payload.accountCode,
    payeePartyId: null,
    payeeName: null,
  } as unknown as T;
}

export function queuedSupplierPayment<T>(
  payload: { readonly supplierPartyId: string; readonly amountMinor: number; readonly accountCode: string },
  operationId: string,
  businessDate: string,
): T {
  return {
    ...base({ operationId, businessDate, amountMinor: payload.amountMinor }),
    partyId: payload.supplierPartyId,
    partyName: '',
    accountCode: payload.accountCode,
    accountName: payload.accountCode,
    advanceMinor: 0,
    settledMinor: payload.amountMinor,
    allocations: [],
  } as unknown as T;
}

export function queuedCashMovement<T>(
  payload: { readonly amountMinor: number },
  operationId: string,
  businessDate: string,
): T {
  return {
    ...base({ operationId, businessDate, amountMinor: payload.amountMinor }),
    fromAccountCode: null,
    toAccountCode: null,
    reference: null,
  } as unknown as T;
}

export function queuedStockAdjustment<T>(
  payload: { readonly productId: string; readonly qtyDelta: number; readonly reason: string },
  operationId: string,
  businessDate: string,
): T {
  return {
    ...base({ operationId, businessDate }),
    productId: payload.productId,
    productName: '',
    qtyDelta: payload.qtyDelta,
    reason: payload.reason,
    // The value of an adjustment is what the goods cost, and cost is the
    // server's to compute (§4). Zero here is not a figure — it is the absence
    // of one, and the screen says the value arrives with the sync.
    valueMinor: 0,
  } as unknown as T;
}

export function queuedCashSession<T>(
  payload: { readonly openingAmountMinor?: number; readonly countedClosingMinor?: number },
  operationId: string,
  businessDate: string,
  closing: boolean,
): T {
  return {
    ...base({ operationId, businessDate }),
    openingAmountMinor: payload.openingAmountMinor ?? 0,
    countedClosingMinor: payload.countedClosingMinor ?? 0,
    /*
     * The cashier's own count is kept exactly as typed (§12). What the drawer
     * *should* have held is computed by the server from its own postings, and
     * where the two differ the difference is surfaced in Sync Issues rather
     * than the count being quietly overwritten.
     */
    expectedClosingMinor: null,
    differenceMinor: null,
    status: closing ? 'CLOSED' : 'OPEN',
    closedAt: closing ? clock.now().toISOString() : null,
  } as unknown as T;
}

export function queuedParty<T>(
  payload: { readonly name: string; readonly phone?: string | null; readonly roles?: readonly string[] },
  operationId: string,
): T {
  return {
    id: operationId,
    name: payload.name,
    phone: payload.phone ?? null,
    roles: payload.roles ?? ['CUSTOMER'],
    status: 'ACTIVE',
    version: 1,
    balance: { netMinor: 0, receivableMinor: 0, payableMinor: 0 },
    creditLimitMinor: null,
    customerGroupId: null,
    createdAt: clock.now().toISOString(),
  } as unknown as T;
}

export function queuedProduct<T>(
  payload: { readonly name: string; readonly sellingPriceMinor?: number; readonly sku?: string | null },
  operationId: string,
): T {
  return {
    id: operationId,
    name: payload.name,
    sku: payload.sku ?? null,
    barcode: null,
    status: 'ACTIVE',
    version: 1,
    // A product created offline has no opening stock and no cost, exactly as a
    // product created online has none: stock enters through a purchase, an
    // opening or an adjustment, and never through the product form (§10, §5.5).
    stockQty: 0,
    sellingPriceMinor: payload.sellingPriceMinor ?? 0,
    createdAt: clock.now().toISOString(),
  } as unknown as T;
}

export function queuedDocument<T>(
  operationId: string,
  businessDate: string,
  amountMinor: number,
): T {
  return base({ operationId, businessDate, amountMinor }) as unknown as T;
}
