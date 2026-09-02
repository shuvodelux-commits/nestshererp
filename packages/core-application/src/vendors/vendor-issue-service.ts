import {
  allocateLots,
  rejectVendorIssueReturn,
  restoreToLots,
  stockValueMinor,
} from '@sher/core-domain';
import type { VendorIssueReturnRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type { SaleResponse, VendorProductIssueResponse } from '@sher/core-contracts';
import { QTY_SCALE, Qty, Ulid, formatForDisplay } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { InventoryRepository } from '../inventory/inventory-repository';
import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { ProductRepository } from '../catalog/product-repository';
import type { CreateSaleService } from '../sales/create-sale-service';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { VendorWorkspaceRepository } from './vendor-workspace-repository';

/**
 * The shop's own goods going out to a vendor, in the two meanings that has
 * (Phase 8.3, owner decision 2026-08-31: the mode is chosen per transaction,
 * never inferred).
 *
 * **`CHARGED` is a sale, and is posted as one.** Not "like" a sale — the very
 * same service the counter uses, so `AR`, `SALES`, `COGS` and `INVENTORY` move
 * by the arithmetic that has always moved them, the invoice is a real invoice
 * the vendor can be shown, and taking the goods back is an ordinary sales
 * return through the ordinary service, which puts them into the very lots they
 * left. There is no vendor-shaped copy of any of that here.
 *
 * **`TEMPORARY` is custody, and posts nothing at all.** The goods are still the
 * shop's, still in `INVENTORY`, still in its valuation; they are merely
 * somewhere else, exactly as they are when stock moves between two of the
 * shop's own locations. What custody must not lose is where each unit came
 * from, so the lots it drew from are recorded with their costs and a return
 * restores them — the cost that comes back is the cost that left, not today's
 * average.
 */

export interface GiveProductsToVendorCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly vendorPartyId: string;
  readonly mode: 'CHARGED' | 'TEMPORARY';
  readonly productId: string;
  readonly qty: number;
  readonly unitValueMinor: number;
  readonly note: string | null;
  readonly businessDate?: string | undefined;
}

export interface ReceiveProductsBackCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly issueId: string;
  readonly qty: number;
  readonly note: string | null;
  readonly businessDate?: string | undefined;
}

const RETURN_REFUSALS: Record<VendorIssueReturnRejection, string> = {
  QTY_NOT_POSITIVE: 'Enter how many are coming back',
  NOTHING_OUTSTANDING: 'Everything from this issue has already come back',
  QTY_EXCEEDS_OUTSTANDING: 'That is more than this vendor still has',
};

export class VendorIssueService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly workspace: VendorWorkspaceRepository,
    private readonly parties: PartyRepository,
    private readonly products: ProductRepository,
    private readonly inventory: InventoryRepository,
    private readonly settings: SettingsRepository,
    private readonly sales: CreateSaleService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /**
   * Charged goods: the counter's own service, with the vendor as the customer.
   *
   * The vendor must therefore also carry the `CUSTOMER` role — which is not a
   * technicality but the truth of what is happening: the shop is selling to
   * them on credit, and D-04 already lets one party be both. The refusal says
   * so plainly rather than quietly adding a role nobody asked for.
   */
  async give(command: GiveProductsToVendorCommand): Promise<SaleResponse | VendorProductIssueResponse> {
    if (command.mode === 'CHARGED') return this.giveCharged(command);
    return this.giveTemporary(command);
  }

  private async giveCharged(command: GiveProductsToVendorCommand): Promise<SaleResponse> {
    if (command.unitValueMinor <= 0) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Charged goods need a price — use a temporary issue if nothing is being charged',
      );
    }

    return this.sales.create({
      ctx: command.ctx,
      operationId: command.operationId,
      partyId: command.vendorPartyId,
      customerName: null,
      customerPhone: null,
      customerGuardianName: null,
      customerAddress: null,
      saveAsCustomer: false,
      businessDate: command.businessDate,
      dueDate: null,
      lines: [
        {
          productId: command.productId,
          qty: command.qty,
          unitPriceMinor: command.unitValueMinor,
          lineDiscountMinor: 0,
          source: 'OWN_STOCK',
          vendorPartyId: null,
          vendorUnitCostMinor: null,
          allocations: [],
        },
      ],
      discountMinor: 0,
      /* Nothing is paid at the moment of handover — that is what makes it a
       * receivable, and what the workspace's Receive Payment action settles. */
      payments: [],
      overpaymentHandling: 'CHANGE',
      allowNegativeStock: false,
      notes: command.note,
    });
  }

  /** Custody: stock moves, provenance is kept, and the journal is not touched. */
  private async giveTemporary(
    command: GiveProductsToVendorCommand,
  ): Promise<VendorProductIssueResponse> {
    const fingerprint = JSON.stringify([
      command.vendorPartyId,
      command.productId,
      command.qty,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.VENDOR_ISSUE_MANAGE);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different issue',
          );
        }
        return replay.response as VendorProductIssueResponse;
      }
      const posted = await this.workspace.findIssueIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.issueDetail(tx, ctx, posted);

      const vendor = await this.parties.findById(tx, ctx, command.vendorPartyId);
      if (vendor === null) throw new AppError(ErrorCode.NOT_FOUND, 'That vendor was not found');
      if (!vendor.roles.includes('VENDOR')) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That party is not a vendor');
      }

      const product = await this.products.findById(tx, ctx, command.productId);
      if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'That product was not found');

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'An issue cannot be dated in the future');
      }
      /*
       * Guarded even though nothing is posted, for the same reason a
       * consignment receipt is: the movement is dated, and a closed month whose
       * stock kept moving is a month nobody can reconcile.
       */
      await this.periods.assertOpen(tx, ctx, businessDate);

      const location = await this.inventory.findDefaultLocation(tx, ctx);
      if (location === null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This shop has no stock location');
      }

      const layers = await this.inventory.listCostLayers(tx, ctx, product.id, location.id);
      const expiryTracked = await this.expiryTracked(tx, ctx);
      const allocation = allocateLots(
        layers.map((layer) => ({
          id: layer.id,
          qtyRemaining: layer.qtyRemaining,
          unitCost: layer.unitCost,
          businessDate: layer.businessDate,
          createdAt: layer.createdAt,
          expiryDate: layer.expiryDate,
        })),
        command.qty,
        expiryTracked,
        expiryTracked ? businessDate : null,
      );

      /*
       * Lending out goods the shop does not have is refused outright, with no
       * negative-stock option. §5.7's policy exists so a *sale* is never
       * blocked at the counter while a customer waits; nobody is waiting here,
       * and stock that does not exist cannot be handed to anybody.
       */
      if (allocation.shortageQty > 0) {
        const available = layers.reduce((sum, layer) => sum + Math.max(layer.qtyRemaining, 0), 0);
        throw new AppError(
          ErrorCode.INSUFFICIENT_STOCK,
          `Only ${formatForDisplay(available, QTY_SCALE)} of “${product.name}” are on the shelf`,
          { reason: 'NEGATIVE_STOCK_BLOCKED', productId: product.id },
        );
      }

      const costMinor = allocation.allocations.reduce(
        (sum, lot) => sum + stockValueMinor(lot.qty, lot.unitCost),
        0,
      );

      const issueId = Ulid.generate(this.clock);
      await this.workspace.insertIssue(tx, ctx, {
        id: issueId,
        number: await this.numbering.allocate(
          tx,
          ctx,
          'VENDOR_ISSUE',
          Number(businessDate.slice(0, 4)),
        ),
        operationId: command.operationId,
        vendorPartyId: vendor.id,
        productId: product.id,
        locationId: location.id,
        qty: command.qty,
        costMinor,
        movementId: Ulid.generate(this.clock),
        note: command.note,
        businessDate,
        lots: allocation.allocations.map((lot) => ({
          id: Ulid.generate(this.clock),
          lotId: lot.lotId,
          qty: lot.qty,
          unitCost: lot.unitCost,
        })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'vendor_product_issue',
        entityId: issueId,
        action: 'CREATE',
        before: null,
        after: {
          vendorPartyId: vendor.id,
          productId: product.id,
          qty: Qty(command.qty).format(),
          mode: 'TEMPORARY',
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'vendor.products.issued',
        aggregateType: 'vendor_product_issue',
        aggregateId: issueId,
        payload: { vendorPartyId: vendor.id, productId: product.id, qty: command.qty },
      });

      const response = await this.issueDetail(tx, ctx, issueId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * Lent goods coming back.
   *
   * Charged goods are **not** handled here: they were sold, so they come back
   * as a sales return through the service that owns returns — which is also the
   * only thing that knows how to unwind their `COGS` and their receivable. The
   * workspace opens that dialog on the invoice instead of wrapping it.
   */
  async receiveBack(command: ReceiveProductsBackCommand): Promise<VendorProductIssueResponse> {
    const fingerprint = JSON.stringify([
      command.issueId,
      command.qty,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.VENDOR_ISSUE_MANAGE);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different return',
          );
        }
        return replay.response as VendorProductIssueResponse;
      }
      const posted = await this.workspace.findIssueReturnIdByOperationId(
        tx,
        ctx,
        command.operationId,
      );
      if (posted !== null) return this.issueDetail(tx, ctx, command.issueId);

      const issue = await this.workspace.findIssueById(tx, ctx, command.issueId);
      if (issue === null) throw new AppError(ErrorCode.NOT_FOUND, 'That issue was not found');

      const rejection = rejectVendorIssueReturn({
        issuedQty: issue.qty,
        returnedQty: issue.returnedQty,
        qty: command.qty,
      });
      if (rejection !== null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, RETURN_REFUSALS[rejection]);
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A return cannot be dated in the future');
      }
      if (businessDate < issue.businessDate) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Goods cannot come back before the day they went out',
        );
      }
      await this.periods.assertOpen(tx, ctx, businessDate);

      const outstanding = await this.workspace.listIssueLotsOutstanding(tx, ctx, issue.id);
      const restores = restoreToLots(outstanding, command.qty);
      const costMinor = restores.reduce(
        (sum, restore) => sum + stockValueMinor(restore.qty, restore.unitCost),
        0,
      );

      const returnId = Ulid.generate(this.clock);
      const written = await this.workspace.insertIssueReturn(tx, ctx, {
        id: returnId,
        number: await this.numbering.allocate(
          tx,
          ctx,
          'VENDOR_ISSUE_RETURN',
          Number(businessDate.slice(0, 4)),
        ),
        operationId: command.operationId,
        issueId: issue.id,
        qty: command.qty,
        costMinor,
        movementId: Ulid.generate(this.clock),
        note: command.note,
        businessDate,
        productId: issue.productId,
        locationId: issue.locationId,
        restores: restores.map((restore) => ({
          issueLotId: restore.id,
          lotId: restore.lotId,
          qty: restore.qty,
          qtyOutstandingAfter: restore.qtyOutstandingAfter,
        })),
        issueVersion: issue.version,
        returnedQtyAfter: Qty(issue.returnedQty).add(Qty(command.qty)).raw,
      });
      if (!written) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Somebody else recorded a return against this issue — open it again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'vendor_product_issue_return',
        entityId: returnId,
        action: 'CREATE',
        before: { outstanding: Qty(issue.qty - issue.returnedQty).format() },
        after: { returned: Qty(command.qty).format() },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'vendor.products.received_back',
        aggregateType: 'vendor_product_issue',
        aggregateId: issue.id,
        payload: { returnId, qty: command.qty },
      });

      const response = await this.issueDetail(tx, ctx, issue.id);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  private async expiryTracked(tx: Tx, ctx: TenantContext): Promise<boolean> {
    const values = settingValuesOf(await this.settings.listStored(tx, ctx));
    return isFeatureOn(values, SettingKey.EXPIRY_TRACKING_ENABLED);
  }

  private async issueDetail(
    tx: Tx,
    ctx: TenantContext,
    issueId: string,
  ): Promise<VendorProductIssueResponse> {
    const row = await this.workspace.findIssueById(tx, ctx, issueId);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'That issue was not found');
    return issueResponseFrom(row, await this.canSeeCost(tx, ctx));
  }

  private async canSeeCost(tx: Tx, ctx: TenantContext): Promise<boolean> {
    return (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
  }
}

/**
 * The row as a screen shows it.
 *
 * Cost is **omitted** rather than blanked for a caller without `COST_VIEW`
 * (UI-40, R-E8) — a zero would read as free goods.
 */
export function issueResponseFrom(
  row: {
    readonly id: string;
    readonly number: string;
    readonly vendorPartyId: string;
    readonly vendorName: string;
    readonly productId: string;
    readonly displayName: string;
    readonly unitName: string;
    readonly qty: number;
    readonly returnedQty: number;
    readonly costMinor: number;
    readonly note: string | null;
    readonly businessDate: string;
    readonly version: number;
  },
  showCost: boolean,
): VendorProductIssueResponse {
  return {
    id: row.id,
    number: row.number,
    mode: 'TEMPORARY',
    vendorPartyId: row.vendorPartyId,
    vendorName: row.vendorName,
    productId: row.productId,
    displayName: row.displayName,
    unitName: row.unitName,
    qty: row.qty,
    returnedQty: row.returnedQty,
    openQty: Qty(row.qty).subtract(Qty(row.returnedQty)).raw,
    ...(showCost ? { costMinor: row.costMinor } : {}),
    /* A temporary issue has no agreed value: nothing has been sold. */
    valueMinor: 0,
    saleId: null,
    invoiceNumber: null,
    businessDate: row.businessDate,
    note: row.note,
    version: row.version,
  };
}
