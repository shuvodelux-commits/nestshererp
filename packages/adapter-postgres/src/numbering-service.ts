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
  /*
   * Phase 12.4, owner decision 2026-09-02: every new sale is numbered
   * `S-{YEAR}-{DEVICE}-{SEQUENCE}`, online and offline alike. The prefix moved
   * from INV to S with it. Numbers already printed keep exactly the form they
   * were printed in — the counter row carries its own prefix, and existing
   * tenants' rows are moved to S by the backfill so the change is deliberate
   * rather than a surprise on the first sale of the day.
   */
  SALE: 'S',
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
  /*
   * Phase 8. The plan is the shop's own paper and the order is the supplier's;
   * they are numbered apart because the supplier only ever sees one of them,
   * and a phone call about "order 41" has to mean exactly one document.
   */
  PURCHASE_PLAN: 'PP',
  SUPPLIER_ORDER: 'PO',
  WARRANTY_CLAIM: 'WC',
  VENDOR_RECEIPT: 'VR',
  VENDOR_RETURN: 'VRT',
  /*
   * Phase 8.3. `VR`/`VRT` above are the consignment documents and are left
   * alone; the workspace's own four are numbered apart because a shopkeeper
   * asking about "VR-2026-000012" must get exactly one document back.
   */
  VENDOR_PAYMENT: 'VPY',
  VENDOR_ADVANCE_REFUND: 'VAR',
  VENDOR_ISSUE: 'VI',
  VENDOR_ISSUE_RETURN: 'VIR',
  /*
   * Phase 8.2. Without a prefix of its own a settlement would be numbered
   * VENDOR_PRODUCT_SETTLEMENT-2026-000001 — the exact shape the Phase 7 note
   * above says will not fit where a document number is printed.
   */
  VENDOR_PRODUCT_SETTLEMENT: 'VPS',
};

/**
 * `{PREFIX}-{YYYY}-{NNNNNN}` (D-30, SRS 3.7).
 *
 * The counter row is created if missing and then held with SELECT ... FOR UPDATE
 * inside the caller's transaction, so two concurrent writers serialise on it:
 * no duplicates, and no gaps from concurrency. Gaps from VOIDED documents are
 * normal and auditable — a number is never reused.
 *
 * **Sales carry the machine that made them** (Phase 12.4, §8). The counter is
 * per (tenant, doc type, year, **device code**), so the shop's central counter
 * and each registered device each run their own sequence and can never issue
 * the same number. `0` is the central code — the browser that never registered
 * itself, a background job, a replay whose device row has gone — and device
 * codes are always letters, so the two sets cannot collide.
 *
 * Every other document type still numbers centrally, exactly as before. A sale
 * is the one document a customer walks out holding, and the one that therefore
 * cannot be renumbered when it reaches the books a day later.
 */
export class PostgresNumberingService implements NumberingService {
  constructor(private readonly clock: Clock) {}

  async allocate(tx: Tx, ctx: TenantContext, docType: string, year: number): Promise<string> {
    const db = txOf(tx);
    const now = this.clock.now();
    const prefix = DEFAULT_PREFIXES[docType] ?? docType;
    /*
     * Only a sale is numbered per device. Everything else keeps the central
     * counter it has always had, so no number already printed on a purchase, a
     * receipt or an expense changes shape.
     */
    const deviceCode = docType === 'SALE' ? (ctx.deviceCode ?? CENTRAL_DEVICE_CODE) : CENTRAL_DEVICE_CODE;

    // Create the counter if this is the tenant's first document of the year.
    // ON CONFLICT DO NOTHING keeps two concurrent first-writers from colliding.
    await db.execute(sql`
      INSERT INTO numbering_counters
        (id, tenant_id, doc_type, year, device_code, next_value, prefix, created_at, updated_at, created_by, updated_by)
      VALUES
        (${Ulid.generate(this.clock)}, ${ctx.tenantId}, ${docType}, ${year}, ${deviceCode}, 1, ${prefix},
         ${now}, ${now}, ${ctx.userId}, ${ctx.userId})
      ON CONFLICT ON CONSTRAINT numbering_counters_unique DO NOTHING
    `);

    // Pessimistic lock: every other transaction wanting this counter waits here.
    const locked = await db.execute<{ next_value: number; prefix: string }>(sql`
      SELECT next_value, prefix
        FROM numbering_counters
       WHERE tenant_id = ${ctx.tenantId} AND doc_type = ${docType} AND year = ${year}
         AND device_code = ${deviceCode}
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
         AND device_code = ${deviceCode}
    `);

    const sequence = String(row.next_value).padStart(SEQUENCE_WIDTH, '0');
    return docType === 'SALE'
      ? `${row.prefix}-${String(year)}-${deviceCode}-${sequence}`
      : `${row.prefix}-${String(year)}-${sequence}`;
  }

  /**
   * Move a device's counter past a number it has already printed.
   *
   * Idempotent by construction: `GREATEST` means reserving a number already
   * behind the counter changes nothing, which is what a repeated push must
   * cost. Deliberately never lowers the counter — a device that lies about its
   * sequence cannot make the server re-issue a number it has already given out.
   */
  async reserve(
    tx: Tx,
    ctx: TenantContext,
    docType: string,
    year: number,
    deviceCode: string,
    sequence: number,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();
    const prefix = DEFAULT_PREFIXES[docType] ?? docType;

    await db.execute(sql`
      INSERT INTO numbering_counters
        (id, tenant_id, doc_type, year, device_code, next_value, prefix, created_at, updated_at, created_by, updated_by)
      VALUES
        (${Ulid.generate(this.clock)}, ${ctx.tenantId}, ${docType}, ${year}, ${deviceCode},
         ${sequence + 1}, ${prefix}, ${now}, ${now}, ${ctx.userId}, ${ctx.userId})
      ON CONFLICT ON CONSTRAINT numbering_counters_unique DO UPDATE
        SET next_value = GREATEST(numbering_counters.next_value, ${sequence + 1}),
            updated_at = ${now},
            updated_by = ${ctx.userId}
    `);
  }
}

/**
 * The shop's own counter, for work no registered device did.
 *
 * A digit, where every assigned device code is letters, so a number issued
 * centrally can never collide with one a machine issued — and a shopkeeper can
 * tell at a glance which is which.
 */
const CENTRAL_DEVICE_CODE = '0';
