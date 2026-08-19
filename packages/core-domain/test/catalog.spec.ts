import { describe, expect, it } from 'vitest';

import {
  catalogNameKey,
  isValidCatalogName,
  isValidConversionFactor,
  normalizeCatalogName,
} from '../src/index';

/**
 * Phase 2, path 2.1. Pure rules, exact expected values.
 *
 * These two functions decide whether two names are the same name. Get it wrong
 * and a shop ends up with `Pran` and `Pran ` as separate brands, each holding
 * half its products, with nothing on any screen to show why.
 */
describe('catalog names', () => {
  it('collapses internal whitespace and trims the ends', () => {
    expect(normalizeCatalogName('  Coca   Cola  ')).toBe('Coca Cola');
    expect(normalizeCatalogName('Pran')).toBe('Pran');
    expect(normalizeCatalogName('Pran\t\nJuice')).toBe('Pran Juice');
  });

  it('compares case-insensitively, after normalising', () => {
    expect(catalogNameKey('Coca Cola')).toBe('coca cola');
    expect(catalogNameKey('  COCA   COLA ')).toBe(catalogNameKey('coca cola'));
    expect(catalogNameKey('Pran')).not.toBe(catalogNameKey('Prann'));
  });

  it('accepts a one-character unit and refuses an empty or over-long name', () => {
    // "L" is a real unit; a 120-character brand is not, and the column is sized
    // for the limit rather than the limit for the column.
    expect(isValidCatalogName('L')).toBe(true);
    expect(isValidCatalogName('   ')).toBe(false);
    expect(isValidCatalogName('')).toBe(false);
    expect(isValidCatalogName('x'.repeat(120))).toBe(true);
    expect(isValidCatalogName('x'.repeat(121))).toBe(false);
  });
});

/**
 * D-10 conversion factors. A zero or negative factor would make a purchase in
 * cartons add no stock at all, or remove it — which is why this is a rule and
 * not a form hint.
 */
describe('unit conversion factors', () => {
  it('accepts any positive scaled quantity and refuses zero, negative or fractional raws', () => {
    // 1 Carton = 24 Pieces, at Qty scale 3.
    expect(isValidConversionFactor(24_000)).toBe(true);
    // 1 Pipe = 20 Feet.
    expect(isValidConversionFactor(20_000)).toBe(true);
    // Half a kilogram bag: fractional in units, still an integer raw.
    expect(isValidConversionFactor(500)).toBe(true);

    expect(isValidConversionFactor(0)).toBe(false);
    expect(isValidConversionFactor(-24_000)).toBe(false);
    expect(isValidConversionFactor(24_000.5)).toBe(false);
    expect(isValidConversionFactor(Number.NaN)).toBe(false);
  });
});
