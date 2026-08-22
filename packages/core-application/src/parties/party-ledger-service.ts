import { buildPartyLedger, partyBalanceOf } from '@sher/core-domain';
import type { PartyRole } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { PartyLedgerResponse } from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PartyLedgerFilter, PartyRepository } from './party-repository';

/**
 * A party's ledger — the statement behind the balance on the list (§2.4,
 * INV-06, INV-10).
 *
 * **READ ONLY.** Nothing here writes, and that is the point: a ledger is a
 * projection of journal lines, not a stored document. Every figure on the
 * screen is recomputed from the lines each time it is asked for, so there is no
 * cached total that can fall out of step with the postings under it.
 *
 * The closing balance this returns is the same number `ManagePartiesService`
 * puts on the list row, because both are `partyBalanceOf` over the same sum.
 */
export interface PartyLedgerCommand {
  readonly ctx: TenantContext;
  readonly partyId: string;
  readonly fromDate?: string | undefined;
  readonly toDate?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const DEFAULT_LIMIT = 50;

/**
 * Which permission admits a ledger. A party's statement is the party's data, so
 * the trust that shows a customer list is the trust that shows a customer
 * statement — a separate "ledger" permission would be a second answer to the
 * same question and would drift from the list's.
 */
const VIEW_PERMISSIONS: Record<PartyRole, string> = {
  CUSTOMER: Permission.CUSTOMER_VIEW,
  SUPPLIER: Permission.SUPPLIER_VIEW,
  VENDOR: Permission.VENDOR_VIEW,
};

export class PartyLedgerService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly parties: PartyRepository,
  ) {}

  async ledger(command: PartyLedgerCommand): Promise<PartyLedgerResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const party = await this.parties.findById(tx, ctx, command.partyId);
      if (party === null) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That party no longer exists');
      }

      /*
       * A party may hold several roles (D-04), and one statement covers all of
       * them — the money is owed by one person regardless of which hat they
       * were wearing. So any role the caller may view is enough to open it; a
       * caller trusted with none of this party's roles is not.
       */
      const held = await this.accessControl.permissionsOf(tx, ctx);
      const permitted = party.roles.some((role) => held.includes(VIEW_PERMISSIONS[role]));
      if (!permitted) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'You do not have permission to view this party',
        );
      }

      const limit = command.limit ?? DEFAULT_LIMIT;
      const filter: PartyLedgerFilter = {
        partyId: command.partyId,
        fromDate: command.fromDate ?? null,
        toDate: command.toDate ?? null,
        cursor: command.cursor ?? null,
        // One more than asked for, so "is there another page" costs nothing
        // extra (§3.9 keyset paging).
        limit: limit + 1,
      };

      const [lines, openingNetMinor] = await Promise.all([
        this.parties.listLedgerLines(tx, ctx, filter),
        this.parties.sumLedgerBefore(tx, ctx, filter),
      ]);

      const hasMore = lines.length > limit;
      const page = hasMore ? lines.slice(0, limit) : lines;

      const ledger = buildPartyLedger(page, openingNetMinor);

      return {
        partyId: party.id,
        partyName: party.name,
        openingBalance: ledger.openingBalance,
        rows: [...ledger.rows],
        /*
         * The closing balance of the *party*, not of the page. When a date
         * filter or a page boundary leaves later lines out, the running total
         * of what is shown is not what the customer owes — and the header of a
         * statement has to say what they owe, or someone will collect the
         * wrong amount. The rows still carry their own running balances.
         */
        closingBalance: partyBalanceOf(party.balanceNetMinor),
        totalDebitMinor: ledger.totalDebitMinor,
        totalCreditMinor: ledger.totalCreditMinor,
        page: {
          nextCursor: hasMore ? (page[page.length - 1]?.journalLineId ?? null) : null,
          hasMore,
        },
      };
    });
  }
}
