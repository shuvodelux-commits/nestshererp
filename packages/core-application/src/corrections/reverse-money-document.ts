import { cancellationDate, rejectEntry } from '@sher/core-domain';
import type { AccountCode } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AuditWriter } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';
import type {
  DocumentReversalRepository, PostedDocument, ReversibleDocument,
} from './document-reversal-repository';

/**
 * The half of a cancellation that is the same for every money document.
 *
 * A helper called **from** the owning service rather than a service of its
 * own: each module still checks its own permission, applies its own refusals
 * and writes its own audit entry, so there is no second writer and no back door
 * (A11). What lives here is only the shared mechanics — negate the entry that
 * was posted, refuse a double cancellation, mark the document, and post on the
 * day the cancellation was made (owner rule).
 *
 * Used for the correcting half too: a correction is this reversal followed by a
 * fresh posting under the same number, inside one transaction, so the ledger is
 * never briefly missing the document.
 */

export interface ReverseMoneyDocumentDeps {
  readonly reversals: DocumentReversalRepository;
  readonly periods: PeriodGuard;
  readonly audit: AuditWriter;
  readonly outbox: Outbox;
  readonly clock: Clock;
}

export interface ReverseMoneyDocumentInput {
  readonly documentType: ReversibleDocument;
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  /** `VOID` marks the document cancelled; `CORRECT` clears the way for a repost. */
  readonly intent: 'VOID' | 'CORRECT';
  /**
   * The day the reversal posts on.
   *
   * A **cancellation** leaves this unset and posts on the day it was made —
   * the money came back today (owner rule). A **correction** passes its own
   * date, because its two halves are one act: reversing on today and
   * re-posting on the original day would leave one day showing both the old
   * and the new figure and another showing a negative that nothing on it
   * explains.
   */
  readonly businessDate?: string | undefined;
  /**
   * Set only by the date-change use case (Phase 11.2), which has already made a
   * **stricter** decision than the one below: it checks *both* the day the
   * document leaves and the day it arrives on, refuses a closed month outright
   * for everyone but the Owner, and makes the Owner acknowledge the warning and
   * re-enter their password before it will post. Re-checking one of those two
   * days here would refuse the case that decision exists to allow.
   *
   * Nothing else may set it. A caller that has not made that decision and skips
   * this guard is posting into a closed month by accident, which is the one
   * thing §5.14 exists to prevent.
   */
  readonly periodDecidedByCaller?: boolean | undefined;
  readonly entityType: string;
  readonly eventType: string;
}

const NOUNS: Readonly<Record<ReversibleDocument, string>> = {
  EXPENSE: 'expense',
  CUSTOMER_RECEIPT: 'receipt',
  SUPPLIER_PAYMENT: 'payment',
  CASH_MOVEMENT: 'cash movement',
};

export async function reverseMoneyDocument(
  deps: ReverseMoneyDocumentDeps,
  tx: Tx,
  ctx: TenantContext,
  input: ReverseMoneyDocumentInput,
): Promise<PostedDocument> {
  const noun = NOUNS[input.documentType];
  const posted = await deps.reversals.findPosted(tx, ctx, input.documentType, input.documentId);
  if (posted === null) throw new AppError(ErrorCode.NOT_FOUND, `That ${noun} was not found`);
  if (posted.status !== 'POSTED') {
    throw new AppError(ErrorCode.VALIDATION_FAILED, `This ${noun} has already been cancelled`);
  }
  if (input.reason.trim().length === 0) {
    // The owner's rule: a cancellation always says why. The before/after values
    // explain a correction, but nothing explains a deletion except the person.
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say why this is being cancelled');
  }

  const today = deps.clock.businessDate(ctx.timezone);
  const businessDate = input.businessDate ?? cancellationDate(today);
  /*
   * Only the day this actually posts on is guarded.
   *
   * The document's own month is deliberately **not** guarded: once it is
   * closed, nothing may post into it — which is exactly why the correction is
   * dated today as a prior-period adjustment, and why a cancellation carries
   * the day it was made. Guarding the old month as well would refuse the one
   * case the owner's rule exists for, and would leave a shop unable to undo
   * last month's mistake at all.
   */
  if (input.periodDecidedByCaller !== true) await deps.periods.assertOpen(tx, ctx, businessDate);

  const reversal = posted.journalLines.map((line) => ({
    id: Ulid.generate(deps.clock),
    account: line.account as AccountCode,
    amountMinor: -line.amountMinor,
    partyId: line.partyId,
  }));
  if (rejectEntry({ lines: reversal }) !== null) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, `This ${noun} cannot be reversed cleanly`);
  }

  const ok = await deps.reversals.reverse(tx, ctx, {
    documentType: input.documentType,
    documentId: posted.id,
    expectedVersion: input.expectedVersion,
    sourceNumber: posted.number,
    businessDate,
    entryMode: 'CORRECTED',
    reason: input.reason.trim(),
    journalEntryId: Ulid.generate(deps.clock),
    journalLines: reversal,
    // A correction re-posts immediately and re-allocates as it goes; a
    // cancellation has nothing to re-point at, so what it settled is owed again.
    releaseAllocations: true,
  });
  if (!ok) {
    throw new AppError(
      ErrorCode.CONFLICT_STALE_VERSION,
      `Someone else changed this ${noun} — reload and try again`,
    );
  }

  await deps.audit.append(tx, ctx, {
    entityType: input.entityType,
    entityId: posted.id,
    action: input.intent === 'VOID' ? 'DELETE' : 'UPDATE',
    before: {
      number: posted.number,
      status: 'POSTED',
      amountMinor: String(posted.amountMinor),
      businessDate: posted.businessDate,
    },
    after: {
      number: posted.number,
      status: input.intent === 'VOID' ? 'VOIDED' : 'CORRECTED',
      reason: input.reason.trim(),
    },
    source: 'API',
  });
  await deps.outbox.append(tx, ctx, {
    eventType: input.eventType,
    aggregateType: input.entityType,
    aggregateId: posted.id,
    payload: { number: posted.number, amountMinor: posted.amountMinor, intent: input.intent },
  });

  return posted;
}
