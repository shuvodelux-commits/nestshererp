import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  CancelSaleService,
  CreateSaleService,
  InvoicePresentationService,
  SaleQueryService,
  TenantContext,
} from '@sher/core-application';
import type {
  InvoiceSettings,
  SaleDraftResponse,
  PosProductList,
  SaleListResponse,
  SaleResponse,
} from '@sher/core-contracts';
import {
  AppError,
  createSaleRequestSchema,
  ErrorCode,
  invoicePresentationSchema,
  posProductQuerySchema,
  saleListQuerySchema,
  saveInvoiceLogoRequestSchema,
  saveSaleDraftRequestSchema,
  updateInvoiceSettingsRequestSchema,
} from '@sher/core-contracts';

import { Delete, Response } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import {
  CANCEL_SALE_SERVICE,
  CREATE_SALE_SERVICE,
  INVOICE_PRESENTATION_SERVICE,
  SALE_QUERY_SERVICE,
} from './tokens';

/**
 * Selling (§5.7, §5.8). Validate shape → build command → call use case → map
 * result (R-B5). Which customer is valid, which account the money landed in,
 * whether the day is open, what the goods cost and whether stock may go
 * negative are all decided in the use case.
 */
@Controller('api/v1/sales')
@UseGuards(TenantContextGuard)
export class SalesController {
  constructor(
    @Inject(CREATE_SALE_SERVICE) private readonly sales: CreateSaleService,
    @Inject(SALE_QUERY_SERVICE) private readonly query: SaleQueryService,
    @Inject(CANCEL_SALE_SERVICE) private readonly cancellation: CancelSaleService,
    @Inject(INVOICE_PRESENTATION_SERVICE)
    private readonly presentation: InvoicePresentationService,
  ) {}

  /** The POS grid, and the barcode lookup that adds a line to the cart. */
  @Get('pos-products')
  async posProducts(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<PosProductList> {
    const parsed = posProductQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid product query');
    return this.query.posProducts(ctx, parsed.data);
  }

  @Get('invoice-settings')
  async invoiceSettings(@Ctx() ctx: TenantContext): Promise<{ data: InvoiceSettings }> {
    return { data: await this.query.invoiceSettings(ctx) };
  }

  @Put('invoice-settings')
  async updateInvoiceSettings(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: InvoiceSettings }> {
    const parsed = updateInvoiceSettingsRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid invoice settings');
    return { data: await this.presentation.updateSettings({ ctx, patch: parsed.data }) };
  }

  /** The shop's logo, served as an image so the browser caches it. */
  @Get('invoice-logo')
  async invoiceLogo(
    @Ctx() ctx: TenantContext,
    @Response() response: ExpressResponse,
  ): Promise<void> {
    const logo = await this.presentation.logo(ctx);
    response.setHeader('Content-Type', logo.mime);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.end(Buffer.from(logo.bytes));
  }

  @Post('invoice-logo')
  async saveInvoiceLogo(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: InvoiceSettings }> {
    const parsed = saveInvoiceLogoRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid logo');
    return { data: await this.presentation.saveLogo({ ctx, logo: parsed.data }) };
  }

  @Delete('invoice-logo')
  async removeInvoiceLogo(@Ctx() ctx: TenantContext): Promise<{ data: InvoiceSettings }> {
    return { data: await this.presentation.saveLogo({ ctx, logo: null }) };
  }

  /** Parked carts (§5.7). Not documents: they post nothing and delete outright. */
  @Get('drafts')
  async drafts(@Ctx() ctx: TenantContext): Promise<{ data: readonly SaleDraftResponse[] }> {
    return { data: await this.query.listDrafts(ctx) };
  }

  @Post('drafts')
  @HttpCode(201)
  async saveDraft(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SaleDraftResponse }> {
    const parsed = saveSaleDraftRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid draft');
    return { data: await this.query.saveDraft(ctx, parsed.data) };
  }

  @Delete('drafts/:id')
  @HttpCode(204)
  async deleteDraft(@Param('id') id: string, @Ctx() ctx: TenantContext): Promise<void> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Draft not found');
    await this.query.deleteDraft(ctx, id);
  }

  @Get()
  async list(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<SaleListResponse> {
    const parsed = saleListQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid sales query');
    return this.query.list(ctx, parsed.data);
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SaleResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');
    return { data: await this.query.detail(ctx, id) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SaleResponse }> {
    const parsed = createSaleRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid sale request');
    }
    return { data: await this.sales.create({ ctx, operationId, ...parsed.data }) };
  }

  /** §5.8's cosmetic overrides: what the invoice says, never what it did. */
  @Put(':id/presentation')
  async updatePresentation(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SaleResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');
    const parsed = invoicePresentationSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid invoice details');
    return {
      data: await this.presentation.update({ ctx, saleId: id, presentation: parsed.data }),
    };
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() body: { version?: number; reason?: string | null } | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SaleResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');
    const version = body?.version;
    if (typeof version !== 'number') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Reload the invoice and try again');
    }
    return {
      data: await this.cancellation.cancel({ ctx, saleId: id, version, reason: body?.reason ?? null }),
    };
  }
}
