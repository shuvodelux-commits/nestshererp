import type {
  DocumentReversalInput, DocumentReversalRepository, PostedDocument, ReversibleDocument,
  TenantContext, Tx,
} from '@sher/core-application';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Clock } from '@sher/shared-utils';

import { txOf } from './unit-of-work';

/**
 * Cancelling a posted money document (§2.5, Phase 9.2).
 *
 * **One table map, four documents.** Each of these tables holds a document that
 * posted exactly one balanced journal entry and moved no stock, and each is
 * undone the same way — so what differs between them is four strings, not four
 * implementations. The map is explicit and closed: a document type that is not
 * in it cannot be reversed here, which is what keeps a stock-bearing document
 * (whose lots and cost states also have to be unwound) from ever being
 * cancelled by this path.
 *
 * The reversing entry is written from the **stored** journal lines, negated —
 * never recomputed — so it cancels the original exactly, whatever has happened
 * to balances since.
 */

interface DocumentShape {
  readonly table: string;
  readonly numberColumn: string;
  readonly sourceType: string;
  readonly reversalSourceType: string;
  /** What a corrected re-posting is filed as, so the original stays unique. */
  readonly correctionSourceType: string;
  /** The money column, for the audit line and the screen's confirmation. */
  readonly amountColumn: string;
  readonly accountColumn: string | null;
  readonly partyColumn: string | null;
  /** Where this document's allocations live, when it has any. */
  readonly allocations: { readonly table: string; readonly column: string } | null;
}

const SHAPES: Readonly<Record<ReversibleDocument, DocumentShape>> = {
  EXPENSE: {
    table: 'expenses',
    numberColumn: 'expense_number',
    sourceType: 'EXPENSE',
    reversalSourceType: 'EXPENSE_REVERSAL',
    correctionSourceType: 'EXPENSE_CORRECTION',
    amountColumn: 'amount_minor',
    accountColumn: 'account_code',
    partyColumn: 'payee_party_id',
    allocations: null,
  },
  CUSTOMER_RECEIPT: {
    table: 'customer_receipts',
    numberColumn: 'receipt_number',
    sourceType: 'CUSTOMER_RECEIPT',
    reversalSourceType: 'CUSTOMER_RECEIPT_REVERSAL',
    correctionSourceType: 'CUSTOMER_RECEIPT_CORRECTION',
    amountColumn: 'amount_minor',
    accountColumn: 'account_code',
    partyColumn: 'customer_party_id',
    allocations: { table: 'receipt_allocations', column: 'receipt_id' },
  },
  SUPPLIER_PAYMENT: {
    table: 'supplier_payments',
    numberColumn: 'payment_number',
    sourceType: 'SUPPLIER_PAYMENT',
    reversalSourceType: 'SUPPLIER_PAYMENT_REVERSAL',
    correctionSourceType: 'SUPPLIER_PAYMENT_CORRECTION',
    amountColumn: 'amount_minor',
    accountColumn: 'account_code',
    partyColumn: 'supplier_party_id',
    allocations: { table: 'payment_allocations', column: 'payment_id' },
  },
  CASH_MOVEMENT: {
    table: 'cash_movements',
    numberColumn: 'movement_number',
    sourceType: 'CASH_MOVEMENT',
    reversalSourceType: 'CASH_MOVEMENT_REVERSAL',
    correctionSourceType: 'CASH_MOVEMENT_CORRECTION',
    amountColumn: 'amount_minor',
    accountColumn: 'to_account_code',
    partyColumn: null,
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

export class PostgresDocumentReversalRepository implements DocumentReversalRepository {
  constructor(private readonly clock: Clock) {}

  async findPosted(
    tx: Tx,
    ctx: TenantContext,
    documentType: ReversibleDocument,
    documentId: string,
  ): Promise<PostedDocument | null> {
    const shape = SHAPES[documentType];
    const db = txOf(tx);

    const rows = await db.execute<{
      id: string; number: string; status: string; business_date: string; entry_mode: string;
      amount_minor: string; version: number; account_code: string | null;
      party_id: string | null; note: string | null; allocated: string;
      journal_entry_id: string | null;
    }>(sql`
      SELECT d.id, d.${ident(shape.numberColumn)} AS number, d.status,
             d.business_date::text AS business_date, d.entry_mode,
             d.${ident(shape.amountColumn)}::text AS amount_minor, d.version,
             ${shape.accountColumn === null ? sql`NULL::text` : sql`d.${ident(shape.accountColumn)}`} AS account_code,
             ${shape.partyColumn === null ? sql`NULL::char(26)` : sql`d.${ident(shape.partyColumn)}`} AS party_id,
             d.note,
             ${
               shape.allocations === null
                 ? sql`0::text`
                 : sql`(SELECT COALESCE(SUM(a.amount_minor), 0)::text
                          FROM ${ident(shape.allocations.table)} a
                         WHERE a.tenant_id = d.tenant_id AND a.${ident(shape.allocations.column)} = d.id)`
             } AS allocated,
             /*
              * The posting that is **standing**, not the first one ever made: a
              * document corrected on Monday and again on Friday must have
              * Monday's correction reversed, not the original nobody can see
              * any more. Reversals are excluded — undoing an undo is not what
              * any of this means.
              */
             (SELECT je.id FROM journal_entries je
               WHERE je.tenant_id = d.tenant_id
                 AND je.source_document_id = d.id
                 AND je.source_document_type IN (${shape.sourceType}, ${shape.correctionSourceType})
               ORDER BY je.created_at DESC LIMIT 1) AS journal_entry_id
        FROM ${ident(shape.table)} d
       WHERE d.tenant_id = ${ctx.tenantId} AND d.id = ${documentId}
       LIMIT 1
    `);

    const row = rows.rows[0];
    if (row === undefined) return null;

    const entryId = row.journal_entry_id;
    const lines =
      entryId === null
        ? { rows: [] as { account_code: string; amount_minor: string; party_id: string | null }[] }
        : await db.execute<{ account_code: string; amount_minor: string; party_id: string | null }>(sql`
            SELECT jl.account_code, jl.amount_minor::text AS amount_minor, jl.party_id
              FROM journal_lines jl
             WHERE jl.tenant_id = ${ctx.tenantId} AND jl.journal_entry_id = ${entryId}
             ORDER BY jl.id
          `);

    return {
      id: row.id.trim(),
      number: row.number,
      status: row.status,
      businessDate: row.business_date,
      entryMode: row.entry_mode,
      amountMinor: int(row.amount_minor),
      version: row.version,
      accountCode: row.account_code,
      partyId: row.party_id === null ? null : row.party_id.trim(),
      note: row.note,
      journalEntryId: entryId === null ? '' : entryId.trim(),
      journalLines: lines.rows.map((line) => ({
        account: line.account_code,
        amountMinor: int(line.amount_minor),
        partyId: line.party_id === null ? null : line.party_id.trim(),
      })),
      allocatedMinor: int(row.allocated),
    };
  }

  async reverse(tx: Tx, ctx: TenantContext, input: DocumentReversalInput): Promise<boolean> {
    const shape = SHAPES[input.documentType];
    const db = txOf(tx);
    const now = this.clock.now();

    /*
     * The optimistic lock is the UPDATE itself (D-32): the loser of a race
     * changes no rows and is told, rather than cancelling a document somebody
     * else has already changed underneath them.
     */
    const updated = await db.execute<{ id: string }>(sql`
      UPDATE ${ident(shape.table)}
         SET status = 'VOIDED',
             void_reason = ${input.reason},
             updated_at = ${now},
             updated_by = ${ctx.userId},
             version = version + 1
       WHERE tenant_id = ${ctx.tenantId}
         AND id = ${input.documentId}
         AND version = ${input.expectedVersion}
         AND status = 'POSTED'
       RETURNING id
    `);
    if (updated.rows.length === 0) return false;

    await db.execute(sql`
      INSERT INTO journal_entries (
        id, tenant_id, created_at, created_by, business_date,
        source_document_type, source_document_id, source_number, entry_mode
      ) VALUES (
        ${input.journalEntryId}, ${ctx.tenantId}, ${now}, ${ctx.userId}, ${input.businessDate},
        ${shape.reversalSourceType}, ${input.documentId}, ${input.sourceNumber}, ${input.entryMode}
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
     * What this document settled is owed again. The allocations are deleted
     * rather than negated because an allocation moves no money — it only says
     * which bill this money was pointed at (§5.9), and a pointer to a
     * cancelled document is not a fact worth keeping.
     */
    if (input.releaseAllocations && shape.allocations !== null) {
      await db.execute(sql`
        DELETE FROM ${ident(shape.allocations.table)}
         WHERE tenant_id = ${ctx.tenantId}
           AND ${ident(shape.allocations.column)} = ${input.documentId}
      `);
    }

    return true;
  }
}
