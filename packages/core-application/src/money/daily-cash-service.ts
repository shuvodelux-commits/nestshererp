import { accountCodeFor, differenceKindOf } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  AccountStatementResponse,
  DailyCashResponse,
  DailyCashRow,
} from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { MoneyRepository } from './money-repository';

/**
 * Daily Cash, and an account's statement (Phase 4, §5.16.8, §5.17, UI-71).
 *
 * **READ ONLY**, and deliberately so: §5.16.8 calls Daily Cash "a read/control
 * view over cash-session rows plus the journal, not another balance table and
 * not another close workflow". Nothing here writes, so there is no second path
 * by which a stored expected figure could be recalculated — the immutability
 * §5.16.4 requires is a property of this service having no way to break it.
 *
 * The history reads what each close **stored**. A sale corrected next month
 * changes today's ledger and does not change what the system expected at last
 * Tuesday's close, which is the only way the difference on that row stays the
 * evidence it was.
 */

export interface DailyCashCommand {
  readonly ctx: TenantContext;
  readonly fromDate?: string | undefined;
  readonly toDate?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface AccountStatementCommand {
  readonly ctx: TenantContext;
  readonly accountId: string;
  readonly fromDate?: string | undefined;
  readonly toDate?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const DEFAULT_LIMIT = 50;

export class DailyCashService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly money: MoneyRepository,
  ) {}

  async history(command: DailyCashCommand): Promise<DailyCashResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.CASH_DAILY_VIEW);

      const limit = command.limit ?? DEFAULT_LIMIT;
      // One more than asked for, so "is there another page" costs nothing
      // extra (§3.9 keyset paging).
      const sessions = await this.money.listSessions(tx, ctx, {
        fromDate: command.fromDate ?? null,
        toDate: command.toDate ?? null,
        cursor: command.cursor ?? null,
        limit: limit + 1,
      });

      const hasMore = sessions.length > limit;
      const page = hasMore ? sessions.slice(0, limit) : sessions;

      const rows: DailyCashRow[] = page.map((session) => {
        const active = session.closes.find((close) => close.status === 'ACTIVE') ?? null;

        return {
          sessionId: session.id,
          businessDate: session.businessDate,
          status: session.status,
          openingAmountMinor: session.openingAmountMinor,
          cashInMinor: active?.cashInMinor ?? 0,
          cashOutMinor: active?.cashOutMinor ?? 0,
          expectedClosingMinor: active?.expectedClosingMinor ?? null,
          countedClosingMinor: active?.countedClosingMinor ?? null,
          differenceMinor: active?.differenceMinor ?? null,
          differenceKind: active === null ? null : differenceKindOf(active.differenceMinor),
          differenceReason: active?.differenceReason ?? null,
          // A day with a superseded close is a day somebody closed by mistake.
          // The owner asked for both closes to stay visible, and this is the
          // flag that lets the list say so without opening the drill-down.
          wasReopened: session.closes.some((close) => close.status === 'SUPERSEDED'),
        };
      });

      return {
        rows,
        page: {
          nextCursor: hasMore ? (page[page.length - 1]?.businessDate ?? null) : null,
          hasMore,
        },
      };
    });
  }

  /**
   * An account's statement — the journal lines against `CASH:{id}` or
   * `BANK:{id}`, with a running balance (§5.17, owner decision 2026-08-24:
   * balance and statement this phase, reconciliation later).
   *
   * Recomputed on every read, exactly like the party ledger. The closing figure
   * is the account's own, not the page's: a date filter that leaves later lines
   * out would otherwise put a number at the top of the statement that is not
   * what the account holds, and somebody would bank on it.
   */
  async statement(command: AccountStatementCommand): Promise<AccountStatementResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const account = await this.money.findAccountById(tx, ctx, command.accountId);
      if (account === null) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That account no longer exists');
      }

      await this.accessControl.require(
        tx,
        ctx,
        account.type === 'CASH' ? Permission.CASH_ACCOUNT_VIEW : Permission.BANK_ACCOUNT_VIEW,
      );

      const limit = command.limit ?? DEFAULT_LIMIT;
      const filter = {
        accountCode: accountCodeFor(account.type, account.id),
        fromDate: command.fromDate ?? null,
        toDate: command.toDate ?? null,
        cursor: command.cursor ?? null,
        limit: limit + 1,
      };

      const [lines, openingBalanceMinor] = await Promise.all([
        this.money.listStatementLines(tx, ctx, filter),
        this.money.sumStatementBefore(tx, ctx, filter),
      ]);

      const hasMore = lines.length > limit;
      const page = hasMore ? lines.slice(0, limit) : lines;

      let running = openingBalanceMinor;
      let totalInMinor = 0;
      let totalOutMinor = 0;

      const rows = page.map((line) => {
        running += line.amountMinor;
        if (line.amountMinor > 0) totalInMinor += line.amountMinor;
        else totalOutMinor -= line.amountMinor;

        return {
          journalLineId: line.journalLineId,
          businessDate: line.businessDate,
          createdAt: line.createdAt,
          sourceType: line.sourceType,
          sourceNumber: line.sourceNumber,
          amountMinor: line.amountMinor,
          runningBalanceMinor: running,
        };
      });

      return {
        accountId: account.id,
        accountName: account.name,
        type: account.type,
        openingBalanceMinor,
        closingBalanceMinor: account.balanceMinor,
        totalInMinor,
        totalOutMinor,
        rows,
        page: {
          nextCursor: hasMore ? (page[page.length - 1]?.journalLineId ?? null) : null,
          hasMore,
        },
      };
    });
  }
}
