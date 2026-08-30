import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AddLandedCostService,
  PlannerService,
  PurchasePlanService,
  TenantContext,
} from '@sher/core-application';
import type {
  LandedCostResponse,
  PlannerResponse,
  PurchasePlanListResponse,
  PurchasePlanResponse,
  SupplierOrderListResponse,
  SupplierPurchaseOrderResponse,
} from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  addLandedCostRequestSchema,
  createPurchasePlanRequestSchema,
  plannerQuerySchema,
  purchasePlanListQuerySchema,
  decidePlanRequestSchema,
  updatePurchasePlanRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { ADD_LANDED_COST_SERVICE, PLANNER_SERVICE, PURCHASE_PLAN_SERVICE } from './tokens';

/**
 * The Purchase Planner and its two outputs (§5.9, §5.12, Phase 8). Validate
 * shape → build command → call use case → map result (R-B5).
 *
 * **Nothing on the plan endpoints takes an `Idempotency-Key`**, and that is
 * deliberate: a plan posts no stock, no payable and no journal entry, so there
 * is nothing to make replay-safe. Adding a landed cost does post money, so that
 * one takes a key like every other financial write.
 */
@Controller('api/v1/purchase-plans')
@UseGuards(TenantContextGuard)
export class PurchasePlansController {
  constructor(
    @Inject(PLANNER_SERVICE) private readonly planner: PlannerService,
    @Inject(PURCHASE_PLAN_SERVICE) private readonly plans: PurchasePlanService,
  ) {}

  /** The working planner: every product, what to buy, and why. */
  @Get('suggestions')
  async suggestions(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<PlannerResponse> {
    const parsed = plannerQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid planner query');
    return this.planner.plan({ ctx, ...parsed.data });
  }

  @Get()
  async list(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<PurchasePlanListResponse> {
    const parsed = purchasePlanListQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid plan query');
    return this.plans.list({ ctx, ...parsed.data });
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchasePlanResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    return { data: await this.plans.detail({ ctx, planId: id }) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchasePlanResponse }> {
    const parsed = createPurchasePlanRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid plan');
    return { data: await this.plans.save({ ctx, ...parsed.data }) };
  }

  @Post(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchasePlanResponse }> {
    const parsed = updatePurchasePlanRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid plan');
    return { data: await this.plans.update({ ctx, planId: id, ...parsed.data }) };
  }

  /**
   * Agree a plan or turn it down. Approving is what creates the supplier
   * orders — there is no separate send, because nothing is transmitted.
   */
  @Post(':id/decide')
  async decide(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchasePlanResponse }> {
    const parsed = decidePlanRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request');
    return { data: await this.plans.decide({ ctx, planId: id, ...parsed.data }) };
  }

  @Post(':id/delete')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Body() body: { version?: number },
    @Ctx() ctx: TenantContext,
  ): Promise<void> {
    const version = Number(body?.version);
    if (!Number.isSafeInteger(version)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request');
    }
    await this.plans.remove({ ctx, planId: id, version });
  }
}

/**
 * The supplier's copy, read on its own so it can be printed or shared without
 * the plan it came from. Its response type carries no cost, price, stock or
 * profit field at all — the owner's rule of 2026-08-26.
 */
@Controller('api/v1/supplier-orders')
@UseGuards(TenantContextGuard)
export class SupplierOrdersController {
  constructor(@Inject(PURCHASE_PLAN_SERVICE) private readonly plans: PurchasePlanService) {}

  @Get()
  async list(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<SupplierOrderListResponse> {
    const parsed = Number(limit ?? 100);
    return this.plans.listOrders({
      ctx,
      status: status === undefined || status === '' ? undefined : status,
      limit: Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 100,
    });
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SupplierPurchaseOrderResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Order not found');
    return { data: await this.plans.order({ ctx, orderId: id }) };
  }
}

/** A cost that turned up after the goods (§5.12). This one posts money. */
@Controller('api/v1/purchases/:purchaseId/landed-costs')
@UseGuards(TenantContextGuard)
export class LandedCostsController {
  constructor(@Inject(ADD_LANDED_COST_SERVICE) private readonly costs: AddLandedCostService) {}

  @Post()
  @HttpCode(201)
  async add(
    @Param('purchaseId') purchaseId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: LandedCostResponse }> {
    const parsed = addLandedCostRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid landed cost request');
    }
    return { data: await this.costs.add({ ctx, operationId, purchaseId, ...parsed.data }) };
  }
}
