import { FixedClock } from '@sher/shared-utils';
import { describe, expect, it } from 'vitest';

import { isValidPassword, isValidPin } from '../src/auth/credentials';
import { classifyIdentifier, normalizeIdentifier } from '../src/auth/identifier';
import { OTP_MAX_ATTEMPTS, rejectionFor } from '../src/auth/otp';

describe('classifyIdentifier (§5.3 identifier rules)', () => {
  it('classifies emails', () => {
    expect(classifyIdentifier('karim@shop.com.bd')).toBe('EMAIL');
    expect(classifyIdentifier('a.b+tag@sub.example.com')).toBe('EMAIL');
  });

  it('classifies Bangladeshi mobile numbers', () => {
    expect(classifyIdentifier('01712345678')).toBe('PHONE');
    expect(classifyIdentifier('01912345678')).toBe('PHONE');
  });

  it('rejects anything that is neither', () => {
    expect(classifyIdentifier('01212345678')).toBeNull(); // operator digit 2
    expect(classifyIdentifier('0171234567')).toBeNull(); // 10 digits
    expect(classifyIdentifier('017123456789')).toBeNull(); // 12 digits
    expect(classifyIdentifier('karim')).toBeNull();
    expect(classifyIdentifier('karim@shop')).toBeNull(); // no dot in the domain
    expect(classifyIdentifier('')).toBeNull();
  });
});

describe('normalizeIdentifier', () => {
  it('lowercases email so one address cannot become two accounts', () => {
    expect(normalizeIdentifier('  Karim@Shop.COM ', 'EMAIL')).toBe('karim@shop.com');
  });

  it('leaves a phone number alone apart from trimming', () => {
    expect(normalizeIdentifier(' 01712345678 ', 'PHONE')).toBe('01712345678');
  });
});

describe('isValidPassword / isValidPin', () => {
  it('requires 8+ characters with a letter and a digit', () => {
    expect(isValidPassword('Passw0rd')).toBe(true);
    expect(isValidPassword('Pass0rd')).toBe(false); // 7 chars
    expect(isValidPassword('passwordonly')).toBe(false); // no digit
    expect(isValidPassword('12345678')).toBe(false); // no letter
  });

  it('requires exactly 4 digits for a PIN', () => {
    expect(isValidPin('4821')).toBe(true);
    expect(isValidPin('482')).toBe(false);
    expect(isValidPin('48211')).toBe(false);
    expect(isValidPin('48a1')).toBe(false);
  });
});

describe('rejectionFor (D-07 OTP rules)', () => {
  const createdAt = new FixedClock('2026-08-16T10:00:00Z').now();
  const fresh = { attemptCount: 0, createdAt, consumedAt: null };

  it('accepts a fresh code inside the 5-minute window', () => {
    const at4m59s = new FixedClock('2026-08-16T10:04:59Z').now();
    expect(rejectionFor(fresh, at4m59s)).toBeNull();
  });

  it('expires it at exactly 5 minutes', () => {
    const at5m = new FixedClock('2026-08-16T10:05:00Z').now();
    expect(rejectionFor(fresh, at5m)).toBe('EXPIRED');
  });

  it('rejects an already-consumed code', () => {
    const consumed = { ...fresh, consumedAt: createdAt };
    expect(rejectionFor(consumed, createdAt)).toBe('CONSUMED');
  });

  it('kills the code after 5 failed attempts', () => {
    const at4 = { ...fresh, attemptCount: OTP_MAX_ATTEMPTS - 1 };
    const at5 = { ...fresh, attemptCount: OTP_MAX_ATTEMPTS };
    expect(rejectionFor(at4, createdAt)).toBeNull();
    expect(rejectionFor(at5, createdAt)).toBe('MAX_ATTEMPTS');
  });
});
