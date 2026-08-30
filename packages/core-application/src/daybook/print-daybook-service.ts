import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { DaybookPrint, DaybookPrintRequest, DaybookResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { DaybookPrintRow, DaybookRepository } from './daybook-repository';
import type { GetDaybookService } from './get-daybook-service';

/**
 * The day-end report, and the record that it was printed (§5.27).
 *
 * Every print writes a `daybook_prints` row **with the totals it showed**, and
 * a reprint points at the print it copies. That is what lets a shopkeeper hold
 * two sheets of paper and prove which came first and whether they say the same
 * thing — without it, a printed day-end report can be quietly invalidated by a
 * later backdated entry and nobody can tell.
 *
 * The layout itself is the browser's: this service returns the figures and the
 * record, the print renderer draws A4 or the 80mm roll from the same data the
 * screen showed, exactly as the invoice does (§5.8's one renderer).
 */
export class PrintDaybookService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly daybook: DaybookRepository,
    private readonly reader: GetDaybookService,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async execute(
    ctx: TenantContext,
    input: DaybookPrintRequest,
  ): Promise<{ print: DaybookPrint; daybook: DaybookResponse }> {
    // The figures are read through the ordinary daybook path, so a printed
    // report and the screen it was printed from cannot disagree.
    const daybook = await this.reader.execute(ctx, {
      from: input.from,
      to: input.to,
      dateBasis: 'BUSINESS_DATE',
      limit: 500,
    });

    const print = await this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.DAYBOOK_PRINT);

      let reprintOf: DaybookPrintRow | null = null;
      if (input.reprintOfId !== undefined) {
        reprintOf = await this.daybook.findPrint(tx, ctx, input.reprintOfId);
        if (reprintOf === null) throw new AppError(ErrorCode.NOT_FOUND, 'That print was not found');
      }

      const days = daybook.days;
      const totals = {
        salesMinor: sum(days, (day) => day.salesMinor),
        purchasesMinor: sum(days, (day) => day.purchasesMinor),
        receiptsMinor: sum(days, (day) => day.receiptsMinor),
        paymentsMinor: sum(days, (day) => day.paymentsMinor),
        expensesMinor: sum(days, (day) => day.expensesMinor),
        returnsMinor: sum(days, (day) => day.returnsMinor),
      };

      const saved = await this.daybook.insertPrint(tx, ctx, {
        id: Ulid.generate(this.clock),
        from: input.from,
        to: input.to,
        format: input.format,
        // The oldest day's opening and the newest day's close: what the shop
        // started the range with and ended it holding.
        openingCashMinor: days[days.length - 1]?.openingCashMinor ?? 0,
        closingCashMinor: days[0]?.countedMinor ?? days[0]?.expectedClosingMinor ?? 0,
        transactionCount: sum(days, (day) => day.transactionCount),
        totals,
        reprintOfId: reprintOf?.id ?? null,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'daybook_print',
        entityId: saved.id,
        action: 'CREATE',
        before: null,
        after: {
          from: input.from,
          to: input.to,
          format: input.format,
          reprintOf: reprintOf?.id ?? '',
        },
        source: 'API',
      });

      return toResponse(saved);
    });

    return { print, daybook };
  }

  async history(ctx: TenantContext, limit: number): Promise<readonly DaybookPrint[]> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.DAYBOOK_PRINT);
      return (await this.daybook.listPrints(tx, ctx, limit)).map(toResponse);
    });
  }
}

function toResponse(row: DaybookPrintRow): DaybookPrint {
  return {
    id: row.id,
    from: row.from,
    to: row.to,
    format: row.format,
    printSerial: row.printSerial,
    printedAt: row.printedAt.toISOString(),
    printedByName: row.printedByName,
    openingCashMinor: row.openingCashMinor,
    closingCashMinor: row.closingCashMinor,
    transactionCount: row.transactionCount,
    salesMinor: row.totals.salesMinor ?? 0,
    purchasesMinor: row.totals.purchasesMinor ?? 0,
    receiptsMinor: row.totals.receiptsMinor ?? 0,
    paymentsMinor: row.totals.paymentsMinor ?? 0,
    expensesMinor: row.totals.expensesMinor ?? 0,
    isReprint: row.reprintOfId !== null,
    reprintOfId: row.reprintOfId,
  };
}

function sum<T>(rows: readonly T[], of: (row: T) => number): number {
  return rows.reduce((total, row) => total + of(row), 0);
}
