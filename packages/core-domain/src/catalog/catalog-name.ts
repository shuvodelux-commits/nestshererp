/**
 * The name on a piece of catalog master data — a brand, a category, a unit, a
 * product (§5.5).
 *
 * Two rules, in one place because both are needed everywhere a name is accepted
 * and neither may differ between the single-record form and the CSV import:
 *
 * **Normalising** is what gets stored. A name typed with a trailing space or a
 * double space between words is the same name, and storing both spellings gives
 * a shopkeeper two "Coca Cola" brands that look identical in a dropdown.
 *
 * **Keying** is what duplicate detection compares. `Coca Cola` and `coca cola`
 * are one brand — a case-sensitive uniqueness check would let the second one in
 * and the shop would never know which products went where.
 */
export const CATALOG_NAME_MAX_LENGTH = 120;

/** Collapses internal runs of whitespace and trims the ends. */
export function normalizeCatalogName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * The comparison key for "does this name already exist". Lower-cased, so
 * uniqueness is case-insensitive.
 *
 * `toLowerCase()` without a locale on purpose: the same input must produce the
 * same key on a server in UTC and in a browser in Dhaka (Phase 12), and a
 * locale-aware fold would not guarantee that.
 */
export function catalogNameKey(value: string): string {
  return normalizeCatalogName(value).toLowerCase();
}

export function isValidCatalogName(value: string): boolean {
  const normalized = normalizeCatalogName(value);
  return normalized.length >= 1 && normalized.length <= CATALOG_NAME_MAX_LENGTH;
}
