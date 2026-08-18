import { describe, expect, it } from 'vitest';

import { addSeconds, FixedClock, startOfBusinessDay, SystemClock } from '../src/clock';

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

describe('startOfBusinessDay', () => {
  /**
   * §3.5's own example, inverted: "A sale at 00:30 Dhaka is 18:30 UTC the
   * previous day." So the Dhaka day begins at 18:00 UTC the day before.
   */
  it('resolves a Dhaka day to the UTC instant it begins', () => {
    expect(startOfBusinessDay('2026-08-18', 'Asia/Dhaka').toISOString()).toBe(
      '2026-08-17T18:00:00.000Z',
    );
  });

  it('round-trips with businessDate at the first moment of the day', () => {
    const start = startOfBusinessDay('2026-08-18', 'Asia/Dhaka');
    expect(new FixedClock(start.toISOString()).businessDate('Asia/Dhaka')).toBe('2026-08-18');
  });

  it('puts the moment before it in the previous day', () => {
    const start = startOfBusinessDay('2026-08-18', 'Asia/Dhaka');
    const justBefore = addSeconds(start, -1);
    expect(new FixedClock(justBefore.toISOString()).businessDate('Asia/Dhaka')).toBe('2026-08-17');
  });

  it('is the identity for UTC itself', () => {
    expect(startOfBusinessDay('2026-08-18', 'UTC').toISOString()).toBe('2026-08-18T00:00:00.000Z');
  });

  /** A zone that observes daylight saving, on a day inside its summer offset. */
  it('uses the offset actually in force, not a fixed one', () => {
    expect(startOfBusinessDay('2026-07-01', 'Europe/London').toISOString()).toBe(
      '2026-06-30T23:00:00.000Z',
    );
    expect(startOfBusinessDay('2026-01-01', 'Europe/London').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('rejects a string that is not a business date', () => {
    expect(() => startOfBusinessDay('18-08-2026', 'Asia/Dhaka')).toThrow(RangeError);
  });
});
