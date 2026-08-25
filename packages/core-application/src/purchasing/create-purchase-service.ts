import {
  averageAfterReceipt,
  purchaseCosts,
  purchasePosting,
  rejectPurchase,
} from '@sher/core-domain';
import type { PurchaseRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { PurchaseResponse } from '@sher/core-contracts';
import { Money, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { ProductRepository } from '../catalog/product-repository';
import type { InventoryRepository } from '../inventory/inventory-repository';
import type { MoneyRepository } from '../money/money-repository';
import { entryModeFor } from '../notes/create-note-service';
import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from './payment-account';
import type { NewPurchaseLine, PurchaseRepository } from './purchase-repository';
import { toPurchaseResponse } from './purchase-view';

/**
 * Recording a supplier bill (Phase 5, §5.9, §5.11).
 *
 * **WRITE CLASS: T** (R-D). One transaction runs the whole ten-step path:
 * permission → idempotency → period guard → load → invariants → the document →
 * lots, stock movements, the moving-average cache and one journal entry →
 * audit + outbox → commit. Goods that reached the shelf without the supplier
 * being owed for them is not half a purchase; it is a wrong one.
 *
 * **Everything a shop buys enters here.** §5.9's Purchase Order seeds this
 * screen and posts nothing itself (A14), and a return is its own document —
 * neither is a second way to bring stock in.
 */

export interface PurchaseLineInput {
  readonly productId: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly expiryDate: string | null;
}

export interface CreatePurchaseCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly supplierPartyId: string;
  readonly supplierBillRef: string | null;
  readonly businessDate?: string | undefined;
  readonly dueDate: string | null;
  readonly lines: readonly PurchaseLineInput[];
  readonly discountMinor: number;
  readonly extraCostMinor: number;
  readonly paidMinor: number;
  readonly paidAccountCode: string | null;
  readonly notes: string | null;
}

/** Domain refusal → the sentence a shopkeeper reads. The rule stays in the domain. */
const REFUSALS: Record<PurchaseRejection, string> = {
  PURCHASE_HAS_NO_LINES: 'Add at least one item to this purchase',
  AMOUNT_NOT_INTEGER_MINOR: 'Enter valid amounts',
  LINE_QUANTITY_NOT_POSITIVE: 'Every item needs a quantity greater than zero',
  LINE_PRICE_NEGATIVE: 'A purchase rate cannot be less than zero',
  DISCOUNT_NEGATIVE: 'A discount cannot be less than zero',
  EXTRA_COST_NEGATIVE: 'An extra cost cannot be less than zero',
  PAID_NEGATIVE: 'The amount paid cannot be less than zero',
  DISCOUNT_EXCEEDS_ITEMS: 'The discount is larger than the goods on this bill',
  PAID_EXCEEDS_TOTAL: 'You cannot pay more than the bill comes to',
  PURCHASE_HAS_NO_VALUE: 'This bill comes to nothing — check the rates',
};

export class CreatePurchaseService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly parties: PartyRepository,
    private readonly products: ProductRepository,
    private readonly inventory: InventoryRepository,
    private readonly money: MoneyRepository,
    private readonly purchases: PurchaseRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async create(command: CreatePurchaseCommand): Promise<PurchaseResponse> {
    const draft = {
      lines: command.lines.map((line) => ({
        productId: line.productId,
        qty: line.qty,
        unitPriceMinor: line.unitPriceMinor,
      })),
      discountMinor: command.discountMinor,
      extraCostMinor: command.extraCostMinor,
      paidMinor: command.paidMinor,
    };
    const rejection = rejectPurchase(draft);
    if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[rejection]);

    const fingerprint = JSON.stringify([
      command.supplierPartyId,
      command.businessDate ?? null,
      command.dueDate,
      command.lines,
      command.discountMinor,
      command.extraCostMinor,
      command.paidMinor,
      command.paidAccountCode,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_CREATE);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different purchase',
          );
        }
        return replay.response as PurchaseResponse;
      }
      const posted = await this.purchases.findPurchaseIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted, []);

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      await this.periods.assertOpen(tx, ctx, businessDate);
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A purchase cannot be dated in the future');
      }
      if (command.dueDate !== null && command.dueDate < businessDate) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'The due date cannot be before the purchase date',
        );
      }

      const supplier = await this.parties.findById(tx, ctx, command.supplierPartyId);
      if (supplier === null) throw new AppError(ErrorCode.NOT_FOUND, 'Supplier not found');
      if (!supplier.roles.includes('SUPPLIER')) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, `“${supplier.name}” is not a supplier`);
      }
      if (supplier.status === 'INACTIVE') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `“${supplier.name}” is no longer in use — reactivate them first`,
        );
      }

      /*
       * Resolved before anything is written, so a drawer that is not open stops
       * the bill at the door rather than after the stock has moved. The
       * refusal carries `CASH_DAY_NOT_STARTED`, which is what lets the screen
       * offer `দিন শুরু করুন` without losing the typed bill.
       */
      const paidAccount =
        command.paidMinor === 0
          ? null
          : await resolvePaymentAccount(
              { access: this.access, money: this.money },
              tx,
              ctx,
              command.paidAccountCode ?? '',
              businessDate,
            );
      if (command.paidMinor > 0 && paidAccount === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say which account the money came from');
      }

      const costs = purchaseCosts(draft);
      const location =
        (await this.inventory.findDefaultLocation(tx, ctx)) ??
        (await this.inventory.createDefaultLocation(tx, ctx, Ulid.generate(this.clock)));

      /*
       * Positions are carried in a map rather than re-read per line: a bill may
       * list the same product twice (two batches at two rates, which §5.9 says
       * become two lots), and re-reading would compute the second line's
       * moving average from a quantity the first line has already changed.
       */
      const positions = new Map<string, { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean }>();
      const purchaseLines: NewPurchaseLine[] = [];
      const priceUpdates: { productId: string; purchasePriceMinor: number }[] = [];
      const warnings: string[] = [];

      for (const [index, cost] of costs.lines.entries()) {
        const product = await this.products.findById(tx, ctx, cost.productId);
        if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
        const expiryDate = command.lines[index]?.expiryDate ?? null;
        if (expiryDate !== null && !product.tracksExpiry) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            `“${product.name}” does not track expiry dates`,
          );
        }

        let position = positions.get(product.id);
        if (position === undefined) {
          const stored = await this.inventory.findStockPosition(tx, ctx, product.id);
          position = {
            qtyOnHand: Math.max(stored?.qtyOnHand ?? 0, 0),
            avgUnitCost: stored?.avgUnitCost ?? 0,
            costStateId: stored?.costStateId ?? Ulid.generate(this.clock),
            exists: stored?.costStateId !== null && stored?.costStateId !== undefined,
          };
        }
        const next = averageAfterReceipt(
          position.qtyOnHand,
          position.avgUnitCost,
          cost.qty,
          cost.actualUnitCost,
        );
        positions.set(product.id, {
          qtyOnHand: next.qtyOnHand,
          avgUnitCost: next.avgUnitCost,
          costStateId: position.costStateId,
          // From here on the row exists: either it already did, or this line is
          // about to create it. A later line for the same product must update
          // what this one wrote, not insert it a second time.
          exists: true,
        });

        purchaseLines.push({
          id: Ulid.generate(this.clock),
          lineNo: index + 1,
          productId: product.id,
          locationId: location.id,
          qty: cost.qty,
          unitPriceMinor: cost.unitPriceMinor,
          lineTotalMinor: cost.lineTotalMinor,
          discountShareMinor: cost.discountShareMinor,
          extraCostShareMinor: cost.extraCostShareMinor,
          actualUnitCost: cost.actualUnitCost,
          lotValueMinor: cost.lotValueMinor,
          expiryDate,
          lotId: Ulid.generate(this.clock),
          movementId: Ulid.generate(this.clock),
          costState: {
            id: position.costStateId,
            exists: position.exists,
            avgUnitCost: next.avgUnitCost,
            qtyOnHand: next.qtyOnHand,
          },
        });

        /*
         * §5.5's purchase price is "what this last cost me", so the newest bill
         * is the truthful answer and it is refreshed silently. The **selling**
         * price is never touched — that is the shopkeeper's decision, not an
         * arithmetic consequence — but a cost that has caught up with it is
         * said out loud, because the next customer would otherwise be sold at a
         * loss nobody noticed (owner decision 2026-08-24).
         */
        if (product.purchasePriceMinor !== cost.unitPriceMinor) {
          priceUpdates.push({ productId: product.id, purchasePriceMinor: cost.unitPriceMinor });
        }
        const costPerUnitMinor = Math.round(cost.actualUnitCost / 100);
        if (costPerUnitMinor >= product.sellingPriceMinor) {
          warnings.push(
            `“${product.name}” now costs ${Money(costPerUnitMinor).format()} but sells for ${Money(product.sellingPriceMinor).format()} — check the selling price`,
          );
        }
      }

      const posting = purchasePosting(costs, {
        supplierPartyId: supplier.id,
        paidAccount: paidAccount?.code ?? null,
        paidMinor: command.paidMinor,
      });

      const purchaseId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'PURCHASE',
        Number(businessDate.slice(0, 4)),
      );

      await this.purchases.insertPurchase(tx, ctx, {
        id: purchaseId,
        number,
        operationId: command.operationId,
        supplierPartyId: supplier.id,
        supplierBillRef: command.supplierBillRef,
        locationId: location.id,
        dueDate: command.dueDate,
        itemsTotalMinor: costs.itemsTotalMinor,
        discountMinor: costs.discountMinor,
        extraCostMinor: costs.extraCostMinor,
        grandTotalMinor: costs.grandTotalMinor,
        paidMinor: command.paidMinor,
        paidAccountCode: paidAccount?.code ?? null,
        sessionId: paidAccount?.sessionId ?? null,
        notes: command.notes,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
        lines: purchaseLines,
      });

      for (const update of priceUpdates) {
        await this.products.setPurchasePrice(tx, ctx, update.productId, update.purchasePriceMinor);
      }

      await this.audit.append(tx, ctx, {
        entityType: 'purchase',
        entityId: purchaseId,
        action: 'CREATE',
        before: null,
        after: {
          number,
          supplierPartyId: supplier.id,
          grandTotalMinor: String(costs.grandTotalMinor),
          paidMinor: String(command.paidMinor),
          dueMinor: String(costs.grandTotalMinor - command.paidMinor),
          businessDate,
          lineCount: String(purchaseLines.length),
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'purchase.recorded',
        aggregateType: 'purchase',
        aggregateId: purchaseId,
        payload: { supplierPartyId: supplier.id, grandTotalMinor: costs.grandTotalMinor },
      });

      const response = await this.detail(tx, ctx, purchaseId, warnings);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  private async detail(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    warnings: readonly string[],
  ): Promise<PurchaseResponse> {
    const detail = await this.purchases.findPurchaseById(tx, ctx, id);
    if (detail === null) throw new AppError(ErrorCode.NOT_FOUND, 'Purchase not found');
    const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
    return toPurchaseResponse(detail, showCost, warnings);
  }
}
