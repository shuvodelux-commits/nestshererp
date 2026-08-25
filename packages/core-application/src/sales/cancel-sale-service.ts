import { rejectEntry } from '@sher/core-domain';
import type { AccountCode } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { SaleResponse } from '@sher/core-contracts';
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
import type { SaleRepository } from './sale-repository';
import { toSaleResponse } from './sale-view';

/**
 * Cancelling a posted sale (§2.5, §5.8).
 *
 * **WRITE CLASS: T** (R-D). A sale is never deleted and never rewritten: the
 * document stays, and one reversing entry undoes exactly what it did. The
 * goods go back into the lots they came out of, the money comes back out of the
 * account it went into, and the invoice is marked `VOIDED` while keeping its
 * number — a missing invoice number is what a shopkeeper cannot explain to an
 * auditor, and a renumbered one is worse.
 *
 * **The reversal is built from the entry that was posted**, read back from the
 * journal rather than recomputed. Costs move: a sale cancelled a week later,
 * re-costed at today's average, would leave `COGS` and `INVENTORY` holding a
 * difference nobody sold anything to create.
 *
 * Both business dates are period-guarded — the sale's own and today's — because
 * cancelling out of a closed period changes that period as much as posting into
 * it.
 */

export interface CancelSaleCommand {
  readonly ctx: TenantContext;
  readonly saleId: string;
  readonly version: number;
  readonly reason: string | null;
}

export class CancelSaleService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly periods: PeriodGuard,
    private readonly inventory: InventoryRepository,
    private readonly sales: SaleRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async cancel(command: CancelSaleCommand): Promise<SaleResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SALE_VOID);

      const sale = await this.sales.findSaleById(tx, ctx, command.saleId);
      if (sale === null) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');
      if (sale.status === 'VOIDED') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This sale is already cancelled');
      }
      if (sale.receipts.length > 0) {
        // Money received afterwards is its own document against this invoice.
        // Cancelling underneath it would leave a receipt allocated to a sale
        // that no longer owes anything, which no screen could explain.
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Money has been received against this invoice — reverse the receipt first',
        );
      }

      const today = this.clock.businessDate(ctx.timezone);
      await this.periods.assertOpen(tx, ctx, sale.businessDate);
      await this.periods.assertOpen(tx, ctx, today);

      const reversal = sale.journalLines.map((line) => ({
        id: Ulid.generate(this.clock),
        account: line.account as AccountCode,
        amountMinor: -line.amountMinor,
        partyId: line.partyId,
      }));
      if (rejectEntry({ lines: reversal }) !== null) {
        // The original entry balanced when it was written; if its negation does
        // not, the stored rows have been changed behind the application's back.
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This sale cannot be reversed cleanly');
      }

      const byLine = new Map(sale.lines.map((line) => [line.id, line]));
      const positions = new Map<string, { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean; locationId: string }>();
      for (const line of sale.lines) {
        if (positions.has(line.productId)) continue;
        const stored = await this.inventory.findStockPosition(tx, ctx, line.productId);
        positions.set(line.productId, {
          qtyOnHand: stored?.qtyOnHand ?? 0,
          avgUnitCost: stored?.avgUnitCost ?? 0,
          costStateId: stored?.costStateId ?? Ulid.generate(this.clock),
          exists: stored?.costStateId !== null && stored?.costStateId !== undefined,
          locationId: stored?.locationId ?? line.locationId,
        });
      }

      const movements = sale.lines
        // Consignment goods were never the shop's, so cancelling puts nothing
        // back on its shelf — the vendor payable is undone by the entry alone.
        .filter((line) => line.source === 'OWN_STOCK')
        .map((line) => {
          const position = positions.get(line.productId);
          if (position !== undefined) {
            positions.set(line.productId, {
              ...position,
              qtyOnHand: Qty(position.qtyOnHand).add(Qty(line.qty)).raw,
            });
          }
          return {
            id: Ulid.generate(this.clock),
            saleLineId: line.id,
            productId: line.productId,
            locationId: line.locationId,
            qty: line.qty,
            unitCost: position?.avgUnitCost ?? 0,
          };
        });

      const ok = await this.sales.reverseSale(tx, ctx, {
        saleId: sale.id,
        expectedVersion: command.version,
        businessDate: today,
        entryMode: entryModeFor(today, today),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: reversal,
        movements,
        restorations: sale.consumptions
          .filter((consumption) => byLine.get(consumption.saleLineId)?.source === 'OWN_STOCK')
          .map((consumption) => ({ lotId: consumption.lotId, qty: consumption.qty })),
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
          'Someone else changed this invoice — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'sale',
        entityId: sale.id,
        action: 'DELETE',
        before: { number: sale.number, status: 'POSTED', grandTotalMinor: String(sale.grandTotalMinor) },
        after: { number: sale.number, status: 'VOIDED', reason: command.reason ?? '' },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'sale.cancelled',
        aggregateType: 'sale',
        aggregateId: sale.id,
        payload: { number: sale.number, grandTotalMinor: sale.grandTotalMinor },
      });

      const updated = await this.sales.findSaleById(tx, ctx, sale.id);
      if (updated === null) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      return toSaleResponse(updated, showCost, [], today);
    });
  }
}
