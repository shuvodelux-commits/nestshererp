import { accountCodeFor, cashMovementPosting, rejectCashMovement } from '@sher/core-domain';
import type { CashMovementRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { CashMovementResponse } from '@sher/core-contracts';
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
import type { MoneyRepository } from './money-repository';

/**
 * Money crossing between named places (Phase 4, §5.16.3, §5.16.5).
 *
 * **WRITE CLASS: B** (R-D): numbered, period-guarded, posted, audited.
 *
 * Owner injections and withdrawals are a **standalone action available any time
 * the day is open** (owner decision 2026-08-24). That is the whole reason this
 * service is not folded into Start Day: the owner takes ৳10,000 out at 3pm, and
 * a cashier who has nowhere to record it at 3pm finds a drawer that is short at
 * 9pm with nothing to explain it — which turns a normal event into a shortage
 * investigation.
 *
 * Owner money is **not** an expense. It posts against `OWNER_CURRENT_ACCOUNT`,
 * because what the owner takes out of the till is not a cost of running the
 * shop and putting it in the P&L would misstate the profit the shop is taxed and
 * judged on.
 */

export interface RecordMovementCommand {
  readonly ctx: TenantContext;
  readonly kind: 'OWNER_INJECTION' | 'OWNER_WITHDRAWAL' | 'TRANSFER';
  readonly fromAccountCode: string;
  readonly toAccountCode: string;
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly note: string | null;
  readonly operationId: string;
}

const OWNER_ACCOUNT = 'OWNER_CURRENT_ACCOUNT';

const REJECTION_MESSAGES: Record<CashMovementRejection, string> = {
  MOVEMENT_AMOUNT_NOT_INTEGER_MINOR: 'The amount must be a whole amount',
  MOVEMENT_AMOUNT_NOT_POSITIVE: 'Enter an amount greater than zero',
  MOVEMENT_SIDES_IDENTICAL: 'Money cannot move from an account to itself',
};

export class CashMovementService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly money: MoneyRepository,
    private readonly numbering: NumberingService,
    private readonly periods: PeriodGuard,
    private readonly idempotency: IdempotencyStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async record(command: RecordMovementCommand): Promise<CashMovementResponse> {
    const { ctx } = command;
    const fingerprint = JSON.stringify({
      kind: command.kind,
      fromAccountCode: command.fromAccountCode,
      toAccountCode: command.toAccountCode,
      amountMinor: command.amountMinor,
      businessDate: command.businessDate,
    });

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.CASH_MOVEMENT_RECORD);

      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different movement',
          );
        }
        return replayed.response as CashMovementResponse;
      }

      const today = this.clock.businessDate(ctx.timezone);
      if (command.businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Money cannot move on a future date');
      }
      await this.periods.assertOpen(tx, ctx, command.businessDate);

      const from = await this.resolveSide(tx, ctx, command.fromAccountCode, command.kind);
      const to = await this.resolveSide(tx, ctx, command.toAccountCode, command.kind);

      const rejection = rejectCashMovement({
        kind: command.kind,
        fromAccount: from.code as never,
        toAccount: to.code as never,
        amountMinor: command.amountMinor,
      });
      if (rejection !== null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, REJECTION_MESSAGES[rejection]);
      }

      /*
       * §5.16.1: with the drawer tracked, cash cannot move on a day nobody has
       * opened — a movement with no session is a movement no count will ever
       * see, and the day it belongs to would close as a shortage of exactly
       * this amount.
       */
      const session = await this.money.findOpenSession(tx, ctx);
      const touchesDrawer = from.isDrawer || to.isDrawer;
      if (touchesDrawer && (session === null || session.businessDate !== command.businessDate)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Start the day before moving cash in or out of the drawer',
        );
      }

      const posting = cashMovementPosting({
        kind: command.kind,
        fromAccount: from.code as never,
        toAccount: to.code as never,
        amountMinor: command.amountMinor,
      });

      const movementId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'CASH_MOVEMENT',
        Number(command.businessDate.slice(0, 4)),
      );

      await this.money.insertMovement(tx, ctx, {
        id: movementId,
        number,
        kind: command.kind,
        fromAccountCode: from.code,
        toAccountCode: to.code,
        amountMinor: command.amountMinor,
        note: command.note,
        sessionId: touchesDrawer ? (session?.id ?? null) : null,
        businessDate: command.businessDate,
        entryMode: entryModeFor(command.businessDate, today),
        operationId: movementId,
        journal: {
          journalEntryId: Ulid.generate(this.clock),
          businessDate: command.businessDate,
          entryMode: entryModeFor(command.businessDate, today),
          sourceType: 'CASH_MOVEMENT',
          sourceId: movementId,
          sourceNumber: number,
          lines: posting.lines.map((line) => ({
            id: Ulid.generate(this.clock),
            account: line.account,
            amountMinor: line.amountMinor,
            partyId: line.partyId,
          })),
        },
      });

      await this.audit.append(tx, ctx, {
        entityType: 'cash_movement',
        entityId: movementId,
        action: 'CREATE',
        before: null,
        after: {
          kind: command.kind,
          fromAccountCode: from.code,
          toAccountCode: to.code,
          amountMinor: String(command.amountMinor),
          businessDate: command.businessDate,
        },
        source: 'API',
      });

      const response: CashMovementResponse = {
        id: movementId,
        number,
        kind: command.kind,
        fromAccountCode: from.code,
        fromAccountName: from.name,
        toAccountCode: to.code,
        toAccountName: to.name,
        amountMinor: command.amountMinor,
        businessDate: command.businessDate,
        note: command.note,
        createdAt: this.clock.now().toISOString(),
      };

      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }

  /**
   * Turns one side of the request into a code this service is willing to post.
   *
   * A client sends account **codes**, and a code is a string — so this is the
   * boundary that refuses one naming an account the caller cannot see, an
   * account that no longer exists, or a fixed account that is not the owner's.
   * Without it, `EXPENSE:x` or `AR` in a transfer request would post real value
   * to an account no cash screen would ever show.
   */
  private async resolveSide(
    tx: Tx,
    ctx: TenantContext,
    code: string,
    kind: RecordMovementCommand['kind'],
  ): Promise<{ readonly code: string; readonly name: string; readonly isDrawer: boolean }> {
    if (code === OWNER_ACCOUNT) {
      if (kind === 'TRANSFER') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Money to or from the owner is recorded as owner money, not as a transfer',
        );
      }
      return { code, name: 'Owner', isDrawer: false };
    }

    const separatorAt = code.indexOf(':');
    const accountId = separatorAt === -1 ? '' : code.slice(separatorAt + 1);
    const account =
      accountId === '' ? null : await this.money.findAccountById(tx, ctx, accountId);

    if (account === null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That is not an account of this shop');
    }

    await this.accessControl.require(
      tx,
      ctx,
      account.type === 'CASH' ? Permission.CASH_ACCOUNT_VIEW : Permission.BANK_ACCOUNT_VIEW,
    );

    if (account.status === 'INACTIVE') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, `“${account.name}” is no longer in use`);
    }

    // Rebuilt from the row rather than trusted from the request: the two agree
    // for an honest client, and where they would not, the row is right.
    return {
      code: accountCodeFor(account.type, account.id),
      name: account.name,
      isDrawer: account.isDrawer,
    };
  }
}
