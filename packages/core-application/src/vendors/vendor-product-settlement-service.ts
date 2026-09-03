import { fixedAccount, normalizeSerial, rejectEntry, rejectSerialBatch } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  VendorProductSettlementRequest,
  VendorProductSettlementResponse,
} from '@sher/core-contracts';
import { Money, Qty, QTY_SCALE, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { ProductRepository } from '../catalog/product-repository';
import type { SerialRepository } from '../inventory/serial-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import { entryModeFor } from '../notes/create-note-service';
import type { AddLandedCostService } from '../purchasing/landed-cost-service';
import type { CreatePurchaseService } from '../purchasing/create-purchase-service';
import type { SaleRepository } from '../sales/sale-repository';
import type { VendorWorkspaceRepository, VendorProductSettlementRow } from './vendor-workspace-repository';

export interface CreateVendorProductSettlementCommand extends VendorProductSettlementRequest {
  readonly ctx: TenantContext;
  readonly operationId: string;
}

/**
 * Receive products against a vendor receivable without creating a second
 * purchase engine. The purchase, owned receipt, serials, landed costs, AP/AR
 * offset and invoice allocations share the caller's one database transaction.
 */
export class VendorProductSettlementService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly workspace: VendorWorkspaceRepository,
    private readonly sales: SaleRepository,
    private readonly products: ProductRepository,
    private readonly serials: SerialRepository,
    private readonly purchases: CreatePurchaseService,
    private readonly landedCosts: AddLandedCostService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async create(command: CreateVendorProductSettlementCommand): Promise<VendorProductSettlementResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.VENDOR_STOCK_MANAGE);

      const replay = await this.workspace.findProductSettlementByOperationId(
        tx,
        ctx,
        command.operationId,
      );
      if (replay !== null) return toResponse(replay);

      if (!(await this.sales.lockReceivableParty(tx, ctx, command.vendorPartyId))) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Vendor not found');
      }

      const grossProductMinor = command.lines.reduce(
        (sum, line) => sum + Money(line.unitPriceMinor).multiply(Qty(line.qty)).minor,
        0,
      );
      const netProductMinor = grossProductMinor - command.discountMinor;
      if (grossProductMinor <= 0 || netProductMinor <= 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The settlement products need a positive net value');
      }

      const balances = await this.workspace.accountBalances(tx, ctx, command.vendorPartyId);
      if (netProductMinor > balances.receivableMinor) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Net product settlement cannot exceed this vendor’s outstanding receivable',
          {
            reason: 'VENDOR_RECEIVABLE_OVER_SETTLEMENT',
            receivableMinor: String(balances.receivableMinor),
            netProductMinor: String(netProductMinor),
          },
        );
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      const purchase = await this.purchases.createWithin(tx, {
        ctx,
        operationId: command.operationId,
        supplierPartyId: command.vendorPartyId,
        supplierBillRef: command.supplierBillRef,
        businessDate,
        dueDate: null,
        lines: command.lines.map((line) => ({
          productId: line.productId,
          qty: line.qty,
          unitPriceMinor: line.unitPriceMinor,
          expiryDate: line.expiryDate,
        })),
        discountMinor: command.discountMinor,
        landedCosts: [],
        extraCostMinor: 0,
        paidMinor: 0,
        paidAccountCode: null,
        notes: command.notes,
        correctionOf: null,
        vendorSettlement: true,
      });

      for (const [index, input] of command.lines.entries()) {
        const product = await this.products.findById(tx, ctx, input.productId);
        const purchaseLine = purchase.lines[index];
        if (product === null || purchaseLine === undefined) {
          throw new AppError(ErrorCode.NOT_FOUND, 'Settlement product was not found');
        }
        if (!product.tracksSerial) {
          if (input.serials.length > 0) {
            throw new AppError(ErrorCode.VALIDATION_FAILED, `“${product.name}” does not use serial numbers`);
          }
          continue;
        }
        if (input.qty % QTY_SCALE !== 0 || input.serials.length !== input.qty / QTY_SCALE) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            `Enter exactly ${String(input.qty / QTY_SCALE)} serial numbers for “${product.name}”`,
          );
        }
        const rejection = rejectSerialBatch({ serials: input.serials, qty: input.qty, alreadyRecorded: 0 });
        if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter valid unique serial numbers');
        const normalised = input.serials.map(normalizeSerial);
        const clashes = await this.serials.findActiveSerials(tx, ctx, product.id, normalised);
        if (clashes.length > 0) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, `Serial ${clashes[0] ?? ''} is already active`);
        }
        await this.serials.insertSerialUnits(
          tx,
          ctx,
          normalised.map((serialNo) => ({
            id: Ulid.generate(this.clock),
            productId: product.id,
            serialNo,
            lotId: purchaseLine.lotId,
            purchaseId: purchase.id,
            purchaseLineId: purchaseLine.id,
            supplierPartyId: command.vendorPartyId,
            vendorPartyId: null,
            vendorStockReceiptId: null,
            vendorLotId: null,
            receivedDate: businessDate,
            expiryDate: input.expiryDate,
            supplierWarrantyMonths: product.supplierWarrantyMonths,
          })),
        );
      }

      for (const cost of command.landedCosts) {
        await this.landedCosts.addWithin(tx, {
          ctx,
          operationId: Ulid.generate(this.clock),
          purchaseId: purchase.id,
          category: cost.category,
          method: cost.method,
          amountMinor: cost.amountMinor,
          paidAccountCode: cost.paidAccountCode,
          note: cost.description,
          description: cost.description,
          manualAllocations: cost.manualAllocations.map((allocation) => ({
            purchaseLineId: purchase.lines[allocation.lineIndex]?.id ?? '',
            amountMinor: allocation.amountMinor,
          })),
          businessDate,
        });
      }

      const openInvoices = await this.sales.listOpenInvoices(tx, ctx, command.vendorPartyId, []);
      let remaining = netProductMinor;
      const allocations = [];
      for (const invoice of openInvoices) {
        if (remaining === 0) break;
        const amountMinor = Math.min(remaining, invoice.outstandingMinor);
        if (amountMinor <= 0) continue;
        allocations.push({
          id: Ulid.generate(this.clock),
          saleId: invoice.id,
          saleNumber: invoice.number,
          amountMinor,
        });
        remaining -= amountMinor;
      }
      if (remaining !== 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The vendor receivable invoices no longer cover this settlement');
      }

      const journalLines = [
        {
          id: Ulid.generate(this.clock),
          account: fixedAccount('AP'),
          amountMinor: netProductMinor,
          partyId: command.vendorPartyId,
        },
        {
          id: Ulid.generate(this.clock),
          account: fixedAccount('AR'),
          amountMinor: -netProductMinor,
          partyId: command.vendorPartyId,
        },
      ];
      if (rejectEntry({ lines: journalLines }) !== null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Vendor settlement journal did not balance');
      }

      const settlementId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'VENDOR_PRODUCT_SETTLEMENT',
        Number(businessDate.slice(0, 4)),
      );
      const landedCostMinor = command.landedCosts.reduce((sum, cost) => sum + cost.amountMinor, 0);
      const record = {
        id: settlementId,
        number,
        operationId: command.operationId,
        vendorPartyId: command.vendorPartyId,
        purchaseId: purchase.id,
        purchaseNumber: purchase.number,
        grossProductMinor,
        discountMinor: command.discountMinor,
        netProductMinor,
        landedCostMinor,
        receivableBeforeMinor: balances.receivableMinor,
        receivableAfterMinor: balances.receivableMinor - netProductMinor,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        journalEntryId: Ulid.generate(this.clock),
        journalLines,
        allocations,
      };
      await this.workspace.insertProductSettlement(tx, ctx, record);
      await this.audit.append(tx, ctx, {
        entityType: 'vendor_product_settlement',
        entityId: settlementId,
        action: 'CREATE',
        before: { receivableMinor: String(balances.receivableMinor) },
        after: {
          number,
          purchaseId: purchase.id,
          netProductMinor: String(netProductMinor),
          landedCostMinor: String(landedCostMinor),
          receivableMinor: String(balances.receivableMinor - netProductMinor),
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'vendor.product_settlement.posted',
        aggregateType: 'vendor_product_settlement',
        aggregateId: settlementId,
        payload: { vendorPartyId: command.vendorPartyId, purchaseId: purchase.id, netProductMinor },
      });
      return toResponse(record);
    });
  }
}

function toResponse(row: VendorProductSettlementRow): VendorProductSettlementResponse {
  return {
    id: row.id,
    number: row.number,
    vendorPartyId: row.vendorPartyId,
    purchaseId: row.purchaseId,
    purchaseNumber: row.purchaseNumber,
    businessDate: row.businessDate,
    grossProductMinor: row.grossProductMinor,
    discountMinor: row.discountMinor,
    netProductMinor: row.netProductMinor,
    landedCostMinor: row.landedCostMinor,
    receivableBeforeMinor: row.receivableBeforeMinor,
    receivableAfterMinor: row.receivableAfterMinor,
    allocations: row.allocations.map((allocation) => ({
      saleId: allocation.saleId,
      saleNumber: allocation.saleNumber,
      amountMinor: allocation.amountMinor,
    })),
  };
}
