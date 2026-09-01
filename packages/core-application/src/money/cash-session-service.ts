import {
  accountCodeFor,
  cashDifferencePosting,
  cashDifferenceReversal,
  cashMovementPosting,
  closeFigures,
  differenceKindOf,
  expectedClosing,
  openingAdjustmentSides,
  openingDifference,
  rejectCashClose,
  rejectCashCloseReason,
  rejectStartDay,
} from '@sher/core-domain';
import type { CashCloseRejection, StartDayRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type {
  CashSessionCloseResponse,
  CashSessionResponse,
  DayStatusResponse,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type {
  CashSessionCloseRow,
  CashSessionRow,
  MoneyAccountRow,
  MoneyRepository,
} from './money-repository';

/**
 * The business day at the drawer (Phase 4, §5.16).
 *
 * **WRITE CLASS: B** (R-D). Start Day, End Day and Reopen Day are documents:
 * each is numbered, period-guarded, posts through the journal kernel and
 * writes audit — in one transaction, or none of it.
 *
 * **What this service refuses to do.** It never closes a day automatically, and
 * it never computes a count. §5.16.7 keeps six quantities apart and five of
 * them exist only because somebody physically counted the drawer; a system that
 * fills one in has collapsed the two the whole module exists to compare. So:
 * yesterday unclosed blocks today (owner decision 2026-08-24), and the block
 * comes with the date to close rather than an offer to close it.
 *
 * **The words on the screen are not these words.** The cashier presses
 * `দিন শুরু করুন` and `ভুল করে বন্ধ করেছি`; what arrives here is `startDay` and
 * `reopenDay`, and what is stored is `SUPERSEDED` and `differenceMinor`
 * (UI-74). One vocabulary is for the person counting, the other has to still
 * make sense to whoever reads the ledger in three years.
 */

export interface DayStatusCommand {
  readonly ctx: TenantContext;
}

export interface StartDayCommand {
  readonly ctx: TenantContext;
  readonly businessDate: string;
  readonly openingAmountMinor: number;
  readonly counterpartAccountCode: string | null;
  readonly note: string | null;
  readonly operationId: string;
}

export interface CloseDayCommand {
  readonly ctx: TenantContext;
  readonly sessionId: string;
  readonly countedClosingMinor: number;
  readonly reason: string | null;
  readonly operationId: string;
}

export interface ReopenDayCommand {
  readonly ctx: TenantContext;
  readonly sessionId: string;
  readonly reason: string;
  readonly operationId: string;
}

const ENTITY_TYPE = 'cash_session';

const START_REJECTION_MESSAGES: Record<StartDayRejection, string> = {
  PREVIOUS_DAY_NOT_CLOSED: 'Close the previous day before starting a new one',
  DAY_ALREADY_STARTED: 'This day has already been started',
  OPENING_NOT_INTEGER_MINOR: 'The opening cash must be a whole amount',
  OPENING_NEGATIVE: 'The opening cash cannot be negative',
  OPENING_DIFFERENCE_NEEDS_COUNTERPART:
    'Say where the difference came from or went — cash always has a named source or destination',
};

const CLOSE_REJECTION_MESSAGES: Record<CashCloseRejection, string> = {
  COUNT_NOT_INTEGER_MINOR: 'The counted cash must be a whole amount',
  COUNT_NEGATIVE: 'The counted cash cannot be negative',
  REASON_REQUIRED_FOR_DIFFERENCE: 'Say why the counted cash differs from what was expected',
};

export class CashSessionService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly money: MoneyRepository,
    private readonly settings: SettingsRepository,
    private readonly numbering: NumberingService,
    private readonly periods: PeriodGuard,
    private readonly idempotency: IdempotencyStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * Everything the day chip needs, in one call.
   *
   * Deliberately one round trip: the chip is on every screen (owner decision
   * 2026-08-24, "both"), so a version of this that took three calls would put
   * three requests behind every page the shop opens.
   */
  async status(command: DayStatusCommand): Promise<DayStatusResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.CASH_DAILY_VIEW);

      const businessDate = this.clock.businessDate(ctx.timezone);
      const enabled = await this.sessionsEnabled(tx, ctx);
      const drawer = await this.money.findDrawer(tx, ctx);

      if (!enabled || drawer === null) {
        return {
          enabled,
          drawerAccountId: drawer?.id ?? null,
          businessDate,
          todaySession: null,
          blockedByDate: null,
          blockedSession: null,
          previousClosingMinor: null,
          drawerBalanceMinor: drawer?.balanceMinor ?? 0,
          canReopenToday: false,
        };
      }

      const open = await this.money.findOpenSession(tx, ctx);
      const previousClose = await this.money.findPreviousClose(tx, ctx, businessDate);

      /*
       * An open session dated before today is the case the owner chose to
       * block on: the shop opened yesterday, never closed, and is now trying to
       * trade on a new date. The chip says which day to close rather than
       * offering to close it at expected, because a count nobody made is not a
       * count (§5.16.7).
       */
      const blockedByDate =
        open !== null && open.businessDate < businessDate ? open.businessDate : null;

      /*
       * Today's row whether it is open or closed. A closed one is what the chip
       * needs in order to offer the reopen, and `findOpenSession` alone could
       * never return it.
       */
      const todaySession = await this.money.findSessionByDate(tx, ctx, businessDate);

      return {
        enabled,
        drawerAccountId: drawer.id,
        businessDate,
        todaySession:
          todaySession === null ? null : await this.toResponse(tx, ctx, todaySession),
        blockedByDate,
        blockedSession:
          blockedByDate === null || open === null ? null : await this.toResponse(tx, ctx, open),
        previousClosingMinor: previousClose?.countedClosingMinor ?? null,
        drawerBalanceMinor: drawer.balanceMinor,
        canReopenToday: await this.canReopenToday(tx, ctx, businessDate),
      };
    });
  }

  /** §5.16.2 — the counted cash going into the drawer opens the day. */
  async startDay(command: StartDayCommand): Promise<CashSessionResponse> {
    const { ctx } = command;
    const fingerprint = JSON.stringify({
      businessDate: command.businessDate,
      openingAmountMinor: command.openingAmountMinor,
      counterpartAccountCode: command.counterpartAccountCode,
    });

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.CASH_SESSION_START);
      await this.requireSessionsEnabled(tx, ctx);

      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used to start a different day',
          );
        }
        return replayed.response as CashSessionResponse;
      }

      const today = this.clock.businessDate(ctx.timezone);
      const { businessDate } = command;

      // A day cannot be opened before it happens: every movement in it would be
      // dated ahead of the shop's own clock, and the drawer cannot be counted
      // on a day that has not arrived.
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The day cannot be started in the future');
      }
      await this.periods.assertOpen(tx, ctx, businessDate);

      const drawer = await this.requireDrawer(tx, ctx);
      const open = await this.money.findOpenSession(tx, ctx);
      const existing = await this.money.findSessionByDate(tx, ctx, businessDate);
      const previousClose = await this.money.findPreviousClose(tx, ctx, businessDate);
      const previousClosingMinor = previousClose?.countedClosingMinor ?? null;

      const counterpart = command.counterpartAccountCode;
      /*
       * Measured against the ledger, not against the previous close alone. They
       * agree on every day after the first (INV-07b); on the first they do not,
       * and the difference is real money the books have never seen.
       */
      const ledgerBalanceMinor = drawer.balanceMinor;
      const rejection = rejectStartDay({
        openingAmountMinor: command.openingAmountMinor,
        ledgerBalanceMinor,
        hasUnclosedEarlierDay: open !== null && open.businessDate !== businessDate,
        dayAlreadyStarted: existing !== null,
        counterpart: counterpart === null ? null : (counterpart as never),
      });
      if (rejection !== null) {
        throw new AppError(
          rejection === 'PREVIOUS_DAY_NOT_CLOSED' || rejection === 'DAY_ALREADY_STARTED'
            ? ErrorCode.VALIDATION_FAILED
            : ErrorCode.VALIDATION_FAILED,
          START_REJECTION_MESSAGES[rejection],
        );
      }

      const sessionId = Ulid.generate(this.clock);
      await this.money.insertSession(tx, ctx, {
        id: sessionId,
        number: await this.numbering.allocate(
          tx,
          ctx,
          'CASH_SESSION',
          Number(businessDate.slice(0, 4)),
        ),
        accountId: drawer.id,
        businessDate,
        openingAmountMinor: command.openingAmountMinor,
        previousClosingMinor,
      });

      /*
       * §5.16.5: an opening that differs from last night's count is a real
       * movement of money and posts on the *new* day's business date. Case C is
       * absent from this code on purpose — a previous shortage is not a
       * difference to explain here, because it was already posted at that day's
       * close and starting today at the counted amount neither erases nor
       * offsets it.
       */
      const differenceMinor = openingDifference({
        openingAmountMinor: command.openingAmountMinor,
        ledgerBalanceMinor,
      });
      if (differenceMinor !== 0 && counterpart !== null) {
        await this.postOpeningAdjustment(
          tx,
          ctx,
          drawer,
          sessionId,
          counterpart,
          differenceMinor,
          command.note,
          businessDate,
          today,
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: sessionId,
        action: 'START_DAY',
        before: null,
        after: {
          businessDate,
          openingAmountMinor: String(command.openingAmountMinor),
          previousClosingMinor:
            previousClosingMinor === null ? null : String(previousClosingMinor),
          openingDifferenceMinor: String(differenceMinor),
          counterpartAccountCode: counterpart,
        },
        source: 'API',
      });

      const response = await this.toResponse(
        tx,
        ctx,
        await this.requireSession(tx, ctx, sessionId),
      );

      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }

  /** §5.16.4 — count the drawer, store the five figures, post the difference. */
  async closeDay(command: CloseDayCommand): Promise<CashSessionResponse> {
    const { ctx } = command;
    const fingerprint = JSON.stringify({
      sessionId: command.sessionId,
      countedClosingMinor: command.countedClosingMinor,
    });

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.CASH_SESSION_CLOSE);
      await this.requireSessionsEnabled(tx, ctx);

      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used to close a different day',
          );
        }
        return replayed.response as CashSessionResponse;
      }

      const session = await this.requireSession(tx, ctx, command.sessionId);
      if (session.status === 'CLOSED') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This day is already closed');
      }

      // The shortage or overage posts on the closing session's own business
      // date (§5.16.4), so the lock that matters is that day's, not today's.
      await this.periods.assertOpen(tx, ctx, session.businessDate);

      const countRejection = rejectCashClose(command.countedClosingMinor);
      if (countRejection !== null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, CLOSE_REJECTION_MESSAGES[countRejection]);
      }

      const totals = await this.money.sessionTotals(tx, ctx, session.id);
      const figures = closeFigures(
        {
          openingAmountMinor: session.openingAmountMinor,
          cashInMinor: totals.cashInMinor,
          cashOutMinor: totals.cashOutMinor,
        },
        command.countedClosingMinor,
      );

      const reasonRejection = rejectCashCloseReason(figures.differenceMinor, command.reason);
      if (reasonRejection !== null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, CLOSE_REJECTION_MESSAGES[reasonRejection]);
      }

      const drawer = await this.requireAccount(tx, ctx, session.accountId);
      const account = accountCodeFor(drawer.type, drawer.id);
      const posting = cashDifferencePosting(account, figures.differenceMinor);

      const closeId = Ulid.generate(this.clock);
      const today = this.clock.businessDate(ctx.timezone);

      await this.money.closeSession(tx, ctx, {
        id: closeId,
        sessionId: session.id,
        openingAmountMinor: figures.openingAmountMinor,
        cashInMinor: figures.cashInMinor,
        cashOutMinor: figures.cashOutMinor,
        expectedClosingMinor: figures.expectedClosingMinor,
        countedClosingMinor: figures.countedClosingMinor,
        differenceMinor: figures.differenceMinor,
        differenceReason: command.reason,
        journal:
          posting === null
            ? null
            : {
                journalEntryId: Ulid.generate(this.clock),
                businessDate: session.businessDate,
                entryMode: entryModeFor(session.businessDate, today),
                sourceType: 'CASH_SESSION_CLOSE',
                sourceId: closeId,
                sourceNumber: session.number,
                lines: posting.lines.map((line) => ({
                  id: Ulid.generate(this.clock),
                  account: line.account,
                  amountMinor: line.amountMinor,
                  partyId: line.partyId,
                })),
              },
      });

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: session.id,
        action: 'CLOSE_DAY',
        before: null,
        after: {
          closeId,
          expectedClosingMinor: String(figures.expectedClosingMinor),
          countedClosingMinor: String(figures.countedClosingMinor),
          differenceMinor: String(figures.differenceMinor),
          differenceReason: command.reason,
        },
        source: 'API',
      });

      const response = await this.toResponse(
        tx,
        ctx,
        await this.requireSession(tx, ctx, session.id),
      );

      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }

  /**
   * §5.16.4 as amended 2026-08-24 — undoing a close made by mistake.
   *
   * Two gates, and they are different in kind. The **permission** admits the
   * Owner; the **rule** admits whoever performed that close, whatever role they
   * hold, because "the person who did it" is not something a role can express
   * and the cashier who mis-tapped at 9pm must be able to fix it without
   * phoning anyone.
   *
   * The date gate is absolute: only while the closed day is still the current
   * business date. An older day has been reported on, and §5.16.4 already gives
   * it the right repair — a new audited adjustment, which leaves the original
   * count standing where the reports found it.
   */
  async reopenDay(command: ReopenDayCommand): Promise<CashSessionResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.requireSessionsEnabled(tx, ctx);

      const session = await this.requireSession(tx, ctx, command.sessionId);
      const close = await this.money.findActiveClose(tx, ctx, session.id);

      if (session.status === 'OPEN' || close === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This day is not closed');
      }

      const today = this.clock.businessDate(ctx.timezone);
      if (session.businessDate !== today) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Only today can be reopened. Correct an earlier day with a cash adjustment instead',
        );
      }

      const held = await this.accessControl.permissionsOf(tx, ctx);
      const permitted =
        held.includes(Permission.CASH_SESSION_REOPEN) || close.closedBy === ctx.userId;
      if (!permitted) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'Only the owner, or whoever closed the day, can reopen it',
        );
      }

      await this.periods.assertOpen(tx, ctx, session.businessDate);

      const drawer = await this.requireAccount(tx, ctx, session.accountId);
      const reversal = cashDifferenceReversal(
        accountCodeFor(drawer.type, drawer.id),
        close.differenceMinor,
      );

      const reopened = await this.money.reopenSession(tx, ctx, {
        closeId: close.id,
        expectedVersion: close.version,
        sessionId: session.id,
        reason: command.reason,
        journal:
          reversal === null
            ? null
            : {
                journalEntryId: Ulid.generate(this.clock),
                businessDate: session.businessDate,
                entryMode: entryModeFor(session.businessDate, today),
                // Its own source id — a reversal is a second entry, never an
                // edit of the first, and `journal_entries_source_unique` would
                // refuse to let it share the close's identity anyway.
                sourceType: 'CASH_SESSION_REOPEN',
                sourceId: close.id,
                sourceNumber: session.number,
                lines: reversal.lines.map((line) => ({
                  id: Ulid.generate(this.clock),
                  account: line.account,
                  amountMinor: line.amountMinor,
                  partyId: line.partyId,
                })),
              },
      });

      if (!reopened) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this day while you were reopening it',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: session.id,
        action: 'REOPEN_DAY',
        before: {
          closeId: close.id,
          countedClosingMinor: String(close.countedClosingMinor),
          differenceMinor: String(close.differenceMinor),
        },
        after: null,
        reason: command.reason,
        source: 'API',
      });

      return this.toResponse(tx, ctx, await this.requireSession(tx, ctx, session.id));
    });
  }

  /* ------------------------------------------------------------- internals */

  private async postOpeningAdjustment(
    tx: Tx,
    ctx: TenantContext,
    drawer: MoneyAccountRow,
    sessionId: string,
    counterpartCode: string,
    differenceMinor: number,
    note: string | null,
    businessDate: string,
    today: string,
  ): Promise<void> {
    const drawerCode = accountCodeFor(drawer.type, drawer.id);
    const sides = openingAdjustmentSides(
      drawerCode,
      counterpartCode as never,
      differenceMinor,
    );
    const posting = cashMovementPosting({ kind: 'OPENING_ADJUSTMENT', ...sides });

    const movementId = Ulid.generate(this.clock);
    await this.money.insertMovement(tx, ctx, {
      id: movementId,
      number: await this.numbering.allocate(
        tx,
        ctx,
        'CASH_MOVEMENT',
        Number(businessDate.slice(0, 4)),
      ),
      kind: 'OPENING_ADJUSTMENT',
      // No slip to quote: Start Day's own difference, not something banked.
      reference: null,
      fromAccountCode: sides.fromAccount,
      toAccountCode: sides.toAccount,
      amountMinor: sides.amountMinor,
      note,
      sessionId,
      businessDate,
      entryMode: entryModeFor(businessDate, today),
      operationId: movementId,
      journal: {
        journalEntryId: Ulid.generate(this.clock),
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        sourceType: 'CASH_MOVEMENT',
        sourceId: movementId,
        sourceNumber: '',
        lines: posting.lines.map((line) => ({
          id: Ulid.generate(this.clock),
          account: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
      },
    });
  }

  private async sessionsEnabled(tx: Tx, ctx: TenantContext): Promise<boolean> {
    const values = settingValuesOf(await this.settings.listStored(tx, ctx));
    return isFeatureOn(values, SettingKey.CASH_SESSION_ENABLED);
  }

  private async requireSessionsEnabled(tx: Tx, ctx: TenantContext): Promise<void> {
    if (!(await this.sessionsEnabled(tx, ctx))) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'The cash drawer is switched off for this shop');
    }
  }

  private async requireDrawer(tx: Tx, ctx: TenantContext): Promise<MoneyAccountRow> {
    const drawer = await this.money.findDrawer(tx, ctx);
    if (drawer === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Set up the cash drawer before starting the day',
      );
    }
    return drawer;
  }

  private async requireAccount(
    tx: Tx,
    ctx: TenantContext,
    accountId: string,
  ): Promise<MoneyAccountRow> {
    const account = await this.money.findAccountById(tx, ctx, accountId);
    if (account === null) throw new AppError(ErrorCode.NOT_FOUND, 'That account no longer exists');
    return account;
  }

  private async requireSession(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<CashSessionRow> {
    const session = await this.money.findSessionById(tx, ctx, sessionId);
    if (session === null) throw new AppError(ErrorCode.NOT_FOUND, 'That day no longer exists');
    return session;
  }

  private async canReopenToday(
    tx: Tx,
    ctx: TenantContext,
    businessDate: string,
  ): Promise<boolean> {
    const session = await this.money.findSessionByDate(tx, ctx, businessDate);
    if (session === null || session.status === 'OPEN') return false;

    const close = await this.money.findActiveClose(tx, ctx, session.id);
    if (close === null) return false;

    const held = await this.accessControl.permissionsOf(tx, ctx);
    return held.includes(Permission.CASH_SESSION_REOPEN) || close.closedBy === ctx.userId;
  }

  /**
   * A session as the screen reads it, including every close it has had.
   *
   * An open day's `expectedClosingMinor` is computed live from the journal, so
   * the End Day dialog can show what the system believes before anyone counts.
   * A closed day's comes from the stored close instead — §5.16.4 makes that
   * figure immutable, and recomputing it on read is precisely how a later
   * correction would silently rewrite what the system expected at the time.
   */
  private async toResponse(
    tx: Tx,
    ctx: TenantContext,
    session: CashSessionRow,
  ): Promise<CashSessionResponse> {
    const closes = await this.money.listCloses(tx, ctx, session.id);
    const active = closes.find((close) => close.status === 'ACTIVE') ?? null;
    const totals =
      active === null
        ? await this.money.sessionTotals(tx, ctx, session.id)
        : { cashInMinor: active.cashInMinor, cashOutMinor: active.cashOutMinor };

    return {
      id: session.id,
      number: session.number,
      accountId: session.accountId,
      accountName: session.accountName,
      businessDate: session.businessDate,
      status: session.status,
      openingAmountMinor: session.openingAmountMinor,
      previousClosingMinor: session.previousClosingMinor,
      cashInMinor: totals.cashInMinor,
      cashOutMinor: totals.cashOutMinor,
      expectedClosingMinor:
        active?.expectedClosingMinor ??
        expectedClosing({
          openingAmountMinor: session.openingAmountMinor,
          cashInMinor: totals.cashInMinor,
          cashOutMinor: totals.cashOutMinor,
        }),
      openedAt: session.openedAt,
      openedByName: session.openedByName,
      closes: closes.map(toCloseResponse),
      version: session.version,
    };
  }
}

function toCloseResponse(close: CashSessionCloseRow): CashSessionCloseResponse {
  return {
    id: close.id,
    status: close.status,
    openingAmountMinor: close.openingAmountMinor,
    cashInMinor: close.cashInMinor,
    cashOutMinor: close.cashOutMinor,
    expectedClosingMinor: close.expectedClosingMinor,
    countedClosingMinor: close.countedClosingMinor,
    differenceMinor: close.differenceMinor,
    differenceKind: differenceKindOf(close.differenceMinor),
    differenceReason: close.differenceReason,
    reopenReason: close.reopenReason,
    closedAt: close.closedAt,
    closedByName: close.closedByName,
    supersededAt: close.supersededAt,
  };
}
