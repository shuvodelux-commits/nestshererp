import { planTotals, suggestFor } from '@sher/core-domain';
import type { PlanParams } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  PurchasePlanListResponse,
  PurchasePlanResponse,
  SupplierOrderListItem,
  SupplierOrderListResponse,
  SupplierPurchaseOrderResponse,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { NumberingService } from '../ports/numbering-service';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { SettingsRepository } from '../settings/settings-repository';
import type { SaleRepository } from '../sales/sale-repository';
import { supplierFor, toPlanProduct } from './planner-service';
import type { NewPlanLine, PurchasePlanRepository } from './purchase-plan-repository';

/**
 * Saving what the planner worked out, and getting it to the supplier
 * (§5.9, owner decisions 2026-08-26).
 *
 * **WRITE CLASS: none of the financial ones.** A plan and a supplier order
 * create no lot, no stock movement, no payable and no journal entry, so there
 * is no period guard, no idempotency key and no outbox event here — §5.9 is
 * explicit that a purchase order "carries no `operation_id`-bearing financial
 * write because there is nothing financial to make idempotent". What they do
 * get is permission, tenant scope and audit, because deciding to spend the
 * shop's money is worth a trail even before the money moves.
 *
 * **Fulfilment and status are derived, never stored as counters.** How much of
 * a plan line has been bought is a SUM over posted purchase lines pointing at
 * it, so voiding a bill simply makes the plan right again; a plan reads
 * COMPLETED when every line is satisfied and CLOSED only when somebody closed
 * it by hand.
 */
export interface SavePlanCommand {
  readonly ctx: TenantContext;
  readonly notes: string | null;
  readonly lookBackDays: number;
  readonly coverDays: number;
  readonly budgetMinor: number | null;
  readonly businessDate?: string | undefined;
  readonly lines: readonly {
    readonly productId: string;
    readonly plannedQty: number;
    readonly supplierPartyId: string | null;
  }[];
}

export interface UpdatePlanCommand {
  readonly ctx: TenantContext;
  readonly planId: string;
  readonly notes: string | null;
  readonly budgetMinor: number | null;
  readonly version: number;
  readonly lines: readonly {
    readonly productId: string;
    readonly plannedQty: number;
    readonly supplierPartyId: string | null;
  }[];
}

export interface SendSupplierOrderCommand {
  readonly ctx: TenantContext;
  readonly planId: string;
  readonly supplierPartyId: string;
  readonly note: string | null;
  readonly businessDate?: string | undefined;
}

export class PurchasePlanService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly plans: PurchasePlanRepository,
    private readonly settings: SettingsRepository,
    private readonly sales: SaleRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async save(command: SavePlanCommand): Promise<PurchasePlanResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_PLAN_MANAGE);

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      const params: PlanParams = {
        lookBackDays: command.lookBackDays,
        coverDays: command.coverDays,
      };

      const planId = Ulid.generate(this.clock);
      const lines = await this.buildLines(tx, ctx, command.lines, params);

      await this.plans.insertPlan(tx, ctx, {
        id: planId,
        planNumber: await this.numbering.allocate(
          tx,
          ctx,
          'PURCHASE_PLAN',
          Number(businessDate.slice(0, 4)),
        ),
        notes: command.notes,
        lookBackDays: command.lookBackDays,
        coverDays: command.coverDays,
        budgetMinor: command.budgetMinor,
        businessDate,
        lines,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'purchase_plan',
        entityId: planId,
        action: 'CREATE',
        before: null,
        after: {
          lineCount: String(lines.length),
          budgetMinor: command.budgetMinor === null ? 'none' : String(command.budgetMinor),
        },
        source: 'API',
      });

      return this.detailWithin(tx, ctx, planId);
    });
  }

  async update(command: UpdatePlanCommand): Promise<PurchasePlanResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_PLAN_MANAGE);

      const existing = await this.plans.findPlan(tx, ctx, command.planId);
      if (existing === null) throw new AppError(ErrorCode.NOT_FOUND, 'That plan was not found');
      if (existing.closed) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This plan is closed — reopen it first');
      }

      const params: PlanParams = {
        lookBackDays: existing.lookBackDays,
        coverDays: existing.coverDays,
      };
      const lines = await this.buildLines(tx, ctx, command.lines, params);

      const ok = await this.plans.replacePlanLines(tx, ctx, {
        planId: command.planId,
        expectedVersion: command.version,
        notes: command.notes,
        budgetMinor: command.budgetMinor,
        lines,
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this plan — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'purchase_plan',
        entityId: command.planId,
        action: 'UPDATE',
        before: { lineCount: String(existing.lines.length) },
        after: { lineCount: String(lines.length) },
        source: 'API',
      });

      return this.detailWithin(tx, ctx, command.planId);
    });
  }

  /**
   * Agree a plan, or turn it down (owner decision 2026-08-26).
   *
   * **Approving is what creates the supplier orders.** There is no send step,
   * because nothing is transmitted: each order is a sheet the shopkeeper
   * prints, saves as a PDF or shares as an image. One order per supplier, each
   * numbered from the shop's own series, snapshotting what that supplier is
   * being asked for — so editing the plan afterwards cannot change a paper
   * somebody is already holding.
   *
   * A plan is decided once. Rejecting posts nothing and creates nothing; the
   * plan stays readable, which is the point of recording the decision at all.
   */
  async decide(input: {
    readonly ctx: TenantContext;
    readonly planId: string;
    readonly decision: 'APPROVED' | 'REJECTED';
    readonly version: number;
    readonly businessDate?: string | undefined;
  }): Promise<PurchasePlanResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.PURCHASE_PLAN_MANAGE);

      const plan = await this.plans.findPlan(tx, ctx, input.planId);
      if (plan === null) throw new AppError(ErrorCode.NOT_FOUND, 'That plan was not found');
      if (plan.status !== 'DRAFT') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `This plan has already been ${plan.status === 'APPROVED' ? 'approved' : 'rejected'}`,
        );
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = input.businessDate ?? today;

      const ok = await this.plans.decidePlan(tx, ctx, {
        planId: input.planId,
        expectedVersion: input.version,
        status: input.decision,
        at: this.clock.now(),
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this plan — reload and try again',
        );
      }

      if (input.decision === 'APPROVED') {
        /*
         * Grouped here rather than in SQL because the grouping is a business
         * rule — a line with no supplier yet belongs on nobody's order, and
         * silently dropping it into one would have the shop ask the wrong
         * person for goods.
         */
        const bySupplier = new Map<string, typeof plan.lines>();
        for (const line of plan.lines) {
          if (line.supplierPartyId === null || line.plannedQty <= 0) continue;
          bySupplier.set(line.supplierPartyId, [
            ...(bySupplier.get(line.supplierPartyId) ?? []),
            line,
          ]);
        }

        if (bySupplier.size === 0) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'No line on this plan has a supplier yet — set one before approving',
          );
        }

        const year = Number(businessDate.slice(0, 4));
        for (const [supplierPartyId, lines] of bySupplier) {
          const orderId = Ulid.generate(this.clock);
          await this.plans.insertSupplierOrder(tx, ctx, {
            id: orderId,
            planId: input.planId,
            supplierPartyId,
            orderNumber: await this.numbering.allocate(tx, ctx, 'SUPPLIER_ORDER', year),
            businessDate,
            note: plan.notes,
            lines: lines.map((line, index) => ({
              id: Ulid.generate(this.clock),
              lineNo: index + 1,
              productId: line.productId,
              productName: line.displayName,
              unitName: line.unitName,
              qty: line.plannedQty,
            })),
          });
        }
      }

      await this.audit.append(tx, ctx, {
        entityType: 'purchase_plan',
        entityId: input.planId,
        action: input.decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
        before: { status: 'DRAFT' },
        after: { status: input.decision },
        source: 'API',
      });

      return this.detailWithin(tx, ctx, input.planId);
    });
  }

  /** A draft nobody wants. Once approved it has orders against it and stays. */
  async remove(input: {
    readonly ctx: TenantContext;
    readonly planId: string;
    readonly version: number;
  }): Promise<void> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.PURCHASE_PLAN_MANAGE);

      const ok = await this.plans.deletePlan(tx, ctx, {
        planId: input.planId,
        expectedVersion: input.version,
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Only a draft plan can be deleted, and only if nobody else has changed it',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'purchase_plan',
        entityId: input.planId,
        action: 'DELETE',
        before: { status: 'DRAFT' },
        after: null,
        source: 'API',
      });
    });
  }

  async listOrders(input: {
    readonly ctx: TenantContext;
    readonly status?: string | undefined;
    readonly limit: number;
  }): Promise<SupplierOrderListResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.PURCHASE_PLAN_VIEW);
      const rows = await this.plans.listSupplierOrders(tx, ctx, {
        status: input.status,
        limit: input.limit,
      });
      return {
        data: rows.map((row) => ({
          id: row.id,
          orderNumber: row.orderNumber,
          businessDate: row.businessDate,
          supplierPartyId: row.supplierPartyId,
          supplierName: row.supplierName,
          planId: row.planId,
          planNumber: row.planNumber,
          itemCount: row.itemCount,
          totalQty: row.totalQty,
          status: row.status as SupplierOrderListItem['status'],
          purchaseId: row.purchaseId,
          purchaseNumber: row.purchaseNumber,
        })),
      };
    });
  }

  async order(input: {
    readonly ctx: TenantContext;
    readonly orderId: string;
  }): Promise<SupplierPurchaseOrderResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.PURCHASE_PLAN_VIEW);

      const order = await this.plans.findSupplierOrder(tx, ctx, input.orderId);
      if (order === null) throw new AppError(ErrorCode.NOT_FOUND, 'That order was not found');

      // The same pad the invoice prints on (§5.24), so the supplier's order
      // looks like it came from the same shop — one place to change a phone
      // number, not two.
      const shop = await this.sales.findInvoiceSettings(tx, ctx);

      /*
       * Everything the supplier gets, and nothing else. There is no cost, price,
       * stock or profit field on this type at all — the owner's rule of
       * 2026-08-26 — so no print template can grow one by accident.
       */
      return {
        id: input.orderId,
        orderNumber: order.orderNumber,
        businessDate: order.businessDate,
        supplierName: order.supplierName,
        supplierPhone: order.supplierPhone,
        supplierAddress: order.supplierAddress,
        shopName: shop?.businessName ?? '',
        shopPhone: shop?.businessPhone ?? null,
        shopAddress: shop?.businessAddress ?? null,
        note: order.note,
        status: order.status as SupplierPurchaseOrderResponse['status'],
        supplierPartyId: order.supplierPartyId,
        purchaseId: order.purchaseId,
        purchaseNumber: order.purchaseNumber,
        lines: order.lines.map((line) => ({
          lineNo: line.lineNo,
          productId: line.productId,
          productName: line.productName,
          unitName: line.unitName,
          qty: line.qty,
        })),
      };
    });
  }

  async detail(input: {
    readonly ctx: TenantContext;
    readonly planId: string;
  }): Promise<PurchasePlanResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      await this.access.require(tx, input.ctx, Permission.PURCHASE_PLAN_VIEW);
      return this.detailWithin(tx, input.ctx, input.planId);
    });
  }

  async list(input: {
    readonly ctx: TenantContext;
    readonly status?: string | undefined;
    readonly limit: number;
  }): Promise<PurchasePlanListResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.PURCHASE_PLAN_VIEW);
      const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);

      const rows = await this.plans.listPlans(tx, ctx, {
        status: input.status,
        limit: input.limit,
      });

      return {
        data: rows.map((row) => ({
          id: row.id,
          planNumber: row.planNumber,
          notes: row.notes,
          status: row.status as PurchasePlanResponse['status'],
          businessDate: row.businessDate,
          lineCount: row.lineCount,
          supplierCount: row.supplierCount,
          version: row.version,
          ...(showMoney
            ? {
                investmentMinor: row.investmentMinor,
                expectedProfitMinor: row.expectedProfitMinor,
              }
            : {}),
        })),
      };
    });
  }

  /**
   * Turn what the shopkeeper decided into stored lines.
   *
   * The suggestion is recomputed here rather than trusted from the browser
   * (DR13.12, R-E): the screen sends which products and how many of each, and
   * the server works out the priority and the suggestion those quantities were
   * a decision about. A client that could post its own priority could post one
   * that never came from the shop's own numbers.
   */
  private async buildLines(
    tx: Tx,
    ctx: TenantContext,
    requested: readonly {
      readonly productId: string;
      readonly plannedQty: number;
      readonly supplierPartyId: string | null;
    }[],
    params: PlanParams,
  ): Promise<readonly NewPlanLine[]> {
    const wanted = new Map(requested.map((line) => [line.productId, line]));
    const products = await this.plans.readPlannerProducts(tx, ctx, {
      lookBackDays: params.lookBackDays,
      limit: requested.length,
      productIds: [...wanted.keys()],
    });
    const byId = new Map(products.map((row) => [row.productId, row]));

    const lines: NewPlanLine[] = [];
    let lineNo = 0;
    for (const line of requested) {
      const row = byId.get(line.productId);
      if (row === undefined) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'One of these products no longer exists');
      }

      const suggestion = suggestFor(toPlanProduct(row), params);
      lineNo += 1;
      lines.push({
        id: Ulid.generate(this.clock),
        lineNo,
        productId: row.productId,
        // The row's own choice wins; falling back keeps a line that was never
        // touched grouped where the planner had it.
        supplierPartyId: line.supplierPartyId ?? supplierFor(row).id,
        suggestedQty: suggestion.suggestedQty,
        plannedQty: line.plannedQty,
        priority: suggestion.priority,
        stockQty: row.stockQty,
        dailySalesQty: suggestion.dailySalesQty,
        coverDays: suggestion.coverDays,
        unitCostMinor: row.unitCostMinor,
        sellingPriceMinor: row.sellingPriceMinor,
      });
    }
    return lines;
  }

  private async detailWithin(
    tx: Tx,
    ctx: TenantContext,
    planId: string,
  ): Promise<PurchasePlanResponse> {
    const plan = await this.plans.findPlan(tx, ctx, planId);
    if (plan === null) throw new AppError(ErrorCode.NOT_FOUND, 'That plan was not found');

    const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
    const totals = showMoney
      ? planTotals(
          plan.lines.map((line) => ({
            qty: line.plannedQty,
            unitCostMinor: line.unitCostMinor,
            sellingPriceMinor: line.sellingPriceMinor,
          })),
        )
      : null;

    return {
      id: plan.id,
      planNumber: plan.planNumber,
      notes: plan.notes,
      status: plan.status as PurchasePlanResponse['status'],
      lookBackDays: plan.lookBackDays,
      coverDays: plan.coverDays,
      budgetMinor: plan.budgetMinor,
      businessDate: plan.businessDate,
      lines: plan.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        displayName: line.displayName,
        unitName: line.unitName,
        supplierPartyId: line.supplierPartyId,
        supplierName: line.supplierName,
        priority: line.priority,
        suggestedQty: line.suggestedQty,
        plannedQty: line.plannedQty,
        receivedQty: line.receivedQty,
        remainingQty: Math.max(line.plannedQty - line.receivedQty, 0),
        stockQty: line.stockQty,
        coverDays: line.coverDays,
        ...(showMoney
          ? {
              unitCostMinor: line.unitCostMinor,
              sellingPriceMinor: line.sellingPriceMinor,
            }
          : {}),
      })),
      version: plan.version,
      orders: plan.orders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        supplierPartyId: order.supplierPartyId,
        supplierName: order.supplierName,
        businessDate: order.businessDate,
        lineCount: order.lineCount,
      })),
      ...(totals === null
        ? {}
        : {
            totals: {
              ...totals,
              budgetMinor: plan.budgetMinor,
              unusedBudgetMinor:
                plan.budgetMinor === null
                  ? null
                  : Math.max(plan.budgetMinor - totals.investmentMinor, 0),
            },
          }),
    };
  }
}


