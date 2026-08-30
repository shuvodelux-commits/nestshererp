/**
 * A faulty item, from the counter to closed (§5.19 M23, owner decisions
 * 2026-08-26).
 *
 * Pure: no clock, no I/O.
 *
 * **Warranty implements no accounting of its own.** §5.19 is binding on that: a
 * replacement given from the shop's own stock is a stock issue with no revenue
 * — `DR WARRANTY_EXPENSE / CR INVENTORY` through the ordinary consume path —
 * and a supplier settlement credits that expense back. Nothing in this file
 * builds a journal entry; it decides what may happen next and when cover ends.
 *
 * **No warranty receivable is ever created.** A claim waiting on a supplier is
 * a status, not an asset: these are frequently never recovered, and a
 * receivable would quietly overstate what the shop is worth.
 *
 * **Six statuses, not eleven** (owner simplification 2026-08-26). What the SRS
 * listed as a separate status per outcome is one `SETTLED` plus a settlement
 * type — the same information, five fewer words for a shopkeeper to learn.
 */

export type ClaimStatus =
  | 'RECEIVED'
  | 'CHECKING'
  | 'SENT_TO_SUPPLIER'
  | 'SETTLED'
  | 'RETURNED_TO_CUSTOMER'
  | 'CLOSED';

/** §5.19's four supplier outcomes, A to D. */
export type ClaimSettlement = 'REPLACED' | 'REPAIRED' | 'ADJUSTED' | 'REJECTED';

export type ClaimHandling = 'SHOP' | 'COURIER';

/**
 * What may follow what.
 *
 * `CHECKING → SETTLED` without going through the supplier is deliberate: a shop
 * that decides on the spot to replace the item from its own stock has settled
 * the customer's side, and forcing it through a supplier step it never took
 * would make the history say something untrue.
 */
const NEXT: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  RECEIVED: ['CHECKING', 'CLOSED'],
  CHECKING: ['SENT_TO_SUPPLIER', 'SETTLED', 'CLOSED'],
  SENT_TO_SUPPLIER: ['SETTLED'],
  SETTLED: ['RETURNED_TO_CUSTOMER', 'CLOSED'],
  RETURNED_TO_CUSTOMER: ['CLOSED'],
  CLOSED: [],
};

export function canMoveClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return NEXT[from].includes(to);
}

export function nextClaimStatuses(from: ClaimStatus): readonly ClaimStatus[] {
  return NEXT[from];
}

/**
 * The settlements that bring something back the shop can put on a shelf.
 *
 * `REPLACED` creates a lot at the replacement's cost and `REPAIRED` returns the
 * original at the cost it already had; both credit `WARRANTY_EXPENSE`.
 * `ADJUSTED` credits it from the supplier's account instead, and `REJECTED`
 * posts nothing at all — the expense stands, which is the honest record of a
 * claim the supplier refused.
 */
export function settlementReturnsGoods(settlement: ClaimSettlement): boolean {
  return settlement === 'REPLACED' || settlement === 'REPAIRED';
}

export function settlementRecoversValue(settlement: ClaimSettlement): boolean {
  return settlement !== 'REJECTED';
}

export type ClaimRejection =
  | 'CLAIM_COMPLAINT_BLANK'
  | 'CLAIM_CUSTOMER_UNKNOWN'
  | 'CLAIM_TRANSITION_NOT_ALLOWED'
  | 'CLAIM_SETTLEMENT_REQUIRED'
  | 'CLAIM_COURIER_NAME_REQUIRED';

export interface ClaimDraft {
  readonly customerName: string;
  readonly complaint: string;
  readonly handling: ClaimHandling;
  readonly courierName: string | null;
}

export function rejectClaim(draft: ClaimDraft): ClaimRejection | null {
  if (draft.customerName.trim() === '') return 'CLAIM_CUSTOMER_UNKNOWN';
  if (draft.complaint.trim() === '') return 'CLAIM_COMPLAINT_BLANK';
  // A courier claim with no courier is a parcel nobody can chase.
  if (draft.handling === 'COURIER' && (draft.courierName ?? '').trim() === '') {
    return 'CLAIM_COURIER_NAME_REQUIRED';
  }
  return null;
}

export function rejectClaimMove(
  from: ClaimStatus,
  to: ClaimStatus,
  settlement: ClaimSettlement | null,
): ClaimRejection | null {
  if (!canMoveClaim(from, to)) return 'CLAIM_TRANSITION_NOT_ALLOWED';
  return to === 'SETTLED' && settlement === null ? 'CLAIM_SETTLEMENT_REQUIRED' : null;
}

/**
 * When cover runs out, counted in whole calendar months from a start date.
 *
 * The customer's clock starts at the sale and the supplier's at the delivery
 * (owner decision 2026-08-26), which is why this takes the start date rather
 * than assuming one: a phone that sat three months in stock reaches the
 * customer with the supplier's window already partly gone, and a shop that
 * cannot see that promises repairs it then pays for itself.
 *
 * A start day that the end month does not have is clamped to that month's last
 * day — 31 January plus one month is 28 February, not 3 March. Dates are
 * handled as calendar text, never as instants, so a timezone can never move a
 * warranty across midnight.
 */
export function warrantyEndDate(startDate: string, months: number | null): string | null {
  if (months === null || months <= 0) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(startDate);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const zeroBased = month - 1 + months;
  const endYear = year + Math.floor(zeroBased / 12);
  const endMonth = (zeroBased % 12) + 1;
  const endDay = Math.min(day, daysInMonth(endYear, endMonth));

  return `${pad(endYear, 4)}-${pad(endMonth, 2)}-${pad(endDay, 2)}`;
}

/** Whether cover is still running on a given business date. */
export function warrantyCoversOn(endDate: string | null, businessDate: string): boolean {
  return endDate !== null && businessDate <= endDate;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
