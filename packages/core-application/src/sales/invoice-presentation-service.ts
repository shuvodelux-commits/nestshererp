import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { InvoicePresentation, InvoiceSettings, SaleResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import { DEFAULT_INVOICE_SETTINGS } from './sale-query-service';
import type { SaleRepository } from './sale-repository';
import { toSaleResponse } from './sale-view';

/**
 * What a printed invoice *says*, as opposed to what it *did* (§5.8).
 *
 * §5.8 splits an invoice in two. Quantity, price, discount, payment, party and
 * business date are **transaction facts** and are changed only by a correction
 * that reverses and re-posts (§2.5). Customer display name, product label,
 * courier, delivery instruction and notes are **presentation**: they change what
 * is printed and nothing else.
 *
 * That split is enforced structurally rather than by care. This service can
 * write only to `invoice_presentation` and `invoice_line_presentation`, and
 * neither table has a quantity, price, payment or account column — so a
 * presentation edit **cannot** reach an accounting figure even if this code
 * were wrong. It is also why the counter can hold `invoice.presentation.edit`
 * safely while `sale.invoice.edit` stays with the owner.
 */

export interface UpdateInvoicePresentationCommand {
  readonly ctx: TenantContext;
  readonly saleId: string;
  readonly presentation: InvoicePresentation;
}

export interface UpdateInvoiceSettingsCommand {
  readonly ctx: TenantContext;
  readonly patch: { readonly [K in keyof InvoiceSettings]?: InvoiceSettings[K] | undefined };
}

export class InvoicePresentationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly sales: SaleRepository,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async update(command: UpdateInvoicePresentationCommand): Promise<SaleResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SALE_PRESENTATION_EDIT);

      const sale = await this.sales.findSaleById(tx, ctx, command.saleId);
      if (sale === null) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');

      // Every named line must belong to this invoice. Without the check a
      // caller could relabel a line of somebody else's bill through this one.
      const lineIds = new Set(sale.lines.map((line) => line.id));
      for (const line of command.presentation.lineNames) {
        if (!lineIds.has(line.saleLineId)) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'That item is not on this invoice');
        }
      }

      const before = await this.sales.findPresentation(tx, ctx, command.saleId);
      await this.sales.savePresentation(tx, ctx, command.saleId, {
        ...command.presentation,
        lineNames: [...command.presentation.lineNames],
      });

      await this.audit.append(tx, ctx, {
        entityType: 'invoice_presentation',
        entityId: command.saleId,
        action: before === null ? 'CREATE' : 'UPDATE',
        before: before === null ? null : auditValues(before),
        after: auditValues(command.presentation),
        source: 'API',
      });

      const updated = await this.sales.findSaleById(tx, ctx, command.saleId);
      if (updated === null) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      return toSaleResponse(updated, showCost, [], this.clock.businessDate(ctx.timezone));
    });
  }

  /** The shop's logo: upload, replace, remove. Nothing else — not a library. */
  async saveLogo(command: {
    readonly ctx: TenantContext;
    readonly logo: { readonly mime: string; readonly dataBase64: string } | null;
  }): Promise<InvoiceSettings> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SETTING_EDIT);

      // A logo needs a settings row to live on; a shop that has never opened
      // the design screen has none yet.
      const current = (await this.sales.findInvoiceSettings(tx, ctx)) ?? DEFAULT_INVOICE_SETTINGS;
      await this.sales.saveInvoiceSettings(tx, ctx, current);

      const bytes = command.logo === null ? null : Buffer.from(command.logo.dataBase64, 'base64');
      if (bytes !== null && bytes.length > 1572864) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That logo is too large');
      }
      await this.sales.saveInvoiceLogo(
        tx,
        ctx,
        command.logo === null || bytes === null ? null : { mime: command.logo.mime, bytes },
      );

      await this.audit.append(tx, ctx, {
        entityType: 'invoice_settings',
        entityId: ctx.tenantId,
        action: 'UPDATE',
        before: null,
        after: { logo: command.logo === null ? 'removed' : 'set' },
        source: 'API',
      });

      return { ...current, hasLogo: command.logo !== null };
    });
  }

  /** The bytes, for the <img> on the invoice and on the settings screen. */
  async logo(ctx: TenantContext): Promise<{ readonly mime: string; readonly bytes: Uint8Array }> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALE_VIEW);
      const logo = await this.sales.findInvoiceLogo(tx, ctx);
      if (logo === null) throw new AppError(ErrorCode.NOT_FOUND, 'This shop has no logo');
      return logo;
    });
  }

  async updateSettings(command: UpdateInvoiceSettingsCommand): Promise<InvoiceSettings> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      // Invoice design is a shop-wide decision about every document it will
      // ever print, so it sits with settings rather than with the counter.
      await this.access.require(tx, ctx, Permission.SETTING_EDIT);

      const current = (await this.sales.findInvoiceSettings(tx, ctx)) ?? DEFAULT_INVOICE_SETTINGS;
      // Only what the screen actually sent is applied: a key present with
      // `undefined` would otherwise wipe a stored preference (§5.21).
      const patch = Object.fromEntries(
        Object.entries(command.patch).filter(([, value]) => value !== undefined),
      ) as Partial<InvoiceSettings>;
      const next: InvoiceSettings = { ...current, ...patch };
      await this.sales.saveInvoiceSettings(tx, ctx, next);

      await this.audit.append(tx, ctx, {
        entityType: 'invoice_settings',
        entityId: ctx.tenantId,
        action: 'UPDATE',
        before: settingsAudit(current),
        after: settingsAudit(next),
        source: 'API',
      });

      return next;
    });
  }
}

function auditValues(
  presentation: Pick<
    InvoicePresentation,
    'customerDisplayName' | 'courierName' | 'deliveryAddress'
  > & { readonly lineNames: readonly { readonly saleLineId: string }[] },
): Record<string, string> {
  return {
    customerDisplayName: presentation.customerDisplayName ?? '',
    courierName: presentation.courierName ?? '',
    deliveryAddress: presentation.deliveryAddress ?? '',
    relabelledLines: String(presentation.lineNames.length),
  };
}

function settingsAudit(settings: InvoiceSettings): Record<string, string> {
  return {
    language: settings.language,
    defaultTemplate: settings.defaultTemplate,
    businessPadEnabled: String(settings.businessPadEnabled),
  };
}
