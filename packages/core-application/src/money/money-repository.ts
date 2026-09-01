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
  /** The slip, cheque or bKash number typed on the form (Finance module). */
  readonly reference: string | null;
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
  readonly reference: string | null;
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

/**
 * What the Finance lists are asking for (owner decision 2026-08-31).
 *
 * `kinds` rather than a group name, because grouping is a screen's idea of the
 * world and this port only knows documents: the use case turns "the Transfer
 * Money page" into the kinds that page shows.
 */
export interface MovementHistoryFilter {
  readonly kinds: readonly CashMovementKind[];
  /** Either side of the movement, as an account **id**, not a code. */
  readonly accountId: string | null;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  /** Matches the reference, the note or the movement number. */
  readonly search: string | null;
  /**
   * The accounts this caller may see. A movement is returned only when every
   * account side of it is one of these — the owner side is not an account and
   * is not tested — so a transfer between two bank accounts never surfaces for
   * someone who cannot open either of them.
   */
  readonly visibleAccountIds: readonly string[];
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * One movement as the Finance lists read it.
 *
 * Carries the stored state — `status`, `correctionReason` — rather than a
 * word for the screen: which of Posted, Corrected and Cancelled a row shows is
 * a presentation decision the use case makes, and a repository that decided it
 * would have to be changed the next time the wording does.
 */
export interface MovementHistoryRow {
  readonly id: string;
  readonly number: string;
  readonly kind: CashMovementKind;
  readonly businessDate: string;
  readonly fromAccountCode: string;
  readonly fromAccountName: string | null;
  readonly toAccountCode: string;
  readonly toAccountName: string | null;
  readonly amountMinor: number;
  readonly reference: string | null;
  readonly note: string | null;
  readonly status: string;
  readonly correctionReason: string | null;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly version: number;
}

export interface StatementFilter {
  readonly accountCode: string;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  /** Matches the typed reference, the document number or the note. */
  readonly search: string | null;
  /**
   * One family of source documents, or null for all of them. The families are
   * the screen's words — sales, purchases, expenses, money movements — mapped
   * to `source_document_type` values by the adapter.
   */
  readonly kind: 'SALE' | 'PURCHASE' | 'EXPENSE' | 'MOVEMENT' | 'OTHER' | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface StatementLineRow {
  readonly journalLineId: string;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly sourceType: string;
  readonly sourceNumber: string;
  readonly sourceId: string;
  readonly amountMinor: number;
  /**
   * Everything the use case needs to write the row's sentence, resolved in the
   * same query as the line (Finance module).
   *
   * A ledger row has to say *what happened*, and a journal line on its own
   * cannot: it knows an amount and an account code. The other side of the same
   * entry is what names the event — the party on a sale, the account on a
   * transfer, the category on an expense — so it is read here rather than in
   * five follow-up queries per page.
   */
  readonly counterpartyName: string | null;
  readonly otherAccountName: string | null;
  readonly expenseCategoryName: string | null;
  /** The typed reference and note, when the document is a money movement. */
  readonly movementReference: string | null;
  readonly movementNote: string | null;
  /**
   * The movement's own kind, so the ledger can say "Transfer from Main Cash"
   * rather than "Money in from Main Cash" — a transfer, an owner withdrawal and
   * a loan repayment all post the same two-sided entry, and the row is the only
   * place that still knows which of them it was.
   */
  readonly movementKind: string | null;
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
    filter: {
      readonly types: readonly MoneyAccountType[];
      readonly includeInactive: boolean;
      /**
       * Balances as they stood at the end of this business date, or now when
       * null (Finance Overview's date selector, and the "available balance as
       * of" the transfer modal shows against the date being entered).
       */
      readonly asOf?: string | null;
    },
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

  /**
   * The kind stored on a posted movement, for the permission check that cannot
   * trust the request (see `CashMovementService.requireKindPermission`).
   */
  findMovementKind(
    tx: Tx,
    ctx: TenantContext,
    movementId: string,
  ): Promise<CashMovementKind | null>;

  /** Money movements for the Finance lists, newest first. */
  listMovementHistory(
    tx: Tx,
    ctx: TenantContext,
    filter: MovementHistoryFilter,
  ): Promise<readonly MovementHistoryRow[]>;

  /** One account's balance at the end of a business date (INV-07, windowed). */
  balanceAsOf(
    tx: Tx,
    ctx: TenantContext,
    accountCode: string,
    asOf: string | null,
  ): Promise<number>;
}
