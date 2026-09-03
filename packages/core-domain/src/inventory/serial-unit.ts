/**
 * One physical unit, identified by the number printed on it (§5.19, D-18).
 *
 * Pure: no clock, no I/O.
 *
 * **SherERP never invents a serial.** Every value here was read or scanned off
 * the goods, which is why there is no generator in this file and never should
 * be: a number the shop made up cannot be matched against the one the
 * manufacturer will ask for when a claim is sent back.
 *
 * **A unit is not stock.** Quantity, valuation and costing live in lots and
 * movements; this only says which individual item is which, so nothing here
 * touches INV-01…INV-05.
 */

/**
 * Where a unit is, as far as the shop is concerned.
 *
 * `RETURNED_TO_VENDOR` is a consignment unit handed back to the vendor it came
 * from (§5.6 M07, migration 0051): the receipt and lot provenance stay on the
 * row, but the goods are no longer in the shop. It was added to the database
 * and to the contracts and missed here, which is the kind of drift that lets a
 * status the server writes be a status the domain says cannot exist.
 *
 * `WARRANTY_REPLACEMENT` is a unit handed to a customer to settle a claim
 * (§5.19). It is deliberately **not** `SOLD`: there is no sale, no invoice and
 * no revenue — the posting is `DR WARRANTY_EXPENSE / CR INVENTORY`, and §5.19
 * is explicit that no warranty receivable is ever created — so calling it sold
 * would both misstate the ledger and break `inventory_units_sold_has_sale`,
 * which insists a sold unit names the sale that took it and the day it went.
 */
export type SerialUnitStatus =
  | 'IN_STOCK'
  | 'SOLD'
  | 'WITH_SUPPLIER'
  | 'WRITTEN_OFF'
  | 'RETURNED_TO_VENDOR'
  | 'WARRANTY_REPLACEMENT';

/**
 * The statuses that hold a serial number against reuse (D-18: *active*
 * serials). A sold, written-off, returned-to-vendor or warranty-replacement
 * unit releases its number, because in every one of those cases the item has
 * left the shop — and a manufacturer reusing a number years later is not the
 * shop making a mistake.
 */
export const ACTIVE_SERIAL_STATUSES: readonly SerialUnitStatus[] = [
  'IN_STOCK',
  'WITH_SUPPLIER',
] as const;

export type SerialRejection =
  | 'SERIAL_BLANK'
  | 'SERIAL_TOO_LONG'
  | 'SERIAL_DUPLICATED_IN_ENTRY'
  | 'SERIAL_COUNT_EXCEEDS_QTY';

/** Long enough for any manufacturer, short enough to be a serial and not a note. */
const MAX_SERIAL_LENGTH = 64;

/**
 * One serial as it will be stored and compared.
 *
 * Trimmed and upper-cased, because a scanner and a keyboard produce the same
 * number in different cases and a shop that cannot find `ab123` after typing
 * `AB123` will conclude the feature is broken. Inner spaces are collapsed for
 * the same reason.
 */
export function normalizeSerial(raw: string): string {
  return raw.trim().replace(/\s+/gu, ' ').toUpperCase();
}

export function rejectSerial(raw: string): SerialRejection | null {
  const serial = normalizeSerial(raw);
  if (serial === '') return 'SERIAL_BLANK';
  return serial.length > MAX_SERIAL_LENGTH ? 'SERIAL_TOO_LONG' : null;
}

export interface SerialBatch {
  readonly serials: readonly string[];
  /** How many of this product the line received, scale-3. */
  readonly qty: number;
  /** How many serials this line already has recorded. */
  readonly alreadyRecorded: number;
}

/**
 * A batch of scanned serials, checked as a batch.
 *
 * Two rules §5.19 states outright: the accepted count may never exceed the
 * serialised quantity received, and the same number may not be entered twice.
 * Both are checked here rather than one row at a time, because "you have
 * scanned that one already" is only answerable while the whole batch is in
 * view.
 *
 * Quantities are scale-3 but a serialised product is counted in whole units —
 * half a phone has no serial — so the comparison is against whole units.
 */
export function rejectSerialBatch(batch: SerialBatch): SerialRejection | null {
  const seen = new Set<string>();
  for (const raw of batch.serials) {
    const rejection = rejectSerial(raw);
    if (rejection !== null) return rejection;

    const serial = normalizeSerial(raw);
    if (seen.has(serial)) return 'SERIAL_DUPLICATED_IN_ENTRY';
    seen.add(serial);
  }

  const capacity = wholeUnitsOf(batch.qty) - batch.alreadyRecorded;
  return seen.size > capacity ? 'SERIAL_COUNT_EXCEEDS_QTY' : null;
}

/** Whole units in a scale-3 quantity, rounded down. */
export function wholeUnitsOf(qty: number): number {
  return Math.floor(qty / 1000);
}

/**
 * How many serials a line is still waiting for.
 *
 * This is what lets a bill be saved tonight and finished in the morning (owner
 * decision 2026-08-26): the number is a fact the purchase screen can state,
 * and the units it stands for are the ones that may not be sold yet.
 */
export function serialsOutstanding(qty: number, recorded: number): number {
  return Math.max(wholeUnitsOf(qty) - recorded, 0);
}
