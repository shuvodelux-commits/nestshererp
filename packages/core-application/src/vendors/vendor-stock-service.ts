import { normalizeSerial, rejectSerialBatch, unitCostFromMoneyMinor } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type {
  VendorSettlementResponse,
  VendorStockReceiptResponse,
} from '@sher/core-contracts';
import { Money, QTY_SCALE, Qty, Ulid, formatForDisplay } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { InventoryRepository } from '../inventory/inventory-repository';
import type { SerialRepository } from '../inventory/serial-repository';
import type { ProductRepository } from '../catalog/product-repository';
import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { VendorReceiptRow, VendorStockRepository } from './vendor-stock-repository';

/**
 * Goods on the shelf that belong to somebody else (§5.6 M07, DR13.10, owner
 * decision 2026-08-26).
 *
 * **Nothing here posts a journal entry, and that is the whole point.** A vendor
 * leaving fifty shirts has not sold the shop anything: the lot carries
 * `owner_type = 'VENDOR'`, stays out of valuation and out of COGS, and nobody
 * is owed a taka. The money happens later, at the till — the sale converts the
 * lot to owned at the agreed vendor cost inside its own transaction, and *that*
 * is what creates the vendor payable. Handing the unsold ones back is stock
 * only, for the same reason: the shop never bought them.
 *
 * **Deliberately a very small form** (owner instruction 2026-08-26): one
 * vendor, one product, one quantity, one cost. There is no consignment
 * agreement, no vendor price list and no settlement document — the vendor is
 * paid through the Pay Supplier flow that already exists, against the ledger
 * that already exists.
 */
export interface ReceiveVendorStockCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly vendorPartyId: string;
  readonly productId: string;
  readonly qty: number;
  readonly vendorUnitCostMinor: number;
  readonly expiryDate: string | null;
  readonly serials: readonly string[];
  readonly note: string | null;
  readonly businessDate?: string | undefined;
}

export interface ReturnVendorStockCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly receiptId: string;
  readonly qty: number;
  readonly serialUnitIds: readonly string[];
  readonly note: string | null;
  readonly businessDate?: string | undefined;
}

export class VendorStockService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly vendors: VendorStockRepository,
    private readonly parties: PartyRepository,
    private readonly inventory: InventoryRepository,
    private readonly products: ProductRepository,
    private readonly serials: SerialRepository,
    private readonly settings: SettingsRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async receive(command: ReceiveVendorStockCommand): Promise<VendorStockReceiptResponse> {
    const fingerprint = JSON.stringify([
      command.vendorPartyId,
      command.productId,
      command.qty,
      command.vendorUnitCostMinor,
      command.expiryDate,
      command.serials,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.VENDOR_STOCK_MANAGE);
      await this.assertConsignmentOn(tx, ctx);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different receipt',
          );
        }
        return replay.response as VendorStockReceiptResponse;
      }
      const posted = await this.vendors.findReceiptByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.receiptWithin(tx, ctx, posted);

      const vendor = await this.parties.findById(tx, ctx, command.vendorPartyId);
      if (vendor === null) throw new AppError(ErrorCode.NOT_FOUND, 'That vendor was not found');
      if (!vendor.roles.includes('VENDOR')) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That party is not a vendor');
      }
      const product = await this.products.findById(tx, ctx, command.productId);
      if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'That product was not found');
      const normalisedSerials = command.serials.map(normalizeSerial);
      if (product.tracksSerial) {
        const rejection = rejectSerialBatch({
          serials: normalisedSerials,
          qty: command.qty,
          alreadyRecorded: 0,
        });
        if (rejection !== null || normalisedSerials.length * 1000 !== command.qty) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'A serialized vendor receipt needs exactly one manufacturer serial for every unit received',
          );
        }
        const clashes = await this.serials.findActiveSerials(tx, ctx, product.id, normalisedSerials);
        if (clashes.length > 0) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, `Serial ${clashes[0] ?? ''} is already active`);
        }
      } else if (normalisedSerials.length > 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This product is not tracked by serial number');
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A receipt cannot be dated in the future');
      }
      /*
       * The period is still guarded even though nothing is posted: the stock
       * movement is dated, and a closed month whose stock kept moving is a
       * month nobody can reconcile.
       */
      await this.periods.assertOpen(tx, ctx, businessDate);

      const location = await this.inventory.findDefaultLocation(tx, ctx);
      if (location === null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This shop has no stock location');
      }

      const receiptId = Ulid.generate(this.clock);
      const lotId = Ulid.generate(this.clock);
      await this.vendors.insertReceipt(tx, ctx, {
        id: receiptId,
        receiptNumber: await this.numbering.allocate(
          tx,
          ctx,
          'VENDOR_RECEIPT',
          Number(businessDate.slice(0, 4)),
        ),
        vendorPartyId: command.vendorPartyId,
        productId: command.productId,
        locationId: location.id,
        qty: command.qty,
        vendorUnitCost: unitCostFromMoneyMinor(command.vendorUnitCostMinor),
        lotId,
        movementId: Ulid.generate(this.clock),
        note: command.note,
        businessDate,
        expiryDate: command.expiryDate,
        operationId: command.operationId,
      });
      if (normalisedSerials.length > 0) {
        await this.serials.insertSerialUnits(
          tx,
          ctx,
          normalisedSerials.map((serialNo) => ({
            id: Ulid.generate(this.clock),
            productId: product.id,
            serialNo,
            lotId,
            purchaseId: null,
            purchaseLineId: null,
            supplierPartyId: null,
            vendorPartyId: vendor.id,
            vendorStockReceiptId: receiptId,
            vendorLotId: lotId,
            receivedDate: businessDate,
            expiryDate: command.expiryDate,
            supplierWarrantyMonths: product.supplierWarrantyMonths,
          })),
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'vendor_stock_receipt',
        entityId: receiptId,
        action: 'CREATE',
        before: null,
        after: {
          vendorPartyId: command.vendorPartyId,
          productId: command.productId,
          qty: Qty(command.qty).format(),
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'vendor.stock.received',
        aggregateType: 'vendor_stock_receipt',
        aggregateId: receiptId,
        payload: { vendorPartyId: command.vendorPartyId, qty: command.qty },
      });

      const response = await this.receiptWithin(tx, ctx, receiptId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * Handing back what did not sell.
   *
   * Stock leaves and nothing else happens — no journal entry, no payable, no
   * refund. Capped at what is still on the shelf from that receipt, because
   * returning goods that have already been sold would drive the lot negative
   * and hand the vendor stock the shop no longer has.
   */
  async returnStock(command: ReturnVendorStockCommand): Promise<VendorStockReceiptResponse> {
    const fingerprint = JSON.stringify([
      command.receiptId,
      command.qty,
      [...command.serialUnitIds].sort(),
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.VENDOR_STOCK_MANAGE);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different return',
          );
        }
        return replay.response as VendorStockReceiptResponse;
      }

      const receipt = await this.vendors.findReceipt(tx, ctx, command.receiptId);
      if (receipt === null) throw new AppError(ErrorCode.NOT_FOUND, 'That receipt was not found');

      const product = await this.products.findById(tx, ctx, receipt.productId);
      if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'That product was not found');
      if (product.tracksSerial) {
        if (
          command.qty % QTY_SCALE !== 0 ||
          command.serialUnitIds.length !== command.qty / QTY_SCALE ||
          new Set(command.serialUnitIds).size !== command.serialUnitIds.length
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'Select exactly one available serial for every serialized unit being returned',
          );
        }
        const selected = await this.serials.findAvailableByIds(
          tx,
          ctx,
          receipt.productId,
          command.serialUnitIds,
        );
        if (
          selected.length !== command.serialUnitIds.length ||
          selected.some(
            (unit) =>
              unit.vendorPartyId !== receipt.vendorPartyId ||
              unit.vendorStockReceiptId !== receipt.id ||
              unit.vendorLotId !== receipt.lotId,
          )
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'Every selected serial must be available stock from this vendor receipt',
          );
        }
      } else if (command.serialUnitIds.length > 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This product does not use serial numbers');
      }

      if (command.qty > receipt.lotQtyRemaining) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Only ${formatForDisplay(receipt.lotQtyRemaining, QTY_SCALE)} of these are still on the shelf`,
        );
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A return cannot be dated in the future');
      }
      await this.periods.assertOpen(tx, ctx, businessDate);

      const returnId = Ulid.generate(this.clock);
      await this.vendors.insertReturn(tx, ctx, {
          id: returnId,
          returnNumber: await this.numbering.allocate(
            tx,
            ctx,
            'VENDOR_RETURN',
            Number(businessDate.slice(0, 4)),
          ),
          receiptId: receipt.id,
          vendorPartyId: receipt.vendorPartyId,
          productId: receipt.productId,
          locationId: receipt.locationId,
          qty: command.qty,
          lotId: receipt.lotId,
          movementId: Ulid.generate(this.clock),
          note: command.note,
          businessDate,
          operationId: command.operationId,
      });
      const returnedSerials = await this.serials.markReturnedToVendor(tx, ctx, {
        unitIds: command.serialUnitIds,
        vendorStockReceiptId: receipt.id,
        vendorLotId: receipt.lotId,
      });
      if (returnedSerials !== command.serialUnitIds.length) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'One or more selected serials changed before the vendor return was posted',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'vendor_stock_return',
        entityId: returnId,
        action: 'CREATE',
        before: { onHand: Qty(receipt.lotQtyRemaining).format() },
        after: { returned: Qty(command.qty).format() },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'vendor.stock.returned',
        aggregateType: 'vendor_stock_receipt',
        aggregateId: receipt.id,
        payload: { returnId, qty: command.qty },
      });

      const response = await this.receiptWithin(tx, ctx, receipt.id);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * `Received · Sold · Returned · Due · Paid · Balance` for one vendor.
   *
   * The quantities come from the receipts and their lots; the money comes from
   * the vendor's ledger. Deliberately not a second tally of the money — a
   * balance kept here would eventually disagree with the accounts, and the
   * accounts are the ones that are right.
   */
  async settlement(input: {
    readonly ctx: TenantContext;
    readonly vendorPartyId: string;
  }): Promise<VendorSettlementResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.SUPPLIER_VIEW);
      const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);

      const vendor = await this.parties.findById(tx, ctx, input.vendorPartyId);
      if (vendor === null) throw new AppError(ErrorCode.NOT_FOUND, 'That vendor was not found');

      const receipts = await this.vendors.listReceipts(tx, ctx, {
        vendorPartyId: input.vendorPartyId,
        limit: 200,
      });
      const totals = await this.vendors.vendorLedgerTotals(tx, ctx, input.vendorPartyId);

      let received = 0;
      let returned = 0;
      let onHand = 0;
      for (const receipt of receipts) {
        received += receipt.qty;
        returned += receipt.returnedQty;
        onHand += receipt.lotQtyRemaining;
      }

      return {
        vendorPartyId: input.vendorPartyId,
        vendorName: vendor.name,
        receivedQty: received,
        soldQty: Math.max(received - returned - onHand, 0),
        returnedQty: returned,
        onHandQty: onHand,
        dueMinor: totals.dueMinor,
        paidMinor: totals.paidMinor,
        balanceMinor: Money(totals.dueMinor).subtract(Money(totals.paidMinor)).minor,
        receipts: receipts.map((receipt) => toReceiptResponse(receipt, showMoney)),
      };
    });
  }

  async listReceipts(input: {
    readonly ctx: TenantContext;
    readonly vendorPartyId?: string | undefined;
    readonly limit: number;
  }): Promise<{ data: readonly VendorStockReceiptResponse[] }> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.SUPPLIER_VIEW);
      const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      const receipts = await this.vendors.listReceipts(tx, ctx, {
        vendorPartyId: input.vendorPartyId,
        limit: input.limit,
      });
      return { data: receipts.map((receipt) => toReceiptResponse(receipt, showMoney)) };
    });
  }

  private async receiptWithin(
    tx: Tx,
    ctx: TenantContext,
    receiptId: string,
  ): Promise<VendorStockReceiptResponse> {
    const receipt = await this.vendors.findReceipt(tx, ctx, receiptId);
    if (receipt === null) throw new AppError(ErrorCode.NOT_FOUND, 'That receipt was not found');
    const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
    return toReceiptResponse(receipt, showMoney);
  }

  private async assertConsignmentOn(tx: Tx, ctx: TenantContext): Promise<void> {
    const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
    if (values.get(SettingKey.VENDOR_CONSIGNMENT_ENABLED) !== 'ON') {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Vendor stock is switched off for this shop — turn it on in Settings',
      );
    }
  }
}

function toReceiptResponse(
  receipt: VendorReceiptRow,
  showMoney: boolean,
): VendorStockReceiptResponse {
  const soldQty = Math.max(receipt.qty - receipt.returnedQty - receipt.lotQtyRemaining, 0);
  // The vendor cost is stored at scale 4; the screen reads poisha like every
  // other price, so it is converted here rather than in Vue (B8).
  const unitCostMinor = Math.round(receipt.vendorUnitCost / 100);

  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    vendorPartyId: receipt.vendorPartyId,
    vendorName: receipt.vendorName,
    productId: receipt.productId,
    displayName: receipt.displayName,
    unitName: receipt.unitName,
    businessDate: receipt.businessDate,
    expiryDate: receipt.expiryDate,
    note: receipt.note,
    receivedQty: receipt.qty,
    soldQty,
    returnedQty: receipt.returnedQty,
    onHandQty: receipt.lotQtyRemaining,
    ...(showMoney
      ? {
          vendorUnitCostMinor: unitCostMinor,
          dueMinor: Money(unitCostMinor).multiply(Qty(soldQty)).minor,
        }
      : {}),
    version: receipt.version,
  };
}
