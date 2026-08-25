/**
 * Finding a product the way a shopkeeper looks for one (§5.5, §5.7).
 *
 * A counter does not type queries; it types fragments, in whatever order they
 * come to mind — `aci salt`, `salt aci`, `sam a15`, `মরিচ ২০০`. So matching is
 * **all tokens, anywhere, in any order**, across everything that identifies a
 * product: its name, brand, category, code, barcode and unit.
 *
 * Pure and browser-safe on purpose. The server filters with it and the counter
 * ranks with it, and a second implementation on either side would mean the list
 * that appears while typing is ordered differently from the list that arrives —
 * which reads as the screen changing its mind.
 *
 * **No search engine.** Elasticsearch, Algolia and their kind solve a problem a
 * shop with four thousand products does not have; the cost of running one is
 * paid every day by whoever keeps it alive.
 */

/** Bangla numerals as a shopkeeper types them, and their Western twins. */
const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';

/**
 * One product, reduced to the text it can be found by.
 *
 * Built once when the product is written, not on every keystroke: normalising
 * six fields for four thousand products on each character typed is work nobody
 * sees and everybody pays for.
 */
export interface ProductSearchFields {
  readonly name: string;
  readonly brandName?: string | null | undefined;
  readonly categoryName?: string | null | undefined;
  readonly sku?: string | null | undefined;
  readonly barcode?: string | null | undefined;
  readonly unitName?: string | null | undefined;
  /** Other names the shop calls it — free text, one per line (§5.5). */
  readonly aliases?: string | null | undefined;
}

/**
 * Everything typed, reduced to one comparable form.
 *
 * - Unicode is normalised (NFC), so a Bangla word composed two different ways
 *   is one word — the same characters typed on two keyboards must match.
 * - Bangla digits become Western, so `১২w` finds `12W`. Digits are the one
 *   place the two scripts mean exactly the same thing.
 * - Case is folded and every separator — space, dash, slash, comma, quote —
 *   becomes a single space, because a shopkeeper types `4"` and the catalogue
 *   says `4 inch`, and neither should have to win.
 */
export function normalizeSearchText(input: string): string {
  const folded = input.normalize('NFC').toLowerCase();

  let out = '';
  for (const character of folded) {
    const bengaliDigit = BENGALI_DIGITS.indexOf(character);
    if (bengaliDigit !== -1) {
      out += String(bengaliDigit);
      continue;
    }
    // Zero-width joiners carry no meaning to a search and break equality.
    if (character === '‌' || character === '‍') continue;
    out += isSearchable(character) ? character : ' ';
  }

  return out.replace(/\s+/g, ' ').trim();
}

/** Letters and digits in any script, which is what a product name is made of. */
function isSearchable(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (character >= '0' && character <= '9') return true;
  if (character >= 'a' && character <= 'z') return true;
  // Bengali block, plus every other letter a shop might legitimately use.
  if (code >= 0x0980 && code <= 0x09ff) return true;
  return code > 0x00ff && !/\p{P}|\p{S}|\p{Z}/u.test(character);
}

/** The precomputed line a product is searched against. */
export function buildProductSearchText(fields: ProductSearchFields): string {
  return normalizeSearchText(
    [
      fields.name,
      fields.brandName,
      fields.categoryName,
      fields.sku,
      fields.barcode,
      fields.unitName,
      fields.aliases,
    ]
      .filter((part): part is string => part !== null && part !== undefined && part !== '')
      .join(' '),
  );
}

/** What the shopkeeper typed, as the pieces that must all be found. */
export function searchTokens(query: string): readonly string[] {
  const normalized = normalizeSearchText(query);
  return normalized === '' ? [] : normalized.split(' ');
}

/**
 * How well a product answers what was typed — higher is better, `null` is not a
 * match at all.
 *
 * The order is the order a counter expects, and each step is a different kind
 * of certainty:
 *
 *   1. the **barcode** exactly — the scanner spoke, and it is never wrong;
 *   2. the **code** exactly — someone read it off a shelf label;
 *   3. the **name** exactly — they know precisely what they want;
 *   4. the name **starts with** what was typed — they are part-way through it;
 *   5. a **word** starts with each fragment — `sam a15` finding `Samsung A15`;
 *   6. the fragments appear **anywhere** — the fallback that catches the rest.
 *
 * Stock breaks ties, never rank: something on the shelf is more likely to be
 * what was meant than something that is not, but a ঝুঁকি of promoting the wrong
 * product over the right one is not worth a shortcut.
 */
export interface ProductSearchDoc {
  readonly searchText: string;
  readonly name: string;
  readonly sku?: string | null | undefined;
  readonly barcode?: string | null | undefined;
  /** Scale-3 quantity; only its sign matters here. */
  readonly qtyOnHand?: number | undefined;
}

const RANK_BARCODE_EXACT = 1000;
const RANK_SKU_EXACT = 900;
const RANK_NAME_EXACT = 800;
const RANK_NAME_PREFIX = 700;
const RANK_WORD_PREFIX = 600;
const RANK_ANYWHERE = 500;
const BONUS_IN_STOCK = 10;

export function rankProduct(tokens: readonly string[], doc: ProductSearchDoc): number | null {
  if (tokens.length === 0) return BONUS_IN_STOCK;

  const query = tokens.join(' ');
  const haystack = doc.searchText;
  const words = haystack === '' ? [] : haystack.split(' ');

  // Every fragment has to be somewhere, or this is not a match at all.
  if (!tokens.every((token) => haystack.includes(token))) return null;

  const bonus = (doc.qtyOnHand ?? 0) > 0 ? BONUS_IN_STOCK : 0;
  const barcode = normalizeSearchText(doc.barcode ?? '');
  const sku = normalizeSearchText(doc.sku ?? '');
  const name = normalizeSearchText(doc.name);

  if (barcode !== '' && barcode === query) return RANK_BARCODE_EXACT + bonus;
  if (sku !== '' && sku === query) return RANK_SKU_EXACT + bonus;
  if (name === query) return RANK_NAME_EXACT + bonus;
  if (name.startsWith(query)) return RANK_NAME_PREFIX + bonus;

  const everyTokenStartsAWord = tokens.every((token) =>
    words.some((word) => word.startsWith(token)),
  );
  if (everyTokenStartsAWord) return RANK_WORD_PREFIX + bonus;

  return RANK_ANYWHERE + bonus;
}

/**
 * The matches, best first.
 *
 * Ties keep the order they arrived in — the caller has already sorted by name,
 * price or whatever the screen asked for, and a search should not scramble that
 * for rows it considers equally good.
 */
export function searchProducts<T extends ProductSearchDoc>(
  query: string,
  items: readonly T[],
): readonly T[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return items;

  return items
    .map((item, index) => ({ item, index, rank: rankProduct(tokens, item) }))
    .filter((scored): scored is { item: T; index: number; rank: number } => scored.rank !== null)
    .sort((left, right) => right.rank - left.rank || left.index - right.index)
    .map((scored) => scored.item);
}
