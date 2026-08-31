import { isRedateRefusal, planRedate } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  ChangeTransactionDateRequest, ChangeTransactionDateResponse, RedatableDocument,
  RedateReasonCode, TransactionDateContext,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { UserRepository } from '../auth/registration-repository';
import { assertStepUp } from '../backup/step-up';
import type { MoneyRepository } from '../money/money-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { PasswordHasher } from '../ports/password-hasher';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { DocumentReversalRepository } from './document-reversal-repository';
import type { DocumentRedateRepository } from './document-redate-repository';
import { reverseMoneyDocument } from './reverse-money-document';

/**
 * Change Transaction Date — moving a posted voucher to the day it really
 * happened (Phase 11.2, §5.15, D-43, UI-70, UI-72, owner decisions 2026-08-31).
 *
 * **WRITE CLASS: T.** One use case behind Daybook, the party and account
 * ledgers and the reconciliation compare screen. Every one of those is a
 * caller; none of them writes a date, and none of them owns a variant of this
 * rule (UI-72).
 *
 * **Append-only, and the two halves land on different days.** The posting that
 * is standing is reversed **on the day it is leaving**, and the same figures are
 * re-posted **on the day it is going to**, in one transaction under the same
 * document number. The old day nets to nothing, the new day carries the
 * transaction, and the journal keeps all three entries. This is the one thing
 * that separates a date change from every other correction, where both halves
 * land together: here, the two days *are* the change.
 *
 * **`created_at` is never touched.** Not by this service, not by the repository
 * it calls. The shop may correct when something happened; it may never rewrite
 * when it was typed, which is the whole of D-43 and the reason the audit view
 * stays trustworthy.
 *
 * **A closed period is protected, not immutable** (owner decision 2026-08-31).
 * Everyone below the Owner is refused. An Owner is shown what it costs, must
 * acknowledge it, and must re-enter their own password (§5.3) — and any
 * completed reconciliation covering those days reads back `REVIEW_REQUIRED` on
 * its own, because the posting count it stored no longer agrees with the
 * journal. Nothing here writes into a reconciliation.
 */

export interface ChangeTransactionDateCommand extends ChangeTransactionDateRequest {
  readonly ctx: TenantContext;
}

const NOUNS: Readonly<Record<RedatableDocument, string>> = {
  EXPENSE: 'expense',
  CUSTOMER_RECEIPT: 'receipt',
  SUPPLIER_PAYMENT: 'payment',
  CASH_MOVEMENT: 'cash movement',
};

const ENTITY_TYPES: Readonly<Record<RedatableDocument, string>> = {
  EXPENSE: 'expense',
  CUSTOMER_RECEIPT: 'customer_receipt',
  SUPPLIER_PAYMENT: 'supplier_payment',
  CASH_MOVEMENT: 'cash_movement',
};

/**
 * The presets, written out (UI-75).
 *
 * A reason is never blank, and three of the four cost a tap rather than a
 * sentence — the shopkeeper who is in a hurry is exactly the one whose reason
 * would otherwise be missing.
 */
const REASON_TEXT: Readonly<Record<RedateReasonCode, string>> = {
  WRONG_DATE: 'The date was typed wrongly',
  ENTERED_LATE: 'Recorded late, on the day it was entered',
  BANK_DATE: "Moved to the bank's own date for this money",
  OTHER: '',
};

export class ChangeTransactionDateService {

  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly periods: PeriodGuard,
    private readonly reversals: DocumentReversalRepository,
    private readonly redates: DocumentRedateRepository,
    private readonly money: MoneyRepository,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /**
   * What the dialog needs before it can ask the question sensibly: which day
   * the voucher is on, whether either month is closed, the earliest bill it
   * settles and whether the drawer pins it to one day.
   *
   * The browser is told the answers rather than deriving them, because the
   * period calendar, the allocations and the open session are three things it
   * does not have — and a screen that guesses would grey out the wrong days.
   */
  async describe(
    ctx: TenantContext,
    documentType: RedatableDocument,
    documentId: string,
  ): Promise<TransactionDateContext> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.TRANSACTION_DATE_CHANGE);

      const posted = await this.reversals.findPosted(tx, ctx, documentType, documentId);
      if (posted === null) {
        throw new AppError(ErrorCode.NOT_FOUND, `That ${NOUNS[documentType]} was not found`);
      }
      const facts = await this.redates.findRedatable(tx, ctx, documentType, documentId);
      const allocations = facts?.allocations ?? [];

      const held = await this.access.permissionsOf(tx, ctx);
      const earliest = [...allocations].sort((a, b) =>
        a.businessDate < b.businessDate ? 1 : a.businessDate > b.businessDate ? -1 : 0,
      )[0];

      return {
        documentType,
        documentId: posted.id,
        number: posted.number,
        version: posted.version,
        businessDate: posted.businessDate,
        originalBusinessDate: null,
        amountMinor: posted.amountMinor,
        today: this.clock.businessDate(ctx.timezone),
        currentPeriodOpen: await this.isOpen(tx, ctx, posted.businessDate),
        mayChange: true,
        mayChangeLocked: held.includes(Permission.TRANSACTION_DATE_CHANGE_LOCKED),
        earliestAllocatedDate: earliest?.businessDate ?? null,
        earliestAllocatedNumber: earliest?.number ?? null,
        drawerSessionDate: await this.drawerDate(tx, ctx, facts?.sessionId ?? null),
      };
    });
  }

  async change(command: ChangeTransactionDateCommand): Promise<ChangeTransactionDateResponse> {
    const { ctx, documentType, documentId } = command;
    const noun = NOUNS[documentType];

    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.TRANSACTION_DATE_CHANGE);

      const posted = await this.reversals.findPosted(tx, ctx, documentType, documentId);
      if (posted === null) throw new AppError(ErrorCode.NOT_FOUND, `That ${noun} was not found`);
      if (posted.status !== 'POSTED') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `This ${noun} has been cancelled — there is no date to change`,
        );
      }

      const reason = this.reasonFor(command.reasonCode, command.reasonText);

      /*
       * Read before the reversal, which deletes the allocation rows: after it,
       * the bills this money settled are no longer knowable from the document,
       * and the refusal below could not be made at all.
       */
      const facts = await this.redates.findRedatable(tx, ctx, documentType, documentId);
      const allocations = facts?.allocations ?? [];

      const held = await this.access.permissionsOf(tx, ctx);
      const plan = planRedate({
        currentDate: posted.businessDate,
        newDate: command.businessDate,
        today: this.clock.businessDate(ctx.timezone),
        currentPeriodOpen: await this.isOpen(tx, ctx, posted.businessDate),
        newPeriodOpen: await this.isOpen(tx, ctx, command.businessDate),
        mayEnterClosedPeriod: held.includes(Permission.TRANSACTION_DATE_CHANGE_LOCKED),
        allocations: allocations.map((allocation) => ({
          number: allocation.number,
          businessDate: allocation.businessDate,
        })),
        drawerSessionDate: await this.drawerDate(tx, ctx, facts?.sessionId ?? null),
      });
      if (isRedateRefusal(plan)) {
        throw new AppError(
          plan.reason === 'PERIOD_LOCKED' ? ErrorCode.PERIOD_LOCKED : ErrorCode.VALIDATION_FAILED,
          plan.message,
          { reason: plan.reason },
        );
      }

      if (plan.closedPeriodOverride) {
        /*
         * The warning cannot be skipped by a client that forgot to draw it.
         * §5.3's step-up is the second half: a session left open on the counter
         * PC is not enough to reach into a month somebody has already closed,
         * printed and shown to a lender.
         */
        if (!command.acknowledgeClosedPeriod) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'That month is closed. Confirm you understand this before moving the transaction.',
            { reason: 'CLOSED_PERIOD_UNACKNOWLEDGED' },
          );
        }
        await assertStepUp(tx, ctx, this.users, this.hasher, command.confirmPassword ?? '');
      }

      /*
       * The reversal posts on the day the transaction is **leaving**, not on the
       * day it is going to. That is what empties the old day: a reversal dated
       * with the repost would leave the original figure standing where it was
       * and net the new day to zero — the exact opposite of the move.
       */
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
          documentType,
          documentId,
          expectedVersion: command.version,
          reason,
          intent: 'CORRECT',
          businessDate: posted.businessDate,
          periodDecidedByCaller: true,
          entityType: ENTITY_TYPES[documentType],
          eventType: 'transaction.date.changed',
        },
      );

      const sessionId = await this.sessionFor(tx, ctx, facts?.sessionId ?? null);

      const reposted = await this.redates.repost(tx, ctx, {
        documentType,
        documentId,
        // The reversal bumped the version a moment ago.
        expectedVersion: command.version + 1,
        sourceNumber: posted.number,
        businessDate: plan.businessDate,
        entryMode: plan.entryMode,
        correctionReason: reason,
        originalBusinessDate: plan.originalBusinessDate,
        sessionId,
        journalEntryId: Ulid.generate(this.clock),
        /*
         * The same lines that were posted, copied under new ids. Not
         * recomputed: this action may change one field, and re-deriving the
         * posting from today's balances could change a figure nobody asked to
         * change.
         */
        journalLines: posted.journalLines.map((line) => ({
          id: Ulid.generate(this.clock),
          account: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
        // Re-created verbatim: the reversal released them, and the same money
        // still settles the same bills for the same amounts.
        allocations: allocations.map((allocation) => ({
          ...allocation,
          id: Ulid.generate(this.clock),
        })),
      });
      if (!reposted) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          `Someone else changed this ${noun} — reload and try again`,
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPES[documentType],
        entityId: documentId,
        action: 'UPDATE',
        before: { number: posted.number, businessDate: posted.businessDate },
        after: {
          number: posted.number,
          businessDate: plan.businessDate,
          entryMode: plan.entryMode,
          reasonCode: command.reasonCode,
          reason,
          closedPeriodOverride: String(plan.closedPeriodOverride),
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'transaction.date.changed',
        aggregateType: ENTITY_TYPES[documentType],
        aggregateId: documentId,
        payload: {
          number: posted.number,
          fromBusinessDate: posted.businessDate,
          toBusinessDate: plan.businessDate,
        },
      });

      return {
        documentType,
        documentId,
        number: posted.number,
        fromBusinessDate: posted.businessDate,
        toBusinessDate: plan.businessDate,
        entryMode: plan.entryMode,
        version: command.version + 2,
        closedPeriodOverride: plan.closedPeriodOverride,
        reconciliationsUnderReview: await this.redates.countCompletedReconciliations(
          tx,
          ctx,
          documentId,
        ),
      };
    });
  }

  /** The reason, never blank — free text only where a preset cannot say it. */
  private reasonFor(code: RedateReasonCode, text: string | null): string {
    const typed = text?.trim() ?? '';
    if (code === 'OTHER') {
      if (typed === '') throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say why the date is changing');
      return typed;
    }
    return typed === '' ? REASON_TEXT[code] : `${REASON_TEXT[code]} — ${typed}`;
  }

  /**
   * The day the drawer this money went through is still open on, or null when
   * it went nowhere near one.
   *
   * A session that has been **closed** returns its own date, which no longer
   * matches any open day — so a voucher inside a counted drawer can only move
   * to the day that session covers, which is to say nowhere. That is the rule:
   * an expected closing is immutable once counted (§5.16.8).
   */
  private async drawerDate(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string | null,
  ): Promise<string | null> {
    if (sessionId === null) return null;
    const open = await this.money.findOpenSession(tx, ctx);
    if (open !== null && open.id === sessionId) return open.businessDate;
    const session = await this.money.findSessionById(tx, ctx, sessionId);
    return session?.businessDate ?? null;
  }

  /**
   * Which session the re-posted document belongs to.
   *
   * The same one it was in: the plan has already refused any move that would
   * take drawer money off the day its session covers, so there is no other
   * session it could honestly join.
   */
  private async sessionFor(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string | null,
  ): Promise<string | null> {
    if (sessionId === null) return null;
    const session = await this.money.findSessionById(tx, ctx, sessionId);
    return session === null ? null : session.id;
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
}
