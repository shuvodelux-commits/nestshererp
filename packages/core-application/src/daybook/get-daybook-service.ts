import { daysOutstanding } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  DaybookActions, DaybookDaySummary, DaybookQuery, DaybookResponse, DaybookRow,
} from '@sher/core-contracts';

import type { CashMovementRow, MoneyRepository } from '../money/money-repository';
import type { AccessControl } from '../ports/access-control';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { CAPABILITIES, kindOf, REVERSAL_SOURCE_TYPES } from './daybook-kinds';
import type { DaybookEntryRow, DaybookRepository } from './daybook-repository';

/**
 * Reading a day (§5.27, D-27).
 *
 * **This service posts nothing and can post nothing**: it is built without a
 * numbering service, an outbox or an idempotency store, because Daybook owns
 * no business documents. Every action a row offers is the owning module's use
 * case, launched by the screen — "if `DaybookUpdateSaleService` ever appears,
 * the module has become a back door" (§5.27).
 *
 * The money summary above the list comes from the **cash session rows** and
 * the journal, read through the money module's own repository, not recomputed
 * here (§5.27). Recomputing it would make Daybook a second opinion on what the
 * drawer held, and the whole point of the screen is that it is not one.
 */
export class GetDaybookService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly daybook: DaybookRepository,
    private readonly money: MoneyRepository,
    private readonly periods: PeriodGuard,
  ) {}

  async execute(ctx: TenantContext, query: DaybookQuery): Promise<DaybookResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.DAYBOOK_VIEW);
      const held = await this.access.permissionsOf(tx, ctx);

      if (query.to < query.from) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The end date is before the start date');
      }
      // §5.27's own validation: a longer window is a report, not a day review,
      // and the printed layout would not survive it either.
      if (daysOutstanding(query.from, query.to) > 92) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A daybook range is at most 92 days — use Reports for a longer period',
        );
      }

      const entryDate = held.includes(Permission.DAYBOOK_VIEW_ENTRY_DATE);
      if (query.dateBasis === 'CREATED_AT' && !entryDate) {
        await this.access.require(tx, ctx, Permission.DAYBOOK_VIEW_ENTRY_DATE);
      }

      // Without `daybook.view.all_users` a cashier sees their own counter and
      // nobody else's (§5.27), and the filter is applied on the server so the
      // response body itself carries nothing they may not see.
      const allUsers = held.includes(Permission.DAYBOOK_VIEW_ALL_USERS);
      const userId = allUsers ? (query.userId ?? null) : ctx.userId;

      const filter = {
        from: query.from,
        to: query.to,
        dateBasis: query.dateBasis,
        kind: query.kind ?? null,
        partyId: query.partyId ?? null,
        userId,
        accountCode: query.accountCode ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      };

      const found = await this.daybook.listEntries(tx, ctx, filter);
      const hasMore = found.length > query.limit;
      const page = hasMore ? found.slice(0, query.limit) : found;
      const backdated = await this.daybook.listBackdated(tx, ctx, { ...filter, limit: 200 });

      const locked = await this.lockedDates(tx, ctx, [...page, ...backdated]);
      const toRow = (entry: DaybookEntryRow): DaybookRow =>
        this.toRow(entry, held, locked.has(entry.businessDate));

      return {
        from: query.from,
        to: query.to,
        dateBasis: query.dateBasis,
        days: await this.days(tx, ctx, query.from, query.to, userId),
        rows: page.map(toRow),
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
        allUsers,
        backdatedRows: backdated.map(toRow),
      };
    });
  }

  /**
   * One summary per business date in the range (§5.27's cash drawer session
   * history): opening, cash in, cash out, expected, counted, difference, and
   * every between-session movement with its reason.
   *
   * A shortage or an overage is shown on the day it was counted and is never
   * netted against another day, which is why this is a list of days and not a
   * total over the range.
   */
  private async days(
    tx: Tx,
    ctx: TenantContext,
    from: string,
    to: string,
    userId: string | null,
  ): Promise<DaybookDaySummary[]> {
    const totals = await this.daybook.dayTotals(tx, ctx, from, to, userId);
    const reviews = await this.daybook.listReviews(tx, ctx, from, to);
    const sessions = await this.money.listSessions(tx, ctx, {
      fromDate: from,
      toDate: to,
      cursor: null,
      limit: 100,
    });
    // Movements belong to a session, so they are read per session — the same
    // rows Daily Cash shows, rather than a second query with its own idea of
    // what a day is.
    const movements = new Map<string, readonly CashMovementRow[]>();
    for (const session of sessions) {
      movements.set(session.businessDate, await this.money.listMovements(tx, ctx, session.id));
    }

    const byDate = new Map(totals.map((row) => [row.businessDate, row]));
    const reviewByDate = new Map(reviews.map((row) => [row.businessDate, row]));
    const dates = new Set<string>([...byDate.keys(), ...sessions.map((s) => s.businessDate)]);

    return [...dates]
      .sort((a, b) => (a < b ? 1 : -1))
      .map((businessDate) => {
        const day = byDate.get(businessDate);
        const session = sessions.find((row) => row.businessDate === businessDate) ?? null;
        const close = session?.closes.find((row) => row.status === 'ACTIVE') ?? null;
        const review = reviewByDate.get(businessDate) ?? null;

        return {
          businessDate,
          openingCashMinor: session?.openingAmountMinor ?? 0,
          cashInMinor: close?.cashInMinor ?? 0,
          cashOutMinor: close?.cashOutMinor ?? 0,
          expectedClosingMinor: close?.expectedClosingMinor ?? session?.openingAmountMinor ?? 0,
          countedMinor: close?.countedClosingMinor ?? null,
          differenceMinor: close?.differenceMinor ?? null,
          // DR6 — the day opened on a figure the previous close did not leave.
          // Shown, never silently reconciled.
          openingMismatchMinor:
            session === null || session.previousClosingMinor === null
              ? 0
              : session.openingAmountMinor - session.previousClosingMinor,
          dayStatus: session === null ? 'NOT_STARTED' : session.status === 'OPEN' ? 'OPEN' : 'CLOSED',
          movements: (movements.get(businessDate) ?? []).map((movement) => ({
              id: movement.id,
              label: movement.kind,
              reason: movement.note,
              amountMinor: movement.amountMinor,
              accountLabel: movement.toAccountCode,
            })),
          salesMinor: day?.salesMinor ?? 0,
          purchasesMinor: day?.purchasesMinor ?? 0,
          receiptsMinor: day?.receiptsMinor ?? 0,
          paymentsMinor: day?.paymentsMinor ?? 0,
          expensesMinor: day?.expensesMinor ?? 0,
          returnsMinor: day?.returnsMinor ?? 0,
          transactionCount: day?.transactionCount ?? 0,
          reviewedAt: review === null ? null : review.reviewedAt.toISOString(),
          reviewedByName: review?.reviewedByName ?? null,
          reviewNote: review?.note ?? null,
        };
      });
  }

  /** Which of the dates on screen sit in a closed month (DR5). */
  private async lockedDates(
    tx: Tx,
    ctx: TenantContext,
    rows: readonly DaybookEntryRow[],
  ): Promise<Set<string>> {
    const locked = new Set<string>();
    for (const date of new Set(rows.map((row) => row.businessDate))) {
      try {
        await this.periods.assertOpen(tx, ctx, date);
      } catch {
        locked.add(date);
      }
    }
    return locked;
  }

  private toRow(entry: DaybookEntryRow, held: readonly string[], locked: boolean): DaybookRow {
    const kind = kindOf(entry.sourceType);
    const capability = CAPABILITIES[kind];
    const isReversal = REVERSAL_SOURCE_TYPES.includes(entry.sourceType);
    const status =
      isReversal
        ? 'REVERSAL'
        : entry.documentStatus === 'VOIDED'
          ? 'VOIDED'
          : entry.entryMode === 'CORRECTED'
            ? 'CORRECTED'
            : 'POSTED';

    const may = (code: string | null): boolean => code !== null && held.includes(code);
    // Three separate reasons an action is unavailable, and the row says which:
    // the month is closed, the document is already undone, or the person does
    // not hold the owning module's permission.
    const changeable = !locked && status !== 'VOIDED' && status !== 'REVERSAL';
    const blockedReason = locked
      ? 'This month is closed — a correction posts in the open month'
      : status === 'VOIDED'
        ? 'This document has already been cancelled'
        : status === 'REVERSAL'
          ? 'This entry is the cancellation of another document'
          : capability.note;

    const actions: DaybookActions = {
      open: capability.open,
      edit: changeable && may(capability.edit),
      remove: changeable && may(capability.remove),
      receivePayment: changeable && may(capability.receivePayment),
      payBill: changeable && may(capability.payBill),
      returnGoods: changeable && may(capability.returnGoods),
      /*
       * Phase 11.2, and the one action a closed month does not hide. A closed
       * period is protected, not immutable (owner decision 2026-08-31): the
       * owner who holds `finance.transaction_date.change_locked` is offered
       * the move and told at the dialog what it costs, and everybody else is
       * refused by the service the moment they try.
       */
      changeDate:
        status !== 'VOIDED' &&
        status !== 'REVERSAL' &&
        may(capability.changeDate) &&
        (!locked || held.includes(Permission.TRANSACTION_DATE_CHANGE_LOCKED)),
      print: capability.print,
      blockedReason,
    };

    return {
      id: entry.id,
      kind,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      sourceNumber: entry.sourceNumber,
      businessDate: entry.businessDate,
      createdAt: entry.createdAt.toISOString(),
      createdBy: entry.createdBy,
      createdByName: entry.createdByName,
      description: entry.note ?? describe(kind, entry),
      partyId: entry.partyId,
      partyName: entry.partyName,
      accountCode: entry.accountCode,
      accountLabel: entry.accountLabel ?? entry.accountCode,
      amountMinor: entry.amountMinor,
      cashEffectMinor: entry.cashEffectMinor,
      qty: entry.qty,
      status,
      reversedByNumber: entry.reversedByNumber,
      locked,
      // DR7 — typed on one day about another. The flag is what makes a late
      // entry findable rather than a surprise in next month's figures.
      backdated: entry.entryMode === 'BACKDATED',
      // Phase 11.2 — what the CORRECTED badge opens into: the day this sat on
      // before it was moved, and why somebody moved it.
      originalBusinessDate: entry.originalBusinessDate,
      correctionReason: entry.correctionReason,
      entryMode: entry.entryMode,
      documentVersion: entry.documentVersion,
      actions,
    };
  }
}

/**
 * The row's own words.
 *
 * A reversal is named after **what it undid**, prefixed rather than renamed
 * (owner-reported 2026-08-31): "Cancelled — Money received RCV-2026-000002"
 * says in one line what `CUSTOMER_RECEIPT_REVERSAL RCV-2026-000002` said in
 * the ledger's vocabulary and nobody's else. The number is kept, because the
 * reversal carries the number of the document it reverses and that is what a
 * shopkeeper searches for.
 */
function describe(kind: string, entry: DaybookEntryRow): string {
  const base = describeKind(kind, entry);
  return REVERSAL_SOURCE_TYPES.includes(entry.sourceType) ? `Cancelled — ${base}` : base;
}

function describeKind(kind: string, entry: DaybookEntryRow): string {
  const who = entry.partyName === null ? '' : ` — ${entry.partyName}`;
  switch (kind) {
    case 'SALE':
      return `Sale ${entry.sourceNumber}${who}`;
    case 'PURCHASE':
      return `Purchase ${entry.sourceNumber}${who}`;
    case 'CUSTOMER_RECEIPT':
      return `Money received ${entry.sourceNumber}${who}`;
    case 'SUPPLIER_PAYMENT':
      return `Paid supplier ${entry.sourceNumber}${who}`;
    case 'EXPENSE':
      return `Expense ${entry.sourceNumber}`;
    case 'SALES_RETURN':
      return `Customer return ${entry.sourceNumber}${who}`;
    case 'PURCHASE_RETURN':
      return `Return to supplier ${entry.sourceNumber}${who}`;
    case 'CASH_MOVEMENT':
      return `Cash movement ${entry.sourceNumber}`;
    case 'STOCK_ADJUSTMENT':
      return `Stock adjustment ${entry.sourceNumber}`;
    case 'OPENING':
      return `Opening ${entry.sourceNumber}${who}`;
    case 'DAY_CLOSE':
      return `Day closed ${entry.sourceNumber}`;
    default:
      return `${entry.sourceType} ${entry.sourceNumber}`;
  }
}
