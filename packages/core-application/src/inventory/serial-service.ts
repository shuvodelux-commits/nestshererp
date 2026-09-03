import { normalizeSerial, rejectSerialBatch, serialsOutstanding, warrantyCoversOn, warrantyEndDate } from '@sher/core-domain';
import type { SerialRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type { SerialProgressResponse, SerialUnitResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { SerialRepository, SerialUnitRow } from './serial-repository';

/**
 * Typing the numbers off the cartons (§5.19, D-18, owner decisions 2026-08-26).
 *
 * **WRITE CLASS: light.** Recording serials creates no lot, moves no stock and
 * posts no money — the goods already arrived when the bill was saved. What it
 * does is make individual units identifiable, which is what a warranty claim
 * later depends on. Permission, tenant scope and audit apply; a period guard
 * does not, because nothing here is dated into the accounts.
 *
 * **The bill may be saved first** (owner decision 2026-08-26). Goods arrive at
 * eight in the evening and nobody has time to read twenty stickers; the stock
 * and the supplier's due are recorded straight away, and the serials are
 * finished in the morning. Until then those units are on the shelf but not
 * sellable, which is the honest state of a phone whose number nobody knows.
 */
const REFUSALS: Record<SerialRejection, string> = {
  SERIAL_BLANK: 'A serial number cannot be empty',
  SERIAL_TOO_LONG: 'That serial number is too long',
  SERIAL_DUPLICATED_IN_ENTRY: 'That serial number is in this list twice',
  SERIAL_COUNT_EXCEEDS_QTY: 'That is more serial numbers than the quantity received',
};

export class SerialService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly serials: SerialRepository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async record(input: {
    readonly ctx: TenantContext;
    readonly purchaseLineId: string;
    readonly serials: readonly string[];
  }): Promise<SerialProgressResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      // Typing the serials off the cartons is part of recording the bill, not a
      // separate privilege (owner simplification 2026-08-26).
      await this.access.require(tx, ctx, Permission.PURCHASE_CREATE);
      await this.assertSerialTrackingOn(tx, ctx);

      const line = await this.serials.findPurchaseLineForSerials(tx, ctx, input.purchaseLineId);
      if (line === null) throw new AppError(ErrorCode.NOT_FOUND, 'That bill line was not found');
      if (!line.tracksSerial) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `“${line.displayName}” is not tracked by serial number`,
        );
      }

      const rejection = rejectSerialBatch({
        serials: input.serials,
        qty: line.qty,
        alreadyRecorded: line.recorded,
      });
      if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[rejection]);

      const normalised = input.serials.map(normalizeSerial);
      const clashes = await this.serials.findActiveSerials(tx, ctx, line.productId, normalised);
      if (clashes.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Serial ${clashes[0] ?? ''} is already on the shelf — check the sticker`,
          { reason: 'SERIAL_ALREADY_ACTIVE', serial: clashes[0] ?? '' },
        );
      }

      await this.serials.insertSerialUnits(
        tx,
        ctx,
        normalised.map((serialNo) => ({
          id: Ulid.generate(this.clock),
          productId: line.productId,
          serialNo,
          lotId: line.lotId,
          purchaseId: line.purchaseId,
          purchaseLineId: line.purchaseLineId,
          supplierPartyId: line.supplierPartyId,
          vendorPartyId: null,
          vendorStockReceiptId: null,
          vendorLotId: null,
          // The supplier's cover runs from the day the goods arrived, not from
          // the day somebody found time to type the numbers in.
          receivedDate: line.businessDate,
          expiryDate: line.expiryDate,
          supplierWarrantyMonths: line.supplierWarrantyMonths,
        })),
      );

      await this.audit.append(tx, ctx, {
        entityType: 'purchase_line_serials',
        entityId: line.purchaseLineId,
        action: 'CREATE',
        before: { recorded: String(line.recorded) },
        after: { recorded: String(line.recorded + normalised.length) },
        source: 'API',
      });

      const after = await this.serials.findPurchaseLineForSerials(tx, ctx, input.purchaseLineId);
      return toProgress(after ?? line);
    });
  }

  async progress(input: {
    readonly ctx: TenantContext;
    readonly purchaseId: string;
  }): Promise<{ data: readonly SerialProgressResponse[] }> {
    return this.uow.run(input.ctx, async (tx) => {
      await this.access.require(tx, input.ctx, Permission.PURCHASE_VIEW);
      const lines = await this.serials.listPurchaseLinesForSerials(tx, input.ctx, input.purchaseId);
      return { data: lines.filter((line) => line.tracksSerial).map(toProgress) };
    });
  }

  /** In-stock units of one product, for the till and for a warranty replacement. */
  async available(input: {
    readonly ctx: TenantContext;
    readonly productId: string;
    readonly limit: number;
  }): Promise<{ data: readonly SerialUnitResponse[] }> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.PRODUCT_VIEW);
      const today = this.clock.businessDate(ctx.timezone);
      const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
      const blockExpired = values.get(SettingKey.EXPIRED_STOCK_SALE_POLICY) === 'BLOCK';
      const units = await this.serials.listAvailable(
        tx,
        ctx,
        input.productId,
        input.limit,
        blockExpired ? today : null,
      );
      return { data: units.map((unit) => toUnitResponse(unit, today)) };
    });
  }

  private async assertSerialTrackingOn(
    tx: Parameters<SerialRepository['findPurchaseLineForSerials']>[0],
    ctx: TenantContext,
  ): Promise<void> {
    const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
    if (values.get(SettingKey.SERIAL_TRACKING_ENABLED) !== 'ON') {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Serial number tracking is switched off for this shop',
      );
    }
  }
}

interface ProgressSource {
  readonly purchaseLineId: string;
  readonly productId: string;
  readonly displayName: string;
  readonly qty: number;
  readonly recorded: number;
  readonly serials: readonly string[];
}

function toProgress(line: ProgressSource): SerialProgressResponse {
  return {
    purchaseLineId: line.purchaseLineId,
    productId: line.productId,
    displayName: line.displayName,
    qty: line.qty,
    recorded: line.recorded,
    outstanding: serialsOutstanding(line.qty, line.recorded),
    serials: [...line.serials],
  };
}

/**
 * One unit with both warranty windows already worked out.
 *
 * The screen never computes a warranty date: the customer's clock starts at the
 * sale and the shop's at the delivery (owner decision 2026-08-26), and a second
 * implementation of that in the browser is how two screens come to disagree
 * about whether a phone is still covered.
 */
export function toUnitResponse(unit: SerialUnitRow, today: string): SerialUnitResponse {
  const customerEnd =
    unit.soldDate === null ? null : warrantyEndDate(unit.soldDate, unit.customerWarrantyMonths);
  const supplierEnd = warrantyEndDate(unit.receivedDate, unit.supplierWarrantyMonths);

  return {
    id: unit.id,
    serialNo: unit.serialNo,
    productId: unit.productId,
    displayName: unit.displayName,
    status: unit.status as SerialUnitResponse['status'],
    receivedDate: unit.receivedDate,
    soldDate: unit.soldDate,
    supplierName: unit.supplierName,
    vendorPartyId: unit.vendorPartyId,
    vendorStockReceiptId: unit.vendorStockReceiptId,
    vendorLotId: unit.vendorLotId,
    customerName: unit.customerName,
    invoiceNumber: unit.invoiceNumber,
    customerWarrantyEnd: customerEnd,
    supplierWarrantyEnd: supplierEnd,
    customerWarrantyLive: warrantyCoversOn(customerEnd, today),
    supplierWarrantyLive: warrantyCoversOn(supplierEnd, today),
  };
}
