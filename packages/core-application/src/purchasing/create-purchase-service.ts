import {
  allocateLandedCost,
  averageAfterReceipt,
  purchaseCosts,
  purchasePosting,
  rejectEntry,
  rejectLandedCost,
  rejectPurchase,
  stockValueMinor,
} from '@sher/core-domain';
import type { AccountCode, LandedCostMethod, PurchaseRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { PurchaseResponse } from '@sher/core-contracts';
import { Money, Qty, Ulid } from '@sher/shared-utils';
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
  /** The plan line this buys, when the bill was seeded from one (Phase 8). */
  readonly planLineId?: string | null | undefined;
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
  readonly landedCosts?: readonly {
    readonly category: string;
    readonly method: LandedCostMethod;
    readonly amountMinor: number;
    readonly description: string | null;
    readonly manualAllocations: readonly { readonly lineIndex: number; readonly amountMinor: number }[];
  }[] | undefined;
  readonly extraCostMinor: number;
  readonly paidMinor: number;
  readonly paidAccountCode: string | null;
  readonly notes: string | null;
  /**
   * The bill this one replaces (Phase 7, §2.5, owner decision 2026-08-26).
   *
   * A posted purchase is never edited in place. Naming it here makes this call
   * a **correction**: the original is reversed in full inside this same
   * transaction, the corrected bill takes its number, and any money already
   * allocated to it follows. There is one purchase writer, so a corrected bill
   * obeys exactly the costing, permissions, audit and outbox rules a typed one
   * does — which is the whole reason this is a field rather than a second
   * service.
   */
  readonly correctionOf: string | null;
  /** The supplier order being converted, when the bill came from one. */
  readonly supplierOrderId?: string | null | undefined;
  /** Internal reuse: receive owned stock from a party whose role is Vendor. */
  readonly vendorSettlement?: boolean | undefined;
}

/**
 * The unit cost (scale 4) that a value in poisha spread over a quantity comes
 * to, rounded half-up once — the inverse of `stockValueMinor`.
 *
 * Used when a receipt is reversed: the average is what is left after this
 * bill's contribution is taken back out, and rounding it any other way would
 * leave the cache disagreeing with the lots it is a cache of.
 */
function averageOf(valueMinor: number, qtyRaw: number): number {
  const scaled = (BigInt(valueMinor) * 100_000n * 2n) / BigInt(qtyRaw);
  return Number((scaled + 1n) / 2n);
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

  /**
   * Undo the bill being corrected (§2.5, owner decision 2026-08-26).
   *
   * **Refused once the goods have been sold.** A bill's lots are what its goods
   * live in; if any of one has been drawn down, un-receiving it would take
   * stock that belongs to somebody else's sale and drive the lot negative. The
   * shop is told to use a purchase return instead — the document that exists
   * for goods which really did move.
   *
   * A later supplier payment allocated to the bill is fine: it follows the
   * number onto the corrected bill. The reversal is built from the entry that
   * was posted, read back from the journal rather than recomputed, because
   * costs move and a rebuilt entry would not cancel out.
   */
  private async reverseForCorrection(
    tx: Tx,
    ctx: TenantContext,
    purchaseId: string,
    businessDate: string,
    today: string,
  ): Promise<{ readonly id: string; readonly number: string }> {
    const original = await this.purchases.findPurchaseForReversal(tx, ctx, purchaseId);
    if (original === null) throw new AppError(ErrorCode.NOT_FOUND, 'That bill was not found');
    if (original.status !== 'POSTED') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That bill has already been cancelled');
    }

    for (const line of original.lines) {
      if (line.qtyRemainingInLot < line.qty) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Some of these goods have already been sold — use a purchase return instead',
        );
      }
    }

    // Both dates are guarded: moving a bill out of a closed period changes that
    // period as much as posting into it.
    await this.periods.assertOpen(tx, ctx, original.businessDate);
    await this.periods.assertOpen(tx, ctx, businessDate);

    const reversal = original.journalLines.map((line) => ({
      id: Ulid.generate(this.clock),
      account: line.account as AccountCode,
      amountMinor: -line.amountMinor,
      partyId: line.partyId,
    }));
    if (rejectEntry({ lines: reversal }) !== null) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'That bill cannot be reversed cleanly');
    }

    const positions = new Map<
      string,
      {
        qtyOnHand: number;
        avgUnitCost: number;
        costStateId: string;
        exists: boolean;
        locationId: string;
      }
    >();
    const movements = [];
    for (const line of original.lines) {
      if (!positions.has(line.productId)) {
        const stored = await this.inventory.findStockPosition(tx, ctx, line.productId);
        positions.set(line.productId, {
          qtyOnHand: stored?.qtyOnHand ?? 0,
          avgUnitCost: stored?.avgUnitCost ?? 0,
          costStateId: stored?.costStateId ?? Ulid.generate(this.clock),
          exists: stored?.costStateId !== null && stored?.costStateId !== undefined,
          locationId: stored?.locationId ?? line.locationId,
        });
      }
      const position = positions.get(line.productId);
      if (position !== undefined) {
        /*
         * The average this receipt created is taken back out of it: the value
         * on hand, less what this line put in, over the quantity that is left.
         * Reversing the quantity alone would leave the shop's average holding a
         * price it never paid.
         */
        const qtyLeft = Qty(position.qtyOnHand).subtract(Qty(line.qty)).raw;
        const valueLeft = stockValueMinor(position.qtyOnHand, position.avgUnitCost) - line.costMinor;
        positions.set(line.productId, {
          ...position,
          qtyOnHand: qtyLeft,
          avgUnitCost: qtyLeft <= 0 || valueLeft <= 0 ? 0 : averageOf(valueLeft, qtyLeft),
        });
      }

      movements.push({
        id: Ulid.generate(this.clock),
        productId: line.productId,
        locationId: line.locationId,
        lotId: line.lotId,
        qty: line.qty,
        unitCost: line.qty === 0 ? 0 : Math.round((line.costMinor * 100_000) / line.qty),
      });
    }

    const ok = await this.purchases.reversePurchase(tx, ctx, {
      purchaseId: original.id,
      expectedVersion: original.version,
      businessDate,
      entryMode: entryModeFor(businessDate, today),
      journalEntryId: Ulid.generate(this.clock),
      journalLines: reversal,
      movements,
      costStates: [...positions].map(([productId, position]) => ({
        id: position.costStateId,
        exists: position.exists,
        productId,
        locationId: position.locationId,
        avgUnitCost: position.avgUnitCost,
        qtyOnHand: position.qtyOnHand,
      })),
    });
    if (!ok) {
      throw new AppError(
        ErrorCode.CONFLICT_STALE_VERSION,
        'Someone else changed this bill — reload and try again',
      );
    }

    await this.audit.append(tx, ctx, {
      entityType: 'purchase',
      entityId: original.id,
      action: 'CORRECT',
      before: {
        number: original.number,
        status: 'POSTED',
        grandTotalMinor: String(original.grandTotalMinor),
      },
      after: { number: original.number, status: 'VOIDED', reason: 'CORRECTED' },
      source: 'API',
    });

    return { id: original.id, number: original.number };
  }

  async create(command: CreatePurchaseCommand): Promise<PurchaseResponse> {
    return this.uow.run(command.ctx, (tx) => this.createWithin(tx, command));
  }

  /** Authoritative purchase writer reused inside another Class-T transaction. */
  async createWithin(tx: Tx, command: CreatePurchaseCommand): Promise<PurchaseResponse> {
    const costTargets = command.lines.map((line, index) => ({
      purchaseLineId: String(index),
      qty: line.qty,
      lineTotalMinor: Money(line.unitPriceMinor).multiply(Qty(line.qty)).minor,
    }));
    const namedCosts = (command.landedCosts ?? []).map((cost) => {
      if (cost.category === 'OTHER' && (cost.description ?? '').trim() === '') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Describe what the Other landed cost was for');
      }
      const manual = new Map(cost.manualAllocations.map((row) => [row.lineIndex, row.amountMinor]));
      const targets = costTargets.map((target, index) => ({
        ...target,
        ...(cost.method === 'MANUAL' ? { manualShareMinor: manual.get(index) } : {}),
      }));
      const rejected = rejectLandedCost(cost.amountMinor, targets, cost.method);
      if (rejected !== null) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          rejected === 'LANDED_COST_MANUAL_ALLOCATION_MISMATCH'
            ? 'Manual landed-cost allocations must add up exactly to the cost amount'
            : 'Enter a valid landed-cost allocation for every purchase line',
        );
      }
      return { ...cost, shares: allocateLandedCost(cost.amountMinor, targets, cost.method) };
    });
    const legacyShares =
      command.extraCostMinor === 0
        ? costTargets.map((target) => ({ purchaseLineId: target.purchaseLineId, shareMinor: 0 }))
        : allocateLandedCost(command.extraCostMinor, costTargets, 'BY_VALUE');
    const namedTotal = namedCosts.reduce((sum, cost) => sum + cost.amountMinor, 0);
    const aggregateShares = costTargets.map(
      (_target, index) =>
        (legacyShares[index]?.shareMinor ?? 0) +
        namedCosts.reduce((sum, cost) => sum + (cost.shares[index]?.shareMinor ?? 0), 0),
    );
    const draft = {
      lines: command.lines.map((line) => ({
        productId: line.productId,
        qty: line.qty,
        unitPriceMinor: line.unitPriceMinor,
      })),
      discountMinor: command.discountMinor,
      extraCostMinor: command.extraCostMinor + namedTotal,
      extraCostShares: aggregateShares,
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
      command.landedCosts ?? [],
      command.extraCostMinor,
      command.paidMinor,
      command.paidAccountCode,
    ]);

      const { ctx } = command;
      await this.access.require(
        tx,
        ctx,
        command.correctionOf === null ? Permission.PURCHASE_CREATE : Permission.PURCHASE_EDIT,
      );

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

      /*
       * The correction happens first, inside this same transaction: the old
       * bill is undone before the new one lands, so stock and the ledger never
       * hold both at once, and anything that refuses below rolls the reversal
       * back with it.
       */
      const replaced =
        command.correctionOf === null
          ? null
          : await this.reverseForCorrection(tx, ctx, command.correctionOf, businessDate, today);

      const supplier = await this.parties.findById(tx, ctx, command.supplierPartyId);
      if (supplier === null) throw new AppError(ErrorCode.NOT_FOUND, 'Supplier not found');
      if (
        !supplier.roles.includes('SUPPLIER') &&
        !(command.vendorSettlement === true && supplier.roles.includes('VENDOR'))
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          command.vendorSettlement === true
            ? `“${supplier.name}” is not a vendor`
            : `“${supplier.name}” is not a supplier`,
        );
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
              command.paidMinor,
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
        /*
         * A tracked product cannot be received without a date (owner decision
         * 2026-08-26, reversing the 5.1 decision that made it optional).
         *
         * That earlier choice is what left FEFO falling back to FIFO whenever
         * one batch was undated, and what would have let "block expired stock"
         * quietly not apply. Every batch bought from here on is dated, so both
         * rules mean what they say. Batches received while it was optional keep
         * their blank date and are filled in from the product screen.
         */
        if (expiryDate === null && product.tracksExpiry) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            `“${product.name}” needs an expiry date — this batch cannot be received without one`,
            { reason: 'EXPIRY_REQUIRED', productId: product.id },
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
          // What this line is buying against, when the bill came from a plan.
          planLineId: command.lines[index]?.planLineId ?? null,
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
      /*
       * A correction keeps the number it is correcting. A shopkeeper holding a
       * bill and the shop holding two different numbers for it is the confusion
       * §2.5 exists to prevent — and a gap in the series would look like a
       * missing document rather than a fixed one.
       */
      const number =
        replaced === null
          ? await this.numbering.allocate(tx, ctx, 'PURCHASE', Number(businessDate.slice(0, 4)))
          : replaced.number;

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
        supplierOrderId: command.supplierOrderId ?? null,
        businessDate,
        entryMode: replaced === null ? entryModeFor(businessDate, today) : 'CORRECTED',
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
        lines: purchaseLines,
        landedCosts: namedCosts.map((cost, costIndex) => ({
          id: Ulid.generate(this.clock),
          lineNo: costIndex + 1,
          category: cost.category,
          method: cost.method,
          amountMinor: cost.amountMinor,
          description: cost.description,
          allocations: cost.shares.map((share, lineIndex) => ({
            id: Ulid.generate(this.clock),
            purchaseLineId: purchaseLines[lineIndex]?.id ?? '',
            amountMinor: share.shareMinor,
          })),
        })),
      });

      /*
       * Money handed over was handed over for this bill number, so it follows
       * the number rather than being unallocated and typed again. The reversal
       * above has already put the original cash line back, so only *later*
       * payments are moved here.
       */
      if (replaced !== null) {
        await this.purchases.movePaymentAllocations(tx, ctx, replaced.id, purchaseId);
      }

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
