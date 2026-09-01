import { accountCodeFor, differenceKindOf } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  AccountStatementResponse,
  DailyCashResponse,
  DailyCashRow,
} from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import { requireLoanVisibility } from './loan-visibility';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { MoneyRepository, StatementLineRow } from './money-repository';

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
  readonly search?: string | undefined;
  readonly kind?: 'ALL' | 'SALE' | 'PURCHASE' | 'EXPENSE' | 'MOVEMENT' | 'OTHER' | undefined;
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

      /*
       * The ledger route is protected **here**, not by the menu that hid it.
       * A person who types `/finance/accounts/{id}/ledger` for an account they
       * may not see reaches this line, and a loan is admitted by its own code
       * so a cashier never reads what the shop owes (owner decision
       * 2026-08-31).
       */
      if (account.type === 'LOAN') {
        await requireLoanVisibility(this.accessControl, tx, ctx);
      } else {
        await this.accessControl.require(
          tx,
          ctx,
          account.type === 'CASH' ? Permission.CASH_ACCOUNT_VIEW : Permission.BANK_ACCOUNT_VIEW,
        );
      }

      const limit = command.limit ?? DEFAULT_LIMIT;
      const search = command.search?.trim() ?? '';
      const filter = {
        accountCode: accountCodeFor(account.type, account.id),
        fromDate: command.fromDate ?? null,
        toDate: command.toDate ?? null,
        search: search === '' ? null : search,
        kind: command.kind === undefined || command.kind === 'ALL' ? null : command.kind,
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
          sourceId: line.sourceId,
          description: describeStatementLine(line),
          /*
           * What the shopkeeper wrote on the slip, or the document number when
           * they wrote nothing. Never both, and never the internal id: the
           * column exists so a person can find the row they are holding a
           * piece of paper about.
           */
          reference:
            line.movementReference === null || line.movementReference.trim() === ''
              ? line.sourceNumber
              : line.movementReference,
          amountMinor: line.amountMinor,
          debitMinor: line.amountMinor > 0 ? line.amountMinor : 0,
          creditMinor: line.amountMinor < 0 ? -line.amountMinor : 0,
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

/**
 * The sentence a ledger row shows (Finance module, owner decision 2026-08-31).
 *
 * §2.4's account codes and source-document types are the internal vocabulary
 * UI-21 says a screen never shows: `CUSTOMER_RECEIPT · RCP-2026-0043` means
 * nothing to the person who took the money. So every row is rebuilt here as
 * something a shopkeeper reads — *Money from Karim Store*, *Transfer to DBBL
 * Bank*, *Expense — Electricity* — from the document type plus whichever of the
 * party, the other account or the expense category the entry actually names.
 *
 * Built in the use case rather than in the browser because the same sentence
 * has to be searchable: the query matches on the party, the account and the
 * category, and a description assembled after the search would find rows the
 * filter had already thrown away.
 *
 * The fallback is the document number, never a raw type name. A source this
 * function has not been taught still reads as "Purchase PB-2026-0004" rather
 * than as `PURCHASE_LANDED_COST`.
 */
/** One movement line, named the way the person who entered it would name it. */
function describeMovement(
  kind: string | null,
  other: string | null,
  incoming: boolean,
): string {
  const to = other === null ? '' : ` ${other}`;

  switch (kind) {
    case 'OWNER_INJECTION':
      return 'Owner put money in';
    case 'OWNER_WITHDRAWAL':
      return 'Owner took money out';
    case 'LOAN_RECEIVED':
      return other === null ? 'Loan received' : `Loan received — ${other}`;
    case 'LOAN_REPAYMENT':
      return other === null ? 'Loan repayment' : `Loan repayment — ${other}`;
    case 'OPENING_ADJUSTMENT':
      return incoming ? `Opening difference from${to}` : `Opening difference to${to}`;
    default:
      if (other === null) return incoming ? 'Money in' : 'Money out';
      return incoming ? `Transfer from${to}` : `Transfer to${to}`;
  }
}

function describeStatementLine(line: StatementLineRow): string {
  const party = line.counterpartyName;
  const other = line.otherAccountName;
  const category = line.expenseCategoryName;
  /** Money arriving is described from where it came; money leaving, to where. */
  const incoming = line.amountMinor > 0;
  const named = (label: string, name: string | null): string =>
    name === null ? label : `${label} — ${name}`;

  switch (line.sourceType) {
    case 'SALE':
      return named('Sale', party);
    case 'SALE_CANCELLATION':
      return named('Sale cancelled', party);
    case 'CUSTOMER_RECEIPT':
      return named('Money from customer', party);
    case 'CUSTOMER_RECEIPT_REVERSAL':
      return named('Customer payment cancelled', party);
    case 'SALES_RETURN':
      return named('Sale returned', party);
    case 'SALES_RETURN_REVERSAL':
      return named('Sale return cancelled', party);
    case 'PURCHASE':
    case 'PURCHASE_LANDED_COST':
      return named('Purchase', party);
    case 'PURCHASE_REVERSAL':
      return named('Purchase cancelled', party);
    case 'SUPPLIER_PAYMENT':
      return named('Money to supplier', party);
    case 'SUPPLIER_PAYMENT_REVERSAL':
      return named('Supplier payment cancelled', party);
    case 'PURCHASE_RETURN':
      return named('Goods returned to supplier', party);
    case 'PURCHASE_RETURN_REVERSAL':
      return named('Purchase return cancelled', party);
    case 'EXPENSE':
      return named('Expense', category);
    case 'EXPENSE_CORRECTION':
      return named('Expense corrected', category);
    case 'EXPENSE_REVERSAL':
      return named('Expense cancelled', category);
    case 'ACCOUNT_OPENING':
      return 'Opening balance';
    case 'ACCOUNT_OPENING_CORRECTION':
      return 'Opening balance corrected';
    case 'CASH_SESSION_CLOSE':
      return 'Day closed — counted difference';
    case 'CASH_SESSION_REOPEN':
      return 'Day reopened';
    case 'CASH_MOVEMENT':
    case 'CASH_MOVEMENT_CORRECTION':
    case 'CASH_MOVEMENT_REVERSAL': {
      const cancelled = line.sourceType === 'CASH_MOVEMENT_REVERSAL';
      /*
       * The kind, not the direction alone. All six kinds post the same
       * two-sided entry, so a ledger that described them by direction would
       * call an owner withdrawal and a bank deposit the same thing — and the
       * row a shopkeeper is trying to explain is exactly the one where those
       * differ.
       */
      const base = describeMovement(line.movementKind, other, incoming);
      return cancelled ? `${base} — cancelled` : base;
    }
    default:
      return `${line.sourceNumber}`;
  }
}
