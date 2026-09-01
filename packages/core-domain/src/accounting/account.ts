/**
 * The internal chart of accounts (§2.4).
 *
 * **The user never sees any of this.** Customer ledgers, the cash screen, the
 * expense list and the P&L are all display mappings over the same signed
 * journal lines — changing a label never changes accounting semantics. These
 * codes exist so that every module posts the same movement of value to the same
 * place, and so a report can be proved against a journal query.
 *
 * **The list is closed.** §2.4 says so in as many words: a module needing an
 * account that is not here must stop and report rather than invent one, because
 * a new account silently changes what every existing report means. Adding a
 * member to this file is a specification change, not an implementation detail.
 *
 * Pure: no clock, no I/O, no database. A code is a string this module can build
 * and parse, and nothing else in the system is allowed to assemble one by hand.
 */

/**
 * Accounts a tenant has exactly one of.
 *
 * `OPENING_EQUITY` is the counterpart every opening balance posts against —
 * opening stock, opening receivables, opening payables and opening cash all
 * need a credit somewhere, and inventing a "balance" column instead is what
 * §5.6 and INV-06 forbid.
 *
 * `STOCK_ADJUSTMENT` is the stock-side twin of `CASH_SHORT_OVER` (§2.4, owner
 * decision 2026-08-20): a loss debits it, a gain credits it, and the period
 * balance is the shop's shrinkage. Without it a physical-count correction has
 * nowhere to balance and `INVENTORY` drifts away from the goods on the shelf,
 * which is the same argument that added `CASH_SHORT_OVER` for the drawer.
 */
export const FIXED_ACCOUNTS = [
  'AR',
  'AP',
  'INVENTORY',
  'COGS',
  'SALES',
  'VENDOR_PAYABLE',
  'CUSTOMER_ADVANCE',
  'SUPPLIER_ADVANCE',
  'VENDOR_ADVANCE',
  'WARRANTY_EXPENSE',
  'CASH_SHORT_OVER',
  'STOCK_ADJUSTMENT',
  'OWNER_CURRENT_ACCOUNT',
  'ROUNDING',
  'OPENING_EQUITY',
] as const;

export type FixedAccount = (typeof FIXED_ACCOUNTS)[number];

/**
 * Accounts that exist once per *something* and carry that something's id.
 *
 * `CASH` is per cash account rather than one lump (§2.4): a tenant has at least
 * the drawer and may add a safe or a second counter, which is what makes "cash
 * left the drawer" always have a named destination instead of disappearing into
 * an adjustment. `EXPENSE` is per category for the same reason on the cost side.
 *
 * `LOAN` is per loan account (owner decision 2026-08-31, Finance module). It is
 * a **liability**: a credit balance is money the shop owes that lender. It is
 * deliberately not `BANK:{id}` — a loan inside the bank family would be added
 * into Total Bank and into every cash-and-bank figure the shop is judged on,
 * overstating what it holds by exactly what it owes. Its own family is also
 * what keeps loans out of those sums for free: the report and daybook queries
 * select on the `CASH:%` and `BANK:%` prefixes.
 */
export const PARAMETERISED_ACCOUNTS = ['CASH', 'BANK', 'EXPENSE', 'LOAN'] as const;

export type ParameterisedAccount = (typeof PARAMETERISED_ACCOUNTS)[number];

/**
 * A validated account code: either `INVENTORY` or `CASH:01J…`.
 *
 * Branded so a raw string cannot be posted by mistake. The only ways to obtain
 * one are `fixedAccount` and `parameterisedAccount`, both of which check.
 */
export type AccountCode = string & { readonly __brand: 'AccountCode' };

const SEGMENT_SEPARATOR = ':';

/**
 * What the id half of a parameterised code may contain.
 *
 * Deliberately narrow. The separator must never appear inside an id, or
 * `parseAccountCode` could not tell `EXPENSE:transport:extra` from a category
 * genuinely called `transport:extra`, and a report grouping by account would
 * quietly split one expense category into two.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function fixedAccount(account: FixedAccount): AccountCode {
  return account as AccountCode;
}

export function parameterisedAccount(
  account: ParameterisedAccount,
  id: string,
): AccountCode {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${account} account id: ${JSON.stringify(id)}`);
  }
  return `${account}${SEGMENT_SEPARATOR}${id}` as AccountCode;
}

/** A parsed code, so a caller can group by account kind without string surgery. */
export type ParsedAccount =
  | { readonly kind: FixedAccount; readonly id: null }
  | { readonly kind: ParameterisedAccount; readonly id: string };

/**
 * Reads a code back, or returns `null` if it is not one this system issues.
 *
 * Used at the edges — a stored row, an import, a query parameter — precisely so
 * that an account which is *not* on the closed list is caught at the boundary
 * rather than becoming a line in a journal nobody can explain later.
 */
export function parseAccountCode(code: string): ParsedAccount | null {
  const separatorAt = code.indexOf(SEGMENT_SEPARATOR);

  if (separatorAt === -1) {
    return isFixedAccount(code) ? { kind: code, id: null } : null;
  }

  const kind = code.slice(0, separatorAt);
  const id = code.slice(separatorAt + 1);

  if (!isParameterisedAccount(kind) || !ID_PATTERN.test(id)) return null;
  return { kind, id };
}

export function isAccountCode(code: string): code is AccountCode {
  return parseAccountCode(code) !== null;
}

function isFixedAccount(code: string): code is FixedAccount {
  return (FIXED_ACCOUNTS as readonly string[]).includes(code);
}

function isParameterisedAccount(code: string): code is ParameterisedAccount {
  return (PARAMETERISED_ACCOUNTS as readonly string[]).includes(code);
}
