import { addSeconds, parseInstant } from '@sher/shared-utils';
import { describe, expect, it } from 'vitest';

import { licenseAllowsWrites, licenseStateAt } from '../src/licensing/license-state';

/**
 * D-36's ladder, with the exact boundaries:
 *
 *   ACTIVE → EXPIRING (30 days before) → GRACE (30 days after) → READ_ONLY
 *
 * Pure and deterministic — the instant is passed in, never read. The dates sit
 * exactly on each boundary rather than safely inside a band, because an
 * off-by-one day here decides whether a shop can trade.
 *
 * Instants come from `parseInstant`/`addSeconds` rather than `new Date`: R-C8
 * allows constructing a Date in exactly one file, and a test is not an
 * exception to that.
 */
function instant(iso: string): Date {
  const value = parseInstant(iso);
  if (value === null) throw new Error(`not an instant: ${iso}`);
  return value;
}

const VALID_UNTIL = instant('2026-12-31T00:00:00Z');
const TERM = { validUntil: VALID_UNTIL, issuedAt: instant('2026-01-01T00:00:00Z') };

const DAY_SECONDS = 24 * 60 * 60;

/** `days` before the term ends; a negative value is after it. */
function at(days: number): Date {
  return addSeconds(VALID_UNTIL, -days * DAY_SECONDS);
}

describe('licenseStateAt (D-36)', () => {
  it('is ACTIVE well inside the term', () => {
    expect(licenseStateAt(TERM, at(90))).toBe('ACTIVE');
  });

  it('turns EXPIRING exactly 30 days before the end, not 29', () => {
    expect(licenseStateAt(TERM, at(31))).toBe('ACTIVE');
    expect(licenseStateAt(TERM, at(30))).toBe('EXPIRING');
    expect(licenseStateAt(TERM, at(1))).toBe('EXPIRING');
  });

  it('enters GRACE the moment the term ends', () => {
    expect(licenseStateAt(TERM, VALID_UNTIL)).toBe('GRACE');
    expect(licenseStateAt(TERM, at(-29))).toBe('GRACE');
  });

  it('falls to READ_ONLY exactly 30 days after the end', () => {
    expect(licenseStateAt(TERM, at(-30))).toBe('READ_ONLY');
    expect(licenseStateAt(TERM, at(-31))).toBe('READ_ONLY');
  });

  describe('RESTORED', () => {
    const RENEWED = {
      validUntil: VALID_UNTIL,
      issuedAt: instant('2026-06-01T00:00:00Z'),
      renewedFrom: instant('2026-05-01T00:00:00Z'),
    };

    it('reports a fresh renewal of a lapsed term as RESTORED', () => {
      expect(licenseStateAt(RENEWED, instant('2026-06-10T00:00:00Z'))).toBe('RESTORED');
    });

    it('stops claiming RESTORED once the renewal is no longer news', () => {
      expect(licenseStateAt(RENEWED, instant('2026-08-01T00:00:00Z'))).toBe('ACTIVE');
    });

    it('does not let RESTORED hide that the renewal is itself expiring', () => {
      const shortRenewal = {
        validUntil: instant('2026-06-20T00:00:00Z'),
        issuedAt: instant('2026-06-01T00:00:00Z'),
        renewedFrom: instant('2026-05-01T00:00:00Z'),
      };
      expect(licenseStateAt(shortRenewal, instant('2026-06-05T00:00:00Z'))).toBe('EXPIRING');
    });
  });
});

describe('licenseAllowsWrites (D-36)', () => {
  it('keeps a shop trading through the grace period', () => {
    // The 30 days after expiry exist so a late renewal does not stop business.
    expect(licenseAllowsWrites('GRACE')).toBe(true);
    expect(licenseAllowsWrites('EXPIRING')).toBe(true);
    expect(licenseAllowsWrites('ACTIVE')).toBe(true);
    expect(licenseAllowsWrites('RESTORED')).toBe(true);
  });

  it('stops new writes only once the grace period is over', () => {
    expect(licenseAllowsWrites('READ_ONLY')).toBe(false);
  });
});
