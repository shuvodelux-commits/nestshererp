import { formatForDisplay, QTY_SCALE } from '@sher/shared-utils';

/**
 * The words the counter reads (UI-74, UI-75; owner decision 2026-08-24).
 *
 * **Bangla is the label, English is the helper** on every surface a cashier
 * acts on. That inverts UI-14/UI-15, which still governs the Owner/Manager
 * screens — an account setup form and a statement stay English-primary, because
 * they are read by whoever keeps the books.
 *
 * Every string lives here rather than in the components for UI-19's reason: one
 * phrase per business concept, reused everywhere. Two different Bangla words
 * for a shortage would be a defect, and a shopkeeper who learns
 * `টাকা কম` on one screen must not meet `ঘাটতি` on the next.
 *
 * These are constants today and i18n values tomorrow (UI-18). Phase 1's message
 * catalogue does not exist yet, so they sit in one module that a later
 * extraction can lift whole — which is exactly why no component writes a Bangla
 * string inline.
 *
 * Digits stay **Western** inside every one of these (UI-47): `৳64,500`, never
 * `৬৪,৫০০`. That is what the phone keypad, the calculator and bKash all show.
 */
export const MONEY_BN = {
  /* the day */
  startDay: 'দিন শুরু করুন',
  endDay: 'দিন শেষ করুন',
  reopenDay: 'ভুল করে বন্ধ করেছি',
  dayOpen: 'দিন চলছে',
  dayNotStarted: 'দিন শুরু হয়নি',
  dayClosed: 'দিন শেষ হয়েছে',
  closePreviousFirst: 'আগের দিন আগে শেষ করুন',

  /* counting */
  countNow: 'ড্রয়ারে এখন কত টাকা আছে?',
  countAtStart: 'ড্রয়ারে কত টাকা দিয়ে শুরু করছেন?',
  lastNightCount: 'কাল রাতে ছিল',
  systemExpects: 'হিসাব অনুযায়ী থাকার কথা',
  cashIn: 'আজ জমা হয়েছে',
  cashOut: 'আজ খরচ হয়েছে',
  short: 'টাকা কম',
  over: 'টাকা বেশি',
  matched: 'হিসাব মিলেছে',

  /* explanations */
  whyShort: 'কেন কম হলো?',
  whyOver: 'কেন বেশি হলো?',
  whereFrom: 'বাড়তি টাকা কোথা থেকে এলো?',
  whereGone: 'কম টাকা কোথায় গেল?',
  whyReopen: 'কেন আবার খুলছেন?',

  /* the counterparts — presets, never a dropdown (UI-75) */
  ownerGave: 'মালিক টাকা দিলেন',
  ownerTook: 'মালিক টাকা নিলেন',
  toSafe: 'সিন্দুকে রাখলাম',
  fromSafe: 'সিন্দুক থেকে আনলাম',
  toBank: 'ব্যাংকে জমা দিলাম',
  fromBank: 'ব্যাংক থেকে তুললাম',

  /* actions */
  confirm: 'ঠিক আছে',
  cancel: 'বাতিল',
  moveMoney: 'টাকা সরান',
  amount: 'টাকার পরিমাণ',
  note: 'কিছু লিখতে চাইলে',

  /* Finance module (owner decisions 2026-08-31) */
  finance: 'সব টাকার সারসংক্ষেপ',
  moneyAccounts: 'ক্যাশ, ব্যাংক ও বিকাশ',
  transferMoney: 'টাকা সরান',
  capitalAndLoans: 'মালিক ও ঋণ',
  accountLedger: 'অ্যাকাউন্টের খতিয়ান',
  reconciliation: 'ব্যাংকের সাথে মিলিয়ে দেখা',
  totalCash: 'নগদ টাকা',
  totalBank: 'ব্যাংকে আছে',
  totalMfs: 'বিকাশ/নগদে আছে',
  loansOwed: 'ঋণ বাকি',
  fromAccount: 'কোথা থেকে',
  toAccount: 'কোথায়',
  transactionDate: 'তারিখ',
  reference: 'রেফারেন্স',
  availableBalance: 'এখন আছে',
  newTransfer: 'নতুন টাকা সরানো',
  newEntry: 'নতুন এন্ট্রি',
  ownerCapital: 'মালিকের টাকা',
  loanReceived: 'ঋণ নিলাম',
  loanRepaid: 'ঋণ শোধ দিলাম',
  manageLoanAccounts: 'ঋণের হিসাব ঠিক করুন',
} as const;

/**
 * The English each Bangla label carries underneath.
 *
 * Kept as a parallel map rather than woven into the strings above, so a screen
 * can drop the English where space is tight (UI-16) without the Bangla losing
 * meaning — and so a later i18n extraction gets two clean catalogues rather
 * than one of concatenated pairs.
 */
export const MONEY_EN: Record<keyof typeof MONEY_BN, string> = {
  startDay: 'Start day',
  endDay: 'End day',
  reopenDay: 'Closed by mistake',
  dayOpen: 'Day open',
  dayNotStarted: 'Day not started',
  dayClosed: 'Day closed',
  closePreviousFirst: 'Close the previous day first',

  countNow: 'How much cash is in the drawer now?',
  countAtStart: 'How much cash are you starting with?',
  lastNightCount: 'Counted last night',
  systemExpects: 'Expected',
  cashIn: 'Cash in today',
  cashOut: 'Cash out today',
  short: 'Short',
  over: 'Over',
  matched: 'Matched',

  whyShort: 'Why is it short?',
  whyOver: 'Why is it over?',
  whereFrom: 'Where did the extra come from?',
  whereGone: 'Where did the missing cash go?',
  whyReopen: 'Why reopen it?',

  ownerGave: 'Owner put money in',
  ownerTook: 'Owner took money out',
  toSafe: 'Moved to the safe',
  fromSafe: 'Brought from the safe',
  toBank: 'Deposited in the bank',
  fromBank: 'Withdrawn from the bank',

  confirm: 'Confirm',
  cancel: 'Cancel',
  moveMoney: 'Move money',
  amount: 'Amount',
  note: 'Note (optional)',

  finance: 'Overview',
  moneyAccounts: 'Money Accounts',
  transferMoney: 'Transfer Money',
  capitalAndLoans: 'Capital & Loans',
  accountLedger: 'Account Ledger',
  reconciliation: 'Reconciliation',
  totalCash: 'Total Cash',
  totalBank: 'Total Bank',
  totalMfs: 'Total MFS',
  loansOwed: 'Outstanding Loans',
  fromAccount: 'From Account',
  toAccount: 'To Account',
  transactionDate: 'Transaction Date',
  reference: 'Reference',
  availableBalance: 'Available balance',
  newTransfer: 'New Transfer',
  newEntry: 'New Entry',
  ownerCapital: 'Owner capital',
  loanReceived: 'Loan received',
  loanRepaid: 'Loan repaid',
  manageLoanAccounts: 'Manage Loan Accounts',
};

/** `৳64,500` — Western digits, grouped, two decimals only when there are any. */
export function taka(amountMinor: number): string {
  const sign = amountMinor < 0 ? '−' : '';
  const abs = Math.abs(amountMinor);
  const whole = Math.trunc(abs / 100);
  const paisa = abs % 100;
  const grouped = whole.toLocaleString('en-US');
  return paisa === 0
    ? `${sign}৳${grouped}`
    : `${sign}৳${grouped}.${paisa.toString().padStart(2, '0')}`;
}

/**
 * Reads a typed amount into minor units, or `null` if it is not a number.
 *
 * Accepts Bengali digits on input even though it never writes them: a phone
 * keyboard set to Bangla will produce them, and refusing what the user's own
 * keyboard types would be a dead end they cannot diagnose (UI-47 is about what
 * the screen *shows*).
 */
export function parseTaka(input: string): number | null {
  const western = input
    .trim()
    .replace(/[০-৯]/g, (digit) => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)))
    .replace(/,/g, '');

  if (western === '' || !/^\d+(\.\d{0,2})?$/.test(western)) return null;
  return Math.round(Number(western) * 100);
}

/**
 * A quantity as a shopkeeper reads it (owner decision 2026-08-26).
 *
 * `12` rather than `12.000`, `12.12` rather than `12.120`, at most two decimal
 * places. Quantities are stored at scale 3 and always will be — this is only
 * how they are drawn, and the same rule `taka` already followed for paisa.
 *
 * Use this everywhere a quantity is shown. The scale-3 `format()` on `Qty` is
 * the storage form and belongs in tests and round-trips, not on a screen.
 */
export function qtyText(rawQty: number): string {
  return formatForDisplay(rawQty, QTY_SCALE);
}
