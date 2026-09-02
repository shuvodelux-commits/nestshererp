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
  TenantContext,
  VendorIssueService,
  VendorMoneyService,
  VendorWorkspaceService,
  VendorProductSettlementService,
} from '@sher/core-application';
import type {
  SaleResponse,
  VendorActivityKind,
  VendorActivityRow,
  VendorMoneyDocumentResponse,
  VendorProductIssueResponse,
  VendorProductSettlementResponse,
  VendorWorkspaceSummaryResponse,
} from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  VENDOR_ACTIVITY_KINDS,
  giveProductsToVendorRequestSchema,
  payVendorRequestSchema,
  receiveFromVendorRequestSchema,
  receiveProductsBackRequestSchema,
  vendorProductSettlementRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import {
  VENDOR_ISSUE_SERVICE,
  VENDOR_MONEY_SERVICE,
  VENDOR_PRODUCT_SETTLEMENT_SERVICE,
  VENDOR_WORKSPACE_SERVICE,
} from './tokens';

/**
 * The vendor's hub (Phase 8.3, §5.6 M07, UI-52).
 *
 * **Four of these six routes hand the work to a service that already existed.**
 * Charging goods to a vendor is a sale, settling what they owe for them is a
 * customer receipt, and taking charged goods back is a sales return — this
 * controller does not re-post any of them, and the sales return is not even
 * routed here: the screen opens the existing dialog on the invoice. What is
 * left is what only a vendor has, and it is where the new writes live.
 *
 * Every write takes an `Idempotency-Key`: three of them post money and the
 * fourth moves stock, and either recorded twice is wrong.
 */
@Controller('api/v1/vendor-workspace')
@UseGuards(TenantContextGuard)
export class VendorWorkspaceController {
  constructor(
    @Inject(VENDOR_WORKSPACE_SERVICE) private readonly workspace: VendorWorkspaceService,
    @Inject(VENDOR_MONEY_SERVICE) private readonly money: VendorMoneyService,
    @Inject(VENDOR_ISSUE_SERVICE) private readonly issues: VendorIssueService,
    @Inject(VENDOR_PRODUCT_SETTLEMENT_SERVICE)
    private readonly productSettlements: VendorProductSettlementService,
  ) {}

  @Post('product-settlements')
  @HttpCode(201)
  async settleWithProducts(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: VendorProductSettlementResponse }> {
    const parsed = vendorProductSettlementRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid vendor product settlement request');
    }
    return { data: await this.productSettlements.create({ ctx, operationId, ...parsed.data }) };
  }

  /** The four tiles, the open items, and whether this vendor may be sold to. */
  @Get('summary/:vendorPartyId')
  async summary(
    @Param('vendorPartyId') vendorPartyId: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: VendorWorkspaceSummaryResponse }> {
    if (vendorPartyId.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Vendor not found');
    return { data: await this.workspace.summary({ ctx, vendorPartyId }) };
  }

  @Get('activity/:vendorPartyId')
  async activity(
    @Param('vendorPartyId') vendorPartyId: string,
    @Query('kinds') kinds: string | undefined,
    @Query('limit') limit: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: readonly VendorActivityRow[] }> {
    if (vendorPartyId.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Vendor not found');

    /*
     * An unknown filter name is dropped rather than refused: the filter chips
     * are a view, and a stale bookmark should show the whole history, not an
     * error where a list belongs.
     */
    const requested = (kinds ?? '')
      .split(',')
      .map((kind) => kind.trim())
      .filter((kind): kind is VendorActivityKind =>
        (VENDOR_ACTIVITY_KINDS as readonly string[]).includes(kind),
      );
    const parsed = Number(limit ?? 100);

    return this.workspace.activity({
      ctx,
      vendorPartyId,
      kinds: requested,
      limit: Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 100,
    });
  }

  @Post('payments')
  @HttpCode(201)
  async pay(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: VendorMoneyDocumentResponse }> {
    const parsed = payVendorRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid vendor payment request');
    }
    return { data: await this.money.pay({ ctx, operationId, ...parsed.data }) };
  }

  @Post('receipts')
  @HttpCode(201)
  async receive(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: VendorMoneyDocumentResponse }> {
    const parsed = receiveFromVendorRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid vendor receipt request');
    }
    return { data: await this.money.receive({ ctx, operationId, ...parsed.data }) };
  }

  /** Charged goods come back as a `SaleResponse`; a temporary issue as itself. */
  @Post('issues')
  @HttpCode(201)
  async give(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SaleResponse | VendorProductIssueResponse }> {
    const parsed = giveProductsToVendorRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid vendor issue request');
    }
    return { data: await this.issues.give({ ctx, operationId, ...parsed.data }) };
  }

  @Post('issues/returns')
  @HttpCode(201)
  async receiveBack(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: VendorProductIssueResponse }> {
    const parsed = receiveProductsBackRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid vendor return request');
    }
    return { data: await this.issues.receiveBack({ ctx, operationId, ...parsed.data }) };
  }
}
