import type { AccountCode } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** Warranty claims (§5.19 M23, Phase 8). */

export interface NewWarrantyClaim {
  readonly id: string;
  readonly claimNumber: string;
  readonly customerPartyId: string | null;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly productId: string;
  readonly inventoryUnitId: string | null;
  readonly serialNo: string | null;
  readonly saleId: string | null;
  readonly invoiceNumber: string | null;
  readonly purchaseId: string | null;
  readonly supplierPartyId: string | null;
  readonly customerWarrantyEnd: string | null;
  readonly supplierWarrantyEnd: string | null;
  readonly complaint: string;
  readonly receivedDate: string;
  readonly handling: string;
  readonly courierName: string | null;
  readonly status: string;
}

export interface WarrantyClaimRow {
  readonly id: string;
  readonly claimNumber: string;
  readonly status: string;
  readonly settlementType: string | null;
  readonly settlementNote: string | null;
  readonly customerPartyId: string | null;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly productId: string;
  readonly displayName: string;
  readonly inventoryUnitId: string | null;
  readonly serialNo: string | null;
  readonly saleId: string | null;
  readonly invoiceNumber: string | null;
  readonly purchaseId: string | null;
  readonly supplierPartyId: string | null;
  readonly supplierName: string | null;
  readonly complaint: string;
  readonly handling: string;
  readonly courierName: string | null;
  readonly receivedDate: string;
  readonly sentToSupplierDate: string | null;
  readonly settledDate: string | null;
  readonly customerWarrantyEnd: string | null;
  readonly supplierWarrantyEnd: string | null;
  readonly replacementUnitId: string | null;
  readonly warrantyCostMinor: number;
  readonly version: number;
}

export interface ClaimMove {
  readonly claimId: string;
  readonly expectedVersion: number;
  readonly status: string;
  readonly settlementType: string | null;
  readonly settlementNote: string | null;
  readonly sentToSupplierDate: string | null;
  readonly settledDate: string | null;
  readonly closedAt: Date | null;
  readonly replacementUnitId: string | null;
  readonly replacementJournalEntryId: string | null;
  readonly recoveryJournalEntryId: string | null;
}

export interface WarrantyRepository {
  insertClaim(tx: Tx, ctx: TenantContext, claim: NewWarrantyClaim): Promise<void>;

  findClaim(tx: Tx, ctx: TenantContext, claimId: string): Promise<WarrantyClaimRow | null>;

  listClaims(
    tx: Tx,
    ctx: TenantContext,
    options: {
      readonly status?: string | undefined;
      readonly search?: string | undefined;
      readonly openOnly?: boolean | undefined;
      readonly limit: number;
    },
  ): Promise<readonly WarrantyClaimRow[]>;

  moveClaim(tx: Tx, ctx: TenantContext, move: ClaimMove): Promise<boolean>;

  /**
   * The entry that credits `WARRANTY_EXPENSE` back when the supplier settles in
   * cash or against their account. Goods coming back go through the ordinary
   * stock path instead, so only this one needs its own writer.
   */
  postRecovery(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly claimId: string;
      readonly claimNumber: string;
      readonly journalEntryId: string;
      readonly businessDate: string;
      readonly entryMode: string;
      readonly lines: readonly {
        readonly id: string;
        readonly account: AccountCode;
        readonly amountMinor: number;
        readonly partyId: string | null;
      }[];
    },
  ): Promise<void>;
}
