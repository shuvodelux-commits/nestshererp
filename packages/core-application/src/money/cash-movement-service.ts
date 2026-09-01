import {
  accountCodeFor, cashMovementPosting, correctionWindow, rejectCashMovement,
} from '@sher/core-domain';
import type { CashMovementRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { CashMovementKindValue, CashMovementResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { DocumentReversalRepository } from '../corrections/document-reversal-repository';
import { reverseMoneyDocument } from '../corrections/reverse-money-document';
import { entryModeFor } from '../notes/create-note-service';
import { requireLoanVisibility } from './loan-visibility';
import type { Outbox } from '../ports/outbox';
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
 *
 * **Loan money joins on the same path (Finance module, owner decision
 * 2026-08-31).** Taking a loan and repaying it are the same two-sided movement
 * — value arrives from `LOAN:{id}` or goes back to it — so they are two more
 * kinds here rather than a second service posting into the same journal.
 * Principal only: the interest inside an instalment is a cost of running the
 * shop and is recorded in the Expenses module.
 *
 * **Which permission a movement needs is decided by its own kind**, and by the
 * kind stored on the row when one is cancelled — never by what the caller says
 * they are doing. Moving the day's takings to the bank, writing down what the
 * owner took home and recording a loan instalment are three different sizes of
 * trust, and a cancellation that trusted the request would let anyone holding
 * `cash.movement.void` undo an owner withdrawal by calling it a transfer.
 */

export type RecordableMovementKind =
  | 'OWNER_INJECTION'
  | 'OWNER_WITHDRAWAL'
  | 'TRANSFER'
  | 'LOAN_RECEIVED'
  | 'LOAN_REPAYMENT';

export interface RecordMovementCommand {
  readonly ctx: TenantContext;
  readonly kind: RecordableMovementKind;
  readonly fromAccountCode: string;
  readonly toAccountCode: string;
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly reference: string | null;
  readonly note: string | null;
  readonly operationId: string;
}

export interface VoidMovementCommand {
  readonly ctx: TenantContext;
  readonly movementId: string;
  readonly version: number;
  readonly reason: string;
}

export interface CorrectMovementCommand extends RecordMovementCommand {
  readonly movementId: string;
  readonly version: number;
  readonly reason: string | null;
}

const OWNER_ACCOUNT = 'OWNER_CURRENT_ACCOUNT';

/**
 * The permission a movement of this kind needs to be written or undone.
 *
 * One table, read from the kind on the way in **and** from the kind stored on
 * the row on the way out. `OPENING_ADJUSTMENT` is Start Day's own document and
 * is never recorded or cancelled through this service, so it maps to the
 * movement permission that path already holds.
 */
const PERMISSION_FOR_KIND: Record<CashMovementKindValue, string> = {
  TRANSFER: Permission.CASH_MOVEMENT_RECORD,
  OPENING_ADJUSTMENT: Permission.CASH_MOVEMENT_RECORD,
  OWNER_INJECTION: Permission.OWNER_CAPITAL_RECORD,
  OWNER_WITHDRAWAL: Permission.OWNER_CAPITAL_RECORD,
  LOAN_RECEIVED: Permission.LOAN_MOVEMENT_RECORD,
  LOAN_REPAYMENT: Permission.LOAN_MOVEMENT_RECORD,
};

/** Which kinds may name the owner account, and which may name a loan account. */
const OWNER_KINDS: readonly string[] = ['OWNER_INJECTION', 'OWNER_WITHDRAWAL'];
const LOAN_KINDS: readonly string[] = ['LOAN_RECEIVED', 'LOAN_REPAYMENT'];


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
    private readonly reversals: DocumentReversalRepository,
    private readonly outbox: Outbox,
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
      await this.accessControl.require(tx, ctx, PERMISSION_FOR_KIND[command.kind]);

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
        reference: command.reference,
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
        reference: command.reference,
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
   * Cancelling a movement that should not have been recorded (Phase 9.2).
   *
   * **WRITE CLASS: T.** One reversing entry sends the money back the way it
   * came and the movement stays visible, marked `VOIDED` with the reason —
   * which is required, because a drawer that changed for no stated reason is
   * exactly what a day-end count cannot explain.
   *
   * A movement that touched the drawer can only be undone while a day is open,
   * for the same reason it could only be recorded while one was: cash that
   * moves on a day nobody counted is cash no count will ever see (§5.16.1).
   */
  async void(command: VoidMovementCommand): Promise<void> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      /*
       * Both codes, and the second one comes from the **stored** kind.
       *
       * `cash.movement.void` alone is not enough to undo an owner withdrawal
       * or a loan instalment: the person must also be trusted to record that
       * kind of movement in the first place. Reading the kind from the row
       * rather than from the request is what makes that true — a request can
       * claim anything, and this is the one call that reaches a posted
       * document by id alone.
       */
      await this.accessControl.require(tx, ctx, Permission.CASH_MOVEMENT_VOID);
      await this.requireKindPermission(tx, ctx, command.movementId);
      await this.assertDrawerOpenFor(tx, ctx, command.movementId);

      await reverseMoneyDocument(
        {
          reversals: this.reversals,
          periods: this.periods,
          audit: this.audit,
          outbox: this.outbox,
          clock: this.clock,
        },
        tx,
        ctx,
        {
          documentType: 'CASH_MOVEMENT',
          documentId: command.movementId,
          expectedVersion: command.version,
          reason: command.reason,
          intent: 'VOID',
          entityType: 'cash_movement',
          eventType: 'cash.movement.cancelled',
        },
      );
    });
  }

  /**
   * Correcting a movement — the amount typed wrongly, or the wrong account
   * picked (Phase 9.2, owner decisions 2026-08-30).
   *
   * Reversed and re-posted under the same number in one transaction. Where it
   * lands follows the closed-period rule: the original day while that month is
   * open, otherwise today as a `PRIOR_PERIOD` adjustment carrying the date it
   * belongs to, with a reason the shopkeeper must give.
   */
  async correct(command: CorrectMovementCommand): Promise<void> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      /*
       * The kind it is becoming **and** the kind it is now: a correction that
       * only checked the new kind would let someone re-label an owner
       * withdrawal as a transfer and thereby edit a document they were never
       * allowed to touch.
       */
      await this.accessControl.require(tx, ctx, PERMISSION_FOR_KIND[command.kind]);
      await this.requireKindPermission(tx, ctx, command.movementId);

      const posted = await this.reversals.findPosted(tx, ctx, 'CASH_MOVEMENT', command.movementId);
      if (posted === null) throw new AppError(ErrorCode.NOT_FOUND, 'That movement was not found');

      const today = this.clock.businessDate(ctx.timezone);
      const placement = correctionWindow(
        command.businessDate,
        today,
        await this.isOpen(tx, ctx, command.businessDate),
      );
      const reason = command.reason?.trim() ?? '';
      if (placement.reasonRequired && reason === '') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          placement.entryMode === 'PRIOR_PERIOD'
            ? 'That month is closed, so this correction posts today — say why'
            : 'A correction dated in the past needs a reason',
        );
      }

      await reverseMoneyDocument(
        {
          reversals: this.reversals,
          periods: this.periods,
          audit: this.audit,
          outbox: this.outbox,
          clock: this.clock,
        },
        tx,
        ctx,
        {
          documentType: 'CASH_MOVEMENT',
          documentId: command.movementId,
          expectedVersion: command.version,
          reason: reason === '' ? 'Corrected' : reason,
          intent: 'CORRECT',
          // Both halves of a correction land on the same day (see the port).
          businessDate: placement.businessDate,
          entityType: 'cash_movement',
          eventType: 'cash.movement.corrected',
        },
      );

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

      const session = await this.money.findOpenSession(tx, ctx);
      const touchesDrawer = from.isDrawer || to.isDrawer;
      if (touchesDrawer && (session === null || session.businessDate !== placement.businessDate)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Start the day before correcting cash in or out of the drawer',
        );
      }

      const posting = cashMovementPosting({
        kind: command.kind,
        fromAccount: from.code as never,
        toAccount: to.code as never,
        amountMinor: command.amountMinor,
      });

      const reposted = await this.money.repostMovement(tx, ctx, {
        id: command.movementId,
        // The reversal bumped the version a moment ago.
        expectedVersion: command.version + 1,
        kind: command.kind,
        fromAccountCode: from.code,
        toAccountCode: to.code,
        amountMinor: command.amountMinor,
        reference: command.reference,
        note: command.note,
        sessionId: touchesDrawer ? (session?.id ?? null) : null,
        businessDate: placement.businessDate,
        entryMode: placement.entryMode,
        correctionReason: reason === '' ? null : reason,
        originalBusinessDate: placement.originalBusinessDate,
        journal: {
          journalEntryId: Ulid.generate(this.clock),
          businessDate: placement.businessDate,
          entryMode: placement.entryMode,
          sourceType: 'CASH_MOVEMENT_CORRECTION',
          sourceId: command.movementId,
          sourceNumber: posted.number,
          lines: posting.lines.map((line) => ({
            id: Ulid.generate(this.clock),
            account: line.account,
            amountMinor: line.amountMinor,
            partyId: line.partyId,
          })),
        },
      });
      if (!reposted) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this movement — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'cash_movement',
        entityId: command.movementId,
        action: 'UPDATE',
        before: {
          amountMinor: String(posted.amountMinor),
          businessDate: posted.businessDate,
        },
        after: {
          amountMinor: String(command.amountMinor),
          businessDate: placement.businessDate,
          entryMode: placement.entryMode,
          reason,
        },
        source: 'API',
      });
    });
  }

  /**
   * The permission the movement **already on the row** needs.
   *
   * Used by cancel and correct, and deliberately not by record: those two
   * reach a posted document by id, so the kind in the request is a claim about
   * something that already exists and the stored kind is the fact. Without
   * this, `cash.movement.void` would be a master key over owner capital and
   * loan movements alike (owner decision 2026-08-31).
   */
  private async requireKindPermission(
    tx: Tx,
    ctx: TenantContext,
    movementId: string,
  ): Promise<void> {
    const stored = await this.money.findMovementKind(tx, ctx, movementId);
    if (stored === null) throw new AppError(ErrorCode.NOT_FOUND, 'That movement was not found');
    await this.accessControl.require(tx, ctx, PERMISSION_FOR_KIND[stored]);
  }

  /** Whether a business date's month still accepts postings (§5.14). */
  private async isOpen(tx: Tx, ctx: TenantContext, businessDate: string): Promise<boolean> {
    try {
      await this.periods.assertOpen(tx, ctx, businessDate);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Undoing drawer cash needs an open day, exactly as recording it did — the
   * money comes back into a till somebody has to count tonight.
   */
  private async assertDrawerOpenFor(
    tx: Tx,
    ctx: TenantContext,
    movementId: string,
  ): Promise<void> {
    const posted = await this.reversals.findPosted(tx, ctx, 'CASH_MOVEMENT', movementId);
    if (posted === null) throw new AppError(ErrorCode.NOT_FOUND, 'That movement was not found');
    const touchesDrawer = posted.journalLines.some((line) => line.account.startsWith('CASH:'));
    if (!touchesDrawer) return;

    const session = await this.money.findOpenSession(tx, ctx);
    if (session === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Start the day before cancelling cash in or out of the drawer',
      );
    }
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
      if (!OWNER_KINDS.includes(kind)) {
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

    /*
     * A loan account may only ever be one side of a loan movement.
     *
     * Without this, a transfer could name `LOAN:{id}` and quietly move money
     * onto a debt — which posts a real journal entry that no money screen
     * would show and that the Capital & Loans history would not list either,
     * because it is not a loan movement.
     */
    if (account.type === 'LOAN' && !LOAN_KINDS.includes(kind)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'A loan account can only be used for loan money received or repaid',
      );
    }
    if (account.type === 'LOAN') {
      await requireLoanVisibility(this.accessControl, tx, ctx);
    } else {
      await this.accessControl.require(
        tx,
        ctx,
        account.type === 'CASH' ? Permission.CASH_ACCOUNT_VIEW : Permission.BANK_ACCOUNT_VIEW,
      );
    }

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
