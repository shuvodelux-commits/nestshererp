import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Everything reconciliation reads and writes (migration 0039, §5.17).
 *
 * **The write surface is the whole safety rule.** There is no method here that
 * touches `journal_entries`, `journal_lines` or any document table, and there
 * never may be: the four tables this port writes are statement files, statement
 * lines, reconciliations and matches. The journal appears only as `listLedger`
 * and `sumBefore` — reads, projections, and the sole contact with the ledger.
 *
 * A future need to post from reconciliation is not a new method here. It is the
 * owning module's use case, called from the screen.
 */

export interface ReconcilableAccount {
  readonly id: string;
  readonly name: string;
  readonly type: 'CASH' | 'BANK' | 'MFS';
  readonly accountCode: string;
}

/**
 * One journal line against the account, as the workspace shows it.
 *
 * `postingCount` is how many journal entries the source document has: one when
 * it was posted and never touched, more once it has been corrected or
 * cancelled. It is the **version snapshot** the later-edit rule (R-22) compares
 * against — uniform across every document type, and needing no union over nine
 * tables, because a change to a posted document is always another posting.
 */
export interface LedgerLineRow {
  readonly journalLineId: string;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly sourceType: string;
  readonly sourceNumber: string;
  readonly sourceDocumentId: string;
  readonly amountMinor: number;
  readonly postingCount: number;
}

export interface LedgerFilter {
  readonly accountCode: string;
  readonly fromDate: string;
  readonly toDate: string;
}

/** The same amount, on another account — the "possible wrong account" probe. */
export interface ForeignAccountLine {
  readonly accountId: string;
  readonly accountName: string;
  readonly sourceNumber: string;
  readonly amountMinor: number;
  readonly businessDate: string;
}

export interface ReconciliationRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: 'CASH' | 'BANK' | 'MFS';
  readonly accountCode: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly status: 'DRAFT' | 'COMPLETED' | 'REVIEW_REQUIRED';
  readonly statementOpeningMinor: number | null;
  readonly statementClosingMinor: number | null;
  readonly bookOpeningMinor: number | null;
  readonly reconciledBalanceMinor: number | null;
  readonly differenceMinor: number | null;
  readonly note: string | null;
  readonly completedAt: string | null;
  readonly completedBy: string | null;
  readonly completedByName: string | null;
  readonly version: number;
}

export interface NewReconciliation {
  readonly id: string;
  readonly accountId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly operationId: string;
}

export interface CompleteReconciliation {
  readonly id: string;
  readonly expectedVersion: number;
  readonly statementOpeningMinor: number | null;
  readonly statementClosingMinor: number;
  readonly bookOpeningMinor: number;
  readonly reconciledBalanceMinor: number;
  readonly differenceMinor: number;
  readonly note: string | null;
}

export interface ReopenReconciliation {
  readonly id: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface StatementFileRow {
  readonly id: string;
  readonly accountId: string;
  readonly reconciliationId: string | null;
  readonly fileName: string;
  readonly byteSize: number;
  readonly parseStatus: 'PARSED' | 'PARTIAL' | 'UNREADABLE';
  readonly parsedFromDate: string | null;
  readonly parsedToDate: string | null;
  readonly parsedOpeningMinor: number | null;
  readonly parsedClosingMinor: number | null;
  readonly problems: readonly { readonly lineNo: number; readonly text: string; readonly reason: string }[];
  readonly importedAt: string | null;
  readonly createdAt: string;
}

export interface NewStatementFile {
  readonly id: string;
  readonly accountId: string;
  readonly reconciliationId: string;
  readonly fileName: string;
  readonly content: Uint8Array;
  readonly parseStatus: 'PARSED' | 'PARTIAL' | 'UNREADABLE';
  readonly parsedFromDate: string | null;
  readonly parsedToDate: string | null;
  readonly parsedOpeningMinor: number | null;
  readonly parsedClosingMinor: number | null;
  readonly problems: readonly { readonly lineNo: number; readonly text: string; readonly reason: string }[];
}

export interface StatementLineRecord {
  readonly id: string;
  readonly fileId: string;
  readonly lineNo: number;
  readonly businessDate: string;
  readonly description: string;
  readonly reference: string | null;
  readonly amountMinor: number;
  readonly balanceMinor: number | null;
  readonly editedByUser: boolean;
}

export interface MatchRecord {
  readonly id: string;
  readonly reconciliationId: string;
  readonly statementLineId: string | null;
  readonly journalLineId: string | null;
  readonly state: 'AUTO' | 'CONFIRMED' | 'MANUAL' | 'REJECTED' | 'NEEDS_REVIEW' | 'OUTSTANDING';
  readonly score: number | null;
  readonly reasons: readonly { readonly label: string; readonly detail: string; readonly ok: boolean }[];
  readonly documentType: string | null;
  readonly documentId: string | null;
  /** The `postingCount` at the moment the link was made — see `LedgerLineRow`. */
  readonly documentVersion: number | null;
  readonly matchedAt: string;
  readonly matchedBy: string;
}

export type NewMatch = Omit<MatchRecord, 'matchedAt' | 'matchedBy'>;

export interface ReconciliationRepository {
  findAccount(tx: Tx, ctx: TenantContext, accountId: string): Promise<ReconcilableAccount | null>;

  /* ------------------------------------------------------ ledger, read only */
  listLedger(tx: Tx, ctx: TenantContext, filter: LedgerFilter): Promise<readonly LedgerLineRow[]>;
  /** The account's balance before the window opens (§3.9's opening figure). */
  sumBefore(tx: Tx, ctx: TenantContext, accountCode: string, fromDate: string): Promise<number>;
  /** Lines of the same amount on the shop's **other** money accounts. */
  findOnOtherAccounts(
    tx: Tx,
    ctx: TenantContext,
    filter: {
      readonly excludeAccountCode: string;
      readonly amountsMinor: readonly number[];
      readonly fromDate: string;
      readonly toDate: string;
    },
  ): Promise<readonly ForeignAccountLine[]>;

  /* ---------------------------------------------------------- reconciliation */
  findById(tx: Tx, ctx: TenantContext, id: string): Promise<ReconciliationRow | null>;
  findDraftForAccount(
    tx: Tx,
    ctx: TenantContext,
    accountId: string,
  ): Promise<ReconciliationRow | null>;
  list(
    tx: Tx,
    ctx: TenantContext,
    filter: { readonly accountId: string | null },
  ): Promise<readonly ReconciliationRow[]>;
  insert(tx: Tx, ctx: TenantContext, reconciliation: NewReconciliation): Promise<void>;
  /** False when somebody else moved it first (D-32's optimistic lock). */
  complete(tx: Tx, ctx: TenantContext, input: CompleteReconciliation): Promise<boolean>;
  reopen(tx: Tx, ctx: TenantContext, input: ReopenReconciliation): Promise<boolean>;

  /* ------------------------------------------------------------- statements */
  insertFile(tx: Tx, ctx: TenantContext, file: NewStatementFile): Promise<void>;
  findFile(tx: Tx, ctx: TenantContext, fileId: string): Promise<StatementFileRow | null>;
  /** The bytes as uploaded — the evidence, never regenerated (§5.17). */
  readFileContent(tx: Tx, ctx: TenantContext, fileId: string): Promise<Uint8Array | null>;
  listFiles(
    tx: Tx,
    ctx: TenantContext,
    reconciliationId: string,
  ): Promise<readonly StatementFileRow[]>;
  markFileImported(tx: Tx, ctx: TenantContext, fileId: string): Promise<void>;

  replaceLines(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly reconciliationId: string;
      readonly fileId: string;
      readonly lines: readonly StatementLineRecord[];
    },
  ): Promise<void>;
  listLines(
    tx: Tx,
    ctx: TenantContext,
    reconciliationId: string,
  ): Promise<readonly StatementLineRecord[]>;

  /* ---------------------------------------------------------------- matches */
  listMatches(
    tx: Tx,
    ctx: TenantContext,
    reconciliationId: string,
  ): Promise<readonly MatchRecord[]>;
  insertMatches(tx: Tx, ctx: TenantContext, matches: readonly NewMatch[]): Promise<void>;
  deleteMatch(tx: Tx, ctx: TenantContext, matchId: string): Promise<boolean>;
}
