import { MONEY_SCALE } from '@sher/shared-utils';

import type { AccountCode } from './account';

/**
 * A balanced journal entry — the posting kernel's one unit of work (§2.4).
 *
 * Every financial and inventory command in SherERP ends here: a sale, a
 * purchase, a payment, an expense, a return, an opening balance. Documents and
 * stock movements say *what happened*; this says *what it did to the money*,
 * and every ledger, statement and report is a projection of these lines
 * (INV-10). There is no second way to move value.
 *
 * **Lines are signed** rather than carrying a debit column and a credit column.
 * §2.4 calls them signed journal lines and defines Debit/Credit, Cash In/Out
 * and পাবো/দিব as display mappings over the same rows, so one signed amount is
 * the honest storage: positive is a debit, negative is a credit, and INV-01 is
 * then literally "the lines sum to zero". Two columns would let a line be both,
 * or neither, and every reader would have to subtract them anyway.
 *
 * Pure: no clock, no I/O, no floating point. Amounts are `Money`-scaled integer
 * minor units (poisha), so a rounding remainder is a real line posted to
 * `ROUNDING`, never a fraction that evaporates.
 */

/** Positive is a debit, negative is a credit. Never zero — see `rejectEntry`. */
export interface JournalLineDraft {
  readonly account: AccountCode;
  readonly amountMinor: number;
  /**
   * Whose line this is, where that is meaningful (§2.4).
   *
   * INV-06 makes a party's balance the sum of their journal lines, so an `AR`
   * or `AP` line without a party is a receivable belonging to nobody — it would
   * count towards the control account and never appear on a statement, which is
   * exactly the drift INV-06 exists to catch. `OWNER_CURRENT_ACCOUNT` carries
   * one too, so an owner statement is produced without splitting the account.
   */
  readonly partyId: string | null;
}

export interface JournalEntryDraft {
  readonly lines: readonly JournalLineDraft[];
}

/**
 * Why an entry was refused. A reason code, not a message: `core-domain` owns the
 * rule, the application layer owns the wording (and the Bangla).
 */
export type JournalRejection =
  | 'ENTRY_HAS_NO_LINES'
  | 'ENTRY_HAS_ONE_LINE'
  | 'LINE_AMOUNT_IS_ZERO'
  | 'LINE_AMOUNT_NOT_INTEGER_MINOR'
  | 'ENTRY_DOES_NOT_BALANCE'
  | 'PARTY_ACCOUNT_WITHOUT_PARTY';

/**
 * Accounts whose lines are meaningless without a party (INV-06).
 *
 * Party advance/payable accounts are here for the same reason `AR` and `AP`
 * are: they are somebody's money, and a statement that cannot name whose is
 * not a statement. `OWNER_CURRENT_ACCOUNT` is deliberately **not** required —
 * §2.4 says lines carry `party_id` so an owner statement can be produced, but a
 * single-owner shop that never names the owner as a party is normal, and
 * refusing its cash injection would stop real work over a reporting nicety.
 */
const PARTY_REQUIRED_ACCOUNTS: readonly string[] = [
  'AR',
  'AP',
  'CUSTOMER_ADVANCE',
  'SUPPLIER_ADVANCE',
  'VENDOR_ADVANCE',
  'VENDOR_PAYABLE',
];

/**
 * Checks INV-01 and returns the first reason the entry cannot be posted.
 *
 * Returns `null` when the entry is postable. Deliberately a check rather than a
 * throw: the application layer turns a reason code into a refusal the user can
 * read, and DR13.12 means the server re-runs this on replay rather than
 * trusting what a client computed.
 */
export function rejectEntry(entry: JournalEntryDraft): JournalRejection | null {
  const { lines } = entry;

  if (lines.length === 0) return 'ENTRY_HAS_NO_LINES';

  // A single line cannot balance unless it is zero, and a zero line is refused
  // below — so this is a clearer refusal than "does not balance" for what is
  // almost always a caller that forgot the counterpart.
  if (lines.length === 1) return 'ENTRY_HAS_ONE_LINE';

  let total = 0;

  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountMinor)) {
      return 'LINE_AMOUNT_NOT_INTEGER_MINOR';
    }

    // A zero line is not harmless. It is either a bug that dropped an amount or
    // a placeholder somebody meant to fill in, and once posted it is
    // indistinguishable from a real line worth nothing.
    if (line.amountMinor === 0) return 'LINE_AMOUNT_IS_ZERO';

    if (line.partyId === null && PARTY_REQUIRED_ACCOUNTS.includes(accountKindOf(line.account))) {
      return 'PARTY_ACCOUNT_WITHOUT_PARTY';
    }

    total += line.amountMinor;
  }

  // INV-01. The whole posting kernel rests on this one line.
  if (total !== 0) return 'ENTRY_DOES_NOT_BALANCE';

  return null;
}

/**
 * The sum of the debits, which for a balanced entry is also the sum of the
 * credits. What a person means by "the size of this entry".
 */
export function entryTotalMinor(entry: JournalEntryDraft): number {
  return entry.lines.reduce((sum, line) => (line.amountMinor > 0 ? sum + line.amountMinor : sum), 0);
}

/**
 * The exact reversal of an entry (§2.5).
 *
 * Editing or voiding a posted document never rewrites its lines — it posts
 * these alongside them, so the original numbers stay reproducible and INV-08
 * ("a voided document has zero net effect") holds by construction rather than
 * by a cleanup routine that might miss a line.
 */
export function reverseEntry(entry: JournalEntryDraft): JournalEntryDraft {
  return {
    lines: entry.lines.map((line) => ({ ...line, amountMinor: -line.amountMinor })),
  };
}

/** `CASH:01J…` is a `CASH` line. Kept private — parsing belongs to `account.ts`. */
function accountKindOf(account: string): string {
  const separatorAt = account.indexOf(':');
  return separatorAt === -1 ? account : account.slice(0, separatorAt);
}

/**
 * Re-exported so a caller building an entry does not have to remember which
 * scale money is in. Amounts here are always minor units at this scale.
 */
export { MONEY_SCALE };
