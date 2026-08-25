import type { NumberingService, TenantContext, Tx } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import { sql } from 'drizzle-orm';

import { txOf } from './unit-of-work';

const SEQUENCE_WIDTH = 6;
/**
 * The prefix a document type starts with when the tenant has not configured one
 * (§3.7: "Prefixes configurable per tenant"). A type with no entry uses its own
 * name, which is fine for a document number and wrong for a barcode label — hence
 * `P` for a generated product barcode.
 */
const DEFAULT_PREFIXES: Readonly<Record<string, string>> = {
  NOTE: 'NOTE',
  PRODUCT_BARCODE: 'P',
  PURCHASE: 'PUR',
  SUPPLIER_PAYMENT: 'SPY',
  SALE: 'INV',
  CUSTOMER_RECEIPT: 'RCV',
  QUOTATION: 'QTN',
  SALES_ORDER: 'SO',
  /*
   * Phase 7 (owner decision 2026-08-26): each corrective document counts on its
   * own short series. Short because the number is printed — spelling one out as
   * SALES_RETURN-2026-000001 was what pushed a statement into a horizontal
   * scroll when the opening correction tried it.
   */
  SALES_RETURN: 'SR',
  PURCHASE_RETURN: 'PR',
  EXPENSE: 'EXP',
  STOCK_COUNT: 'SC',
};

/**
 * `{PREFIX}-{YYYY}-{NNNNNN}` (D-30, SRS 3.7).
 *
 * The counter row is created if missing and then held with SELECT ... FOR UPDATE
 * inside the caller's transaction, so two concurrent writers serialise on it:
 * no duplicates, and no gaps from concurrency. Gaps from VOIDED documents are
 * normal and auditable — a number is never reused.
 *
 * `device_prefix` is reserved and empty in V1; an offline device will produce
 * `NOTE-D2-2026-000123` with no schema change.
 */
export class PostgresNumberingService implements NumberingService {
  constructor(private readonly clock: Clock) {}

  async allocate(tx: Tx, ctx: TenantContext, docType: string, year: number): Promise<string> {
    const db = txOf(tx);
    const now = this.clock.now();
    const prefix = DEFAULT_PREFIXES[docType] ?? docType;

    // Create the counter if this is the tenant's first document of the year.
    // ON CONFLICT DO NOTHING keeps two concurrent first-writers from colliding.
    await db.execute(sql`
      INSERT INTO numbering_counters
        (id, tenant_id, doc_type, year, next_value, prefix, created_at, updated_at, created_by, updated_by)
      VALUES
        (${Ulid.generate(this.clock)}, ${ctx.tenantId}, ${docType}, ${year}, 1, ${prefix},
         ${now}, ${now}, ${ctx.userId}, ${ctx.userId})
      ON CONFLICT ON CONSTRAINT numbering_counters_unique DO NOTHING
    `);

    // Pessimistic lock: every other transaction wanting this counter waits here.
    const locked = await db.execute<{ next_value: number; prefix: string }>(sql`
      SELECT next_value, prefix
        FROM numbering_counters
       WHERE tenant_id = ${ctx.tenantId} AND doc_type = ${docType} AND year = ${year}
         FOR UPDATE
    `);

    const row = locked.rows[0];
    if (row === undefined) {
      throw new Error(`numbering counter missing for ${docType} ${String(year)}`);
    }

    await db.execute(sql`
      UPDATE numbering_counters
         SET next_value = next_value + 1, updated_at = ${now}, updated_by = ${ctx.userId}
       WHERE tenant_id = ${ctx.tenantId} AND doc_type = ${docType} AND year = ${year}
    `);

    const sequence = String(row.next_value).padStart(SEQUENCE_WIDTH, '0');
    return `${row.prefix}-${String(year)}-${sequence}`;
  }
}
