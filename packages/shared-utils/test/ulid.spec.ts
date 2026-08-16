import { describe, expect, it } from 'vitest';

import { FixedClock } from '../src/clock';
import { Ulid } from '../src/ulid';

describe('Ulid.generate', () => {
  it('produces a valid 26-character ULID', () => {
    const id = Ulid.generate(new FixedClock('2026-08-15T18:30:00Z'));
    expect(id).toHaveLength(26);
    expect(Ulid.isValid(id)).toBe(true);
  });

  it('encodes the timestamp in the first 10 characters', () => {
    const clock = new FixedClock('2026-08-15T18:30:00Z');
    expect(Ulid.generate(clock).slice(0, 10)).toBe(Ulid.generate(clock).slice(0, 10));
  });

  it('is monotonic within the same millisecond', () => {
    const clock = new FixedClock('2026-08-15T18:30:00Z');
    const ids = Array.from({ length: 50 }, () => Ulid.generate(clock));

    expect(new Set(ids).size).toBe(50);
    for (let index = 1; index < ids.length; index += 1) {
      expect((ids[index] ?? '') > (ids[index - 1] ?? '')).toBe(true);
    }
  });

  it('sorts by creation order across milliseconds', () => {
    const earlier = Ulid.generate(new FixedClock('2026-08-15T18:30:00Z'));
    const later = Ulid.generate(new FixedClock('2026-08-15T18:30:01Z'));
    expect(later > earlier).toBe(true);
  });

  it('never goes backwards when the clock does', () => {
    const forward = Ulid.generate(new FixedClock('2026-08-15T18:30:05Z'));
    const backwards = Ulid.generate(new FixedClock('2026-08-15T18:30:00Z'));
    expect(backwards > forward).toBe(true);
  });

  it('rejects a timestamp beyond the 48-bit ULID range', () => {
    expect(() => Ulid.generate(new FixedClock('+012000-01-01T00:00:00Z'))).toThrow(RangeError);
  });
});

describe('Ulid.isValid', () => {
  it('accepts a well-formed ULID', () => {
    expect(Ulid.isValid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(Ulid.isValid('')).toBe(false);
    expect(Ulid.isValid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25 chars
    expect(Ulid.isValid('01ARZ3NDEKTSV4RRFFQ69G5FAVV')).toBe(false); // 27 chars
    expect(Ulid.isValid('81ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false); // timestamp overflow
    expect(Ulid.isValid('01arz3ndektsv4rrffq69g5fav')).toBe(false); // lowercase
    expect(Ulid.isValid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // I is not in Crockford
    expect(Ulid.isValid('01ARZ3NDEKTSV4RRFFQ69G5FAL')).toBe(false); // L is not in Crockford
    expect(Ulid.isValid('01ARZ3NDEKTSV4RRFFQ69G5FAO')).toBe(false); // O is not in Crockford
    expect(Ulid.isValid('01ARZ3NDEKTSV4RRFFQ69G5FAU')).toBe(false); // U is not in Crockford
  });
});
