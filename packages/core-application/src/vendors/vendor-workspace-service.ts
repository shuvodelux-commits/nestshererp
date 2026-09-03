import { stockValueMinor } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  VendorActivityKind,
  VendorActivityRow,
  VendorWorkspaceSummaryResponse,
} from '@sher/core-contracts';

import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { VendorStockRepository } from './vendor-stock-repository';
import { issueResponseFrom } from './vendor-issue-service';
import type { VendorWorkspaceRepository } from './vendor-workspace-repository';

/**
 * What the vendor's hub reads (Phase 8.3, §5.6 M07, UI-52).
 *
 * **Reads only, and recalculates nothing.** Every figure comes from the module
 * that owns it: the two vendor balances and the receivable are sums of the
 * party's journal lines (INV-06), the consignment position comes from the
 * receipts, the open custody comes from the issues. A hub that kept its own
 * total would be the first thing to disagree with the ledger, which is exactly
 * what §5.6 forbids.
 */
export class VendorWorkspaceService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly workspace: VendorWorkspaceRepository,
    private readonly vendorStock: VendorStockRepository,
    private readonly parties: PartyRepository,
  ) {}

  async summary(input: {
    readonly ctx: TenantContext;
    readonly vendorPartyId: string;
  }): Promise<VendorWorkspaceSummaryResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.VENDOR_VIEW);
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);

      const vendor = await this.parties.findById(tx, ctx, input.vendorPartyId);
      if (vendor === null) throw new AppError(ErrorCode.NOT_FOUND, 'That vendor was not found');
      if (!vendor.roles.includes('VENDOR')) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That party is not a vendor');
      }

      const balances = await this.workspace.accountBalances(tx, ctx, vendor.id);
      const receipts = await this.vendorStock.listReceipts(tx, ctx, {
        vendorPartyId: vendor.id,
        limit: 200,
      });
      const issues = await this.workspace.listIssues(tx, ctx, {
        vendorPartyId: vendor.id,
        openOnly: true,
        limit: 100,
      });

      const open = receipts.filter((receipt) => receipt.lotQtyRemaining > 0);
      const stockQty = open.reduce((sum, receipt) => sum + receipt.lotQtyRemaining, 0);
      /*
       * The shop's exposure, not its debt: these goods are the vendor's, and
       * nothing is owed on them until one sells. It sits beside the payable
       * rather than inside it for exactly that reason.
       */
      const stockValueTotal = open.reduce(
        (sum, receipt) => sum + stockValueMinor(receipt.lotQtyRemaining, receipt.vendorUnitCost),
        0,
      );

      return {
        vendorPartyId: vendor.id,
        vendorName: vendor.name,
        isActive: vendor.status === 'ACTIVE',
        /* Charging goods to a vendor is a credit sale, which needs the role. */
        isAlsoCustomer: vendor.roles.includes('CUSTOMER'),
        payableMinor: balances.payableMinor,
        receivableMinor: balances.receivableMinor,
        advancePaidMinor: balances.advanceMinor,
        vendorOwnedStockQty: stockQty,
        vendorOwnedStockValueMinor: showCost ? stockValueTotal : 0,
        openIssueCount: issues.length,
        openIssues: issues.map((issue) => issueResponseFrom(issue, showCost)),
        openConsignments: open.map((receipt) => ({
          id: receipt.id,
          receiptNumber: receipt.receiptNumber,
          vendorPartyId: receipt.vendorPartyId,
          vendorName: receipt.vendorName,
          productId: receipt.productId,
          displayName: receipt.displayName,
          unitName: receipt.unitName,
          businessDate: receipt.businessDate,
          expiryDate: receipt.expiryDate,
          note: receipt.note,
          receivedQty: receipt.qty,
          soldQty: receipt.qty - receipt.returnedQty - receipt.lotQtyRemaining,
          returnedQty: receipt.returnedQty,
          onHandQty: receipt.lotQtyRemaining,
          ...(showCost ? { vendorUnitCostMinor: receipt.vendorUnitCost } : {}),
          version: receipt.version,
        })),
      };
    });
  }

  /**
   * One history list across six kinds of document (UI-52: every row source-links
   * to the authoritative document, and none of them is re-derived here).
   */
  async activity(input: {
    readonly ctx: TenantContext;
    readonly vendorPartyId: string;
    readonly kinds: readonly VendorActivityKind[];
    readonly limit: number;
  }): Promise<{ readonly data: readonly VendorActivityRow[] }> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.VENDOR_VIEW);
      const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);

      const rows = await this.workspace.listActivity(tx, ctx, {
        vendorPartyId: input.vendorPartyId,
        kinds: input.kinds,
        limit: input.limit,
      });

      return {
        data: rows.map((row) => ({
          ...row,
          /* Same rule as everywhere else: a caller without cost sight sees no
           * money at all rather than a zero that reads as free (UI-40). */
          amountMinor: showMoney ? row.amountMinor : null,
        })),
      };
    });
  }
}
