import { parameterisedAccount } from '../accounting/account';
import type { AccountCode } from '../accounting/account';

/**
 * An account money sits in: the drawer, the safe, a bank account, bKash (§2.4,
 * §5.17).
 *
 * **Three types, two account codes.** `CASH` posts to `CASH:{id}` and `BANK`
 * and `MFS` both post to `BANK:{id}`. That is not a shortcut — §2.4's closed
 * list has no `MFS` member, and bKash is not drawer cash by the only test that
 * matters here: you cannot count it at the end of the day. The distinction the
 * shop cares about is the label on the screen, and a label never changes
 * accounting semantics (UI-21).
 *
 * Pure: no clock, no I/O. Naming, uniqueness and permissions belong to the
 * application layer; what an account *is*, and where it posts, belongs here.
 */

export const MONEY_ACCOUNT_TYPES = ['CASH', 'BANK', 'MFS'] as const;
export type MoneyAccountType = (typeof MONEY_ACCOUNT_TYPES)[number];

export type MoneyAccountStatus = 'ACTIVE' | 'INACTIVE';

export const ACCOUNT_NAME_MAX_LENGTH = 80;
export const ACCOUNT_REFERENCE_MAX_LENGTH = 64;

export type MoneyAccountRejection =
  | 'ACCOUNT_NAME_REQUIRED'
  | 'ACCOUNT_NAME_TOO_LONG'
  | 'ACCOUNT_REFERENCE_TOO_LONG'
  | 'ACCOUNT_TYPE_NOT_VALID'
  | 'ACCOUNT_DRAWER_MUST_BE_CASH'
  | 'ACCOUNT_OPENING_NOT_INTEGER_MINOR'
  | 'ACCOUNT_OPENING_NEGATIVE'
  | 'ACCOUNT_OPENING_DATE_REQUIRED';

export interface MoneyAccountDraft {
  readonly name: string;
  readonly type: MoneyAccountType;
  readonly holderName: string | null;
  readonly reference: string | null;
  /** Whether this is the box the day is counted against (owner decision 2026-08-24). */
  readonly isDrawer: boolean;
  /** What is already in it on day one. Zero means "nothing to open with". */
  readonly openingAmountMinor: number;
  /** Required only when the opening is non-zero — see `rejectMoneyAccount`. */
  readonly openingDate: string | null;
}

/**
 * The journal account this money account posts to.
 *
 * The only sanctioned way to build one. A caller assembling `CASH:${id}` by
 * hand would skip the id validation in `parameterisedAccount` and could put a
 * separator inside an id, which is the one thing that makes a posted code
 * unparseable afterwards.
 */
export function accountCodeFor(type: MoneyAccountType, accountId: string): AccountCode {
  return parameterisedAccount(type === 'CASH' ? 'CASH' : 'BANK', accountId);
}

/** Whether this account is one the shop can physically count. */
export function isCountable(type: MoneyAccountType): boolean {
  return type === 'CASH';
}

/** Returns the first reason the account cannot be saved, or `null`. */
export function rejectMoneyAccount(draft: MoneyAccountDraft): MoneyAccountRejection | null {
  const name = draft.name.trim();
  if (name.length === 0) return 'ACCOUNT_NAME_REQUIRED';
  if (name.length > ACCOUNT_NAME_MAX_LENGTH) return 'ACCOUNT_NAME_TOO_LONG';

  if ((draft.reference?.trim().length ?? 0) > ACCOUNT_REFERENCE_MAX_LENGTH) {
    return 'ACCOUNT_REFERENCE_TOO_LONG';
  }

  if (!(MONEY_ACCOUNT_TYPES as readonly string[]).includes(draft.type)) {
    return 'ACCOUNT_TYPE_NOT_VALID';
  }

  // A bank account cannot be emptied onto a table and counted, so a session
  // counted against one would record a "physical count" nobody performed.
  if (draft.isDrawer && !isCountable(draft.type)) return 'ACCOUNT_DRAWER_MUST_BE_CASH';

  if (!Number.isSafeInteger(draft.openingAmountMinor)) return 'ACCOUNT_OPENING_NOT_INTEGER_MINOR';

  // Negative is refused rather than clamped: an overdrawn bank account is a
  // real thing, but it is the result of posted movements, not something a shop
  // opens with. Accepting it here would post a debit to `OPENING_EQUITY` that
  // nothing in §5.6 or §5.16 describes.
  if (draft.openingAmountMinor < 0) return 'ACCOUNT_OPENING_NEGATIVE';

  // An opening with no date has no business date to post on, and defaulting it
  // to today would date a migrating shop's history to the day they typed it.
  if (draft.openingAmountMinor > 0 && draft.openingDate === null) {
    return 'ACCOUNT_OPENING_DATE_REQUIRED';
  }

  return null;
}

/**
 * Whether an account may be taken out of use (owner decision 2026-08-24).
 *
 * Only at zero. Money must first be moved somewhere named — the till, the safe,
 * the bank — because an inactive account still holding cash keeps that cash in
 * the shop's total while nobody looks at the box. History never blocks: this is
 * a soft delete (§3.6), and past movements stay readable.
 */
export function canDeactivate(balanceMinor: number): boolean {
  return balanceMinor === 0;
}
