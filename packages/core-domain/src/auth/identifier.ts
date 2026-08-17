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

/**
 * The username for an account Google creates (§5.3 Google OAuth, D-07 revised
 * 2026-08-17). That path collects only a business name, so the username has to
 * come from the one other thing known about the person: their address.
 *
 * Username is a display and audit identity, never a login identifier, so this
 * only has to be stable, readable and non-empty. Uniqueness is per tenant and
 * the tenant is brand new with exactly one user, so a collision is impossible
 * here by construction — this deliberately does not try to de-duplicate.
 *
 * Gmail's dots and `+tags` are **kept**, not stripped: `a.b@gmail.com` and
 * `ab@gmail.com` reach the same mailbox at Google but are different strings
 * here, and silently folding them would make one person's username depend on
 * which spelling they happened to type.
 */
const USERNAME_DISALLOWED = /[^a-z0-9._-]/g;
const USERNAME_EDGE_SEPARATORS = /^[._-]+|[._-]+$/g;

/** Used when an address has no usable characters before the `@` at all. */
export const DERIVED_USERNAME_FALLBACK = 'owner';

export function usernameFromEmail(email: string): string {
  const localPart = email.trim().toLowerCase().split('@')[0] ?? '';
  const cleaned = localPart
    .replace(USERNAME_DISALLOWED, '')
    .replace(USERNAME_EDGE_SEPARATORS, '');

  return cleaned === '' ? DERIVED_USERNAME_FALLBACK : cleaned;
}
