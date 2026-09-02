import {
  allocateLandedCost,
  fixedAccount,
  rejectEntry,
  rejectLandedCost,
  splitLateLandedCost,
  stockValueMinor,
} from '@sher/core-domain';
import type { AccountCode, LandedCostMethod, LandedCostRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { LandedCostResponse } from '@sher/core-contracts';
import { Money, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { MoneyRepository } from '../money/money-repository';
import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from './payment-account';
import type { CostStateUpdate, LandedCostRepository, LotCostUpdate } from './landed-cost-repository';

/**
 * The van fare that turned up three days after the goods (§5.12, owner decision
 * 2026-08-26).
 *
 * **WRITE CLASS: T** (R-D). Permission, idempotency, period guard, load,
 * invariants, the document, the lots and the average cache, one journal entry,
 * audit and outbox — one transaction, because goods revalued without an entry
 * to pay for it is exactly the drift INV-05 exists to catch.
 *
 * **The split is the whole design.** A cost arriving late cannot raise a lot
 * that has already been sold out of, so each line's share is divided by what is
 * left of its lot: the part belonging to stock still on the shelf raises that
 * lot, and the part belonging to units already gone is charged to `COGS`.
 *
 * **It is dated the day it is recorded, not the day of the bill.** Backdating
 * it into the original purchase would mean rewriting a period that may be
 * closed, which the period guard exists to prevent. The shop's total profit is
 * identical either way; only which month carries the correction moves, and
 * that is the honest answer to a bill nobody had yet.
 *
 * **`ROUNDING` absorbs the last poisha.** A unit cost is scale-4 and rounded
 * once, so raising a lot by a target value need not land on the exact taka. The
 * entry debits `INVENTORY` by what the valuation *actually* moved rather than
 * by what was intended, and the remainder goes to `ROUNDING` — the same choice
 * `purchaseCosts` already makes, and for the same reason: INV-05 requires the
 * account to equal the valuation exactly.
 */
export interface AddLandedCostCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly purchaseId: string;
  readonly category: string;
  readonly method: LandedCostMethod;
  readonly amountMinor: number;
  readonly paidAccountCode: string | null;
  readonly note: string | null;
  readonly description: string | null;
  readonly manualAllocations: readonly {
    readonly purchaseLineId: string;
    readonly amountMinor: number;
  }[];
  readonly businessDate?: string | undefined;
}

const REFUSALS: Record<LandedCostRejection, string> = {
  LANDED_COST_NOT_POSITIVE: 'Enter how much the extra cost was',
  LANDED_COST_NOT_INTEGER_MINOR: 'Enter a valid amount',
  LANDED_COST_HAS_NO_TARGET: 'That bill has no items to spread this cost over',
  LANDED_COST_TARGET_HAS_NO_WEIGHT:
    'This cost cannot be spread over that bill — its items have no quantity or value',
  LANDED_COST_MANUAL_ALLOCATION_INVALID: 'Enter a manual allocation for every purchase line',
  LANDED_COST_MANUAL_ALLOCATION_MISMATCH:
    'Manual allocations must add up exactly to the landed cost amount',
};

/** The scale-4 unit cost a value spread over a quantity comes to, rounded once. */
function unitCostFor(valueMinor: number, qtyRaw: number): number {
  if (qtyRaw <= 0) return 0;
  const scaled = (BigInt(valueMinor) * 100_000n * 2n) / BigInt(qtyRaw);
  return Number((scaled + 1n) / 2n);
}

export class AddLandedCostService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly costs: LandedCostRepository,
    private readonly money: MoneyRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async add(command: AddLandedCostCommand): Promise<LandedCostResponse> {
    return this.uow.run(command.ctx, (tx) => this.addWithin(tx, command));
  }

  /** Authoritative landed-cost writer reused by atomic vendor settlement. */
  async addWithin(tx: Tx, command: AddLandedCostCommand): Promise<LandedCostResponse> {
    const fingerprint = JSON.stringify([
      command.purchaseId,
      command.category,
      command.method,
      command.amountMinor,
      command.paidAccountCode,
      command.description,
      command.manualAllocations,
      command.businessDate ?? null,
    ]);

      const { ctx } = command;
      // Changing what a posted bill's goods cost is an edit of that bill by any
      // honest reading, so it is gated on the permission that already means so.
      await this.access.require(tx, ctx, Permission.PURCHASE_EDIT);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different cost',
          );
        }
        return replay.response as LandedCostResponse;
      }

      const purchase = await this.costs.findPurchaseForLandedCost(tx, ctx, command.purchaseId);
      if (purchase === null) throw new AppError(ErrorCode.NOT_FOUND, 'That bill was not found');
      if (purchase.status !== 'POSTED') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'That bill has been cancelled — there is nothing to add a cost to',
        );
      }
      if (command.category === 'OTHER' && (command.description ?? '').trim() === '') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Describe what the Other landed cost was for');
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A cost cannot be dated in the future');
      }
      if (businessDate < purchase.businessDate) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A cost cannot be dated before the bill it belongs to',
        );
      }
      await this.periods.assertOpen(tx, ctx, businessDate);

      const manual = new Map(
        command.manualAllocations.map((allocation) => [allocation.purchaseLineId, allocation.amountMinor]),
      );
      const targets = purchase.lines.map((line) => ({
        purchaseLineId: line.purchaseLineId,
        qty: line.qty,
        lineTotalMinor: line.lineTotalMinor,
        ...(command.method === 'MANUAL'
          ? { manualShareMinor: manual.get(line.purchaseLineId) }
          : {}),
      }));
      const rejection = rejectLandedCost(command.amountMinor, targets, command.method);
      if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[rejection]);

      const shares = allocateLandedCost(command.amountMinor, targets, command.method);
      const shareOf = new Map(shares.map((share) => [share.purchaseLineId, share.shareMinor]));

      /*
       * Raise each lot to what its remaining stock now costs, and remember what
       * the valuation actually moved by — not what it was asked to move by. The
       * two differ by at most a poisha per lot, and pretending otherwise is
       * what would put `INVENTORY` out of step with the goods.
       */
      const lots: LotCostUpdate[] = [];
      const lineShares = [];
      const inventoryByProduct = new Map<string, number>();
      let inventoryPosted = 0;
      let cogsPosted = 0;

      for (const line of purchase.lines) {
        const share = shareOf.get(line.purchaseLineId) ?? 0;
        if (share === 0) continue;

        const split = splitLateLandedCost(share, line.lotQtyReceived, line.lotQtyRemaining);
        cogsPosted += split.cogsMinor;

        lineShares.push({
          purchaseLineId: line.purchaseLineId,
          extraCostShareMinor: line.extraCostShareMinor + share,
        });

        if (split.inventoryMinor === 0 || line.lotQtyRemaining <= 0) continue;

        const before = stockValueMinor(line.lotQtyRemaining, line.lotActualUnitCost);
        const actualUnitCost = unitCostFor(before + split.inventoryMinor, line.lotQtyRemaining);
        const after = stockValueMinor(line.lotQtyRemaining, actualUnitCost);
        const moved = after - before;

        lots.push({
          lotId: line.lotId,
          landedCostTotal: line.lotLandedCostTotal + split.inventoryMinor,
          actualUnitCost,
        });
        inventoryPosted += moved;
        const key = `${line.productId}:${line.locationId}`;
        inventoryByProduct.set(key, (inventoryByProduct.get(key) ?? 0) + moved);
      }

      /*
       * The moving-average cache is raised by exactly what the lots moved, so a
       * shop on AVERAGE costing values the same goods at the same figure a shop
       * on FIFO does. It is a cache of the lots; letting it drift would make
       * INV-05 pass under one setting and fail under the other.
       */
      const states = await this.costs.findCostStates(
        tx,
        ctx,
        [...inventoryByProduct.keys()].map((key) => {
          const [productId = '', locationId = ''] = key.split(':');
          return { productId, locationId };
        }),
      );
      const costStates: CostStateUpdate[] = [];
      for (const state of states) {
        const moved = inventoryByProduct.get(`${state.productId}:${state.locationId}`) ?? 0;
        if (moved === 0 || state.qtyOnHand <= 0) continue;
        const before = stockValueMinor(state.qtyOnHand, state.avgUnitCost);
        costStates.push({
          id: state.id,
          avgUnitCost: unitCostFor(before + moved, state.qtyOnHand),
        });
      }

      const paidAccount =
        command.paidAccountCode === null
          ? null
          : await resolvePaymentAccount(
              { access: this.access, money: this.money },
              tx,
              ctx,
              command.paidAccountCode,
              businessDate,
              command.amountMinor,
            );

      const rounding = command.amountMinor - inventoryPosted - cogsPosted;
      const journalLines: {
        readonly id: string;
        readonly account: AccountCode;
        readonly amountMinor: number;
        readonly partyId: string | null;
      }[] = [];

      if (inventoryPosted !== 0) {
        journalLines.push({
          id: Ulid.generate(this.clock),
          account: fixedAccount('INVENTORY'),
          amountMinor: inventoryPosted,
          partyId: null,
        });
      }
      if (cogsPosted !== 0) {
        journalLines.push({
          id: Ulid.generate(this.clock),
          account: fixedAccount('COGS'),
          amountMinor: cogsPosted,
          partyId: null,
        });
      }
      if (rounding !== 0) {
        journalLines.push({
          id: Ulid.generate(this.clock),
          account: fixedAccount('ROUNDING'),
          amountMinor: rounding,
          partyId: null,
        });
      }
      journalLines.push({
        id: Ulid.generate(this.clock),
        account: paidAccount === null ? fixedAccount('AP') : paidAccount.code,
        amountMinor: -command.amountMinor,
        partyId: paidAccount === null ? purchase.supplierPartyId : null,
      });

      if (rejectEntry({ lines: journalLines }) !== null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'That cost could not be posted cleanly');
      }

      const costId = Ulid.generate(this.clock);
      const existing = await this.costs.listLandedCosts(tx, ctx, purchase.id);
      const cost = {
        id: costId,
        purchaseId: purchase.id,
        lineNo: existing.length + 1,
        category: command.category,
        method: command.method,
        amountMinor: command.amountMinor,
        inventoryShareMinor: inventoryPosted + Math.max(rounding, 0),
        cogsShareMinor: command.amountMinor - inventoryPosted - Math.max(rounding, 0),
        businessDate,
        operationId: command.operationId,
        journalEntryId: Ulid.generate(this.clock),
        description: command.description,
        paidAccountCode: paidAccount?.code ?? null,
        sessionId: paidAccount?.sessionId ?? null,
        allocations: shares.map((share) => ({
          id: Ulid.generate(this.clock),
          purchaseLineId: share.purchaseLineId,
          amountMinor: share.shareMinor,
        })),
      };

      await this.costs.recordLandedCost(tx, ctx, {
        cost,
        purchaseNumber: purchase.number,
        entryMode: entryModeFor(businessDate, today),
        lots,
        lineShares,
        costStates,
        journalLines,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'purchase_landed_cost',
        entityId: costId,
        action: 'CREATE',
        before: null,
        after: {
          purchase: purchase.number,
          category: command.category,
          amountMinor: String(command.amountMinor),
          toInventory: String(inventoryPosted),
          toCogs: String(cogsPosted),
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'purchase.landed_cost.added',
        aggregateType: 'purchase',
        aggregateId: purchase.id,
        payload: {
          costId,
          category: command.category,
          amountMinor: Money(command.amountMinor).minor,
        },
      });

      const response: LandedCostResponse = {
        id: costId,
        category: command.category as LandedCostResponse['category'],
        method: command.method,
        amountMinor: command.amountMinor,
        inventoryShareMinor: cost.inventoryShareMinor,
        cogsShareMinor: cost.cogsShareMinor,
        businessDate,
        addedLater: true,
        description: command.description,
        allocations: shares.map((share) => ({
          purchaseLineId: share.purchaseLineId,
          amountMinor: share.shareMinor,
        })),
      };
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
  }
}
