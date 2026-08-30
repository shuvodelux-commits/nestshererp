import type { CashMovementKind, MoneyAccountStatus, MoneyAccountType } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Everything Phase 4 reads and writes (migration 0016).
 *
 * One port rather than four, because the five tables are one aggregate in
 * practice: closing a day reads the drawer, sums its journal lines, writes a
 * close row and posts an entry, and splitting that across repositories would
 * mean a use case holding four handles to the same transaction.
 */

/** A journal entry as it is written alongside the document that caused it. */
export interface NewJournalEntry {
  readonly journalEntryId: string;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceNumber: string;
  readonly lines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
}

export interface MoneyAccountRow {
  readonly id: string;
  readonly name: string;
  readonly type: MoneyAccountType;
  readonly holderName: string | null;
  readonly reference: string | null;
  readonly isDrawer: boolean;
  readonly status: MoneyAccountStatus;
  /**
   * The INV-07 rollup of this account's journal lines, computed in the same
   * query as the row so a list column and the statement under it cannot
   * disagree. Not a stored column — migration 0016 says why.
   */
  readonly balanceMinor: number;
  readonly openingAmountMinor: number | null;
  readonly openingDate: string | null;
  readonly openingId: string | null;
  readonly openingVersion: number | null;
  readonly version: number;
}

export interface NewMoneyAccount {
  readonly id: string;
  readonly name: string;
  readonly type: MoneyAccountType;
  readonly holderName: string | null;
  readonly reference: string | null;
  readonly isDrawer: boolean;
}

export interface MoneyAccountEdit extends NewMoneyAccount {
  readonly expectedVersion: number;
  readonly status: MoneyAccountStatus;
}

export interface NewAccountOpening {
  readonly id: string;
  readonly number: string;
  readonly accountId: string;
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly operationId: string;
  readonly journal: NewJournalEntry;
}

/** Correcting a posted opening by the §2.5 delta — never an edit of the entry. */
export interface AccountOpeningCorrection {
  readonly openingId: string;
  readonly expectedVersion: number;
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly correctionId: string;
  readonly correctionNumber: string;
  readonly journal: NewJournalEntry;
}

export interface CashSessionRow {
  readonly id: string;
  readonly number: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly businessDate: string;
  readonly status: 'OPEN' | 'CLOSED';
  readonly openingAmountMinor: number;
  readonly previousClosingMinor: number | null;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly openedByName: string | null;
  readonly version: number;
}

export interface NewCashSession {
  readonly id: string;
  readonly number: string;
  readonly accountId: string;
  readonly businessDate: string;
  readonly openingAmountMinor: number;
  readonly previousClosingMinor: number | null;
}

export interface CashSessionCloseRow {
  readonly id: string;
  readonly sessionId: string;
  readonly status: 'ACTIVE' | 'SUPERSEDED';
  readonly openingAmountMinor: number;
  readonly cashInMinor: number;
  readonly cashOutMinor: number;
  readonly expectedClosingMinor: number;
  readonly countedClosingMinor: number;
  readonly differenceMinor: number;
  readonly differenceReason: string | null;
  readonly reopenReason: string | null;
  readonly closedAt: string;
  readonly closedBy: string;
  readonly closedByName: string | null;
  readonly supersededAt: string | null;
  readonly version: number;
}

export interface NewCashSessionClose {
  readonly id: string;
  readonly sessionId: string;
  readonly openingAmountMinor: number;
  readonly cashInMinor: number;
  readonly cashOutMinor: number;
  readonly expectedClosingMinor: number;
  readonly countedClosingMinor: number;
  readonly differenceMinor: number;
  readonly differenceReason: string | null;
  /** Posted only when the difference is non-zero (§5.16.4). */
  readonly journal: NewJournalEntry | null;
}

export interface CashSessionReopen {
  readonly closeId: string;
  readonly expectedVersion: number;
  readonly sessionId: string;
  readonly reason: string;
  /** The equal and opposite entry, or `null` when the mistaken close matched. */
  readonly journal: NewJournalEntry | null;
}

/** The day's posted cash in and cash out — see `sessionTotals` for what counts. */
export interface CashSessionTotalsRow {
  readonly cashInMinor: number;
  readonly cashOutMinor: number;
}

export interface NewCashMovement {
  readonly id: string;
  readonly number: string;
  readonly kind: CashMovementKind;
  readonly fromAccountCode: string;
  readonly toAccountCode: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly sessionId: string | null;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly operationId: string;
  readonly journal: NewJournalEntry;
}

/**
 * A corrected cash movement, re-posted under its own number (Phase 9.2).
 *
 * The row is updated in place and a `CASH_MOVEMENT_CORRECTION` entry is
 * written; the reversal of what it used to say was posted a moment earlier in
 * the same transaction, so the journal holds all three facts (§2.5).
 */
export interface RepostCashMovement {
  readonly id: string;
  readonly expectedVersion: number;
  readonly kind: CashMovementKind;
  readonly fromAccountCode: string;
  readonly toAccountCode: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly sessionId: string | null;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly correctionReason: string | null;
  readonly originalBusinessDate: string | null;
  readonly journal: NewJournalEntry;
}

export interface CashMovementRow {

  readonly id: string;
  readonly number: string;
  readonly kind: CashMovementKind;
  readonly fromAccountCode: string;
  readonly toAccountCode: string;
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface StatementFilter {
  readonly accountCode: string;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface StatementLineRow {
  readonly journalLineId: string;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly sourceType: string;
  readonly sourceNumber: string;
  readonly amountMinor: number;
}

export interface DailyCashFilter {
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface MoneyRepository {
  listAccounts(
    tx: Tx,
    ctx: TenantContext,
    filter: { readonly types: readonly MoneyAccountType[]; readonly includeInactive: boolean },
  ): Promise<readonly MoneyAccountRow[]>;
  findAccountById(tx: Tx, ctx: TenantContext, accountId: string): Promise<MoneyAccountRow | null>;
  /** The one box the day is counted against, or `null` before setup. */
  findDrawer(tx: Tx, ctx: TenantContext): Promise<MoneyAccountRow | null>;
  insertAccount(tx: Tx, ctx: TenantContext, account: NewMoneyAccount): Promise<void>;
  updateAccount(tx: Tx, ctx: TenantContext, account: MoneyAccountEdit): Promise<boolean>;

  insertAccountOpening(tx: Tx, ctx: TenantContext, opening: NewAccountOpening): Promise<void>;
  correctAccountOpening(
    tx: Tx,
    ctx: TenantContext,
    correction: AccountOpeningCorrection,
  ): Promise<boolean>;

  findSessionByDate(
    tx: Tx,
    ctx: TenantContext,
    businessDate: string,
  ): Promise<CashSessionRow | null>;
  findOpenSession(tx: Tx, ctx: TenantContext): Promise<CashSessionRow | null>;
  findSessionById(tx: Tx, ctx: TenantContext, sessionId: string): Promise<CashSessionRow | null>;
  /** The most recent closed day before this one, for Start Day's suggestion. */
  findPreviousClose(
    tx: Tx,
    ctx: TenantContext,
    beforeDate: string,
  ): Promise<CashSessionCloseRow | null>;
  insertSession(tx: Tx, ctx: TenantContext, session: NewCashSession): Promise<void>;
  listSessions(
    tx: Tx,
    ctx: TenantContext,
    filter: DailyCashFilter,
  ): Promise<readonly (CashSessionRow & { readonly closes: readonly CashSessionCloseRow[] })[]>;

  /**
   * What the drawer took in and paid out on this day.
   *
   * Sums the journal lines against the drawer's account code for the session's
   * business date, **excluding** three kinds of entry that are not the day's
   * trading:
   *
   *   `ACCOUNT_OPENING`      — the balance the shop started the account with.
   *                            It *is* the opening, so counting it again as
   *                            cash in would double the first day's expected.
   *   `OPENING_ADJUSTMENT`   — the Start Day difference. The counted opening
   *                            already includes it (§5.16.5 case A: the drawer
   *                            holds 70,000 *because* the owner put 5,500 in).
   *   `CASH_SESSION_CLOSE`   — the shortage/overage and any reversal of it.
   *                            Expected is what the system believed *before*
   *                            the count; folding the count's own correction
   *                            back in would make the difference always zero.
   *
   * Everything else — sales, collections, expenses, purchases, transfers, owner
   * money — is the day's cash movement and counts.
   */
  sessionTotals(tx: Tx, ctx: TenantContext, sessionId: string): Promise<CashSessionTotalsRow>;

  findActiveClose(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<CashSessionCloseRow | null>;
  listCloses(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<readonly CashSessionCloseRow[]>;
  /** Writes the close row, its posting, and flips the session to CLOSED. */
  closeSession(tx: Tx, ctx: TenantContext, close: NewCashSessionClose): Promise<void>;
  /** Supersedes the standing close, posts the reversal, reopens the session. */
  reopenSession(tx: Tx, ctx: TenantContext, reopen: CashSessionReopen): Promise<boolean>;

  insertMovement(tx: Tx, ctx: TenantContext, movement: NewCashMovement): Promise<void>;
  /** Returns false when somebody else changed the movement first (D-32). */
  repostMovement(tx: Tx, ctx: TenantContext, movement: RepostCashMovement): Promise<boolean>;
  listMovements(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<readonly CashMovementRow[]>;

  listStatementLines(
    tx: Tx,
    ctx: TenantContext,
    filter: StatementFilter,
  ): Promise<readonly StatementLineRow[]>;
  /** The account's balance before the first line on this page (§3.9 keyset). */
  sumStatementBefore(tx: Tx, ctx: TenantContext, filter: StatementFilter): Promise<number>;
}
