import { describe, expect, it } from 'vitest';

import { FixedClock, SystemClock } from '../src/clock';

describe('businessDate (SRS 3.5)', () => {
  it('18:30 UTC is already the next day in Dhaka', () => {
    expect(new FixedClock('2026-08-15T18:30:00Z').businessDate('Asia/Dhaka')).toBe('2026-08-16');
  });

  it('one minute before the Dhaka midnight boundary is still the same day', () => {
    // Dhaka is UTC+6, so the day turns over at 18:00 UTC.
    expect(new FixedClock('2026-08-15T17:59:59Z').businessDate('Asia/Dhaka')).toBe('2026-08-15');
    expect(new FixedClock('2026-08-15T18:00:00Z').businessDate('Asia/Dhaka')).toBe('2026-08-16');
  });

  it('the same instant is a different business date in a different timezone', () => {
    const clock = new FixedClock('2026-08-15T18:30:00Z');
    expect(clock.businessDate('UTC')).toBe('2026-08-15');
    expect(clock.businessDate('Asia/Dhaka')).toBe('2026-08-16');
    expect(clock.businessDate('America/New_York')).toBe('2026-08-15');
  });

  it('pads month and day to two digits', () => {
    expect(new FixedClock('2026-01-02T00:00:00Z').businessDate('UTC')).toBe('2026-01-02');
  });

  it('rejects an unknown timezone instead of silently using UTC', () => {
    expect(() => new FixedClock('2026-08-15T18:30:00Z').businessDate('Mars/Olympus')).toThrow(
      RangeError,
    );
  });
});

describe('FixedClock', () => {
  it('returns the instant it was given, as UTC', () => {
    expect(new FixedClock('2026-08-15T18:30:00Z').now().toISOString()).toBe(
      '2026-08-15T18:30:00.000Z',
    );
  });

  it('hands out a copy, so a caller cannot move the clock', () => {
    const clock = new FixedClock('2026-08-15T18:30:00Z');
    clock.now().setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-08-15T18:30:00.000Z');
  });

  it('rejects an invalid instant', () => {
    expect(() => new FixedClock('not-a-date')).toThrow(RangeError);
  });
});

describe('SystemClock', () => {
  it('produces a business date in YYYY-MM-DD form', () => {
    expect(new SystemClock().businessDate('Asia/Dhaka')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('advances', () => {
    const clock = new SystemClock();
    expect(clock.now().getTime()).toBeLessThanOrEqual(clock.now().getTime());
  });
});
