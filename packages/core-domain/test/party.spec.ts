import { describe, expect, it } from 'vitest';

import {
  customerPhoneKey,
  isPhoneShaped,
  normalizePartyName,
  normalizePhone,
  rejectParty,
} from '../src/parties/party';
import type { PartyDraft } from '../src/parties/party';

/**
 * Party rules (§5.6, D-02). Pure domain — no database, no HTTP (R-E4).
 *
 * The rule worth the most here is D-02's: a customer must have a phone number
 * and a supplier need not. Getting it the other way round would either block a
 * shop from saving the supplier whose number nobody has, or let a customer be
 * created that no cashier can ever find at the counter.
 */
function draft(overrides: Partial<PartyDraft> = {}): PartyDraft {
  return {
    name: 'Karim Uddin',
    roles: ['CUSTOMER'],
    phone: '01712345678',
    creditLimitMinor: null,
    ...overrides,
  };
}

describe('what a party must have', () => {
  it('accepts a customer with a name and a phone number', () => {
    expect(rejectParty(draft())).toBeNull();
  });

  it('refuses a customer with no phone number (D-02)', () => {
    expect(rejectParty(draft({ phone: null }))).toBe('CUSTOMER_PHONE_REQUIRED');
    expect(rejectParty(draft({ phone: '   ' }))).toBe('CUSTOMER_PHONE_REQUIRED');
  });

  it('accepts a supplier with no phone number', () => {
    expect(rejectParty(draft({ roles: ['SUPPLIER'], phone: null }))).toBeNull();
  });

  it('refuses a record with no name and one with no role', () => {
    expect(rejectParty(draft({ name: '  ' }))).toBe('NAME_REQUIRED');
    expect(rejectParty(draft({ roles: [] }))).toBe('ROLE_REQUIRED');
  });

  it('refuses something that is not a phone number', () => {
    expect(rejectParty(draft({ phone: 'call the shop' }))).toBe('PHONE_NOT_A_PHONE_NUMBER');
  });

  it('takes a credit limit of exactly zero, and refuses a negative one', () => {
    // Zero is a real answer: this customer takes nothing on credit. It is not
    // the same as no limit at all, which is `null`.
    expect(rejectParty(draft({ creditLimitMinor: 0 }))).toBeNull();
    expect(rejectParty(draft({ creditLimitMinor: 50_000 }))).toBeNull();
    expect(rejectParty(draft({ creditLimitMinor: -1 }))).toBe('CREDIT_LIMIT_NEGATIVE');
  });

  it('refuses a credit limit on a party that is not a customer', () => {
    expect(rejectParty(draft({ roles: ['SUPPLIER'], creditLimitMinor: 50_000 }))).toBe(
      'CREDIT_LIMIT_WITHOUT_CUSTOMER_ROLE',
    );
  });
});

describe('phone numbers', () => {
  it('treats a number spaced differently as the same number', () => {
    expect(normalizePhone('01712 345 678')).toBe('01712345678');
    expect(customerPhoneKey(' 01712 345678 ')).toBe('01712345678');
  });

  it('does not fold a country code into the local form', () => {
    // Deliberate, and reported to the owner rather than decided here: nothing in
    // v4 says +8801712345678 and 01712345678 are the same number, so they are
    // stored and compared as written (R-A5).
    expect(customerPhoneKey('+8801712345678')).not.toBe(customerPhoneKey('01712345678'));
  });

  it('accepts a landline and a number written with separators', () => {
    expect(isPhoneShaped('02-9611234')).toBe(true);
    expect(isPhoneShaped('+8801712345678')).toBe(true);
    expect(isPhoneShaped('abc')).toBe(false);
    expect(isPhoneShaped('12')).toBe(false);
  });
});

describe('names', () => {
  it('collapses the spacing so one person is not two records', () => {
    expect(normalizePartyName('  Karim   Uddin ')).toBe('Karim Uddin');
  });
});
