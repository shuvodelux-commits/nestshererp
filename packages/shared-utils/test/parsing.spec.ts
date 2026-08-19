import { describe, expect, it } from 'vitest';

import {
  addSeconds,
  businessDateAt,
  endOfBusinessDay,
  parseInstant,
  parseMoney,
  parseQty,
  startOfBusinessDay,
} from '../src/index';

/**
 * What someone types, turned into integer minor units (Phase 2).
 *
 * Every money input in the application goes through `parseMoney`. A bug here is
 * a bug in every price a shopkeeper will ever enter, so the values are exact and
 * the refusals are as important as the acceptances: more decimals than the scale
 * is refused, never silently rounded away.
 */
describe('parseMoney', () => {
  it('reads an amount as exact poisha', () => {
    expect(parseMoney('150')).toBe(15_000);
    expect(parseMoney('150.75')).toBe(15_075);
    expect(parseMoney('0.05')).toBe(5);
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('0')).toBe(0);
    expect(parseMoney('-12.34')).toBe(-1234);
    // A pasted figure with separators is a number someone meant.
    expect(parseMoney('1,250.75')).toBe(125_075);
    expect(parseMoney('  99.90  ')).toBe(9990);
  });

  it('refuses a third decimal place rather than dropping it', () => {
    // 150.756 is not an amount of poisha. Rounding it here would lose a fraction
    // nobody was told about; refusing sends the person back to the field.
    expect(parseMoney('150.756')).toBe(null);
  });

  it('refuses anything that is not a number', () => {
    expect(parseMoney('')).toBe(null);
    expect(parseMoney('   ')).toBe(null);
    expect(parseMoney('abc')).toBe(null);
    expect(parseMoney('12.3.4')).toBe(null);
    expect(parseMoney('1e3')).toBe(null);
    expect(parseMoney('৳150')).toBe(null);
    expect(parseMoney('-')).toBe(null);
  });
});

describe('parseQty', () => {
  it('reads a quantity at three decimals', () => {
    expect(parseQty('2')).toBe(2000);
    expect(parseQty('2.5')).toBe(2500);
    expect(parseQty('0.125')).toBe(125);
    expect(parseQty('24')).toBe(24_000);
  });

  it('refuses a fourth decimal place', () => {
    expect(parseQty('2.5001')).toBe(null);
  });
});

/**
 * The two directions of §3.5. A day boundary read wrong moves a day's takings
 * into the wrong report, "and both numbers look plausible".
 */
describe('tenant-local days', () => {
  const DHAKA = 'Asia/Dhaka';

  /** `new Date()` is banned outside `clock.ts`, tests included (R-C8). */
  function instant(iso: string): Date {
    const parsed = parseInstant(iso);
    if (parsed === null) throw new Error(`bad instant: ${iso}`);
    return parsed;
  }

  it('reads an instant as the day the shop would call it', () => {
    // 18:30 UTC is already the next day in Dhaka (UTC+6).
    expect(businessDateAt(startOfBusinessDay('2026-08-16', DHAKA), DHAKA)).toBe('2026-08-16');
    expect(businessDateAt(instant('2026-08-15T18:30:00Z'), DHAKA)).toBe('2026-08-16');
    expect(businessDateAt(instant('2026-08-15T17:59:59Z'), DHAKA)).toBe('2026-08-15');
  });

  it('ends a day at its last millisecond, local', () => {
    const end = endOfBusinessDay('2026-08-16', DHAKA);

    // Dhaka is UTC+6, so the 16th ends at 17:59:59.999Z on the 16th.
    expect(end.toISOString()).toBe('2026-08-16T17:59:59.999Z');
    // Still the 16th locally, and one millisecond later is the 17th.
    expect(businessDateAt(end, DHAKA)).toBe('2026-08-16');
    expect(businessDateAt(addSeconds(end, 0.001), DHAKA)).toBe('2026-08-17');
    expect(end.getTime()).toBe(startOfBusinessDay('2026-08-17', DHAKA).getTime() - 1);
  });
});
