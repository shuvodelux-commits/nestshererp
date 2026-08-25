/**
 * An amount written out in words, in Bangla or English (§5.8, UI-47).
 *
 * A Bangladeshi invoice says the total twice — in figures and in words — because
 * a figure can be altered with a pen and a sentence cannot. Both languages count
 * in the **South Asian** system: lakh and crore, not million and billion, which
 * is what a shopkeeper and a customer here read without translating.
 *
 * Input is poisha (minor units), like every other money figure in this codebase.
 * Digits stay Western (UI-47); only the words change language.
 */

const EN_ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
] as const;

const EN_TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
] as const;

/**
 * Bangla has a distinct word for every number to ninety-nine — there is no
 * "twenty-three" built from two words — so the only correct way to write them
 * is to list them. Anything cleverer produces text no one here would say.
 */
const BN_BELOW_HUNDRED = [
  '', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়',
  'দশ', 'এগারো', 'বারো', 'তেরো', 'চৌদ্দ', 'পনেরো', 'ষোলো', 'সতেরো', 'আঠারো', 'উনিশ',
  'বিশ', 'একুশ', 'বাইশ', 'তেইশ', 'চব্বিশ', 'পঁচিশ', 'ছাব্বিশ', 'সাতাশ', 'আটাশ', 'ঊনত্রিশ',
  'ত্রিশ', 'একত্রিশ', 'বত্রিশ', 'তেত্রিশ', 'চৌত্রিশ', 'পঁয়ত্রিশ', 'ছত্রিশ', 'সাঁইত্রিশ', 'আটত্রিশ', 'ঊনচল্লিশ',
  'চল্লিশ', 'একচল্লিশ', 'বিয়াল্লিশ', 'তেতাল্লিশ', 'চুয়াল্লিশ', 'পঁয়তাল্লিশ', 'ছেচল্লিশ', 'সাতচল্লিশ', 'আটচল্লিশ', 'ঊনপঞ্চাশ',
  'পঞ্চাশ', 'একান্ন', 'বায়ান্ন', 'তিপ্পান্ন', 'চুয়ান্ন', 'পঞ্চান্ন', 'ছাপ্পান্ন', 'সাতান্ন', 'আটান্ন', 'ঊনষাট',
  'ষাট', 'একষট্টি', 'বাষট্টি', 'তেষট্টি', 'চৌষট্টি', 'পঁয়ষট্টি', 'ছেষট্টি', 'সাতষট্টি', 'আটষট্টি', 'ঊনসত্তর',
  'সত্তর', 'একাত্তর', 'বাহাত্তর', 'তিহাত্তর', 'চুয়াত্তর', 'পঁচাত্তর', 'ছিয়াত্তর', 'সাতাত্তর', 'আটাত্তর', 'ঊনআশি',
  'আশি', 'একাশি', 'বিরাশি', 'তিরাশি', 'চুরাশি', 'পঁচাশি', 'ছিয়াশি', 'সাতাশি', 'আটাশি', 'ঊননব্বই',
  'নব্বই', 'একানব্বই', 'বিরানব্বই', 'তিরানব্বই', 'চুরানব্বই', 'পঁচানব্বই', 'ছিয়ানব্বই', 'সাতানব্বই', 'আটানব্বই', 'নিরানব্বই',
] as const;

export type AmountWordsLanguage = 'EN' | 'BN';

/**
 * `৳1,45,555.00` → `One lakh forty five thousand five hundred fifty five taka only`
 * or `এক লক্ষ পঁয়তাল্লিশ হাজার পাঁচশত পঞ্চান্ন টাকা মাত্র`.
 *
 * Poisha are written only when there are any: a shop's bills are almost always
 * whole taka, and "and zero poisha" on every invoice is noise.
 */
export function amountInWords(minor: number, language: AmountWordsLanguage): string {
  if (!Number.isFinite(minor)) return '';
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const taka = Math.floor(absolute / 100);
  const poisha = absolute % 100;

  if (language === 'BN') {
    const takaWords = taka === 0 ? 'শূন্য' : bengaliWords(taka);
    const body =
      poisha === 0
        ? `${takaWords} টাকা মাত্র`
        : `${takaWords} টাকা ${bengaliWords(poisha)} পয়সা মাত্র`;
    return negative ? `ঋণাত্মক ${body}` : body;
  }

  const takaWords = taka === 0 ? 'zero' : englishWords(taka);
  const body =
    poisha === 0
      ? `${takaWords} taka only`
      : `${takaWords} taka and ${englishWords(poisha)} poisha only`;
  const sentence = negative ? `minus ${body}` : body;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Splits a number the South Asian way: crore · lakh · thousand · hundred · rest. */
function southAsianParts(value: number): {
  crore: number; lakh: number; thousand: number; hundred: number; rest: number;
} {
  return {
    crore: Math.floor(value / 10_000_000),
    lakh: Math.floor(value / 100_000) % 100,
    thousand: Math.floor(value / 1_000) % 100,
    hundred: Math.floor(value / 100) % 10,
    rest: value % 100,
  };
}

function englishWords(value: number): string {
  const { crore, lakh, thousand, hundred, rest } = southAsianParts(value);
  const parts: string[] = [];
  // A crore may itself run past a hundred (১২০ কোটি), so it recurses rather
  // than assuming two digits the way the middle groups safely can.
  if (crore > 0) parts.push(`${englishWords(crore)} crore`);
  if (lakh > 0) parts.push(`${englishBelowHundred(lakh)} lakh`);
  if (thousand > 0) parts.push(`${englishBelowHundred(thousand)} thousand`);
  if (hundred > 0) parts.push(`${EN_ONES[hundred] ?? ''} hundred`);
  if (rest > 0) parts.push(englishBelowHundred(rest));
  return parts.join(' ');
}

function englishBelowHundred(value: number): string {
  if (value < 20) return EN_ONES[value] ?? '';
  const tens = EN_TENS[Math.floor(value / 10)] ?? '';
  const ones = EN_ONES[value % 10] ?? '';
  return ones === '' ? tens : `${tens} ${ones}`;
}

function bengaliWords(value: number): string {
  const { crore, lakh, thousand, hundred, rest } = southAsianParts(value);
  const parts: string[] = [];
  if (crore > 0) parts.push(`${bengaliWords(crore)} কোটি`);
  if (lakh > 0) parts.push(`${BN_BELOW_HUNDRED[lakh] ?? ''} লক্ষ`);
  if (thousand > 0) parts.push(`${BN_BELOW_HUNDRED[thousand] ?? ''} হাজার`);
  // Bangla joins the hundred to its digit — পাঁচশত, not পাঁচ শত.
  if (hundred > 0) parts.push(`${BN_BELOW_HUNDRED[hundred] ?? ''}শত`);
  if (rest > 0) parts.push(BN_BELOW_HUNDRED[rest] ?? '');
  return parts.join(' ');
}

/**
 * Western digits rewritten as Bangla numerals, for print only.
 *
 * UI-47 keeps the **application** in Western digits — that is what the phone
 * keypad, the calculator and bKash all show, and a cashier reading a screen
 * should never have to transliterate. A printed invoice is the other way round:
 * a Bangla চালান handed across the counter reads ২,৮৮০, and this shop's
 * customers read that faster than 2,880. So the conversion lives here, is
 * applied only by the Bangla invoice template, and never touches the UI.
 */
const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'] as const;

export function toBengaliDigits(text: string): string {
  return text.replace(/[0-9]/g, (digit) => BENGALI_DIGITS[Number(digit)] ?? digit);
}
