/**
 * A tiny seeded generator for property tests.
 *
 * Deterministic on purpose: a property test that fails only on some runs cannot
 * be investigated, and these files decide every number in the system. Same seed,
 * same sequence, on every machine — and no test dependency to install.
 */
export function randomInts(seed: number, bound: number, count: number): number[] {
  let state = seed >>> 0;
  const values: number[] = [];

  for (let index = 0; index < count; index += 1) {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    const unsigned = ((next ^ (next >>> 14)) >>> 0) / 4294967296;
    values.push(Math.floor(unsigned * bound));
  }

  return values;
}
