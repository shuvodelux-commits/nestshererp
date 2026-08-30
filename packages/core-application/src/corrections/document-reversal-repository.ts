import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Undoing a posted money document (§2.5, Phase 9.2).
 *
 * **One port for four document types, because it is one act.** An expense, a
 * customer receipt, a supplier payment and a cash movement differ in what they
 * mean and not at all in how they are undone: each posted exactly one balanced
 * journal entry and moved no stock, so cancelling any of them is the same
 * three steps — read the entry that was posted, post its negation, and mark
 * the document `VOIDED` without deleting it.
 *
 * The **reversal is built from what was posted**, never recomputed from the
 * document's own columns. A receipt cancelled a month later at today's account
 * balances would be a different entry from the one it is undoing, and the two
 * would not cancel out.
 *
 * Documents that move stock are **not** here. A sale, a purchase, a return and
 * a stock adjustment each have to unwind lots and cost states as well, which is
 * their own module's arithmetic and not something a shared table map can do
 * correctly.
 */

export type ReversibleDocument =
  | 'EXPENSE'
  | 'CUSTOMER_RECEIPT'
  | 'SUPPLIER_PAYMENT'
  | 'CASH_MOVEMENT';

export interface PostedJournalLine {
  readonly account: string;
  readonly amountMinor: number;
  readonly partyId: string | null;
}

export interface PostedDocument {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly amountMinor: number;
  readonly version: number;
  readonly accountCode: string | null;
  readonly partyId: string | null;
  readonly note: string | null;
  readonly journalEntryId: string;
  readonly journalLines: readonly PostedJournalLine[];
  /**
   * What this document has been pointed at — the invoices a receipt settled,
   * the bills a payment paid. Cancelling releases them, so they are owed again.
   */
  readonly allocatedMinor: number;
}

export interface DocumentReversalInput {
  readonly documentType: ReversibleDocument;
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly sourceNumber: string;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly reason: string;
  readonly journalEntryId: string;
  readonly journalLines: readonly (PostedJournalLine & { id: string })[];
  /** True to drop this document's allocations, so what it settled is owed again. */
  readonly releaseAllocations: boolean;
}

export interface DocumentReversalRepository {
  findPosted(
    tx: Tx,
    ctx: TenantContext,
    documentType: ReversibleDocument,
    documentId: string,
  ): Promise<PostedDocument | null>;

  /** Returns false when somebody else changed the document first (D-32). */
  reverse(tx: Tx, ctx: TenantContext, input: DocumentReversalInput): Promise<boolean>;
}
