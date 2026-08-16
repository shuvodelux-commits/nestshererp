/**
 * Password and PIN rules for signup (§5.3).
 *
 * The SRS sets no complexity rule, so these are the minimum that keeps a
 * shopkeeper's account from being guessable in an afternoon. They are stated as
 * an assumption in the slice report and can be tightened here alone.
 *
 * PIN is a convenience credential for a returning session on a known device —
 * it never substitutes for a password on a new device and never satisfies
 * step-up, which is why 4 digits is acceptable for it and not for a password.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PIN_LENGTH = 4;

const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /\d/;
const ONLY_DIGITS = /^\d+$/;

export function isValidPassword(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH && HAS_LETTER.test(password) && HAS_DIGIT.test(password)
  );
}

export function isValidPin(pin: string): boolean {
  return pin.length === PIN_LENGTH && ONLY_DIGITS.test(pin);
}
