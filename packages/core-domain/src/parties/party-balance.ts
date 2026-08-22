import type { AccountCode } from '../accounting/account';

/**
 * What a party's journal lines mean to the person reading the screen (§2.4, INV-06).
 *
 * INV-06 defines a party's balance as the sum of their journal lines and
 * nothing else — there is no `balance` column to drift from the journal, and
 * this module is the only place that turns those signed lines into the two
 * words a shopkeeper actually uses: পাবো (I will receive) and দিব (I will pay).
 *
 * Pure: no clock, no I/O. Amounts in and out are integer minor units (poisha).
 */

/**
 * The accounts that make up a party's balance.
 *
 * Deliberately the same set `journal-entry.ts` requires a `party_id` on, minus
 * `OWNER_CURRENT_ACCOUNT`: an owner's capital is not money the shop is chasing,
 * and folding it into an outstanding figure would tell a shopkeeper their own
 * investment is a debt someone owes them.
 *
 * Advances sit here rather than in a separate figure because they net. A
 * customer who owes 500 on an invoice and has 200 sitting as an advance is owed
 * 300 by any sane reading, and showing "500 due / 200 advance" side by side
 * invites collecting the wrong number at the counter.
 */
export const PARTY_BALANCE_ACCOUNTS: readonly string[] = [
  'AR',
  'AP',
  'CUSTOMER_ADVANCE',
  'SUPPLIER_ADVANCE',
  'VENDOR_ADVANCE',
  'VENDOR_PAYABLE',
];

/** True when a line on this account belongs in a party's balance. */
export function affectsPartyBalance(account: AccountCode | string): boolean {
  const separatorAt = account.indexOf(':');
  const kind = separatorAt === -1 ? account : account.slice(0, separatorAt);
  return PARTY_BALANCE_ACCOUNTS.includes(kind);
}

/**
 * Which way a balance points, named the way the shop says it.
 *
 * `SETTLED` is its own case rather than a zero `RECEIVABLE`, because "পাবো ০"
 * and "settled" read differently at a counter — the first invites a second look
 * for the missing amount.
 */
export type BalanceDirection = 'RECEIVABLE' | 'PAYABLE' | 'SETTLED';

/**
 * A party balance as a screen shows it.
 *
 * `netMinor` keeps the sign so a caller can sort or total without re-deriving
 * it; `outstandingMinor` and `advanceMinor` are the unsigned halves, exactly
 * one of which is non-zero. Both are present so a list column can render
 * without a conditional that might pick the wrong sign.
 */
export interface PartyBalance {
  /** Positive: the party owes the shop. Negative: the shop owes the party. */
  readonly netMinor: number;
  readonly direction: BalanceDirection;
  /** `netMinor` when positive, else 0. What "outstanding" means on a list. */
  readonly outstandingMinor: number;
  /** `-netMinor` when negative, else 0. Advance held, or credit owed back. */
  readonly advanceMinor: number;
}

export const SETTLED_BALANCE: PartyBalance = {
  netMinor: 0,
  direction: 'SETTLED',
  outstandingMinor: 0,
  advanceMinor: 0,
};

/**
 * Turns a party's signed net into the figures a list and a ledger both show.
 *
 * Takes the net rather than the lines so the sum can be done where it belongs —
 * in SQL, over an indexed query — while the meaning of the sign stays here and
 * is applied identically by the list, the ledger header and the statement.
 */
export function partyBalanceOf(netMinor: number): PartyBalance {
  if (!Number.isSafeInteger(netMinor)) {
    throw new Error(`Party balance must be integer minor units: ${netMinor}`);
  }

  if (netMinor === 0) return SETTLED_BALANCE;

  return {
    netMinor,
    direction: netMinor > 0 ? 'RECEIVABLE' : 'PAYABLE',
    outstandingMinor: netMinor > 0 ? netMinor : 0,
    advanceMinor: netMinor < 0 ? -netMinor : 0,
  };
}

/**
 * Whether a sale would push a customer past their limit (§5.6's credit limit).
 *
 * `null` limit means no limit, which is not a limit of zero — a shop that has
 * not set one must not have every credit sale refused. The check is `>` rather
 * than `>=` so a customer may land exactly on their limit, which is the reading
 * of "limit" that does not surprise someone at the counter.
 */
export function exceedsCreditLimit(
  balance: PartyBalance,
  creditLimitMinor: number | null,
  additionalMinor = 0,
): boolean {
  if (creditLimitMinor === null) return false;
  return balance.outstandingMinor + additionalMinor > creditLimitMinor;
}
