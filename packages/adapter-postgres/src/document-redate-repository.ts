import type {
  DocumentRedateInput, DocumentRedateRepository, RedatableFacts, RedateAllocation,
  TenantContext, Tx,
} from '@sher/core-application';
import type { RedatableDocument } from '@sher/core-contracts';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Clock } from '@sher/shared-utils';

import { txOf } from './unit-of-work';

/**
 * Re-posting a money document on a different day (Phase 11.2, D-43).
 *
 * **One table map, four documents**, the same closed and explicit map the
 * reversal repository keeps next door — and deliberately a second copy rather
 * than a shared one, because the two maps answer different questions and the
 * day one of them needs a fifth document is not the day the other does.
 *
 * The map is the only source of table and column names in this file. Nothing a
 * caller sends is ever interpolated as an identifier.
 *
 * **`created_at` is not in any statement here.** Not in the UPDATE, not in the
 * allocation inserts. The new journal rows get their own `created_at` because
 * they are genuinely being written now — which is the point: the entry date
 * tells the truth about when the shop did this, while `business_date` tells the
 * truth about when the money moved (D-43).
 */

interface RedateShape {
  readonly table: string;
  readonly numberColumn: string;
  /** What a corrected re-posting is filed as, so the original stays unique. */
  readonly correctionSourceType: string;
  /** Where this document's allocations live, and what they point at. */
  readonly allocations: {
    readonly table: string;
    readonly column: string;
    readonly targetColumn: string;
    readonly targetTable: string;
    readonly targetNumberColumn: string;
  } | null;
}

const SHAPES: Readonly<Record<RedatableDocument, RedateShape>> = {
  EXPENSE: {
    table: 'expenses',
    numberColumn: 'expense_number',
    correctionSourceType: 'EXPENSE_CORRECTION',
    allocations: null,
  },
  CUSTOMER_RECEIPT: {
    table: 'customer_receipts',
    numberColumn: 'receipt_number',
    correctionSourceType: 'CUSTOMER_RECEIPT_CORRECTION',
    allocations: {
      table: 'receipt_allocations',
      column: 'receipt_id',
      targetColumn: 'sale_id',
      targetTable: 'sales',
      targetNumberColumn: 'sale_number',
    },
  },
  SUPPLIER_PAYMENT: {
    table: 'supplier_payments',
    numberColumn: 'payment_number',
    correctionSourceType: 'SUPPLIER_PAYMENT_CORRECTION',
    allocations: {
      table: 'payment_allocations',
      column: 'payment_id',
      targetColumn: 'purchase_id',
      targetTable: 'purchases',
      targetNumberColumn: 'purchase_number',
    },
  },
  CASH_MOVEMENT: {
    table: 'cash_movements',
    numberColumn: 'movement_number',
    correctionSourceType: 'CASH_MOVEMENT_CORRECTION',
    allocations: null,
  },
};

function int(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? Math.round(value) : Math.round(Number(value));
}

/** An identifier the caller did not supply — it comes from the closed map above. */
function ident(name: string): SQL {
  return sql.raw(name);
}

export class PostgresDocumentRedateRepository implements DocumentRedateRepository {
  constructor(private readonly clock: Clock) {}

  async findRedatable(
    tx: Tx,
    ctx: TenantContext,
    documentType: RedatableDocument,
    documentId: string,
  ): Promise<RedatableFacts | null> {
    const shape = SHAPES[documentType];
    const db = txOf(tx);

    const found = await db.execute<{ session_id: string | null }>(sql`
      SELECT d.session_id
        FROM ${ident(shape.table)} d
       WHERE d.tenant_id = ${ctx.tenantId} AND d.id = ${documentId}
       LIMIT 1
    `);
    const row = found.rows[0];
    if (row === undefined) return null;

    const allocations: RedateAllocation[] = [];
    if (shape.allocations !== null) {
      const link = shape.allocations;
      /*
       * Each settled bill with **its own** business date, which is what the
       * "money cannot pay a bill that does not exist yet" refusal is decided
       * from. Joined here rather than counted, because a refusal that cannot
       * name the offending invoice is not one a shopkeeper can act on.
       */
      const rows = await db.execute<{
        id: string; target_id: string; number: string; business_date: string; amount_minor: string;
      }>(sql`
        SELECT a.id, a.${ident(link.targetColumn)} AS target_id,
               t.${ident(link.targetNumberColumn)} AS number,
               t.business_date::text AS business_date,
               a.amount_minor::text AS amount_minor
          FROM ${ident(link.table)} a
          JOIN ${ident(link.targetTable)} t
            ON t.tenant_id = a.tenant_id AND t.id = a.${ident(link.targetColumn)}
         WHERE a.tenant_id = ${ctx.tenantId} AND a.${ident(link.column)} = ${documentId}
         ORDER BY t.business_date, a.id
      `);
      for (const allocation of rows.rows) {
        allocations.push({
          id: allocation.id.trim(),
          targetId: allocation.target_id.trim(),
          number: allocation.number,
          businessDate: allocation.business_date,
          amountMinor: int(allocation.amount_minor),
        });
      }
    }

    return {
      sessionId: row.session_id === null ? null : row.session_id.trim(),
      allocations,
    };
  }

  async repost(tx: Tx, ctx: TenantContext, input: DocumentRedateInput): Promise<boolean> {
    const shape = SHAPES[input.documentType];
    const db = txOf(tx);
    const now = this.clock.now();

    /*
     * Back to POSTED from the VOIDED the reversal left moments ago, inside the
     * same transaction: no reader ever sees this document cancelled, and none
     * sees the day without it. The optimistic lock is the UPDATE itself (D-32).
     *
     * `business_date` moves. `created_at` is not in this statement.
     */
    const updated = await db.execute<{ id: string }>(sql`
      UPDATE ${ident(shape.table)}
         SET business_date = ${input.businessDate},
             entry_mode = ${input.entryMode},
             correction_reason = ${input.correctionReason},
             original_business_date = ${input.originalBusinessDate},
             session_id = ${input.sessionId},
             status = 'POSTED',
             void_reason = NULL,
             updated_at = ${now},
             updated_by = ${ctx.userId},
             version = ${input.expectedVersion + 1}
       WHERE tenant_id = ${ctx.tenantId}
         AND id = ${input.documentId}
         AND version = ${input.expectedVersion}
       RETURNING id
    `);
    if (updated.rows.length === 0) return false;

    await db.execute(sql`
      INSERT INTO journal_entries (
        id, tenant_id, created_at, created_by, business_date,
        source_document_type, source_document_id, source_number, entry_mode
      ) VALUES (
        ${input.journalEntryId}, ${ctx.tenantId}, ${now}, ${ctx.userId}, ${input.businessDate},
        ${shape.correctionSourceType}, ${input.documentId}, ${input.sourceNumber}, ${input.entryMode}
      )
    `);

    for (const line of input.journalLines) {
      await db.execute(sql`
        INSERT INTO journal_lines (
          id, tenant_id, created_at, created_by, journal_entry_id, account_code, amount_minor, party_id
        ) VALUES (
          ${line.id}, ${ctx.tenantId}, ${now}, ${ctx.userId}, ${input.journalEntryId},
          ${line.account}, ${line.amountMinor}, ${line.partyId}
        )
      `);
    }

    /*
     * The reversal released these; the same money still settles the same bills
     * for the same amounts, so they go back exactly as they were. A date change
     * that re-allocated from scratch could quietly point the money at a
     * different invoice, which is a change nobody asked for.
     */
    if (shape.allocations !== null) {
      const link = shape.allocations;
      for (const allocation of input.allocations) {
        await db.execute(sql`
          INSERT INTO ${ident(link.table)} (
            id, tenant_id, ${ident(link.column)}, ${ident(link.targetColumn)},
            amount_minor, created_at, created_by
          ) VALUES (
            ${allocation.id}, ${ctx.tenantId}, ${input.documentId}, ${allocation.targetId},
            ${allocation.amountMinor}, ${now}, ${ctx.userId}
          )
        `);
      }
    }

    return true;
  }

  async countCompletedReconciliations(
    tx: Tx,
    ctx: TenantContext,
    documentId: string,
  ): Promise<number> {
    const db = txOf(tx);
    /*
     * Read, never written. A completed reconciliation that matched this
     * document now reads back `REVIEW_REQUIRED` all by itself, because the
     * posting count it stored no longer agrees with the journal (§5.17). This
     * count only tells the person who moved the date how many sign-offs they
     * have just put back under review.
     */
    const rows = await db.execute<{ count: string }>(sql`
      SELECT COUNT(DISTINCT r.id)::text AS count
        FROM account_reconciliations r
        JOIN reconciliation_matches m
          ON m.tenant_id = r.tenant_id AND m.reconciliation_id = r.id
       WHERE r.tenant_id = ${ctx.tenantId}
         AND r.status = 'COMPLETED'
         AND m.document_id = ${documentId}
         AND m.state <> 'REJECTED'
    `);
    return int(rows.rows[0]?.count);
  }
}
