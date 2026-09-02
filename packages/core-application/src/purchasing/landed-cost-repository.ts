import type { AccountCode } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Reading a posted bill closely enough to raise what its goods cost, and
 * writing the result (§5.12, Phase 8).
 *
 * The lot figures matter more here than anywhere else: how much of each lot is
 * left is what decides whether a share of a late cost can be capitalised at
 * all, and `actual_unit_cost` is the number INV-05 checks the `INVENTORY`
 * account against.
 */

export interface LandedCostTargetRow {
  readonly purchaseLineId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly lineTotalMinor: number;
  readonly extraCostShareMinor: number;
  readonly lotId: string;
  readonly lotQtyReceived: number;
  readonly lotQtyRemaining: number;
  readonly lotLandedCostTotal: number;
  readonly lotActualUnitCost: number;
}

export interface LandedCostPurchaseRow {
  readonly id: string;
  readonly number: string;
  readonly supplierPartyId: string;
  readonly businessDate: string;
  readonly status: string;
  readonly extraCostMinor: number;
  readonly lineCount: number;
  readonly lines: readonly LandedCostTargetRow[];
}

export interface CostStateRow {
  readonly id: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qtyOnHand: number;
  readonly avgUnitCost: number;
}

export interface LotCostUpdate {
  readonly lotId: string;
  readonly landedCostTotal: number;
  readonly actualUnitCost: number;
}

export interface PurchaseLineShareUpdate {
  readonly purchaseLineId: string;
  readonly extraCostShareMinor: number;
}

export interface CostStateUpdate {
  readonly id: string;
  readonly avgUnitCost: number;
}

export interface NewLandedCost {
  readonly id: string;
  readonly purchaseId: string;
  readonly lineNo: number;
  readonly category: string;
  readonly method: string;
  readonly amountMinor: number;
  readonly inventoryShareMinor: number;
  readonly cogsShareMinor: number;
  readonly businessDate: string;
  readonly operationId: string | null;
  readonly journalEntryId: string | null;
  readonly description: string | null;
  readonly paidAccountCode: string | null;
  readonly sessionId: string | null;
  readonly allocations: readonly {
    readonly id: string;
    readonly purchaseLineId: string;
    readonly amountMinor: number;
  }[];
}

export interface LandedCostRepository {
  findPurchaseForLandedCost(
    tx: Tx,
    ctx: TenantContext,
    purchaseId: string,
  ): Promise<LandedCostPurchaseRow | null>;

  listLandedCosts(tx: Tx, ctx: TenantContext, purchaseId: string): Promise<readonly NewLandedCost[]>;

  findCostStates(
    tx: Tx,
    ctx: TenantContext,
    keys: readonly { readonly productId: string; readonly locationId: string }[],
  ): Promise<readonly CostStateRow[]>;

  /**
   * One transaction: the cost row, the raised lots, the raised average cache,
   * the line shares and the journal entry. Splitting any of it out would let a
   * shop hold stock valued at a cost no entry ever paid for.
   */
  recordLandedCost(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly cost: NewLandedCost;
      readonly purchaseNumber: string;
      readonly entryMode: string;
      readonly lots: readonly LotCostUpdate[];
      readonly lineShares: readonly PurchaseLineShareUpdate[];
      readonly costStates: readonly CostStateUpdate[];
      readonly journalLines: readonly {
        readonly id: string;
        readonly account: AccountCode;
        readonly amountMinor: number;
        readonly partyId: string | null;
      }[];
    },
  ): Promise<void>;
}
