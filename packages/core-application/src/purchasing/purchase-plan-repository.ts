import type { PlanPriority } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * What the Purchase Planner reads, and what a saved plan writes (§5.9, Phase 8).
 *
 * **Nothing here posts.** A plan creates no lot, no movement, no payable and no
 * journal entry, so there is no `UnitOfWork` ceremony beyond the transaction
 * the caller is already in — and no idempotency, because there is no financial
 * write to replay.
 *
 * Every id is generated in the application layer (R-C1) and handed down; the
 * repository inserts rows and decides nothing about business meaning (R-B6).
 */

/** One product with everything the suggestion needs, read in one pass. */
export interface PlannerProductRow {
  readonly productId: string;
  readonly displayName: string;
  readonly unitName: string;
  /**
   * Sellable stock: on-hand less expired batches and less anything a vendor
   * still owns. The exclusions are the point — buying against stock the shop
   * may not sell is how a shelf ends up double-stocked.
   */
  readonly stockQty: number;
  readonly minStockQty: number;
  /** Base units sold across the look-back window. */
  readonly soldQty: number;
  /** Distinct business dates it sold on, in that window. */
  readonly sellingDays: number;
  /** Planned and not yet bought, across every open plan. */
  readonly pendingQty: number;
  readonly packQty: number | null;
  readonly minOrderQty: number | null;
  /** Last purchase cost per base unit; the product's purchase price when never bought. */
  readonly unitCostMinor: number;
  readonly sellingPriceMinor: number;
  readonly usualSupplierId: string | null;
  readonly usualSupplierName: string | null;
  /** Most-used supplier over recent purchases, used when there is no usual one. */
  readonly historySupplierId: string | null;
  readonly historySupplierName: string | null;
}

export interface PlannerReadOptions {
  readonly lookBackDays: number;
  readonly supplierPartyId?: string | undefined;
  readonly search?: string | undefined;
  /**
   * Read exactly these products instead of the whole catalogue. Used when a
   * saved plan is re-derived: the same read, narrowed, so a stored line and a
   * planner row can never be computed two different ways.
   */
  readonly productIds?: readonly string[] | undefined;
  readonly limit: number;
}

export interface NewPlanLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly supplierPartyId: string | null;
  readonly suggestedQty: number;
  readonly plannedQty: number;
  readonly priority: PlanPriority;
  readonly stockQty: number;
  readonly dailySalesQty: number;
  readonly coverDays: number | null;
  readonly unitCostMinor: number;
  readonly sellingPriceMinor: number;
}

export interface NewPurchasePlan {
  readonly id: string;
  readonly planNumber: string;
  readonly notes: string | null;
  readonly lookBackDays: number;
  readonly coverDays: number;
  readonly budgetMinor: number | null;
  readonly businessDate: string;
  readonly lines: readonly NewPlanLine[];
}

export interface PlanLineRow {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly displayName: string;
  readonly unitName: string;
  readonly supplierPartyId: string | null;
  readonly supplierName: string | null;
  readonly priority: PlanPriority;
  readonly suggestedQty: number;
  readonly plannedQty: number;
  /** Σ of posted purchase lines pointing here. Derived, never a stored counter. */
  readonly receivedQty: number;
  readonly stockQty: number;
  readonly coverDays: number | null;
  readonly unitCostMinor: number;
  readonly sellingPriceMinor: number;
}

export interface PlanOrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly businessDate: string;
  readonly lineCount: number;
}

export interface PlanRow {
  readonly id: string;
  readonly planNumber: string;
  readonly notes: string | null;
  readonly status: string;
  readonly lookBackDays: number;
  readonly coverDays: number;
  readonly budgetMinor: number | null;
  readonly businessDate: string;
  readonly closed: boolean;
  readonly version: number;
  readonly lines: readonly PlanLineRow[];
  readonly orders: readonly PlanOrderRow[];
}

export interface PlanListRow {
  readonly id: string;
  readonly planNumber: string;
  readonly notes: string | null;
  readonly status: string;
  readonly businessDate: string;
  readonly closed: boolean;
  readonly lineCount: number;
  readonly supplierCount: number;
  readonly plannedQtyRemaining: number;
  readonly investmentMinor: number;
  readonly expectedProfitMinor: number;
  readonly version: number;
}

export interface NewSupplierOrderLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  readonly qty: number;
}

export interface NewSupplierOrder {
  readonly id: string;
  readonly planId: string;
  readonly supplierPartyId: string;
  readonly orderNumber: string;
  readonly businessDate: string;
  readonly note: string | null;
  readonly lines: readonly NewSupplierOrderLine[];
}

export interface SupplierOrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly businessDate: string;
  readonly note: string | null;
  readonly status: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly supplierPhone: string | null;
  readonly supplierAddress: string | null;
  readonly purchaseId: string | null;
  readonly purchaseNumber: string | null;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly productId: string;
    readonly productName: string;
    readonly unitName: string;
    readonly qty: number;
  }[];
}

/** One row of the Supplier Orders list. */
export interface SupplierOrderListRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly businessDate: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly planId: string;
  readonly planNumber: string;
  readonly itemCount: number;
  readonly totalQty: number;
  readonly status: string;
  readonly purchaseId: string | null;
  readonly purchaseNumber: string | null;
}

export interface PurchasePlanRepository {
  /** Everything the planner screen computes from, for one tenant, in one read. */
  readPlannerProducts(
    tx: Tx,
    ctx: TenantContext,
    options: PlannerReadOptions,
  ): Promise<readonly PlannerProductRow[]>;

  insertPlan(tx: Tx, ctx: TenantContext, plan: NewPurchasePlan): Promise<void>;

  /**
   * Replace a plan's lines wholesale. Safe precisely because a plan posts
   * nothing: there is no stock or ledger effect to unwind, only a list to
   * rewrite. Returns false on a stale version (D-32).
   */
  replacePlanLines(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly planId: string;
      readonly expectedVersion: number;
      readonly notes: string | null;
      readonly budgetMinor: number | null;
      readonly lines: readonly NewPlanLine[];
    },
  ): Promise<boolean>;

  findPlan(tx: Tx, ctx: TenantContext, planId: string): Promise<PlanRow | null>;

  listPlans(
    tx: Tx,
    ctx: TenantContext,
    options: { readonly status?: string | undefined; readonly limit: number },
  ): Promise<readonly PlanListRow[]>;

  /**
   * Record the decision on a plan. Returns false on a stale version (D-32) or
   * when the plan has already been decided — a plan is agreed once.
   */
  decidePlan(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly planId: string;
      readonly expectedVersion: number;
      readonly status: string;
      readonly at: Date;
    },
  ): Promise<boolean>;

  /** Soft-delete, allowed only while a plan is still a draft. */
  deletePlan(
    tx: Tx,
    ctx: TenantContext,
    input: { readonly planId: string; readonly expectedVersion: number },
  ): Promise<boolean>;

  listSupplierOrders(
    tx: Tx,
    ctx: TenantContext,
    options: { readonly status?: string | undefined; readonly limit: number },
  ): Promise<readonly SupplierOrderListRow[]>;

  insertSupplierOrder(tx: Tx, ctx: TenantContext, order: NewSupplierOrder): Promise<void>;

  findSupplierOrder(tx: Tx, ctx: TenantContext, orderId: string): Promise<SupplierOrderRow | null>;
}
