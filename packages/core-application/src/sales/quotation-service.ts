import { saleTotals } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type { QuotationResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { NumberingService } from '../ports/numbering-service';
import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { QuotationRow, SaleRepository } from './sale-repository';

/**
 * The wholesale drafts (§5.7): quotation → sales order → invoice.
 *
 * **WRITE CLASS: M.** A quotation reserves no stock, moves no money and writes
 * no journal entry — §5.7 is explicit, and it is what keeps this from becoming a
 * second selling engine. Converting one **seeds the POS** with its lines and
 * the sale posts through `CreateSaleService` like any other (A14).
 *
 * Both documents are behind `wholesale_sales_enabled` and are absent from the
 * UI, not disabled, while it is off (UI-09, §5.21).
 */

export interface CreateQuotationCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly kind: 'QUOTATION' | 'ORDER';
  readonly partyId: string | null;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly validUntil: string | null;
  readonly businessDate?: string | undefined;
  readonly lines: readonly {
    readonly productId: string;
    readonly qty: number;
    readonly unitPriceMinor: number;
    readonly lineDiscountMinor: number;
  }[];
  readonly discountMinor: number;
  readonly notes: string | null;
  readonly sourceQuotationId: string | null;
}

export class QuotationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly sales: SaleRepository,
    private readonly settings: SettingsRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async create(command: CreateQuotationCommand): Promise<QuotationResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.assertWholesaleOn(tx, ctx);
      await this.access.require(
        tx,
        ctx,
        command.kind === 'QUOTATION'
          ? Permission.SALE_QUOTATION_MANAGE
          : Permission.SALE_ORDER_MANAGE,
      );

      // The same arithmetic the counter uses, so a quoted total and the invoice
      // it becomes are the same number rather than two roundings of one cart.
      const totals = saleTotals({
        lines: command.lines.map((line) => ({
          productId: line.productId,
          qty: line.qty,
          unitPriceMinor: line.unitPriceMinor,
          lineDiscountMinor: line.lineDiscountMinor,
        })),
        discountMinor: command.discountMinor,
        paidMinor: 0,
      });

      const businessDate = command.businessDate ?? this.clock.businessDate(ctx.timezone);
      const id = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        command.kind === 'QUOTATION' ? 'QUOTATION' : 'SALES_ORDER',
        Number(businessDate.slice(0, 4)),
      );

      await this.sales.insertQuotation(tx, ctx, {
        id,
        kind: command.kind,
        number,
        operationId: command.operationId,
        partyId: command.partyId,
        customerName: command.customerName,
        customerPhone: command.customerPhone,
        validUntil: command.validUntil,
        itemsTotalMinor: totals.itemsTotalMinor,
        discountMinor: totals.discountMinor,
        grandTotalMinor: totals.grandTotalMinor,
        notes: command.notes,
        businessDate,
        sourceQuotationId: command.sourceQuotationId,
        lines: totals.lines.map((line, index) => ({
          id: Ulid.generate(this.clock),
          lineNo: index + 1,
          productId: line.productId,
          qty: line.qty,
          unitPriceMinor: line.unitPriceMinor,
          lineDiscountMinor: line.lineDiscountMinor,
          lineTotalMinor: line.lineTotalMinor,
        })),
      });

      // Converting a quotation into an order marks it converted, so §5.7's
      // "never convert more than the remaining quantity" has something to
      // measure against.
      if (command.sourceQuotationId !== null) {
        await this.sales.markQuotationConverted(tx, ctx, 'QUOTATION', command.sourceQuotationId);
      }

      await this.audit.append(tx, ctx, {
        entityType: command.kind === 'QUOTATION' ? 'quotation' : 'sales_order',
        entityId: id,
        action: 'CREATE',
        before: null,
        after: { number, customerName: command.customerName, grandTotalMinor: String(totals.grandTotalMinor) },
        source: 'API',
      });

      const row = await this.sales.findQuotationById(tx, ctx, command.kind, id);
      if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'Not found');
      return toResponse(row);
    });
  }

  async list(
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    limit: number,
  ): Promise<readonly QuotationResponse[]> {
    return this.uow.run(ctx, async (tx) => {
      await this.assertWholesaleOn(tx, ctx);
      await this.access.require(
        tx,
        ctx,
        kind === 'QUOTATION' ? Permission.SALE_QUOTATION_MANAGE : Permission.SALE_ORDER_MANAGE,
      );
      const rows = await this.sales.listQuotations(tx, ctx, kind, limit);
      return rows.map(toResponse);
    });
  }

  async detail(
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    id: string,
  ): Promise<QuotationResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.assertWholesaleOn(tx, ctx);
      await this.access.require(
        tx,
        ctx,
        kind === 'QUOTATION' ? Permission.SALE_QUOTATION_MANAGE : Permission.SALE_ORDER_MANAGE,
      );
      const row = await this.sales.findQuotationById(tx, ctx, kind, id);
      if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'Not found');
      return toResponse(row);
    });
  }

  private async assertWholesaleOn(tx: Tx, ctx: TenantContext): Promise<void> {
    const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
    if (values.get(SettingKey.WHOLESALE_SALES_ENABLED) !== 'ON') {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'Wholesale is switched off for this shop');
    }
  }
}

function toResponse(row: QuotationRow): QuotationResponse {
  return {
    id: row.id,
    kind: row.kind,
    number: row.number,
    partyId: row.partyId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    validUntil: row.validUntil,
    businessDate: row.businessDate,
    status: row.status,
    itemsTotalMinor: row.itemsTotalMinor,
    discountMinor: row.discountMinor,
    grandTotalMinor: row.grandTotalMinor,
    notes: row.notes,
    lines: row.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      qty: line.qty,
      unitPriceMinor: line.unitPriceMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      lineTotalMinor: line.lineTotalMinor,
      qtyConverted: line.qtyConverted,
    })),
  };
}
