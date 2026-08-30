// The shared primitives every other package depends on (SRS 3.3, 3.5).
// This package depends on nothing.
export { Money, MONEY_SCALE, parseMoney } from './money';
export { parseQty, Qty, QTY_SCALE } from './qty';
// The integer arithmetic `core-domain` needs for unit conversion (D-10). Exported
// rather than reimplemented: D-31's rounding rule lives in scaled.ts and nowhere
// else, and a second half-up implementation is exactly how two of them drift.
export {
  allocateLargestRemainder,
  divideRoundHalfUp,
  formatScaled,
  formatForDisplay,
  multiplyScaled,
  parseScaled,
} from './scaled';
export { UnitCost, UNIT_COST_SCALE } from './unit-cost';
export { Ulid } from './ulid';
export {
  addSeconds,
  businessDateAt,
  endOfBusinessDay,
  parseInstant,
  startOfBusinessDay,
  SystemClock,
  FixedClock,
  addDays,
  daysInMonth,
  weekdayOf,
  monthOf,
  monthRange,
} from './clock';
export type { Clock } from './clock';
export { amountInWords, toBengaliDigits } from './amount-in-words';
export type { AmountWordsLanguage } from './amount-in-words';
