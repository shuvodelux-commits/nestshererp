/**
 * The single signup/login field accepts a mobile number OR an email, and is
 * classified by format (§5.3 "Identifier rules"). Which channel the OTP goes to
 * follows from this classification: email identifier ⇒ email OTP, phone ⇒ SMS.
 */
export type IdentifierChannel = 'EMAIL' | 'PHONE';

/**
 * Bangladeshi mobile: 11 digits, `01`, then an operator digit 3–9.
 * The SRS does not specify a phone format; this is the standard BD mobile
 * pattern and is stated as an assumption in the slice report.
 */
const BD_MOBILE = /^01[3-9]\d{8}$/;

/**
 * Deliberately permissive: one `@`, no spaces, a dot in the domain. Rejecting a
 * deliverable address is worse than accepting an undeliverable one, because the
 * OTP round-trip is what actually proves the address works.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function classifyIdentifier(value: string): IdentifierChannel | null {
  if (EMAIL.test(value)) return 'EMAIL';
  if (BD_MOBILE.test(value)) return 'PHONE';
  return null;
}

/**
 * Emails are compared case-insensitively so `Karim@shop.com` and
 * `karim@shop.com` cannot register as two accounts. Phone numbers are digits
 * already and are left alone.
 */
export function normalizeIdentifier(value: string, channel: IdentifierChannel): string {
  return channel === 'EMAIL' ? value.trim().toLowerCase() : value.trim();
}
