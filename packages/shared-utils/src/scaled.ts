/**
 * Integer arithmetic shared by Money, Qty and UnitCost.
 *
 * Everything here operates on integers only — there is no floating point in this
 * file and there must never be one (SRS 3.3). Multiplication and allocation run
 * through BigInt so an intermediate product can never lose precision, and the
 * result is converted back to a safe JavaScript integer exactly once.
 *
 * The rounding rule lives here and nowhere else: half-up, applied ONCE, at the
 * boundary (D-31). Three value types share it because it is one business rule,
 * not three similar-looking ones.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer, got ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds the safe integer range: ${String(value)}`);
  }
}

function toNumber(value: bigint, label: string): number {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new RangeError(`${label} exceeds the safe integer range: ${value.toString()}`);
  }
  return Number(value);
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Divides and rounds half-up, ties away from zero, so that
 * round(-x) === -round(x) and a sign flip can never change a magnitude.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = absBigInt(numerator);
  const absDenominator = absBigInt(denominator);
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Multiplies two scaled integers and rescales the exact product once.
 *
 * `left` and `right` are raw scaled integers; `dropScale` is how many decimal
 * places the product carries in excess of the wanted result. The product is
 * computed exactly in BigInt first — nothing is rounded on the way in.
 */
export function multiplyScaled(
  left: number,
  right: number,
  dropScale: number,
  label: string,
): number {
  const product = BigInt(left) * BigInt(right);
  const divisor = 10n ** BigInt(dropScale);
  return toNumber(divideRoundHalfUp(product, divisor), label);
}

/**
 * Largest remainder method (SRS 3.3, binding).
 *
 * Shares sum EXACTLY to `total` for every input, including total < parts and
 * negative totals. Leftover minor units go to the largest fractional remainders,
 * ties broken by line index ascending, which is what makes the split identical
 * on the server, in the browser and on a future offline device.
 */
export function allocateLargestRemainder(
  total: number,
  weights: readonly number[],
  label: string,
): number[] {
  if (weights.length === 0) throw new RangeError('allocate requires at least one weight');

  weights.forEach((weight, index) => {
    assertSafeInteger(weight, `${label} weight[${String(index)}]`);
    if (weight < 0) throw new RangeError(`${label} weight[${String(index)}] must not be negative`);
  });

  const weightSum = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (weightSum === 0n) throw new RangeError(`${label} weights must not sum to zero`);

  // Allocate the magnitude, then re-apply the sign, so a negative total splits
  // as the mirror image of the positive one instead of drifting by a minor unit.
  const negative = total < 0;
  const absTotal = BigInt(negative ? -total : total);

  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let distributed = 0n;

  for (const weight of weights) {
    const numerator = absTotal * BigInt(weight);
    const share = numerator / weightSum;
    floors.push(share);
    remainders.push(numerator - share * weightSum);
    distributed += share;
  }

  let leftover = absTotal - distributed;
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));

  for (const entry of order) {
    if (leftover === 0n) break;
    floors[entry.index] = (floors[entry.index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return floors.map((share, index) =>
    toNumber(negative ? -share : share, `${label} share[${String(index)}]`),
  );
}

/** Formats a scaled integer as a fixed-decimal, thousands-separated string. */
export function formatScaled(value: number, scale: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = scale === 0 ? grouped : `${grouped}.${fraction}`;

  return negative ? `-${body}` : body;
}

/**
 * A typed decimal string as a scaled integer — `"150.75"` at scale 2 is `15075`.
 *
 * The inverse of `formatScaled`, and the only sanctioned way to turn what someone
 * typed into money or a quantity. Entirely integer string arithmetic: no
 * `parseFloat`, no `Number()` on the decimal part, because both are how a price
 * becomes 15074.999999 (R-C3).
 *
 * Returns `null` rather than throwing or rounding when the text is not a number
 * this scale can hold. **More decimal places than the scale is a refusal, not a
 * rounding**: someone typing three decimals into a money field has misunderstood
 * something, and silently dropping the third digit is how a poisha goes missing
 * without anybody being told.
 *
 * Thousands separators are accepted, because a pasted `1,250.75` is a number a
 * person meant.
 */
export function parseScaled(text: string, scale: number): number | null {
  const cleaned = text.trim().replace(/,/g, '');
  if (cleaned === '') return null;

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (match === null) return null;

  const [, sign = '', whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  if (fraction.length > scale) return null;

  const minor = `${whole === '' ? '0' : whole}${fraction.padEnd(scale, '0')}`;
  const value = Number(minor);
  if (!Number.isSafeInteger(value)) return null;

  return sign === '-' ? -value : value;
}

/**
 * A scaled integer as a person reads it (owner decision 2026-08-26).
 *
 * `formatScaled` writes every decimal place the scale has, because it is the
 * exact inverse of `parseScaled` and a stored figure must round-trip. That is
 * right for storage and wrong for a screen: a shopkeeper reading `12.000 PCs`
 * sees precision that means nothing to them, and the owner asked for whole
 * numbers to look whole.
 *
 * So: at most `maxFractionDigits` places, rounded half-up once (D-31), with
 * trailing zeros and a bare decimal point removed. `12.000` reads `12`,
 * `12.100` reads `12.1`, `12.126` reads `12.13`.
 *
 * **Display only.** Nothing may parse this back — it has thrown information
 * away on purpose.
 */
export function formatForDisplay(value: number, scale: number, maxFractionDigits = 2): string {
  const drop = Math.max(scale - maxFractionDigits, 0);
  const rounded =
    drop === 0 ? value : Number(divideRoundHalfUp(BigInt(value), 10n ** BigInt(drop)));
  const shown = Math.min(scale, maxFractionDigits);

  const text = formatScaled(rounded, shown);
  if (shown === 0) return text;

  // `12.10` → `12.1` → `12.` → `12`. Only ever touches the fraction, so a
  // grouped whole part like `1,200` is never damaged.
  return text.replace(/\.?0+$/u, '');
}
