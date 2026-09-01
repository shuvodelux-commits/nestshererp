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
  MovementHistoryFilter,
  MovementHistoryRow,
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
  RepostCashMovement,
} from '@sher/core-application';
import type { CashMovementKind, MoneyAccountStatus, MoneyAccountType } from '@sher/core-domain';
import { parseInstant } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

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
 * `created_at` comes back as a string from a raw statement and as a `Date` from
 * the query builder, so the two Finance history reads normalise it here. The
 * parse goes through `shared-utils`, the only file allowed to touch `Date`
 * (R-C8) — the same helper `daybook-repository` and `report-repository` keep
 * for the same reason.
 */
function instant(value: unknown): Date {
  if (value instanceof Date) return value;
  return parseInstant(typeof value === 'string' ? value : null) ?? EPOCH;
}

const EPOCH = parseInstant('1970-01-01T00:00:00.000Z') as Date;

/**
 * A bound `IN` list for a raw statement.
 *
 * Not `= ANY($1)` with a JS array: the driver binds the array as one parameter
 * and Postgres answers "op ANY/ALL (array) requires array on right side",
 * because what arrives is a scalar. One placeholder per value is what the rest
 * of this adapter does (`daybook-repository`), and it keeps every value bound
 * rather than interpolated.
 *
 * An empty list becomes `IN (NULL)` rather than `IN ()`, which is a syntax
 * error: `x IN (NULL)` is never true, which is exactly what "this person can
 * see no such account" should mean. A caller with nothing visible therefore
 * gets no rows instead of a 500.
 */
function list(values: readonly string[]): SQL {
  if (values.length === 0) return sql`NULL`;
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

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

/**
 * The journal family an account row posts to (§2.4, Finance module).
 *
 * One expression, used everywhere a row is turned into an account code, because
 * the mapping is no longer "cash or not cash": a loan posts to `LOAN:{id}`, and
 * a query that still assumed two families would read every loan as a bank
 * account that happens to be empty.
 */
const ACCOUNT_CODE_PREFIX = sql`(CASE WHEN ${accounts.type} = 'CASH' THEN 'CASH:'
  WHEN ${accounts.type} = 'LOAN' THEN 'LOAN:' ELSE 'BANK:' END)`;

/** Entries that are not the day's trading — see `MoneyRepository.sessionTotals`. */
const NON_TRADING_SOURCES = ['ACCOUNT_OPENING', 'ACCOUNT_OPENING_CORRECTION', 'CASH_SESSION_CLOSE', 'CASH_SESSION_REOPEN'];

export class PostgresMoneyRepository implements MoneyRepository {
  constructor(private readonly clock: Clock) {}

  /* ------------------------------------------------------------- accounts */

  async listAccounts(
    tx: Tx,
    ctx: TenantContext,
    filter: {
      readonly types: readonly MoneyAccountType[];
      readonly includeInactive: boolean;
      readonly asOf?: string | null;
    },
  ): Promise<readonly MoneyAccountRow[]> {
    if (filter.types.length === 0) return [];

    const rows = await txOf(tx)
      .select(this.accountSelection(filter.asOf ?? null))
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
        reference: movement.reference,
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

  async repostMovement(
    tx: Tx,
    ctx: TenantContext,
    movement: RepostCashMovement,
  ): Promise<boolean> {
    const now = this.clock.now();

    // Back to POSTED from the VOIDED the reversal left moments ago, in the same
    // transaction — so no reader ever sees the movement cancelled or missing.
    const updated = await txOf(tx)
      .update(cashMovements)
      .set({
        kind: movement.kind,
        fromAccountCode: movement.fromAccountCode,
        toAccountCode: movement.toAccountCode,
        amountMinor: movement.amountMinor,
        reference: movement.reference,
        note: movement.note,
        sessionId: movement.sessionId,
        businessDate: movement.businessDate,
        entryMode: movement.entryMode,
        correctionReason: movement.correctionReason,
        originalBusinessDate: movement.originalBusinessDate,
        status: 'POSTED',
        voidReason: null,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: movement.expectedVersion + 1,
      })
      .where(
        and(
          eq(cashMovements.tenantId, ctx.tenantId),
          eq(cashMovements.id, movement.id),
          eq(cashMovements.version, movement.expectedVersion),
        ),
      )
      .returning({ id: cashMovements.id });
    if (updated.length === 0) return false;

    await this.postJournal(tx, ctx, movement.journal);
    return true;
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

  /**
   * One account's ledger lines, with what it takes to describe them.
   *
   * Raw SQL rather than the query builder because of the three lateral joins,
   * and they are here rather than in five follow-up queries because a ledger
   * row has to say *what happened*: a journal line knows an amount and an
   * account code, and the **other side of the same entry** is what names the
   * event — the party on a sale, the account on a transfer, the category on an
   * expense. Reading them per row would be a query per line on a page of two
   * hundred.
   *
   * The search and the family filter run here for the reason the owner chose
   * on 2026-08-31: filtering in the browser would search only the page already
   * downloaded, and the totals under the table would stop describing what is
   * above it.
   */
  async listStatementLines(
    tx: Tx,
    ctx: TenantContext,
    filter: StatementFilter,
  ): Promise<readonly StatementLineRow[]> {
    const rows = await txOf(tx).execute<StatementRecord>(sql`
      SELECT jl.id AS journal_line_id,
             je.business_date::text AS business_date,
             jl.created_at AS created_at,
             je.source_document_type AS source_type,
             je.source_number AS source_number,
             je.source_document_id AS source_id,
             jl.amount_minor::text AS amount_minor,
             pa.name AS counterparty_name,
             oa.name AS other_account_name,
             ec.name AS expense_category_name,
             cm.reference AS movement_reference,
             cm.note AS movement_note,
             cm.kind AS movement_kind
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        LEFT JOIN LATERAL (
          SELECT l2.account_code, l2.party_id
            FROM journal_lines l2
           WHERE l2.tenant_id = jl.tenant_id
             AND l2.journal_entry_id = je.id
             AND l2.id <> jl.id
           ORDER BY (CASE WHEN l2.party_id IS NOT NULL THEN 0 ELSE 1 END), l2.id
           LIMIT 1
        ) other ON TRUE
        LEFT JOIN parties pa ON pa.tenant_id = jl.tenant_id AND pa.id = other.party_id
        LEFT JOIN accounts oa ON oa.tenant_id = jl.tenant_id
             AND other.account_code LIKE ANY (ARRAY['CASH:%', 'BANK:%', 'LOAN:%'])
             AND oa.id = split_part(other.account_code, ':', 2)
        LEFT JOIN expense_categories ec ON ec.tenant_id = jl.tenant_id
             AND other.account_code LIKE 'EXPENSE:%'
             AND ec.id = split_part(other.account_code, ':', 2)
        LEFT JOIN cash_movements cm ON cm.tenant_id = jl.tenant_id
             AND cm.id = je.source_document_id
             AND je.source_document_type LIKE 'CASH_MOVEMENT%'
       WHERE jl.tenant_id = ${ctx.tenantId}
         AND jl.account_code = ${filter.accountCode}
         ${filter.fromDate === null ? sql`` : sql`AND je.business_date >= ${filter.fromDate}`}
         ${filter.toDate === null ? sql`` : sql`AND je.business_date <= ${filter.toDate}`}
         ${filter.cursor === null ? sql`` : sql`AND jl.id > ${filter.cursor}`}
         ${statementKindClause(filter.kind)}
         ${
           filter.search === null
             ? sql``
             : sql`AND (je.source_number ILIKE ${'%' + filter.search + '%'}
                     OR cm.reference ILIKE ${'%' + filter.search + '%'}
                     OR cm.note ILIKE ${'%' + filter.search + '%'}
                     OR pa.name ILIKE ${'%' + filter.search + '%'}
                     OR oa.name ILIKE ${'%' + filter.search + '%'}
                     OR ec.name ILIKE ${'%' + filter.search + '%'})`
         }
       ORDER BY je.business_date ASC, jl.id ASC
       LIMIT ${filter.limit}
    `);

    return rows.rows.map((row) => ({
      journalLineId: row.journal_line_id,
      businessDate: row.business_date,
      createdAt: instant(row.created_at).toISOString(),
      sourceType: row.source_type,
      sourceNumber: row.source_number,
      sourceId: row.source_id,
      amountMinor: Number(row.amount_minor),
      counterpartyName: row.counterparty_name,
      otherAccountName: row.other_account_name,
      expenseCategoryName: row.expense_category_name,
      movementReference: row.movement_reference,
      movementNote: row.movement_note,
      movementKind: row.movement_kind,
    }));
  }

  /**
   * What the account held before the window opened.
   *
   * Deliberately **not** filtered by the search or the family filter: the
   * opening balance is a fact about the account on that date, and narrowing it
   * to "the rows matching DEP-83" would produce a running balance that starts
   * from a number the shop has never held.
   */
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

  /* ------------------------------------------------- Finance money movements */

  /**
   * The movements behind the Transfer Money list and the two Capital & Loans
   * sections (Finance module, owner decision 2026-08-31).
   *
   * Cancelled movements stay in the list rather than being filtered out: the
   * shopkeeper is looking for a transfer they remember making, and one that
   * silently vanished because somebody undid it is the row they most need to
   * find. The status column is what tells them.
   */
  async listMovementHistory(
    tx: Tx,
    ctx: TenantContext,
    filter: MovementHistoryFilter,
  ): Promise<readonly MovementHistoryRow[]> {
    if (filter.kinds.length === 0) return [];

    const rows = await txOf(tx).execute<MovementRecord>(sql`
      SELECT cm.id,
             cm.movement_number AS number,
             cm.kind,
             cm.business_date::text AS business_date,
             cm.from_account_code,
             cm.to_account_code,
             cm.amount_minor::text AS amount_minor,
             cm.reference,
             cm.note,
             cm.status,
             cm.correction_reason,
             cm.created_at,
             cm.version,
             u.display_name AS created_by_name,
             fa.name AS from_account_name,
             ta.name AS to_account_name
        FROM cash_movements cm
        LEFT JOIN users u ON u.tenant_id = cm.tenant_id AND u.id = cm.created_by
        LEFT JOIN accounts fa ON fa.tenant_id = cm.tenant_id
             AND fa.id = split_part(cm.from_account_code, ':', 2)
        LEFT JOIN accounts ta ON ta.tenant_id = cm.tenant_id
             AND ta.id = split_part(cm.to_account_code, ':', 2)
       WHERE cm.tenant_id = ${ctx.tenantId}
         AND cm.deleted_at IS NULL
         AND cm.kind IN (${list(filter.kinds)})
         AND (cm.from_account_code = 'OWNER_CURRENT_ACCOUNT'
              OR split_part(cm.from_account_code, ':', 2) IN (${list(filter.visibleAccountIds)}))
         AND (cm.to_account_code = 'OWNER_CURRENT_ACCOUNT'
              OR split_part(cm.to_account_code, ':', 2) IN (${list(filter.visibleAccountIds)}))
         ${filter.cursor === null ? sql`` : sql`AND cm.id < ${filter.cursor}`}
         ${filter.fromDate === null ? sql`` : sql`AND cm.business_date >= ${filter.fromDate}`}
         ${filter.toDate === null ? sql`` : sql`AND cm.business_date <= ${filter.toDate}`}
         ${
           filter.accountId === null
             ? sql``
             : sql`AND (split_part(cm.from_account_code, ':', 2) = ${filter.accountId}
                     OR split_part(cm.to_account_code, ':', 2) = ${filter.accountId})`
         }
         ${
           filter.search === null
             ? sql``
             : sql`AND (cm.reference ILIKE ${'%' + filter.search + '%'}
                     OR cm.note ILIKE ${'%' + filter.search + '%'}
                     OR cm.movement_number ILIKE ${'%' + filter.search + '%'})`
         }
       ORDER BY cm.business_date DESC, cm.id DESC
       LIMIT ${filter.limit}
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      number: row.number,
      kind: row.kind as CashMovementKind,
      businessDate: row.business_date,
      fromAccountCode: row.from_account_code,
      fromAccountName: row.from_account_name,
      toAccountCode: row.to_account_code,
      toAccountName: row.to_account_name,
      amountMinor: Number(row.amount_minor),
      reference: row.reference,
      note: row.note,
      status: row.status,
      correctionReason: row.correction_reason,
      createdAt: instant(row.created_at).toISOString(),
      createdByName: row.created_by_name,
      version: Number(row.version),
    }));
  }

  async findMovementKind(
    tx: Tx,
    ctx: TenantContext,
    movementId: string,
  ): Promise<CashMovementKind | null> {
    const [row] = await txOf(tx)
      .select({ kind: cashMovements.kind })
      .from(cashMovements)
      .where(
        and(
          eq(cashMovements.tenantId, ctx.tenantId),
          eq(cashMovements.id, movementId),
          isNull(cashMovements.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : (row.kind as CashMovementKind);
  }

  /**
   * One account's balance at the end of a business date (INV-07, windowed).
   *
   * The figure the transfer modal shows under the account it is taking money
   * from. It is the same sum the account row carries, cut off at the date being
   * entered — because warning about today's balance while posting three days
   * back would be a warning about a number the entry never touches.
   */
  async balanceAsOf(
    tx: Tx,
    ctx: TenantContext,
    accountCode: string,
    asOf: string | null,
  ): Promise<number> {
    const [row] = await txOf(tx)
      .select({ total: sql<number>`COALESCE(SUM(${journalLines.amountMinor}), 0)::bigint` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          eq(journalLines.accountCode, accountCode),
          asOf === null ? undefined : lte(journalEntries.businessDate, asOf),
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

  private accountSelection(asOf: string | null = null) {
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
       *
       * `asOf` windows it to the end of a business date, which is what the
       * Overview's date selector and the transfer modal's "available balance
       * as of" both ask for. Without the window the modal would warn about
       * today's balance while posting on a date three days ago, and the
       * warning would be about a figure the entry never touches.
       *
       * The account family is a CASE rather than two prefixes because a loan
       * posts to `LOAN:{id}` (§2.4): reading it as `BANK:` would return a
       * balance belonging to no account at all — always zero — and every loan
       * would look repaid.
       */
      balanceMinor: sql<number>`(
        SELECT COALESCE(SUM(l.amount_minor), 0)::bigint
        FROM journal_lines l
        ${asOf === null ? sql`` : sql`JOIN journal_entries e ON e.id = l.journal_entry_id`}
        WHERE l.tenant_id = ${accounts.tenantId}
          AND l.account_code = ${ACCOUNT_CODE_PREFIX} || ${accounts.id}
          ${asOf === null ? sql`` : sql`AND e.business_date <= ${asOf}`}
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

/* ------------------------------------------------- Finance raw-query shapes */

/**
 * The row shapes of the two raw queries above.
 *
 * `pg` hands back whatever the driver parsed, so every number arrives as a
 * string cast in SQL (`::text`) and is turned into a number exactly once, on
 * the way out. Money is never allowed to become a float on the way through.
 */
interface StatementRecord extends Record<string, unknown> {
  journal_line_id: string;
  business_date: string;
  created_at: string;
  source_type: string;
  source_number: string;
  source_id: string;
  amount_minor: string;
  counterparty_name: string | null;
  other_account_name: string | null;
  expense_category_name: string | null;
  movement_reference: string | null;
  movement_note: string | null;
  movement_kind: string | null;
}

interface MovementRecord extends Record<string, unknown> {
  id: string;
  number: string;
  kind: string;
  business_date: string;
  from_account_code: string;
  to_account_code: string;
  from_account_name: string | null;
  to_account_name: string | null;
  amount_minor: string;
  reference: string | null;
  note: string | null;
  status: string;
  correction_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  version: number;
}

/**
 * The ledger's family filter, as source-document types.
 *
 * The screen offers four words a shopkeeper knows — sales, purchases, expenses,
 * money moved — and each is several document types underneath, including the
 * reversal and correction entries that belong to the same event. `OTHER` is
 * everything the four do not claim, so no line can be filtered out of existence
 * and leave a running balance that does not add up.
 */
function statementKindClause(kind: StatementFilter['kind']): SQL {
  if (kind === null) return sql``;

  type Family = Exclude<StatementFilter['kind'], null>;
  const families: Record<Family, readonly string[]> = {
    SALE: ['SALE', 'SALE_CANCELLATION', 'SALES_RETURN', 'SALES_RETURN_REVERSAL', 'CUSTOMER_RECEIPT', 'CUSTOMER_RECEIPT_REVERSAL'],
    PURCHASE: ['PURCHASE', 'PURCHASE_REVERSAL', 'PURCHASE_LANDED_COST', 'PURCHASE_RETURN', 'PURCHASE_RETURN_REVERSAL', 'SUPPLIER_PAYMENT', 'SUPPLIER_PAYMENT_REVERSAL'],
    EXPENSE: ['EXPENSE', 'EXPENSE_CORRECTION', 'EXPENSE_REVERSAL'],
    MOVEMENT: ['CASH_MOVEMENT', 'CASH_MOVEMENT_CORRECTION', 'CASH_MOVEMENT_REVERSAL'],
    OTHER: [],
  };

  const listed = Object.entries(families)
    .filter(([name]) => name !== 'OTHER')
    .flatMap(([, types]) => types);

  return kind === 'OTHER'
    ? sql`AND je.source_document_type <> ALL(${listed})`
    : sql`AND je.source_document_type = ANY(${[...families[kind as Family]]})`;
}
