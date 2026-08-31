import type { RedatableDocument } from '@sher/core-contracts';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Re-posting a money document on a different day (Phase 11.2, D-43).
 *
 * The sibling of `DocumentReversalRepository`, and deliberately not part of it:
 * that port **undoes** a document, this one **puts it back**, and the two are
 * used together by exactly one caller. Keeping the repost separate is what
 * stops a cancellation from ever growing a way to re-post something.
 *
 * **Only the date moves.** The journal lines handed back here are the ones that
 * were already posted, copied line for line under new ids, and the allocations
 * are the ones the reversal just released, re-created unchanged. Nothing is
 * recomputed from the document's columns: a receipt re-priced at today's
 * balances would be a different receipt, and this action is not allowed to
 * change a single figure.
 */

export interface RedateJournalLine {
  readonly id: string;
  readonly account: string;
  readonly amountMinor: number;
  readonly partyId: string | null;
}

/** One invoice or bill this document settles, for the before-the-debt refusal. */
export interface RedateAllocation {
  readonly id: string;
  /** `sale_id` or `purchase_id` — which, is the document type's business. */
  readonly targetId: string;
  readonly number: string;
  readonly businessDate: string;
  readonly amountMinor: number;
}

export interface DocumentRedateInput {
  readonly documentType: RedatableDocument;
  readonly documentId: string;
  /** The reversal bumped the version a moment ago, so this is that number. */
  readonly expectedVersion: number;
  readonly sourceNumber: string;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly correctionReason: string;
  readonly originalBusinessDate: string;
  /**
   * The cash session the money now belongs to, re-resolved for the new day.
   * Null for an account nobody counts.
   */
  readonly sessionId: string | null;
  readonly journalEntryId: string;
  readonly journalLines: readonly RedateJournalLine[];
  /** Re-created verbatim: the same bills, for the same amounts. */
  readonly allocations: readonly RedateAllocation[];
}

/**
 * The two things a date change needs that cancelling one never did.
 *
 * Read **before** the reversal, which deletes the allocation rows.
 */
export interface RedatableFacts {
  /**
   * The cash session this document was recorded into, when it went through a
   * counted drawer. Non-null is the whole test: a bank or bKash account has
   * nothing to count, and its date moves freely.
   */
  readonly sessionId: string | null;
  /** What this money settles, with each bill's own day. */
  readonly allocations: readonly RedateAllocation[];
}

export interface DocumentRedateRepository {
  /**
   * The drawer session and the settled bills — the figures the "a payment
   * cannot precede its bill" and "that drawer has been counted" refusals are
   * decided from. Null when the document does not exist.
   */
  findRedatable(
    tx: Tx,
    ctx: TenantContext,
    documentType: RedatableDocument,
    documentId: string,
  ): Promise<RedatableFacts | null>;

  /** Returns false when somebody else changed the document first (D-32). */
  repost(tx: Tx, ctx: TenantContext, input: DocumentRedateInput): Promise<boolean>;

  /**
   * How many **completed** reconciliations have this document matched into
   * them. Each of those now reads back `REVIEW_REQUIRED`, because its stored
   * posting count no longer agrees with the journal — nothing is written into
   * them here, and nothing needs to be (§5.17).
   */
  countCompletedReconciliations(
    tx: Tx,
    ctx: TenantContext,
    documentId: string,
  ): Promise<number>;
}
