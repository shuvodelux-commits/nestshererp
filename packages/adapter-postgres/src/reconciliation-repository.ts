import type {
  CompleteReconciliation,
  ForeignAccountLine,
  LedgerFilter,
  LedgerLineRow,
  MatchRecord,
  NewMatch,
  NewReconciliation,
  NewStatementFile,
  ReconcilableAccount,
  ReconciliationRepository,
  ReconciliationRow,
  ReopenReconciliation,
  StatementFileRow,
  StatementLineRecord,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, asc, desc, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';

import {
  accountReconciliations,
  accounts,
  bankStatementFiles,
  journalEntries,
  journalLines,
  reconciliationMatches,
  statementLines,
  users,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Account reconciliation storage (migration 0039, §5.17).
 *
 * **Read the write methods.** `insertFile`, `replaceLines`, `insert`,
 * `complete`, `reopen`, `insertMatches`, `deleteMatch`, `markFileImported` —
 * every one of them touches a reconciliation table and nothing else. The
 * journal appears in `listLedger`, `sumBefore` and `findOnOtherAccounts`, and
 * all three are SELECTs. This file is where the module's "compares and links,
 * never posts" rule stops being a promise and becomes something a reader can
 * check in a minute.
 *
 * No business rule here (R-B6): what may be matched, when a reconciliation may
 * be completed and what makes it need review are decided in the service.
 */

/** A money account's journal code, the way §2.4 parameterises them. */
function accountCodeOf(type: string, id: string): string {
  return `${type === 'CASH' ? 'CASH' : 'BANK'}:${id}`;
}

export class PostgresReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly clock: Clock) {}

  async findAccount(
    tx: Tx,
    ctx: TenantContext,
    accountId: string,
  ): Promise<ReconcilableAccount | null> {
    const [row] = await txOf(tx)
      .select({ id: accounts.id, name: accounts.name, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, accountId)))
      .limit(1);

    if (row === undefined) return null;

    const type = row.type as 'CASH' | 'BANK' | 'MFS';
    return { id: row.id, name: row.name, type, accountCode: accountCodeOf(type, row.id) };
  }

  /* ------------------------------------------------------- ledger, read only */

  async listLedger(
    tx: Tx,
    ctx: TenantContext,
    filter: LedgerFilter,
  ): Promise<readonly LedgerLineRow[]> {
    /*
     * `postingCount` is the number of journal entries the source document has.
     * One means posted and untouched; two or more means it has been corrected
     * or cancelled since. It is counted here, in the same statement as the row,
     * for the same reason an account balance is (INV-07): a stored copy is a
     * second answer waiting to disagree — and this particular copy is what the
     * later-edit rule depends on being true.
     */
    const postings = sql<number>`(
      SELECT COUNT(*) FROM ${journalEntries} AS je
      WHERE je.tenant_id = ${journalEntries.tenantId}
        AND je.source_document_id = ${journalEntries.sourceDocumentId}
    )`;

    const rows = await txOf(tx)
      .select({
        journalLineId: journalLines.id,
        businessDate: journalEntries.businessDate,
        createdAt: journalLines.createdAt,
        sourceType: journalEntries.sourceDocumentType,
        sourceNumber: journalEntries.sourceNumber,
        sourceDocumentId: journalEntries.sourceDocumentId,
        amountMinor: journalLines.amountMinor,
        postingCount: postings,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          eq(journalLines.accountCode, filter.accountCode),
          gte(journalEntries.businessDate, filter.fromDate),
          lte(journalEntries.businessDate, filter.toDate),
        ),
      )
      .orderBy(asc(journalEntries.businessDate), asc(journalLines.id));

    return rows.map((row) => ({
      journalLineId: row.journalLineId,
      businessDate: row.businessDate,
      createdAt: row.createdAt.toISOString(),
      sourceType: row.sourceType,
      sourceNumber: row.sourceNumber,
      sourceDocumentId: row.sourceDocumentId,
      amountMinor: Number(row.amountMinor),
      postingCount: Number(row.postingCount),
    }));
  }

  async sumBefore(
    tx: Tx,
    ctx: TenantContext,
    accountCode: string,
    fromDate: string,
  ): Promise<number> {
    const [row] = await txOf(tx)
      .select({ total: sql<number>`COALESCE(SUM(${journalLines.amountMinor}), 0)::bigint` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          eq(journalLines.accountCode, accountCode),
          lt(journalEntries.businessDate, fromDate),
        ),
      );

    return Number(row?.total ?? 0);
  }

  async findOnOtherAccounts(
    tx: Tx,
    ctx: TenantContext,
    filter: {
      readonly excludeAccountCode: string;
      readonly amountsMinor: readonly number[];
      readonly fromDate: string;
      readonly toDate: string;
    },
  ): Promise<readonly ForeignAccountLine[]> {
    if (filter.amountsMinor.length === 0) return [];

    /*
     * The "possible wrong account" probe. It joins the journal line's account
     * code back to the account it names, so only the shop's own cash, bank and
     * MFS accounts can produce a warning — a matching amount sitting on an
     * income or expense account is not a transaction posted to the wrong bank.
     */
    const rows = await txOf(tx)
      .select({
        accountId: accounts.id,
        accountName: accounts.name,
        sourceNumber: journalEntries.sourceNumber,
        amountMinor: journalLines.amountMinor,
        businessDate: journalEntries.businessDate,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(
        accounts,
        and(
          eq(accounts.tenantId, journalLines.tenantId),
          sql`${journalLines.accountCode} = CASE WHEN ${accounts.type} = 'CASH' THEN 'CASH:'
            WHEN ${accounts.type} = 'LOAN' THEN 'LOAN:' ELSE 'BANK:' END || ${accounts.id}`,
        ),
      )
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          ne(journalLines.accountCode, filter.excludeAccountCode),
          inArray(journalLines.amountMinor, [...filter.amountsMinor]),
          gte(journalEntries.businessDate, filter.fromDate),
          lte(journalEntries.businessDate, filter.toDate),
        ),
      )
      .limit(50);

    return rows.map((row) => ({
      accountId: row.accountId,
      accountName: row.accountName,
      sourceNumber: row.sourceNumber,
      amountMinor: Number(row.amountMinor),
      businessDate: row.businessDate,
    }));
  }

  /* ----------------------------------------------------------- reconciliation */

  async findById(tx: Tx, ctx: TenantContext, id: string): Promise<ReconciliationRow | null> {
    const rows = await this.selectReconciliations(tx, [
      eq(accountReconciliations.tenantId, ctx.tenantId),
      eq(accountReconciliations.id, id),
    ]);

    return rows[0] ?? null;
  }

  async findDraftForAccount(
    tx: Tx,
    ctx: TenantContext,
    accountId: string,
  ): Promise<ReconciliationRow | null> {
    const rows = await this.selectReconciliations(tx, [
      eq(accountReconciliations.tenantId, ctx.tenantId),
      eq(accountReconciliations.accountId, accountId),
      eq(accountReconciliations.status, 'DRAFT'),
    ]);

    return rows[0] ?? null;
  }

  async list(
    tx: Tx,
    ctx: TenantContext,
    filter: { readonly accountId: string | null },
  ): Promise<readonly ReconciliationRow[]> {
    return this.selectReconciliations(tx, [
      eq(accountReconciliations.tenantId, ctx.tenantId),
      ...(filter.accountId === null
        ? []
        : [eq(accountReconciliations.accountId, filter.accountId)]),
    ]);
  }

  async insert(tx: Tx, ctx: TenantContext, reconciliation: NewReconciliation): Promise<void> {
    const now = this.clock.now();

    await txOf(tx).insert(accountReconciliations).values({
      id: reconciliation.id,
      tenantId: ctx.tenantId,
      accountId: reconciliation.accountId,
      fromDate: reconciliation.fromDate,
      toDate: reconciliation.toDate,
      status: 'DRAFT',
      statementOpeningMinor: null,
      statementClosingMinor: null,
      bookOpeningMinor: null,
      reconciledBalanceMinor: null,
      differenceMinor: null,
      note: null,
      completedAt: null,
      completedBy: null,
      reopenedReason: null,
      operationId: reconciliation.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  async complete(
    tx: Tx,
    ctx: TenantContext,
    input: CompleteReconciliation,
  ): Promise<boolean> {
    const now = this.clock.now();

    const updated = await txOf(tx)
      .update(accountReconciliations)
      .set({
        status: 'COMPLETED',
        statementOpeningMinor: input.statementOpeningMinor,
        statementClosingMinor: input.statementClosingMinor,
        bookOpeningMinor: input.bookOpeningMinor,
        reconciledBalanceMinor: input.reconciledBalanceMinor,
        differenceMinor: input.differenceMinor,
        note: input.note,
        completedAt: now,
        completedBy: ctx.userId,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${accountReconciliations.version} + 1`,
      })
      .where(
        and(
          eq(accountReconciliations.tenantId, ctx.tenantId),
          eq(accountReconciliations.id, input.id),
          eq(accountReconciliations.version, input.expectedVersion),
          eq(accountReconciliations.status, 'DRAFT'),
        ),
      )
      .returning({ id: accountReconciliations.id });

    return updated.length === 1;
  }

  async reopen(tx: Tx, ctx: TenantContext, input: ReopenReconciliation): Promise<boolean> {
    const now = this.clock.now();

    /*
     * Reopening keeps every figure the sign-off wrote. The status changes and
     * the reason is recorded; what was certified stays on the row, because
     * §5.17 is explicit that reconciliation history is never silently
     * rewritten — including by the person undoing it.
     */
    const updated = await txOf(tx)
      .update(accountReconciliations)
      .set({
        status: 'DRAFT',
        reopenedReason: input.reason,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${accountReconciliations.version} + 1`,
      })
      .where(
        and(
          eq(accountReconciliations.tenantId, ctx.tenantId),
          eq(accountReconciliations.id, input.id),
          eq(accountReconciliations.version, input.expectedVersion),
          ne(accountReconciliations.status, 'DRAFT'),
        ),
      )
      .returning({ id: accountReconciliations.id });

    return updated.length === 1;
  }

  /* --------------------------------------------------------------- statements */

  async insertFile(tx: Tx, ctx: TenantContext, file: NewStatementFile): Promise<void> {
    const now = this.clock.now();

    await txOf(tx).insert(bankStatementFiles).values({
      id: file.id,
      tenantId: ctx.tenantId,
      accountId: file.accountId,
      reconciliationId: file.reconciliationId,
      fileName: file.fileName,
      byteSize: file.content.byteLength,
      content: Buffer.from(file.content),
      parseStatus: file.parseStatus,
      parsedFromDate: file.parsedFromDate,
      parsedToDate: file.parsedToDate,
      parsedOpeningMinor: file.parsedOpeningMinor,
      parsedClosingMinor: file.parsedClosingMinor,
      problemsJson: file.problems,
      importedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  async findFile(tx: Tx, ctx: TenantContext, fileId: string): Promise<StatementFileRow | null> {
    const rows = await this.selectFiles(tx, [
      eq(bankStatementFiles.tenantId, ctx.tenantId),
      eq(bankStatementFiles.id, fileId),
    ]);

    return rows[0] ?? null;
  }

  async listFiles(
    tx: Tx,
    ctx: TenantContext,
    reconciliationId: string,
  ): Promise<readonly StatementFileRow[]> {
    return this.selectFiles(tx, [
      eq(bankStatementFiles.tenantId, ctx.tenantId),
      eq(bankStatementFiles.reconciliationId, reconciliationId),
    ]);
  }

  /** The bytes are read only when somebody asks for them — they are large. */
  async readFileContent(
    tx: Tx,
    ctx: TenantContext,
    fileId: string,
  ): Promise<Uint8Array | null> {
    const [row] = await txOf(tx)
      .select({ content: bankStatementFiles.content })
      .from(bankStatementFiles)
      .where(
        and(eq(bankStatementFiles.tenantId, ctx.tenantId), eq(bankStatementFiles.id, fileId)),
      )
      .limit(1);

    return row === undefined ? null : new Uint8Array(row.content);
  }

  async markFileImported(tx: Tx, ctx: TenantContext, fileId: string): Promise<void> {
    const now = this.clock.now();

    await txOf(tx)
      .update(bankStatementFiles)
      .set({ importedAt: now, updatedAt: now, updatedBy: ctx.userId })
      .where(
        and(eq(bankStatementFiles.tenantId, ctx.tenantId), eq(bankStatementFiles.id, fileId)),
      );
  }

  async replaceLines(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly reconciliationId: string;
      readonly fileId: string;
      readonly lines: readonly StatementLineRecord[];
    },
  ): Promise<void> {
    const now = this.clock.now();

    // Re-importing the same file replaces its reading of the statement. The
    // service refuses this once anything has been matched, so no link is ever
    // orphaned by it.
    await txOf(tx)
      .delete(statementLines)
      .where(
        and(eq(statementLines.tenantId, ctx.tenantId), eq(statementLines.fileId, input.fileId)),
      );

    if (input.lines.length === 0) return;

    await txOf(tx)
      .insert(statementLines)
      .values(
        input.lines.map((line) => ({
          id: line.id,
          tenantId: ctx.tenantId,
          fileId: input.fileId,
          reconciliationId: input.reconciliationId,
          lineNo: line.lineNo,
          businessDate: line.businessDate,
          description: line.description,
          reference: line.reference,
          amountMinor: line.amountMinor,
          balanceMinor: line.balanceMinor,
          editedByUser: line.editedByUser,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
        })),
      );
  }

  async listLines(
    tx: Tx,
    ctx: TenantContext,
    reconciliationId: string,
  ): Promise<readonly StatementLineRecord[]> {
    const rows = await txOf(tx)
      .select()
      .from(statementLines)
      .where(
        and(
          eq(statementLines.tenantId, ctx.tenantId),
          eq(statementLines.reconciliationId, reconciliationId),
        ),
      )
      .orderBy(asc(statementLines.lineNo), asc(statementLines.id));

    return rows.map((row) => ({
      id: row.id,
      fileId: row.fileId,
      lineNo: row.lineNo,
      businessDate: row.businessDate,
      description: row.description,
      reference: row.reference,
      amountMinor: Number(row.amountMinor),
      balanceMinor: row.balanceMinor === null ? null : Number(row.balanceMinor),
      editedByUser: row.editedByUser,
    }));
  }

  /* ------------------------------------------------------------------ matches */

  async listMatches(
    tx: Tx,
    ctx: TenantContext,
    reconciliationId: string,
  ): Promise<readonly MatchRecord[]> {
    const rows = await txOf(tx)
      .select()
      .from(reconciliationMatches)
      .where(
        and(
          eq(reconciliationMatches.tenantId, ctx.tenantId),
          eq(reconciliationMatches.reconciliationId, reconciliationId),
        ),
      )
      .orderBy(asc(reconciliationMatches.id));

    return rows.map((row) => ({
      id: row.id,
      reconciliationId: row.reconciliationId,
      statementLineId: row.statementLineId,
      journalLineId: row.journalLineId,
      state: row.state as MatchRecord['state'],
      score: row.score,
      reasons: row.reasonsJson as MatchRecord['reasons'],
      documentType: row.documentType,
      documentId: row.documentId,
      documentVersion: row.documentVersion,
      matchedAt: row.matchedAt.toISOString(),
      matchedBy: row.matchedBy,
    }));
  }

  async insertMatches(tx: Tx, ctx: TenantContext, matches: readonly NewMatch[]): Promise<void> {
    if (matches.length === 0) return;
    const now = this.clock.now();

    await txOf(tx)
      .insert(reconciliationMatches)
      .values(
        matches.map((match) => ({
          id: match.id,
          tenantId: ctx.tenantId,
          reconciliationId: match.reconciliationId,
          statementLineId: match.statementLineId,
          journalLineId: match.journalLineId,
          state: match.state,
          score: match.score,
          reasonsJson: match.reasons,
          documentType: match.documentType,
          documentId: match.documentId,
          documentVersion: match.documentVersion,
          matchedAt: now,
          matchedBy: ctx.userId,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
        })),
      );
  }

  async deleteMatch(tx: Tx, ctx: TenantContext, matchId: string): Promise<boolean> {
    const removed = await txOf(tx)
      .delete(reconciliationMatches)
      .where(
        and(
          eq(reconciliationMatches.tenantId, ctx.tenantId),
          eq(reconciliationMatches.id, matchId),
        ),
      )
      .returning({ id: reconciliationMatches.id });

    return removed.length === 1;
  }

  /* -------------------------------------------------------------- internals */

  private async selectReconciliations(
    tx: Tx,
    conditions: readonly ReturnType<typeof eq>[],
  ): Promise<readonly ReconciliationRow[]> {
    const rows = await txOf(tx)
      .select({
        row: accountReconciliations,
        accountName: accounts.name,
        accountType: accounts.type,
        completedByName: users.displayName,
      })
      .from(accountReconciliations)
      .innerJoin(
        accounts,
        and(
          eq(accounts.id, accountReconciliations.accountId),
          eq(accounts.tenantId, accountReconciliations.tenantId),
        ),
      )
      .leftJoin(users, eq(users.id, accountReconciliations.completedBy))
      .where(and(...conditions))
      .orderBy(desc(accountReconciliations.toDate), desc(accountReconciliations.id));

    return rows.map(({ row, accountName, accountType, completedByName }) => {
      const type = accountType as 'CASH' | 'BANK' | 'MFS';
      return {
        id: row.id,
        accountId: row.accountId,
        accountName,
        accountType: type,
        accountCode: accountCodeOf(type, row.accountId),
        fromDate: row.fromDate,
        toDate: row.toDate,
        status: row.status as ReconciliationRow['status'],
        statementOpeningMinor:
          row.statementOpeningMinor === null ? null : Number(row.statementOpeningMinor),
        statementClosingMinor:
          row.statementClosingMinor === null ? null : Number(row.statementClosingMinor),
        bookOpeningMinor: row.bookOpeningMinor === null ? null : Number(row.bookOpeningMinor),
        reconciledBalanceMinor:
          row.reconciledBalanceMinor === null ? null : Number(row.reconciledBalanceMinor),
        differenceMinor: row.differenceMinor === null ? null : Number(row.differenceMinor),
        note: row.note,
        completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
        completedBy: row.completedBy,
        completedByName,
        version: row.version,
      };
    });
  }

  private async selectFiles(
    tx: Tx,
    conditions: readonly ReturnType<typeof eq>[],
  ): Promise<readonly StatementFileRow[]> {
    const rows = await txOf(tx)
      .select({
        id: bankStatementFiles.id,
        accountId: bankStatementFiles.accountId,
        reconciliationId: bankStatementFiles.reconciliationId,
        fileName: bankStatementFiles.fileName,
        byteSize: bankStatementFiles.byteSize,
        parseStatus: bankStatementFiles.parseStatus,
        parsedFromDate: bankStatementFiles.parsedFromDate,
        parsedToDate: bankStatementFiles.parsedToDate,
        parsedOpeningMinor: bankStatementFiles.parsedOpeningMinor,
        parsedClosingMinor: bankStatementFiles.parsedClosingMinor,
        problemsJson: bankStatementFiles.problemsJson,
        importedAt: bankStatementFiles.importedAt,
        createdAt: bankStatementFiles.createdAt,
      })
      .from(bankStatementFiles)
      .where(and(...conditions))
      .orderBy(asc(bankStatementFiles.createdAt));

    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      reconciliationId: row.reconciliationId,
      fileName: row.fileName,
      byteSize: row.byteSize,
      parseStatus: row.parseStatus as StatementFileRow['parseStatus'],
      parsedFromDate: row.parsedFromDate,
      parsedToDate: row.parsedToDate,
      parsedOpeningMinor: row.parsedOpeningMinor === null ? null : Number(row.parsedOpeningMinor),
      parsedClosingMinor: row.parsedClosingMinor === null ? null : Number(row.parsedClosingMinor),
      problems: row.problemsJson as StatementFileRow['problems'],
      importedAt: row.importedAt === null ? null : row.importedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
