import {
  averageUnitCostFrom, refillLots, rejectEntry, rejectSalesReturn, salesReturnPosting,
  salesReturnTotals, stockValueMinor,
} from '@sher/core-domain';
import type { AccountCode, LotRefill, ReturnableLine, SalesReturnRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { SalesReturnResponse } from '@sher/core-contracts';
import { Qty, QTY_SCALE, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { InventoryRepository } from '../inventory/inventory-repository';
import type { ManagePartiesService } from '../parties/manage-parties-service';
import type { PartyRepository } from '../parties/party-repository';
import type { MoneyRepository } from '../money/money-repository';
import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PasswordHasher } from '../ports/password-hasher';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from '../purchasing/payment-account';
import type { ReturnableInvoiceRow, SalesReturnRepository } from './sales-return-repository';
import { toSalesReturnResponse } from './sales-return-view';

/**
 * Goods coming back from a customer (Phase 7, §5.11, §2.5, owner decisions
 * 2026-08-26).
 *
 * **WRITE CLASS: T** (R-D). One transaction: permission → idempotency → the
 * invoice and its caps → period guard → refund limit (and the PIN that lifts
 * it) → the account the money comes out of → the document, the goods back into
 * their own lots, the moving-average cache and one journal entry → audit and
 * outbox. Goods accepted at the counter without the refund recorded is not half
 * a return; it is a shop that has paid twice.
 *
 * **A return is always against its invoice.** What may come back is what that
 * invoice sold minus what has already come back, valued at what the customer
 * actually paid for it and costed at what actually left the shelf. Nothing the
 * screen computed is trusted: the modal runs `salesReturnTotals` for the figures
 * the shopkeeper watches, and this service runs the same function again on the
 * invoice's own rows (DR13.12).
 *
 * **Damage is not handled here** (owner decision, 2026-08-26). The return
 * accepts the quantity the shop actually takes back and puts all of it into
 * stock; goods later found unsellable are written off through the stock
 * adjustment screen that already exists, with reason `DAMAGE`.
 */

export interface SalesReturnLineInput {
  readonly saleLineId: string;
  readonly qty: number;
  readonly serialUnitIds: readonly string[];
}

export interface CreateSalesReturnCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly saleId: string;
  readonly lines: readonly SalesReturnLineInput[];
  readonly reason: string;
  readonly note: string | null;
  readonly refundMinor: number;
  readonly refundAccountCode: string | null;
  readonly approvalPin: string | null;
  /**
   * The customer, when a guest sale's return leaves money on account. Blank
   * falls back to what the invoice already recorded (§5.8).
   */
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerAddress: string | null;
  readonly customerGuardianName: string | null;
  readonly businessDate?: string | undefined;
  readonly backdateReason: string | null;
}

/** Domain refusal → the sentence a shopkeeper reads. The rule stays in the domain. */
const REFUSALS: Record<SalesReturnRejection, string> = {
  RETURN_HAS_NO_LINES: 'Choose what is coming back',
  AMOUNT_NOT_INTEGER_MINOR: 'Enter valid amounts',
  RETURN_QUANTITY_NOT_POSITIVE: 'A returned quantity must be more than zero',
  RETURN_LINE_NOT_ON_INVOICE: 'That item is not on this invoice',
  RETURN_EXCEEDS_SOLD: 'More is coming back than this invoice sold',
  REFUND_NEGATIVE: 'A refund cannot be less than zero',
  REFUND_EXCEEDS_RETURN: 'The refund is more than the goods coming back are worth',
  RETURN_HAS_NO_VALUE: 'These goods are worth nothing to return',
};

export interface VoidSalesReturnCommand {
  readonly ctx: TenantContext;
  readonly returnId: string;
  readonly version: number;
  readonly reason: string;
}

export class CreateSalesReturnService {

  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly inventory: InventoryRepository,
    private readonly money: MoneyRepository,
    private readonly parties: PartyRepository,
    private readonly partyService: ManagePartiesService,
    private readonly returns: SalesReturnRepository,
    private readonly numbering: NumberingService,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /**
   * Cancelling a customer return (Phase 9.2, §2.5).
   *
   * **WRITE CLASS: T.** A return taken in by mistake is undone whole: the goods
   * leave the shelf again **through the very lots they were put back into**, so
   * FIFO order still means something afterwards; the refund or the credit is
   * reversed; and the document stays, marked `VOIDED` with the reason the
   * shopkeeper gave.
   *
   * Everything is undone from what was **stored** — the cost that came back is
   * the cost that goes out again, not today's average — because a return
   * cancelled next month at a different cost would leave `COGS` and
   * `INVENTORY` holding a difference nobody created.
   *
   * The refusal is the honest one: if the returned goods have since been sold,
   * they are not on the shelf to take back, and the shop is told so.
   */
  async void(command: VoidSalesReturnCommand): Promise<void> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SALES_RETURN_VOID);
      if (command.reason.trim().length === 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say why this is being cancelled');
      }

      const original = await this.returns.findReturnForReversal(tx, ctx, command.returnId);
      if (original === null) throw new AppError(ErrorCode.NOT_FOUND, 'That return was not found');
      if (original.status !== 'POSTED') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This return has already been cancelled');
      }

      const today = this.clock.businessDate(ctx.timezone);
      // The day the reversal posts on, and only that day: the document's own
      // month may be closed, and a cancellation still has to be possible.
      await this.periods.assertOpen(tx, ctx, today);

      for (const line of original.lines) {
        for (const refill of line.refills) {
          if (refill.lotRemaining < refill.qty) {
            throw new AppError(
              ErrorCode.VALIDATION_FAILED,
              'Some of these returned goods have been sold again — they are not on the shelf to take back',
            );
          }
        }
      }

      /*
       * What each line put back into the shop's **own** stock, and what it put
       * back somewhere else. One line may have been served from the shelf, from
       * a vendor's consignment and from nothing at all (§5.7) at once; only the
       * owned and negative parts ever entered the valuation, so only those parts
       * leave it again. The vendor's goods go back out of the vendor's own lot,
       * and a serial goes back to the customer it was sold to.
       */
      const ownedByLine = new Map<string, { qty: number; costMinor: number }>();
      const vendorTakes: { lotId: string; qty: number }[] = [];
      const serialRestores: {
        unitId: string;
        status: string;
        saleId: string | null;
        saleLineId: string | null;
        customerPartyId: string | null;
        soldDate: string | null;
        customerWarrantyMonths: number | null;
      }[] = [];
      for (const line of original.lines) {
        const origins = original.sourceOrigins.filter(
          (origin) => origin.saleLineId === line.saleLineId,
        );
        if (origins.length === 0) {
          // Returns taken before migration 0045 have no origin trail, and every
          // one of them was own stock — which is what that path recorded.
          ownedByLine.set(line.saleLineId, { qty: line.qty, costMinor: line.costMinor });
          continue;
        }

        let ownedQty = 0;
        let ownedCostMinor = 0;
        for (const origin of origins) {
          if (origin.sourceType === 'VENDOR') {
            if (origin.vendorLotId === null) {
              throw new AppError(ErrorCode.INTERNAL_ERROR, 'Vendor sale allocation lost its lot');
            }
            if (origin.vendorLotRemaining < origin.qty) {
              throw new AppError(
                ErrorCode.VALIDATION_FAILED,
                'Some of these returned goods have been sold again — they are not on the shelf to take back',
              );
            }
            vendorTakes.push({ lotId: origin.vendorLotId, qty: origin.qty });
          } else {
            ownedQty = Qty(ownedQty).add(Qty(origin.qty)).raw;
            ownedCostMinor += stockValueMinor(origin.qty, origin.unitCostUsed);
          }
          if (origin.inventoryUnitId !== null && origin.serialPreviousStatus !== null) {
            serialRestores.push({
              unitId: origin.inventoryUnitId,
              status: origin.serialPreviousStatus,
              saleId: origin.serialSaleId,
              saleLineId: origin.serialSaleLineId,
              customerPartyId: origin.serialCustomerPartyId,
              soldDate: origin.serialSoldDate,
              customerWarrantyMonths: origin.serialCustomerWarrantyMonths,
            });
          }
        }
        ownedByLine.set(line.saleLineId, { qty: ownedQty, costMinor: ownedCostMinor });
      }

      /*
       * The exact poisha that came back into the valuation is on the return's
       * own `INVENTORY` line. Recomputing it from unit costs can land a poisha
       * away when an earlier partial return already took the remainder off the
       * same allocation, so the recomputed shares decide the split between
       * products and the stored total decides the sum — the valuation and the
       * `INVENTORY` account then move by the same number (INV-05).
       */
      const ownedTotalMinor = original.journalLines
        .filter((line) => line.account === 'INVENTORY')
        .reduce((sum, line) => sum + line.amountMinor, 0);
      const residualMinor =
        ownedTotalMinor - [...ownedByLine.values()].reduce((sum, owned) => sum + owned.costMinor, 0);
      if (residualMinor !== 0) {
        let largest: { saleLineId: string; qty: number; costMinor: number } | null = null;
        for (const [saleLineId, owned] of ownedByLine) {
          if (owned.qty === 0) continue;
          if (largest === null || owned.costMinor > largest.costMinor) {
            largest = { saleLineId, ...owned };
          }
        }
        if (largest !== null) {
          ownedByLine.set(largest.saleLineId, {
            qty: largest.qty,
            costMinor: largest.costMinor + residualMinor,
          });
        }
      }

      const reversalLines = original.journalLines.map((line) => ({
        id: Ulid.generate(this.clock),
        account: line.account as AccountCode,
        amountMinor: -line.amountMinor,
        partyId: line.partyId,
      }));
      if (rejectEntry({ lines: reversalLines }) !== null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This return cannot be reversed cleanly');
      }

      /*
       * The cached position per product, wound back by exactly what the return
       * added: the quantity that came in goes out, and the value that came in
       * with it goes with it.
       */
      const costStates = original.costStates.map((state) => {
        const returned = original.lines
          .filter((line) => line.productId === state.productId)
          .reduce(
            (totals, line) => {
              const owned = ownedByLine.get(line.saleLineId) ?? { qty: 0, costMinor: 0 };
              return {
                qty: Qty(totals.qty).add(Qty(owned.qty)).raw,
                valueMinor: totals.valueMinor + owned.costMinor,
              };
            },
            { qty: 0, valueMinor: 0 },
          );
        const qtyAfter = Qty(state.qtyOnHand).subtract(Qty(returned.qty)).raw;
        const valueAfter = stockValueMinor(state.qtyOnHand, state.avgUnitCost) - returned.valueMinor;
        return {
          id: state.id,
          exists: true,
          productId: state.productId,
          locationId: state.locationId,
          qtyOnHand: qtyAfter,
          avgUnitCost: averageUnitCostFrom(valueAfter, qtyAfter),
        };
      });

      const ok = await this.returns.reverseSalesReturn(tx, ctx, {
        returnId: original.id,
        expectedVersion: command.version,
        businessDate: today,
        entryMode: entryModeFor(today, today),
        reason: command.reason.trim(),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: reversalLines,
        lines: original.lines.map((line) => ({
          movementId: Ulid.generate(this.clock),
          productId: line.productId,
          locationId: line.locationId,
          qty: line.qty,
          costMinor: line.costMinor,
          takeBack: line.refills.map((refill) => ({ lotId: refill.lotId, qty: refill.qty })),
        })),
        vendorTakes,
        serialRestores,
        costStates,
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this return — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'sales_return',
        entityId: original.id,
        action: 'DELETE',
        before: { number: original.number, status: 'POSTED', cogsMinor: String(original.cogsMinor) },
        after: { number: original.number, status: 'VOIDED', reason: command.reason.trim() },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'sales.return.cancelled',
        aggregateType: 'sales_return',
        aggregateId: original.id,
        payload: { number: original.number },
      });
    });
  }

  async create(command: CreateSalesReturnCommand): Promise<SalesReturnResponse> {

    const fingerprint = JSON.stringify([
      command.saleId,
      command.lines,
      command.reason,
      command.refundMinor,
      command.refundAccountCode,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SALES_RETURN_CREATE);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different return',
          );
        }
        return replay.response as SalesReturnResponse;
      }
      const posted = await this.returns.findReturnIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted);

      if (!(await this.returns.lockSale(tx, ctx, command.saleId))) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Invoice not found');
      }

      const invoice = await this.returns.findReturnableInvoice(tx, ctx, command.saleId);
      if (invoice === null) throw new AppError(ErrorCode.NOT_FOUND, 'Invoice not found');
      if (invoice.status === 'VOIDED') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This invoice was cancelled — there is nothing to return against it',
        );
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      const backdateReason = await this.guardDate(tx, ctx, businessDate, today, command.backdateReason);
      if (businessDate < invoice.businessDate) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A return cannot be dated before the sale it comes back from',
        );
      }

      const sold: ReturnableLine[] = invoice.lines.map((line) => ({
        saleLineId: line.saleLineId,
        productId: line.productId,
        qtySold: line.qtySold,
        qtyReturned: line.qtyReturned,
        netAmountMinor: line.netAmountMinor,
        costMinor: line.costMinor,
      }));

      const draft = {
        lines: command.lines.map((line) => ({ saleLineId: line.saleLineId, qty: line.qty })),
        refundMinor: command.refundMinor,
      };
      const rejection = rejectSalesReturn(draft, sold);
      if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[rejection]);
      const totals = salesReturnTotals(draft, sold);

      const approvedBy = await this.approveRefund(tx, ctx, totals.refundMinor, businessDate, command.approvalPin);

      /*
       * Resolved before anything is written, so a drawer nobody opened stops the
       * refund at the counter rather than after the goods are back on the shelf.
       * The refusal carries `CASH_DAY_NOT_STARTED`, exactly as a sale's does.
       */
      const resolved =
        totals.refundMinor === 0 || command.refundAccountCode === null
          ? null
          : await resolvePaymentAccount(
              { access: this.access, money: this.money },
              tx,
              ctx,
              command.refundAccountCode,
              businessDate,
              totals.refundMinor,
            );
      const refundAccount = resolved?.code ?? null;
      if (totals.refundMinor > 0 && refundAccount === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose where the refund comes from');
      }

      /*
       * The credit clears **this invoice** first and whatever is left becomes an
       * advance. Spreading it across the customer's other invoices is what a
       * receipt does; a return belongs to the bill it came off, and a shopkeeper
       * asked why an old invoice changed would have no answer.
       */
      const settledMinor = Math.min(totals.creditMinor, Math.max(invoice.dueMinor, 0));

      /*
       * A guest sale creates nobody (§5.8) — but credit left on account is a
       * balance, and a balance needs somebody the ledger can point at. The
       * customer is created here from what the counter was already told.
       */
      const creditParty = await this.resolveCreditParty(tx, ctx, invoice, totals.creditMinor, {
        name: command.customerName,
        phone: command.customerPhone,
        address: command.customerAddress,
        guardianName: command.customerGuardianName,
      });

      const consumptions = await this.returns.lineConsumptions(tx, ctx, invoice.saleId);
      const already = await this.returns.refillsSoFar(tx, ctx, invoice.saleId);
      const sourceOrigins = await this.returns.sourceAllocations(tx, ctx, invoice.saleId);

      const positions = new Map<
        string,
        { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean; locationId: string }
      >();
      const lines = [];
      const vendorReturnCosts = new Map<string, number>();
      let exactReturnCostMinor = 0;
      let ownedReturnCostMinor = 0;
      let lineNo = 0;
      for (const line of totals.lines) {
        const source = invoice.lines.find((row) => row.saleLineId === line.saleLineId);
        if (source === undefined) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'That item is not on this invoice');
        }

        let durable = sourceOrigins.filter((origin) => origin.saleLineId === line.saleLineId);
        const serialOrigins = durable.filter((origin) => origin.inventoryUnitId !== null);
        const requestedLine = command.lines.find((item) => item.saleLineId === line.saleLineId);
        const selectedSerialIds = requestedLine?.serialUnitIds ?? [];
        if (serialOrigins.length > 0) {
          if (
            line.qty % QTY_SCALE !== 0 ||
            selectedSerialIds.length !== line.qty / QTY_SCALE ||
            new Set(selectedSerialIds).size !== selectedSerialIds.length
          ) {
            throw new AppError(
              ErrorCode.VALIDATION_FAILED,
              'Select the exact serial number for every serialized unit being returned',
            );
          }
          const selected = new Set(selectedSerialIds);
          durable = serialOrigins.filter(
            (origin) =>
              origin.inventoryUnitId !== null &&
              selected.has(origin.inventoryUnitId) &&
              origin.reversedQty < origin.qty,
          );
          if (durable.length !== selected.size) {
            throw new AppError(
              ErrorCode.VALIDATION_FAILED,
              'One or more selected serials do not belong to this invoice line or were already returned',
            );
          }
        } else if (selectedSerialIds.length > 0) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'This sale line does not use serial numbers');
        }
        let left = line.qty;
        let ownedPositionQty = 0;
        let ownedCostMinor = 0;
        let lineCostMinor = 0;
        const refills: LotRefill[] = [];
        const vendorRestorations = new Map<string, number>();
        const sourceReversals: { id: string; sourceAllocationId: string; qty: number }[] = [];
        const serialUnitIds: string[] = [];

        for (const origin of durable) {
          if (left === 0) break;
          const available = Qty(origin.qty).subtract(Qty(origin.reversedQty)).raw;
          if (available <= 0) continue;
          const qty = Math.min(left, available);
          const costMinor =
            qty === available
              ? stockValueMinor(origin.qty, origin.unitCostUsed) -
                stockValueMinor(origin.reversedQty, origin.unitCostUsed)
              : stockValueMinor(qty, origin.unitCostUsed);
          lineCostMinor += costMinor;
          sourceReversals.push({
            id: Ulid.generate(this.clock),
            sourceAllocationId: origin.id,
            qty,
          });
          if (origin.inventoryUnitId !== null) serialUnitIds.push(origin.inventoryUnitId);
          if (origin.sourceType === 'OWNED') {
            if (origin.ownedLotId === null) {
              throw new AppError(ErrorCode.INTERNAL_ERROR, 'Owned sale allocation lost its lot');
            }
            ownedPositionQty = Qty(ownedPositionQty).add(Qty(qty)).raw;
            ownedCostMinor += costMinor;
            refills.push({ lotId: origin.ownedLotId, qty, unitCostUsed: origin.unitCostUsed });
          } else if (origin.sourceType === 'NEGATIVE') {
            ownedPositionQty = Qty(ownedPositionQty).add(Qty(qty)).raw;
            ownedCostMinor += costMinor;
          } else {
            if (origin.vendorLotId === null || origin.vendorPartyId === null) {
              throw new AppError(ErrorCode.INTERNAL_ERROR, 'Vendor sale allocation lost its origin');
            }
            vendorRestorations.set(
              origin.vendorLotId,
              (vendorRestorations.get(origin.vendorLotId) ?? 0) + qty,
            );
            vendorReturnCosts.set(
              origin.vendorPartyId,
              (vendorReturnCosts.get(origin.vendorPartyId) ?? 0) + costMinor,
            );
          }
          left = Qty(left).subtract(Qty(qty)).raw;
        }

        if (durable.length === 0) {
          // Historical invoices predate migration 0045 and keep their existing
          // exact-owned-lot behaviour.
          if (source.source !== 'OWN_STOCK') {
            throw new AppError(
              ErrorCode.VALIDATION_FAILED,
              'This historical vendor-sourced line cannot be returned automatically',
            );
          }
          ownedPositionQty = line.qty;
          ownedCostMinor = line.costMinor;
          lineCostMinor = line.costMinor;
          refills.push(
            ...refillLots(
              line.qty,
              consumptions
                .filter((row) => row.saleLineId === line.saleLineId)
                .map((row) => ({ lotId: row.lotId, qty: row.qty, unitCostUsed: row.unitCostUsed })),
              already
                .filter((row) => row.saleLineId === line.saleLineId)
                .map((row) => ({ lotId: row.lotId, qty: row.qty, unitCostUsed: 0 })),
            ),
          );
          left = 0;
        }
        if (left !== 0) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'More is being returned than remains from this line');
        }

        exactReturnCostMinor += lineCostMinor;
        ownedReturnCostMinor += ownedCostMinor;

        if (ownedPositionQty > 0 && !positions.has(source.productId)) {
          const stored = await this.inventory.findStockPosition(tx, ctx, source.productId);
          positions.set(source.productId, {
            qtyOnHand: stored?.qtyOnHand ?? 0,
            avgUnitCost: stored?.avgUnitCost ?? 0,
            costStateId: stored?.costStateId ?? Ulid.generate(this.clock),
            exists: stored?.costStateId !== null && stored?.costStateId !== undefined,
            locationId: stored?.locationId ?? source.locationId,
          });
        }
        const position = positions.get(source.productId);
        if (position !== undefined && ownedPositionQty > 0) {
          positions.set(source.productId, {
            ...position,
            qtyOnHand: Qty(position.qtyOnHand).add(Qty(ownedPositionQty)).raw,
          });
        }

        lineNo += 1;
        lines.push({
          id: Ulid.generate(this.clock),
          lineNo,
          saleLineId: line.saleLineId,
          productId: source.productId,
          locationId: source.locationId,
          qty: line.qty,
          valueMinor: line.valueMinor,
          costMinor: lineCostMinor,
          movementId: Ulid.generate(this.clock),
          refills,
          vendorRestorations: [...vendorRestorations].map(([lotId, qty]) => ({ lotId, qty })),
          sourceReversals,
          serialUnitIds,
        });
      }

      const exactTotals = { ...totals, returnCostMinor: exactReturnCostMinor };
      const journal = salesReturnPosting(exactTotals, {
        partyId: creditParty.partyId,
        refundAccount,
        settledMinor,
        ownedReturnCostMinor,
        vendorReturns: [...vendorReturnCosts].map(([vendorPartyId, costMinor]) => ({
          vendorPartyId,
          costMinor,
        })),
      });

      const returnId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'SALES_RETURN',
        Number(businessDate.slice(0, 4)),
      );

      await this.returns.postSalesReturn(tx, ctx, {
        id: returnId,
        number,
        saleId: invoice.saleId,
        partyId: creditParty.partyId,
        customerName: creditParty.name,
        locationId: invoice.locationId,
        reason: command.reason,
        note: command.note,
        returnValueMinor: totals.returnValueMinor,
        refundMinor: totals.refundMinor,
        creditMinor: totals.creditMinor,
        settledMinor,
        cogsMinor: exactReturnCostMinor,
        refundAccountCode: refundAccount,
        approvedBy,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        backdateReason,
        operationId: command.operationId,
        lines,
        journalEntryId: Ulid.generate(this.clock),
        journalLines: journal.lines.map((line) => ({
          id: Ulid.generate(this.clock),
          account: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
        costStates: [...positions].map(([productId, position]) => ({
          id: position.costStateId,
          exists: position.exists,
          productId,
          locationId: position.locationId,
          // The goods go back at the cost they left at, so the average they were
          // part of is the average they rejoin — the same reasoning that keeps a
          // cancelled sale from moving anybody's cost.
          avgUnitCost: position.avgUnitCost,
          qtyOnHand: position.qtyOnHand,
        })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'sales_return',
        entityId: returnId,
        action: 'CREATE',
        before: null,
        after: {
          number,
          saleNumber: invoice.number,
          returnValueMinor: String(totals.returnValueMinor),
          refundMinor: String(totals.refundMinor),
          approvedBy: approvedBy ?? '',
          businessDate,
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'sales.return.posted',
        aggregateType: 'sales_return',
        aggregateId: returnId,
        payload: { number, saleId: invoice.saleId, returnValueMinor: totals.returnValueMinor },
      });

      const response = await this.detail(tx, ctx, returnId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * Who the credit belongs to (§5.8, owner-reported 2026-08-26).
   *
   * A fully paid sale stays on the shop's walk-in party and creates nobody —
   * that is §5.8's guest rule and it is right, because a settled sale has no
   * balance and a balance is the only thing that needs a name. **A return
   * changes that.** The moment goods come back and the money stays on account,
   * there is a balance again, and leaving it on the walk-in party would put a
   * shop's credit against nobody: the next visit could not find it, and no
   * statement could show it.
   *
   * So the customer is created here, from what the counter was already told
   * when the sale was made — the name, phone, address and guardian the invoice
   * carries — through **`ManagePartiesService.createWithin`, the same writer
   * the party form and the POS call**, inside this return's own transaction.
   * There is one party writer (A11, A14), so a customer born from a return
   * obeys the same validation, the same D-02 phone rule, the same permissions
   * and the same audit trail as one typed into the form.
   *
   * A phone that already belongs to a customer **is** that customer: D-02 makes
   * the number unique among customers, and a return that created a second
   * Karim would split his credit across two ledgers.
   *
   * Nothing happens for a refund: cash handed back leaves no balance behind, so
   * a guest stays a guest. Nothing happens on a named customer's invoice
   * either — they already have a ledger.
   */
  private async resolveCreditParty(
    tx: Tx,
    ctx: TenantContext,
    invoice: ReturnableInvoiceRow,
    creditMinor: number,
    typed: {
      readonly name: string | null;
      readonly phone: string | null;
      readonly address: string | null;
      readonly guardianName: string | null;
    },
  ): Promise<{ readonly partyId: string; readonly name: string }> {
    if (!invoice.isWalkIn || creditMinor <= 0) {
      return { partyId: invoice.partyId, name: invoice.customerName };
    }

    // What the shopkeeper typed on the return wins over the invoice's snapshot:
    // the guest may be correcting a number that was taken down wrongly.
    const name = (typed.name ?? '').trim() === '' ? invoice.customerName.trim() : (typed.name ?? '').trim();
    const phone = (typed.phone ?? '').trim() === '' ? (invoice.customerPhone ?? '').trim() : (typed.phone ?? '').trim();

    if (name === '' || phone === '') {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Leaving money on account needs the customer’s name and phone',
        { reason: 'CUSTOMER_REQUIRED' },
      );
    }

    const existingId = await this.parties.findCustomerIdByPhone(tx, ctx, phone);
    if (existingId !== null) {
      const existing = await this.parties.findById(tx, ctx, existingId);
      if (existing !== null && existing.status === 'ACTIVE') {
        return { partyId: existing.id, name: existing.name };
      }
    }

    const created = await this.partyService.createWithin(
      tx,
      ctx,
      {
        name,
        roles: ['CUSTOMER'],
        phone,
        address: (typed.address ?? '').trim() === '' ? invoice.customerAddress : typed.address,
        guardianName:
          (typed.guardianName ?? '').trim() === '' ? invoice.customerGuardianName : typed.guardianName,
        nid: null,
        email: null,
        notes: null,
        customerGroupId: null,
        creditLimitMinor: null,
        opening: null,
      },
      'POS',
    );
    return { partyId: created.id, name: created.name };
  }

  /**
   * The business date this return posts on (§5.19, owner decision 2026-08-26).
   *
   * Today needs nothing. An earlier date needs `period.backdate` **and** a
   * reason, and must fall in a period still open. A later date is refused
   * outright: a shop cannot take goods back tomorrow.
   */
  private async guardDate(
    tx: Tx,
    ctx: TenantContext,
    businessDate: string,
    today: string,
    reason: string | null,
  ): Promise<string | null> {
    if (businessDate > today) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A return cannot be dated in the future');
    }
    if (businessDate !== today) {
      await this.access.require(tx, ctx, Permission.PERIOD_BACKDATE);
      if (reason === null || reason.trim() === '') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Say why this return is being entered on an earlier date',
        );
      }
    }
    await this.periods.assertOpen(tx, ctx, businessDate);
    return businessDate === today ? null : reason;
  }

  /**
   * The refund caps, and the PIN that lifts them (owner decision 2026-08-26).
   *
   * Two caps on the caller's role: one refund, and everything they have refunded
   * today. Over either, somebody whose own role allows the amount types their
   * PIN and their name is stored on the return — the counter keeps working when
   * the owner is out, and nothing leaves the drawer unaccounted for. `null` is
   * unlimited; `0` is a role that may take returns and never open the drawer.
   */
  private async approveRefund(
    tx: Tx,
    ctx: TenantContext,
    refundMinor: number,
    businessDate: string,
    pin: string | null,
  ): Promise<string | null> {
    if (refundMinor === 0) return null;

    const caps = await this.returns.refundCapsOf(tx, ctx, ctx.userId);
    const usedToday = await this.returns.cashRefundedToday(tx, ctx, ctx.userId, businessDate);
    const overPerReturn = caps.perReturnMinor !== null && refundMinor > caps.perReturnMinor;
    const overPerDay = caps.perDayMinor !== null && usedToday + refundMinor > caps.perDayMinor;
    if (!overPerReturn && !overPerDay) return null;

    if (pin === null) {
      throw new AppError(
        ErrorCode.APPROVAL_REQUIRED,
        overPerReturn
          ? 'This refund is more than you may hand back — ask a manager to approve it'
          : 'You have already refunded your limit for today — ask a manager to approve it',
      );
    }

    const candidates = await this.returns.approvalCandidates(tx, ctx, refundMinor, businessDate);
    for (const candidate of candidates) {
      if (await this.hasher.verify(pin, candidate.pinHash)) return candidate.userId;
    }
    // Deliberately one message for a wrong PIN and for a PIN belonging to
    // somebody who could not approve this much: telling them apart would let
    // anyone at the counter map out who holds which limit.
    throw new AppError(ErrorCode.APPROVAL_REQUIRED, 'That PIN cannot approve this refund');
  }

  private async detail(tx: Tx, ctx: TenantContext, returnId: string): Promise<SalesReturnResponse> {
    const row = await this.returns.findReturnById(tx, ctx, returnId);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'Return not found');
    return toSalesReturnResponse(row);
  }
}
