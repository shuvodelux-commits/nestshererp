import type {
  ClaimMove,
  NewWarrantyClaim,
  TenantContext,
  Tx,
  WarrantyClaimRow,
  WarrantyRepository,
} from '@sher/core-application';
import type { AccountCode } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { and, eq, sql } from 'drizzle-orm';

import { journalEntries, journalLines, warrantyClaims } from './schema';
import { txOf } from './unit-of-work';

/**
 * Warranty claims over PostgreSQL (§5.19, Phase 8).
 *
 * **There is no receivable table here and there never will be** — §5.19 is
 * explicit that a pending claim is a status, not an asset. What a claim has
 * cost the shop is read straight off the `WARRANTY_EXPENSE` entries that point
 * at it, which is also why net warranty cost for a period needs no report of
 * its own: it is that account's balance.
 */

interface RawClaim extends Record<string, unknown> {
  id: string;
  claim_number: string;
  status: string;
  settlement_type: string | null;
  settlement_note: string | null;
  customer_party_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  product_id: string;
  display_name: string;
  inventory_unit_id: string | null;
  serial_no: string | null;
  sale_id: string | null;
  invoice_number: string | null;
  purchase_id: string | null;
  supplier_party_id: string | null;
  supplier_name: string | null;
  complaint: string;
  handling: string;
  courier_name: string | null;
  received_date: string;
  sent_to_supplier_date: string | null;
  settled_date: string | null;
  customer_warranty_end: string | null;
  supplier_warranty_end: string | null;
  replacement_unit_id: string | null;
  warranty_cost_minor: string;
  version: number;
}

/**
 * One claim, with what it has cost so far.
 *
 * The cost is the sum of every `WARRANTY_EXPENSE` line on entries belonging to
 * this claim: a replacement out of own stock debits it, and a supplier's
 * settlement credits it back, so the figure is net by construction. Summed here
 * rather than stored, because a stored total would have to be corrected every
 * time one of those entries was reversed.
 */
const CLAIM_SELECT = sql`
  SELECT wc.id, wc.claim_number, wc.status, wc.settlement_type, wc.settlement_note,
         wc.customer_party_id, wc.customer_name, wc.customer_phone,
         wc.product_id,
         CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
              ELSE b.name || ' ' || p.name END AS display_name,
         wc.inventory_unit_id, wc.serial_no, wc.sale_id,
         s.sale_number AS invoice_number,
         wc.purchase_id, wc.supplier_party_id, sup.name AS supplier_name,
         wc.complaint, wc.handling, wc.courier_name,
         wc.received_date::text, wc.sent_to_supplier_date::text, wc.settled_date::text,
         wc.customer_warranty_end::text, wc.supplier_warranty_end::text,
         wc.replacement_unit_id,
         COALESCE((
           SELECT SUM(jl.amount_minor) FROM journal_lines jl
            WHERE jl.tenant_id = wc.tenant_id
              AND jl.account_code = 'WARRANTY_EXPENSE'
              AND jl.journal_entry_id IN (
                wc.replacement_journal_entry_id, wc.recovery_journal_entry_id
              )
         ), 0)::text AS warranty_cost_minor,
         wc.version
    FROM warranty_claims wc
    JOIN products p ON p.id = wc.product_id AND p.tenant_id = wc.tenant_id
    LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
    LEFT JOIN parties sup ON sup.id = wc.supplier_party_id AND sup.tenant_id = wc.tenant_id
    LEFT JOIN sales s ON s.id = wc.sale_id AND s.tenant_id = wc.tenant_id
`;

function toClaim(row: RawClaim): WarrantyClaimRow {
  return {
    id: row.id,
    claimNumber: row.claim_number,
    status: row.status,
    settlementType: row.settlement_type,
    settlementNote: row.settlement_note,
    customerPartyId: row.customer_party_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    productId: row.product_id,
    displayName: row.display_name,
    inventoryUnitId: row.inventory_unit_id,
    serialNo: row.serial_no,
    saleId: row.sale_id,
    invoiceNumber: row.invoice_number,
    purchaseId: row.purchase_id,
    supplierPartyId: row.supplier_party_id,
    supplierName: row.supplier_name,
    complaint: row.complaint,
    handling: row.handling,
    courierName: row.courier_name,
    receivedDate: row.received_date,
    sentToSupplierDate: row.sent_to_supplier_date,
    settledDate: row.settled_date,
    customerWarrantyEnd: row.customer_warranty_end,
    supplierWarrantyEnd: row.supplier_warranty_end,
    replacementUnitId: row.replacement_unit_id,
    warrantyCostMinor: Number(row.warranty_cost_minor),
    version: row.version,
  };
}

export class PostgresWarrantyRepository implements WarrantyRepository {
  constructor(private readonly clock: Clock) {}

  async insertClaim(tx: Tx, ctx: TenantContext, claim: NewWarrantyClaim): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .insert(warrantyClaims)
      .values({
        id: claim.id,
        tenantId: ctx.tenantId,
        claimNumber: claim.claimNumber,
        customerPartyId: claim.customerPartyId,
        customerName: claim.customerName,
        customerPhone: claim.customerPhone,
        productId: claim.productId,
        inventoryUnitId: claim.inventoryUnitId,
        serialNo: claim.serialNo,
        saleId: claim.saleId,
        invoiceNumber: claim.invoiceNumber,
        purchaseId: claim.purchaseId,
        supplierPartyId: claim.supplierPartyId,
        customerWarrantyEnd: claim.customerWarrantyEnd,
        supplierWarrantyEnd: claim.supplierWarrantyEnd,
        complaint: claim.complaint,
        receivedDate: claim.receivedDate,
        handling: claim.handling,
        courierName: claim.courierName,
        status: claim.status,
        settlementType: null,
        settlementNote: null,
        sentToSupplierDate: null,
        settledDate: null,
        replacementUnitId: null,
        replacementJournalEntryId: null,
        recoveryJournalEntryId: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });
  }

  async findClaim(
    tx: Tx,
    ctx: TenantContext,
    claimId: string,
  ): Promise<WarrantyClaimRow | null> {
    const rows = await txOf(tx).execute<RawClaim>(sql`
      ${CLAIM_SELECT}
       WHERE wc.tenant_id = ${ctx.tenantId} AND wc.id = ${claimId} AND wc.deleted_at IS NULL
       LIMIT 1
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toClaim(row);
  }

  async listClaims(
    tx: Tx,
    ctx: TenantContext,
    options: {
      readonly status?: string | undefined;
      readonly search?: string | undefined;
      readonly openOnly?: boolean | undefined;
      readonly limit: number;
    },
  ): Promise<readonly WarrantyClaimRow[]> {
    const statusFilter =
      options.status === undefined ? sql`` : sql`AND wc.status = ${options.status}`;
    // "Open" is everything still needing somebody to do something about it.
    const openFilter = options.openOnly === true ? sql`AND wc.status <> 'CLOSED'` : sql``;
    const searchFilter =
      options.search === undefined || options.search.trim() === ''
        ? sql``
        : sql`AND (wc.claim_number ILIKE ${`%${options.search.trim()}%`}
                OR wc.customer_name ILIKE ${`%${options.search.trim()}%`}
                OR wc.customer_phone ILIKE ${`%${options.search.trim()}%`}
                OR wc.serial_no ILIKE ${`%${options.search.trim()}%`})`;

    const rows = await txOf(tx).execute<RawClaim>(sql`
      ${CLAIM_SELECT}
       WHERE wc.tenant_id = ${ctx.tenantId} AND wc.deleted_at IS NULL
         ${statusFilter}
         ${openFilter}
         ${searchFilter}
       ORDER BY wc.received_date DESC, wc.id DESC
       LIMIT ${options.limit}
    `);
    return rows.rows.map(toClaim);
  }

  async moveClaim(tx: Tx, ctx: TenantContext, move: ClaimMove): Promise<boolean> {
    const updated = await txOf(tx)
      .update(warrantyClaims)
      .set({
        status: move.status,
        settlementType: move.settlementType,
        settlementNote: move.settlementNote,
        sentToSupplierDate: move.sentToSupplierDate,
        settledDate: move.settledDate,
        closedAt: move.closedAt,
        replacementUnitId: move.replacementUnitId,
        /*
         * Only ever written when this step actually posted one: passing null
         * through would erase the entry an earlier step recorded, and the
         * claim's cost is summed from exactly these two references.
         */
        ...(move.replacementJournalEntryId === null
          ? {}
          : { replacementJournalEntryId: move.replacementJournalEntryId }),
        ...(move.recoveryJournalEntryId === null
          ? {}
          : { recoveryJournalEntryId: move.recoveryJournalEntryId }),
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${warrantyClaims.version} + 1`,
      })
      .where(
        and(
          eq(warrantyClaims.tenantId, ctx.tenantId),
          eq(warrantyClaims.id, move.claimId),
          eq(warrantyClaims.version, move.expectedVersion),
        ),
      )
      .returning({ id: warrantyClaims.id });
    return updated.length > 0;
  }

  async postRecovery(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly claimId: string;
      readonly claimNumber: string;
      readonly journalEntryId: string;
      readonly businessDate: string;
      readonly entryMode: string;
      readonly lines: readonly {
        readonly id: string;
        readonly account: AccountCode;
        readonly amountMinor: number;
        readonly partyId: string | null;
      }[];
    },
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(journalEntries).values({
      id: input.journalEntryId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      businessDate: input.businessDate,
      sourceDocumentType: 'WARRANTY_CLAIM',
      sourceDocumentId: input.claimId,
      sourceNumber: input.claimNumber,
      entryMode: input.entryMode,
    });
    await db.insert(journalLines).values(
      input.lines.map((line) => ({
        id: line.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        journalEntryId: input.journalEntryId,
        accountCode: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      })),
    );
  }
}
