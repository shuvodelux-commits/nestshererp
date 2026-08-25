import { rejectEntry, stockValueMinor } from '@sher/core-domain';
import type { AccountCode } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { PurchaseResponse } from '@sher/core-contracts';
import { Qty, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { InventoryRepository } from '../inventory/inventory-repository';
import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PurchaseRepository } from './purchase-repository';
import { toPurchaseResponse } from './purchase-view';

/**
 * Cancelling a posted bill (§2.5, Phase 7).
 *
 * **WRITE CLASS: T** (R-D). A bill is never deleted: the document stays with
 * its number, marked `VOIDED`, and one reversing entry undoes exactly what it
 * did — the goods come back off the shelf, the lots close, and the supplier is
 * no longer owed.
 *
 * Two refusals, and they are different questions:
 *
 * - **Goods sold.** If any of a bill's lots has been drawn down, the stock is
 *   not there to take back. The shop is told to use a purchase return.
 * - **Money allocated.** A supplier payment recorded *later* and pointed at
 *   this bill would be left settling a bill that no longer owes anything, which
 *   no screen could explain. A correction can move that money onto the
 *   replacement; a cancellation has nowhere to move it to, so it refuses.
 *
 * Money paid **on** the bill is not a refusal: the original entry carried that
 * cash line, and reversing the entry puts it back where it came from.
 */

export interface VoidPurchaseCommand {
  readonly ctx: TenantContext;
  readonly purchaseId: string;
  readonly version: number;
  readonly reason: string | null;
}

export class VoidPurchaseService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly periods: PeriodGuard,
    private readonly inventory: InventoryRepository,
    private readonly purchases: PurchaseRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async void(command: VoidPurchaseCommand): Promise<PurchaseResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_VOID);

      const original = await this.purchases.findPurchaseForReversal(tx, ctx, command.purchaseId);
      if (original === null) throw new AppError(ErrorCode.NOT_FOUND, 'Purchase not found');
      if (original.status !== 'POSTED') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This bill is already cancelled');
      }
      if (original.allocatedMinor > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A payment has been recorded against this bill — reverse the payment first',
        );
      }
      for (const line of original.lines) {
        if (line.qtyRemainingInLot < line.qty) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'Some of these goods have already been sold — use a purchase return instead',
          );
        }
      }

      const today = this.clock.businessDate(ctx.timezone);
      await this.periods.assertOpen(tx, ctx, original.businessDate);
      await this.periods.assertOpen(tx, ctx, today);

      const reversal = original.journalLines.map((line) => ({
        id: Ulid.generate(this.clock),
        account: line.account as AccountCode,
        amountMinor: -line.amountMinor,
        partyId: line.partyId,
      }));
      if (rejectEntry({ lines: reversal }) !== null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This bill cannot be reversed cleanly');
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
          // The average this receipt made is taken back out of it, exactly as a
          // correction does — the two paths differ in what follows, not in what
          // they undo.
          const qtyLeft = Qty(position.qtyOnHand).subtract(Qty(line.qty)).raw;
          const valueLeft =
            stockValueMinor(position.qtyOnHand, position.avgUnitCost) - line.costMinor;
          positions.set(line.productId, {
            ...position,
            qtyOnHand: qtyLeft,
            avgUnitCost:
              qtyLeft <= 0 || valueLeft <= 0
                ? 0
                : Number(((BigInt(valueLeft) * 100_000n * 2n) / BigInt(qtyLeft) + 1n) / 2n),
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
        expectedVersion: command.version,
        businessDate: today,
        entryMode: entryModeFor(today, today),
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
        action: 'DELETE',
        before: {
          number: original.number,
          status: 'POSTED',
          grandTotalMinor: String(original.grandTotalMinor),
        },
        after: { number: original.number, status: 'VOIDED', reason: command.reason ?? '' },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'purchase.cancelled',
        aggregateType: 'purchase',
        aggregateId: original.id,
        payload: { number: original.number, grandTotalMinor: original.grandTotalMinor },
      });

      const updated = await this.purchases.findPurchaseById(tx, ctx, original.id);
      if (updated === null) throw new AppError(ErrorCode.NOT_FOUND, 'Purchase not found');
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      return toPurchaseResponse(updated, showCost);
    });
  }
}
