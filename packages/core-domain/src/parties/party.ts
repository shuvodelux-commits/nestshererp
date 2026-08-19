/**
 * Party rules (§5.6, D-02, D-04). Pure: same input, same output, no clock and
 * no I/O.
 *
 * D-04 makes customers, suppliers and vendors **one identity with roles**, not
 * three tables. That is what lets a shop sell to its own supplier and still see
 * one person with one phone number, rather than two records nobody can
 * reconcile later.
 */
import { normalizeCatalogName } from '../catalog/catalog-name';

/**
 * D-04 names five role flags: CUSTOMER, SUPPLIER, VENDOR, EXPENSE, EMPLOYEE.
 *
 * Three are implementable now, because §5.6 defines what a customer, a supplier
 * and a vendor **are**. `EXPENSE` and `EMPLOYEE` arrive with the modules that
 * give them meaning (expenses is Phase 7); the schema's CHECK constraint already
 * admits them so that arrival is a use case, not a migration on a table that by
 * then holds every party in the business.
 */
export type PartyRole = 'CUSTOMER' | 'SUPPLIER' | 'VENDOR';

export const PARTY_ROLES: readonly PartyRole[] = ['CUSTOMER', 'SUPPLIER', 'VENDOR'];

/**
 * §5.6 lists Status among the customer fields. G2.3's rule for products applies
 * here for the same reason: status is independent of any balance. A customer who
 * owes nothing is not thereby inactive, and an inactive customer's due does not
 * disappear.
 */
export type PartyStatus = 'ACTIVE' | 'INACTIVE';

export const PARTY_NAME_MAX_LENGTH = 200;
export const PARTY_PHONE_MAX_LENGTH = 30;

/**
 * Why a party was refused. A reason code, not a message: `core-domain` owns the
 * rule and the application layer owns the wording (R-B1).
 */
export type PartyRejection =
  | 'NAME_REQUIRED'
  | 'ROLE_REQUIRED'
  | 'CUSTOMER_PHONE_REQUIRED'
  | 'PHONE_NOT_A_PHONE_NUMBER'
  | 'CREDIT_LIMIT_NOT_A_WHOLE_MINOR_UNIT'
  | 'CREDIT_LIMIT_NEGATIVE'
  | 'CREDIT_LIMIT_WITHOUT_CUSTOMER_ROLE';

export interface PartyDraft {
  readonly name: string;
  readonly roles: readonly PartyRole[];
  readonly phone: string | null;
  /** Poisha (§3.3, scale 2). `null` is "no limit", which is not the same as 0. */
  readonly creditLimitMinor: number | null;
}

/**
 * **What a phone number is normalised to before it is stored or compared.**
 *
 * Whitespace only. `01712 345678` and `01712345678` are one number by any
 * reading, and storing both spellings gives a shop two customers with two
 * ledgers for one person.
 *
 * Deliberately **nothing else**. `+8801712345678` and `01712345678` are stored
 * and compared as different numbers, because no part of v4 says they are the
 * same and folding them would be a business rule this file invented. It is worth
 * knowing that the consequence runs the other way too: a shopkeeper who types
 * the country code once and omits it the next time gets two customer records.
 * That is reported as a risk for the owner to decide, not decided here (R-A5).
 */
export function normalizePhone(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * The comparison key for D-02's uniqueness rule. The same string as what is
 * stored — uniqueness is exact, for the reason above — with the case fold that
 * costs nothing and protects a number written with a letter in it.
 */
export function customerPhoneKey(phone: string): string {
  return normalizePhone(phone).toLowerCase();
}

export function normalizePartyName(value: string): string {
  // One whitespace rule for every name in the system, not a second one that
  // drifts from it (DRY applies to rules).
  return normalizeCatalogName(value);
}

/**
 * Digits, with an optional leading `+` and internal separators a person might
 * type. Not a Bangladeshi-operator pattern: a supplier in Chattogram may be a
 * landline and an importer may be abroad, and a rejected valid number is a sale
 * that cannot be recorded.
 */
const PHONE_SHAPE = /^\+?[0-9][0-9\-()]*$/;

export function isPhoneShaped(value: string): boolean {
  const phone = normalizePhone(value);
  return phone.length >= 4 && phone.length <= PARTY_PHONE_MAX_LENGTH && PHONE_SHAPE.test(phone);
}

/**
 * Everything that must be true of a party before it is stored, in the order the
 * person filling the form would meet it.
 *
 * The one rule with real teeth is D-02's: **a customer's phone is mandatory**,
 * and a supplier's is not. A supplier is identified by who they are; a customer
 * is identified by a number the shopkeeper will search on at the counter, and
 * §5.6 makes it the key their whole ledger hangs from.
 */
export function rejectParty(draft: PartyDraft): PartyRejection | null {
  if (normalizePartyName(draft.name).length === 0) return 'NAME_REQUIRED';
  if (normalizePartyName(draft.name).length > PARTY_NAME_MAX_LENGTH) return 'NAME_REQUIRED';
  if (draft.roles.length === 0) return 'ROLE_REQUIRED';

  const isCustomer = draft.roles.includes('CUSTOMER');
  if (isCustomer && (draft.phone === null || normalizePhone(draft.phone).length === 0)) {
    return 'CUSTOMER_PHONE_REQUIRED';
  }
  if (draft.phone !== null && draft.phone !== '' && !isPhoneShaped(draft.phone)) {
    return 'PHONE_NOT_A_PHONE_NUMBER';
  }

  if (draft.creditLimitMinor !== null) {
    if (!Number.isSafeInteger(draft.creditLimitMinor)) {
      return 'CREDIT_LIMIT_NOT_A_WHOLE_MINOR_UNIT';
    }
    if (draft.creditLimitMinor < 0) return 'CREDIT_LIMIT_NEGATIVE';
    /*
     * §3.4 puts `credit_limit` on the party, and §5.6 lists it among the
     * **customer** fields. A credit limit on a party that is only a supplier is
     * a number no screen would ever read — and a stored number nothing enforces
     * is worse than an absent one, because someone will eventually trust it.
     */
    if (!isCustomer) return 'CREDIT_LIMIT_WITHOUT_CUSTOMER_ROLE';
  }

  return null;
}
