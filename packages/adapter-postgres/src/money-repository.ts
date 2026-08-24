import type {
  AccountOpeningCorrection,
  CashMovementRow,
  CashSessionCloseRow,
  CashSessionReopen,
  CashSessionRow,
  CashSessionTotalsRow,
  DailyCashFilter,
  MoneyAccountEdit,
  MoneyAccountRow,
  MoneyRepository,
  NewAccountOpening,
  NewCashMovement,
  NewCashSession,
  NewCashSessionClose,
  NewJournalEntry,
  NewMoneyAccount,
  StatementFilter,
  StatementLineRow,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { CashMovementKind, MoneyAccountStatus, MoneyAccountType } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';

import {
  accountOpenings,
  accounts,
  cashMovements,
  cashSessionCloses,
  cashSessions,
  journalEntries,
  journalLines,
  users,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Money accounts, days and movements (migration 0016). No business rule here
 * (R-B6) — what may be deactivated, who may reopen a day and what a difference
 * posts to are all decided in the services.
 *
 * The one thing this file owns is that **a balance is a query, never a column**.
 * Every account row below carries a `balanceMinor` computed in the same
 * statement as the row, because INV-07 defines the balance that way and a
 * cached copy would be a second answer waiting to disagree.
 */

/** Entries that are not the day's trading — see `MoneyRepository.sessionTotals`. */
const NON_TRADING_SOURCES = ['ACCOUNT_OPENING', 'ACCOUNT_OPENING_CORRECTION', 'CASH_SESSION_CLOSE', 'CASH_SESSION_REOPEN'];

export class PostgresMoneyRepository implements MoneyRepository {
  constructor(private readonly clock: Clock) {}

  /* ------------------------------------------------------------- accounts */

  async listAccounts(
    tx: Tx,
    ctx: TenantContext,
    filter: { readonly types: readonly MoneyAccountType[]; readonly includeInactive: boolean },
  ): Promise<readonly MoneyAccountRow[]> {
    if (filter.types.length === 0) return [];

    const rows = await txOf(tx)
      .select(this.accountSelection())
      .from(accounts)
      .leftJoin(
        accountOpenings,
        and(
          eq(accountOpenings.accountId, accounts.id),
          eq(accountOpenings.tenantId, accounts.tenantId),
          isNull(accountOpenings.deletedAt),
        ),
      )
      .where(
        and(
          eq(accounts.tenantId, ctx.tenantId),
          isNull(accounts.deletedAt),
          inArray(accounts.type, [...filter.types]),
          filter.includeInactive ? undefined : eq(accounts.status, 'ACTIVE'),
        ),
      )
      .orderBy(desc(accounts.isDrawer), asc(accounts.name));

    return rows.map(toAccountRow);
  }

  async findAccountById(
    tx: Tx,
    ctx: TenantContext,
    accountId: string,
  ): Promise<MoneyAccountRow | null> {
    const [row] = await txOf(tx)
      .select(this.accountSelection())
      .from(accounts)
      .leftJoin(
        accountOpenings,
        and(
          eq(accountOpenings.accountId, accounts.id),
          eq(accountOpenings.tenantId, accounts.tenantId),
          isNull(accountOpenings.deletedAt),
        ),
      )
      .where(
        and(
          eq(accounts.tenantId, ctx.tenantId),
          eq(accounts.id, accountId),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : toAccountRow(row);
  }

  async findDrawer(tx: Tx, ctx: TenantContext): Promise<MoneyAccountRow | null> {
    const [row] = await txOf(tx)
      .select(this.accountSelection())
      .from(accounts)
      .leftJoin(
        accountOpenings,
        and(
          eq(accountOpenings.accountId, accounts.id),
          eq(accountOpenings.tenantId, accounts.tenantId),
          isNull(accountOpenings.deletedAt),
        ),
      )
      .where(
        and(
          eq(accounts.tenantId, ctx.tenantId),
          eq(accounts.isDrawer, true),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : toAccountRow(row);
  }

  async insertAccount(tx: Tx, ctx: TenantContext, account: NewMoneyAccount): Promise<void> {
    const now = this.clock.now();

    await txOf(tx)
      .insert(accounts)
      .values({
        id: account.id,
        tenantId: ctx.tenantId,
        name: account.name,
        type: account.type,
        holderName: account.holderName,
        reference: account.reference,
        isDrawer: account.isDrawer,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });
  }

  /** D-32's optimistic lock: `false` means somebody else got there first. */
  async updateAccount(tx: Tx, ctx: TenantContext, account: MoneyAccountEdit): Promise<boolean> {
    const now = this.clock.now();

    const updated = await txOf(tx)
      .update(accounts)
      .set({
        name: account.name,
        type: account.type,
        holderName: account.holderName,
        reference: account.reference,
        isDrawer: account.isDrawer,
        status: account.status,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${accounts.version} + 1`,
      })
      .where(
        and(
          eq(accounts.tenantId, ctx.tenantId),
          eq(accounts.id, account.id),
          eq(accounts.version, account.expectedVersion),
          isNull(accounts.deletedAt),
        ),
      )
      .returning({ id: accounts.id });

    return updated.length === 1;
  }

  /* ------------------------------------------------------------- openings */

  async insertAccountOpening(
    tx: Tx,
    ctx: TenantContext,
    opening: NewAccountOpening,
  ): Promise<void> {
    const now = this.clock.now();

    await txOf(tx)
      .insert(accountOpenings)
      .values({
        id: opening.id,
        tenantId: ctx.tenantId,
        openingNumber: opening.number,
        accountId: opening.accountId,
        amountMinor: opening.amountMinor,
        businessDate: opening.businessDate,
        entryMode: opening.entryMode,
        status: 'POSTED',
        operationId: opening.operationId,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });

    await this.postJournal(tx, ctx, opening.journal);
  }

  /**
   * §2.5: the document takes the new figure and the **delta** posts alongside
   * the original entry. The original lines are never touched, which is why this
   * writes a second entry rather than updating the first.
   */
  async correctAccountOpening(
    tx: Tx,
    ctx: TenantContext,
    correction: AccountOpeningCorrection,
  ): Promise<boolean> {
    const now = this.clock.now();

    const updated = await txOf(tx)
      .update(accountOpenings)
      .set({
        amountMinor: correction.amountMinor,
        businessDate: correction.businessDate,
        entryMode: correction.entryMode,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${accountOpenings.version} + 1`,
      })
      .where(
        and(
          eq(accountOpenings.tenantId, ctx.tenantId),
          eq(accountOpenings.id, correction.openingId),
          eq(accountOpenings.version, correction.expectedVersion),
          isNull(accountOpenings.deletedAt),
        ),
      )
      .returning({ id: accountOpenings.id });

    if (updated.length !== 1) return false;

    await this.postJournal(tx, ctx, correction.journal);
    return true;
  }

  /* -------------------------------------------------------------- sessions */

  async findSessionByDate(
    tx: Tx,
    ctx: TenantContext,
    businessDate: string,
  ): Promise<CashSessionRow | null> {
    return this.oneSession(
      tx,
      and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.businessDate, businessDate)),
    );
  }

  async findOpenSession(tx: Tx, ctx: TenantContext): Promise<CashSessionRow | null> {
    return this.oneSession(
      tx,
      and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.status, 'OPEN')),
    );
  }

  async findSessionById(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<CashSessionRow | null> {
    return this.oneSession(
      tx,
      and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.id, sessionId)),
    );
  }

  async findPreviousClose(
    tx: Tx,
    ctx: TenantContext,
    beforeDate: string,
  ): Promise<CashSessionCloseRow | null> {
    const [row] = await txOf(tx)
      .select(this.closeSelection())
      .from(cashSessionCloses)
      .innerJoin(cashSessions, eq(cashSessions.id, cashSessionCloses.sessionId))
      .leftJoin(users, eq(users.id, cashSessionCloses.createdBy))
      .where(
        and(
          eq(cashSessionCloses.tenantId, ctx.tenantId),
          eq(cashSessionCloses.status, 'ACTIVE'),
          isNull(cashSessionCloses.deletedAt),
          lt(cashSessions.businessDate, beforeDate),
        ),
      )
      .orderBy(desc(cashSessions.businessDate))
      .limit(1);

    return row === undefined ? null : toCloseRow(row);
  }

  async insertSession(tx: Tx, ctx: TenantContext, session: NewCashSession): Promise<void> {
    const now = this.clock.now();

    await txOf(tx)
      .insert(cashSessions)
      .values({
        id: session.id,
        tenantId: ctx.tenantId,
        sessionNumber: session.number,
        accountId: session.accountId,
        businessDate: session.businessDate,
        status: 'OPEN',
        openingAmountMinor: session.openingAmountMinor,
        previousClosingMinor: session.previousClosingMinor,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });
  }

  async listSessions(
    tx: Tx,
    ctx: TenantContext,
    filter: DailyCashFilter,
  ): Promise<readonly (CashSessionRow & { readonly closes: readonly CashSessionCloseRow[] })[]> {
    const rows = await txOf(tx)
      .select(this.sessionSelection())
      .from(cashSessions)
      .innerJoin(accounts, eq(accounts.id, cashSessions.accountId))
      .leftJoin(users, eq(users.id, cashSessions.createdBy))
      .where(
        and(
          eq(cashSessions.tenantId, ctx.tenantId),
          isNull(cashSessions.deletedAt),
          filter.fromDate === null ? undefined : gte(cashSessions.businessDate, filter.fromDate),
          filter.toDate === null ? undefined : lte(cashSessions.businessDate, filter.toDate),
          // Newest first, so the cursor walks backwards through history.
          filter.cursor === null ? undefined : lt(cashSessions.businessDate, filter.cursor),
        ),
      )
      .orderBy(desc(cashSessions.businessDate))
      .limit(filter.limit);

    if (rows.length === 0) return [];

    const closes = await txOf(tx)
      .select(this.closeSelection())
      .from(cashSessionCloses)
      .innerJoin(cashSessions, eq(cashSessions.id, cashSessionCloses.sessionId))
      .leftJoin(users, eq(users.id, cashSessionCloses.createdBy))
      .where(
        and(
          eq(cashSessionCloses.tenantId, ctx.tenantId),
          isNull(cashSessionCloses.deletedAt),
          inArray(
            cashSessionCloses.sessionId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(desc(cashSessionCloses.createdAt));

    return rows.map((row) => ({
      ...toSessionRow(row),
      closes: closes.filter((close) => close.sessionId === row.id).map(toCloseRow),
    }));
  }

  /**
   * The day's cash in and cash out.
   *
   * Sums the drawer's journal lines for the session's business date, minus the
   * entries that are not the day's trading: the account's own opening, the
   * Start Day adjustment (already inside the counted opening), and the close's
   * shortage/overage and any reversal of it. The port documents why each one
   * would otherwise be counted twice.
   */
  async sessionTotals(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<CashSessionTotalsRow> {
    const [session] = await txOf(tx)
      .select({
        businessDate: cashSessions.businessDate,
        accountId: cashSessions.accountId,
        type: accounts.type,
      })
      .from(cashSessions)
      .innerJoin(accounts, eq(accounts.id, cashSessions.accountId))
      .where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.id, sessionId)))
      .limit(1);

    if (session === undefined) return { cashInMinor: 0, cashOutMinor: 0 };

    const accountCode = `${session.type === 'CASH' ? 'CASH' : 'BANK'}:${session.accountId}`;

    const [totals] = await txOf(tx)
      .select({
        cashInMinor: sql<number>`COALESCE(SUM(CASE WHEN ${journalLines.amountMinor} > 0 THEN ${journalLines.amountMinor} ELSE 0 END), 0)::bigint`,
        cashOutMinor: sql<number>`COALESCE(SUM(CASE WHEN ${journalLines.amountMinor} < 0 THEN -${journalLines.amountMinor} ELSE 0 END), 0)::bigint`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          eq(journalLines.accountCode, accountCode),
          eq(journalEntries.businessDate, session.businessDate),
          sql`${journalEntries.sourceDocumentType} NOT IN ${NON_TRADING_SOURCES}`,
          sql`NOT EXISTS (
            SELECT 1 FROM cash_movements m
            WHERE m.id = ${journalEntries.sourceDocumentId}
              AND m.tenant_id = ${ctx.tenantId}
              AND m.kind = 'OPENING_ADJUSTMENT'
          )`,
        ),
      );

    return {
      cashInMinor: Number(totals?.cashInMinor ?? 0),
      cashOutMinor: Number(totals?.cashOutMinor ?? 0),
    };
  }

  async findActiveClose(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<CashSessionCloseRow | null> {
    const [row] = await txOf(tx)
      .select(this.closeSelection())
      .from(cashSessionCloses)
      .innerJoin(cashSessions, eq(cashSessions.id, cashSessionCloses.sessionId))
      .leftJoin(users, eq(users.id, cashSessionCloses.createdBy))
      .where(
        and(
          eq(cashSessionCloses.tenantId, ctx.tenantId),
          eq(cashSessionCloses.sessionId, sessionId),
          eq(cashSessionCloses.status, 'ACTIVE'),
          isNull(cashSessionCloses.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : toCloseRow(row);
  }

  async listCloses(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<readonly CashSessionCloseRow[]> {
    const rows = await txOf(tx)
      .select(this.closeSelection())
      .from(cashSessionCloses)
      .innerJoin(cashSessions, eq(cashSessions.id, cashSessionCloses.sessionId))
      .leftJoin(users, eq(users.id, cashSessionCloses.createdBy))
      .where(
        and(
          eq(cashSessionCloses.tenantId, ctx.tenantId),
          eq(cashSessionCloses.sessionId, sessionId),
          isNull(cashSessionCloses.deletedAt),
        ),
      )
      .orderBy(desc(cashSessionCloses.createdAt));

    return rows.map(toCloseRow);
  }

  async closeSession(tx: Tx, ctx: TenantContext, close: NewCashSessionClose): Promise<void> {
    const now = this.clock.now();

    await txOf(tx)
      .insert(cashSessionCloses)
      .values({
        id: close.id,
        tenantId: ctx.tenantId,
        sessionId: close.sessionId,
        status: 'ACTIVE',
        openingAmountMinor: close.openingAmountMinor,
        cashInMinor: close.cashInMinor,
        cashOutMinor: close.cashOutMinor,
        expectedClosingMinor: close.expectedClosingMinor,
        countedClosingMinor: close.countedClosingMinor,
        differenceMinor: close.differenceMinor,
        differenceReason: close.differenceReason,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });

    await txOf(tx)
      .update(cashSessions)
      .set({
        status: 'CLOSED',
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${cashSessions.version} + 1`,
      })
      .where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.id, close.sessionId)));

    if (close.journal !== null) await this.postJournal(tx, ctx, close.journal);
  }

  /**
   * Undoing a close: supersede the row, post the reversal, reopen the session.
   *
   * The optimistic lock is on the close, not the session, because the close is
   * what is being undone — two people pressing reopen on the same standing
   * close must not both succeed and post two reversals of one posting.
   */
  async reopenSession(tx: Tx, ctx: TenantContext, reopen: CashSessionReopen): Promise<boolean> {
    const now = this.clock.now();

    const superseded = await txOf(tx)
      .update(cashSessionCloses)
      .set({
        status: 'SUPERSEDED',
        reopenReason: reopen.reason,
        supersededAt: now,
        supersededBy: ctx.userId,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${cashSessionCloses.version} + 1`,
      })
      .where(
        and(
          eq(cashSessionCloses.tenantId, ctx.tenantId),
          eq(cashSessionCloses.id, reopen.closeId),
          eq(cashSessionCloses.version, reopen.expectedVersion),
          eq(cashSessionCloses.status, 'ACTIVE'),
          isNull(cashSessionCloses.deletedAt),
        ),
      )
      .returning({ id: cashSessionCloses.id });

    if (superseded.length !== 1) return false;

    await txOf(tx)
      .update(cashSessions)
      .set({
        status: 'OPEN',
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${cashSessions.version} + 1`,
      })
      .where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.id, reopen.sessionId)));

    if (reopen.journal !== null) await this.postJournal(tx, ctx, reopen.journal);
    return true;
  }

  /* ------------------------------------------------------------- movements */

  async insertMovement(tx: Tx, ctx: TenantContext, movement: NewCashMovement): Promise<void> {
    const now = this.clock.now();

    await txOf(tx)
      .insert(cashMovements)
      .values({
        id: movement.id,
        tenantId: ctx.tenantId,
        movementNumber: movement.number,
        kind: movement.kind,
        fromAccountCode: movement.fromAccountCode,
        toAccountCode: movement.toAccountCode,
        amountMinor: movement.amountMinor,
        note: movement.note,
        sessionId: movement.sessionId,
        businessDate: movement.businessDate,
        entryMode: movement.entryMode,
        status: 'POSTED',
        operationId: movement.operationId,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });

    await this.postJournal(tx, ctx, movement.journal);
  }

  async listMovements(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<readonly CashMovementRow[]> {
    const rows = await txOf(tx)
      .select({
        id: cashMovements.id,
        number: cashMovements.movementNumber,
        kind: cashMovements.kind,
        fromAccountCode: cashMovements.fromAccountCode,
        toAccountCode: cashMovements.toAccountCode,
        amountMinor: cashMovements.amountMinor,
        businessDate: cashMovements.businessDate,
        note: cashMovements.note,
        createdAt: cashMovements.createdAt,
      })
      .from(cashMovements)
      .where(
        and(
          eq(cashMovements.tenantId, ctx.tenantId),
          eq(cashMovements.sessionId, sessionId),
          eq(cashMovements.status, 'POSTED'),
          isNull(cashMovements.deletedAt),
        ),
      )
      .orderBy(asc(cashMovements.createdAt));

    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      kind: row.kind as CashMovementKind,
      fromAccountCode: row.fromAccountCode,
      toAccountCode: row.toAccountCode,
      amountMinor: Number(row.amountMinor),
      businessDate: row.businessDate,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /* ------------------------------------------------------------- statement */

  async listStatementLines(
    tx: Tx,
    ctx: TenantContext,
    filter: StatementFilter,
  ): Promise<readonly StatementLineRow[]> {
    const rows = await txOf(tx)
      .select({
        journalLineId: journalLines.id,
        businessDate: journalEntries.businessDate,
        createdAt: journalLines.createdAt,
        sourceType: journalEntries.sourceDocumentType,
        sourceNumber: journalEntries.sourceNumber,
        amountMinor: journalLines.amountMinor,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          eq(journalLines.accountCode, filter.accountCode),
          filter.fromDate === null ? undefined : gte(journalEntries.businessDate, filter.fromDate),
          filter.toDate === null ? undefined : lte(journalEntries.businessDate, filter.toDate),
          filter.cursor === null ? undefined : sql`${journalLines.id} > ${filter.cursor}`,
        ),
      )
      .orderBy(asc(journalEntries.businessDate), asc(journalLines.id))
      .limit(filter.limit);

    return rows.map((row) => ({
      journalLineId: row.journalLineId,
      businessDate: row.businessDate,
      createdAt: row.createdAt.toISOString(),
      sourceType: row.sourceType,
      sourceNumber: row.sourceNumber,
      amountMinor: Number(row.amountMinor),
    }));
  }

  async sumStatementBefore(
    tx: Tx,
    ctx: TenantContext,
    filter: StatementFilter,
  ): Promise<number> {
    const [row] = await txOf(tx)
      .select({
        total: sql<number>`COALESCE(SUM(${journalLines.amountMinor}), 0)::bigint`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          eq(journalLines.accountCode, filter.accountCode),
          filter.fromDate === null
            ? filter.cursor === null
              ? sql`FALSE`
              : sql`${journalLines.id} <= ${filter.cursor}`
            : lt(journalEntries.businessDate, filter.fromDate),
        ),
      );

    return Number(row?.total ?? 0);
  }

  /* ------------------------------------------------------------- internals */

  /** One journal entry and its lines, written with the document that caused it. */
  private async postJournal(tx: Tx, ctx: TenantContext, journal: NewJournalEntry): Promise<void> {
    const now = this.clock.now();
    const owner = { tenantId: ctx.tenantId, createdAt: now, createdBy: ctx.userId };

    await txOf(tx)
      .insert(journalEntries)
      .values({
        id: journal.journalEntryId,
        ...owner,
        businessDate: journal.businessDate,
        sourceDocumentType: journal.sourceType,
        sourceDocumentId: journal.sourceId,
        sourceNumber: journal.sourceNumber,
        entryMode: journal.entryMode,
      });

    await txOf(tx)
      .insert(journalLines)
      .values(
        journal.lines.map((line) => ({
          id: line.id,
          ...owner,
          journalEntryId: journal.journalEntryId,
          accountCode: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
      );
  }

  private accountSelection() {
    return {
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      holderName: accounts.holderName,
      reference: accounts.reference,
      isDrawer: accounts.isDrawer,
      status: accounts.status,
      version: accounts.version,
      openingId: accountOpenings.id,
      openingAmountMinor: accountOpenings.amountMinor,
      openingDate: accountOpenings.businessDate,
      openingVersion: accountOpenings.version,
      /*
       * INV-07 in one subquery: the balance is the sum of the lines carrying
       * this account's code. Computed with the row so the list, the form and
       * the statement header cannot disagree about what is in the box.
       */
      balanceMinor: sql<number>`(
        SELECT COALESCE(SUM(l.amount_minor), 0)::bigint
        FROM journal_lines l
        WHERE l.tenant_id = ${accounts.tenantId}
          AND l.account_code = (CASE WHEN ${accounts.type} = 'CASH' THEN 'CASH:' ELSE 'BANK:' END) || ${accounts.id}
      )`,
    };
  }

  private sessionSelection() {
    return {
      id: cashSessions.id,
      number: cashSessions.sessionNumber,
      accountId: cashSessions.accountId,
      accountName: accounts.name,
      businessDate: cashSessions.businessDate,
      status: cashSessions.status,
      openingAmountMinor: cashSessions.openingAmountMinor,
      previousClosingMinor: cashSessions.previousClosingMinor,
      openedAt: cashSessions.createdAt,
      openedBy: cashSessions.createdBy,
      openedByName: users.displayName,
      version: cashSessions.version,
    };
  }

  private closeSelection() {
    return {
      id: cashSessionCloses.id,
      sessionId: cashSessionCloses.sessionId,
      status: cashSessionCloses.status,
      openingAmountMinor: cashSessionCloses.openingAmountMinor,
      cashInMinor: cashSessionCloses.cashInMinor,
      cashOutMinor: cashSessionCloses.cashOutMinor,
      expectedClosingMinor: cashSessionCloses.expectedClosingMinor,
      countedClosingMinor: cashSessionCloses.countedClosingMinor,
      differenceMinor: cashSessionCloses.differenceMinor,
      differenceReason: cashSessionCloses.differenceReason,
      reopenReason: cashSessionCloses.reopenReason,
      closedAt: cashSessionCloses.createdAt,
      closedBy: cashSessionCloses.createdBy,
      closedByName: users.displayName,
      supersededAt: cashSessionCloses.supersededAt,
      version: cashSessionCloses.version,
    };
  }

  private async oneSession(
    tx: Tx,
    where: ReturnType<typeof and>,
  ): Promise<CashSessionRow | null> {
    const [row] = await txOf(tx)
      .select(this.sessionSelection())
      .from(cashSessions)
      .innerJoin(accounts, eq(accounts.id, cashSessions.accountId))
      .leftJoin(users, eq(users.id, cashSessions.createdBy))
      .where(and(where, isNull(cashSessions.deletedAt)))
      .limit(1);

    return row === undefined ? null : toSessionRow(row);
  }
}


function toAccountRow(row: {
  id: string;
  name: string;
  type: string;
  holderName: string | null;
  reference: string | null;
  isDrawer: boolean;
  status: string;
  version: number;
  openingId: string | null;
  openingAmountMinor: number | null;
  openingDate: string | null;
  openingVersion: number | null;
  balanceMinor: number;
}): MoneyAccountRow {
  return {
    id: row.id,
    name: row.name,
    type: row.type as MoneyAccountType,
    holderName: row.holderName,
    reference: row.reference,
    isDrawer: row.isDrawer,
    status: row.status as MoneyAccountStatus,
    balanceMinor: Number(row.balanceMinor),
    openingAmountMinor: row.openingAmountMinor === null ? null : Number(row.openingAmountMinor),
    openingDate: row.openingDate,
    openingId: row.openingId,
    openingVersion: row.openingVersion,
    version: row.version,
  };
}

function toSessionRow(row: {
  id: string;
  number: string;
  accountId: string;
  accountName: string;
  businessDate: string;
  status: string;
  openingAmountMinor: number;
  previousClosingMinor: number | null;
  openedAt: Date;
  openedBy: string;
  openedByName: string | null;
  version: number;
}): CashSessionRow {
  return {
    id: row.id,
    number: row.number,
    accountId: row.accountId,
    accountName: row.accountName,
    businessDate: row.businessDate,
    status: row.status as 'OPEN' | 'CLOSED',
    openingAmountMinor: Number(row.openingAmountMinor),
    previousClosingMinor:
      row.previousClosingMinor === null ? null : Number(row.previousClosingMinor),
    openedAt: row.openedAt.toISOString(),
    openedBy: row.openedBy,
    openedByName: row.openedByName,
    version: row.version,
  };
}

function toCloseRow(row: {
  id: string;
  sessionId: string;
  status: string;
  openingAmountMinor: number;
  cashInMinor: number;
  cashOutMinor: number;
  expectedClosingMinor: number;
  countedClosingMinor: number;
  differenceMinor: number;
  differenceReason: string | null;
  reopenReason: string | null;
  closedAt: Date;
  closedBy: string;
  closedByName: string | null;
  supersededAt: Date | null;
  version: number;
}): CashSessionCloseRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status as 'ACTIVE' | 'SUPERSEDED',
    openingAmountMinor: Number(row.openingAmountMinor),
    cashInMinor: Number(row.cashInMinor),
    cashOutMinor: Number(row.cashOutMinor),
    expectedClosingMinor: Number(row.expectedClosingMinor),
    countedClosingMinor: Number(row.countedClosingMinor),
    differenceMinor: Number(row.differenceMinor),
    differenceReason: row.differenceReason,
    reopenReason: row.reopenReason,
    closedAt: row.closedAt.toISOString(),
    closedBy: row.closedBy,
    closedByName: row.closedByName,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    version: row.version,
  };
}
