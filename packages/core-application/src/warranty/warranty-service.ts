import {
  fixedAccount,
  nextClaimStatuses,
  rejectClaim,
  rejectClaimMove,
  rejectEntry,
  settlementRecoversValue,
  settlementReturnsGoods,
  warrantyCoversOn,
  warrantyEndDate,
} from '@sher/core-domain';
import type { AccountCode, ClaimRejection, ClaimSettlement, ClaimStatus } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type {
  ClaimCandidateResponse,
  MoveWarrantyClaimRequest,
  WarrantyClaimListResponse,
  WarrantyClaimResponse,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { ProductRepository } from '../catalog/product-repository';
import type { ManageInventoryService } from '../inventory/manage-inventory-service';
import type { SerialRepository, SerialUnitRow } from '../inventory/serial-repository';
import type { MoneyRepository } from '../money/money-repository';
import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from '../purchasing/payment-account';
import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { WarrantyClaimRow, WarrantyRepository } from './warranty-repository';

/**
 * A faulty item, from the counter to closed (§5.19 M23, owner decisions
 * 2026-08-26).
 *
 * **Warranty implements no accounting of its own** — §5.19 is binding on that,
 * and this service holds to it literally. A replacement handed to a customer
 * out of the shop's own stock goes through `ManageInventoryService`, the same
 * use case the Stock Adjustment dialog calls, with the value directed at
 * `WARRANTY_EXPENSE` instead of `STOCK_ADJUSTMENT`. Goods coming back from a
 * supplier go in through the same door. Only a cash or account settlement needs
 * an entry of its own, because no stock moves at all.
 *
 * **No warranty receivable is ever created.** A claim waiting on a supplier is
 * a status on this record, never an asset: these claims are frequently never
 * recovered, and a receivable would quietly overstate what the shop is worth.
 * Net warranty cost for a period is therefore readable straight off
 * `WARRANTY_EXPENSE`.
 *
 * **Six statuses, not eleven** (owner simplification 2026-08-26): one `SETTLED`
 * plus the settlement type carries the same information.
 */
const REFUSALS: Record<ClaimRejection, string> = {
  CLAIM_COMPLAINT_BLANK: 'Write what is wrong with it',
  CLAIM_CUSTOMER_UNKNOWN: 'Say who brought it in',
  CLAIM_TRANSITION_NOT_ALLOWED: 'That is not the next step for this claim',
  CLAIM_SETTLEMENT_REQUIRED: 'Say how this claim was settled',
  CLAIM_COURIER_NAME_REQUIRED: 'Write which courier is carrying it',
};

export interface CreateClaimCommand {
  readonly ctx: TenantContext;
  readonly productId: string;
  readonly inventoryUnitId: string | null;
  readonly saleId: string | null;
  readonly customerPartyId: string | null;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly complaint: string;
  readonly handling: 'SHOP' | 'COURIER';
  readonly courierName: string | null;
  readonly receivedDate?: string | undefined;
}

export interface MoveClaimCommand extends MoveWarrantyClaimRequest {
  readonly ctx: TenantContext;
  readonly claimId: string;
  readonly operationId: string;
}

export class WarrantyService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly periods: PeriodGuard,
    private readonly claims: WarrantyRepository,
    private readonly serials: SerialRepository,
    private readonly products: ProductRepository,
    private readonly inventory: ManageInventoryService,
    private readonly money: MoneyRepository,
    private readonly settings: SettingsRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /**
   * What the customer brought in, found from whatever they still have.
   *
   * A serial identifies the unit, the invoice, the customer, the delivery, the
   * supplier and both warranty dates with nothing typed. Phone and invoice
   * number are the fallbacks — for goods that carry no serial, and for the
   * customer who has lost the receipt (owner decision 2026-08-26).
   */
  async lookup(input: {
    readonly ctx: TenantContext;
    readonly serial?: string | undefined;
    readonly phone?: string | undefined;
    readonly invoiceNumber?: string | undefined;
  }): Promise<{ data: readonly ClaimCandidateResponse[] }> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.WARRANTY_CLAIM_VIEW);
      const today = this.clock.businessDate(ctx.timezone);

      if (input.serial !== undefined && input.serial.trim() !== '') {
        const unit = await this.serials.findBySerial(tx, ctx, input.serial.trim());
        return { data: unit === null ? [] : [toCandidate(unit, today)] };
      }

      const units = await this.serials.listByPhoneOrInvoice(tx, ctx, {
        phone: input.phone,
        invoiceNumber: input.invoiceNumber,
      });
      return { data: units.map((unit) => toCandidate(unit, today)) };
    });
  }

  async create(command: CreateClaimCommand): Promise<WarrantyClaimResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.WARRANTY_CLAIM_MANAGE);
      await this.assertWarrantyOn(tx, ctx);

      const rejection = rejectClaim({
        customerName: command.customerName,
        complaint: command.complaint,
        handling: command.handling,
        courierName: command.courierName,
      });
      if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[rejection]);

      const product = await this.products.findById(tx, ctx, command.productId);
      if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'That product was not found');

      const today = this.clock.businessDate(ctx.timezone);
      const receivedDate = command.receivedDate ?? today;

      /*
       * Both windows are worked out once, here, and stored on the claim. A
       * claim is a decision made on a day: recomputing the dates later, after
       * somebody edits the product's warranty months, would silently rewrite
       * whether a customer was covered.
       */
      const unit =
        command.inventoryUnitId === null
          ? null
          : await this.serials.findById(tx, ctx, command.inventoryUnitId);

      const customerEnd =
        unit === null || unit.soldDate === null
          ? null
          : warrantyEndDate(unit.soldDate, unit.customerWarrantyMonths);
      const supplierEnd =
        unit === null ? null : warrantyEndDate(unit.receivedDate, unit.supplierWarrantyMonths);

      const claimId = Ulid.generate(this.clock);
      await this.claims.insertClaim(tx, ctx, {
        id: claimId,
        claimNumber: await this.numbering.allocate(
          tx,
          ctx,
          'WARRANTY_CLAIM',
          Number(receivedDate.slice(0, 4)),
        ),
        customerPartyId: command.customerPartyId ?? unit?.customerPartyId ?? null,
        customerName: command.customerName.trim(),
        customerPhone: command.customerPhone,
        productId: command.productId,
        inventoryUnitId: command.inventoryUnitId,
        serialNo: unit?.serialNo ?? null,
        saleId: command.saleId ?? unit?.saleId ?? null,
        invoiceNumber: unit?.invoiceNumber ?? null,
        purchaseId: unit?.purchaseId ?? null,
        supplierPartyId: unit?.supplierPartyId ?? null,
        customerWarrantyEnd: customerEnd,
        supplierWarrantyEnd: supplierEnd,
        complaint: command.complaint.trim(),
        receivedDate,
        handling: command.handling,
        courierName: command.courierName,
        status: 'RECEIVED',
      });

      await this.audit.append(tx, ctx, {
        entityType: 'warranty_claim',
        entityId: claimId,
        action: 'CREATE',
        before: null,
        after: { productId: command.productId, serial: unit?.serialNo ?? 'none', status: 'RECEIVED' },
        source: 'API',
      });

      return this.detailWithin(tx, ctx, claimId);
    });
  }

  /**
   * One step along the claim, and whatever that step costs.
   *
   * `SETTLED` is where the money is: a replacement out of own stock charges
   * `WARRANTY_EXPENSE`, and a supplier's replacement, repair or cash adjustment
   * credits it back. `REJECTED` posts nothing at all — the expense stands,
   * which is the honest record of a claim the supplier refused.
   */
  async move(command: MoveClaimCommand): Promise<WarrantyClaimResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.WARRANTY_CLAIM_MANAGE);

      const claim = await this.claims.findClaim(tx, ctx, command.claimId);
      if (claim === null) throw new AppError(ErrorCode.NOT_FOUND, 'That claim was not found');

      const to = command.status as ClaimStatus;
      const settlement = (command.settlement ?? claim.settlementType) as ClaimSettlement | null;
      const moveRejection = rejectClaimMove(claim.status as ClaimStatus, to, settlement);
      if (moveRejection !== null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[moveRejection]);
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;

      let replacementJournalEntryId: string | null = null;
      let recoveryJournalEntryId: string | null = null;

      /*
       * A unit handed over from the shop's own stock. It leaves through the
       * ordinary stock path — same costing, same lot consumption, same movement
       * — with the value directed at `WARRANTY_EXPENSE` because this is a cost
       * the shop chose to carry, not a correction to what was on the shelf.
       */
      if (command.replacementUnitId !== null && claim.replacementUnitId === null) {
        const replacement = await this.serials.findById(tx, ctx, command.replacementUnitId);
        if (replacement === null || replacement.status !== 'IN_STOCK') {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'That replacement unit is not on the shelf',
          );
        }

        await this.inventory.adjustStockWithin(tx, {
          ctx,
          operationId: command.operationId,
          productId: replacement.productId,
          qtyDelta: -1000,
          reason: 'OTHER',
          note: `Warranty replacement — claim ${claim.claimNumber}`,
          businessDate,
          source: 'WARRANTY',
          counterAccount: fixedAccount('WARRANTY_EXPENSE'),
        });
        /*
         * The unit is gone from the shelf, but it was not sold: no invoice, no
         * revenue, and §5.19 forbids a warranty receivable, so the whole of it
         * sits in `WARRANTY_EXPENSE`. Marking it `SOLD` would claim a sale that
         * does not exist and would break `inventory_units_sold_has_sale`
         * (migration 0033), which insists a sold unit names the sale that took
         * it and the day it went — `setStatus` writes neither, so the shop
         * handing a customer a replacement got a raw constraint error instead
         * of a settled claim. `WARRANTY_REPLACEMENT` is the honest state, and
         * like `SOLD` it releases the serial number (D-18).
         */
        await this.serials.setStatus(tx, ctx, replacement.id, 'WARRANTY_REPLACEMENT');
        replacementJournalEntryId = command.operationId;
      }

      /*
       * The supplier settling in cash or against their account. Goods coming
       * back are not here — a replacement or a repaired unit is received as
       * stock, through the same door everything else arrives by.
       */
      if (to === 'SETTLED' && settlement === 'ADJUSTED') {
        const amount = command.recoveryMinor ?? 0;
        if (amount <= 0) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say how much the supplier credited');
        }
        await this.periods.assertOpen(tx, ctx, businessDate);

        const account =
          command.recoveryAccountCode === null
            ? null
            : await resolvePaymentAccount(
                { access: this.access, money: this.money },
                tx,
                ctx,
                command.recoveryAccountCode,
                businessDate,
              );

        const lines: {
          readonly id: string;
          readonly account: AccountCode;
          readonly amountMinor: number;
          readonly partyId: string | null;
        }[] = [
          {
            id: Ulid.generate(this.clock),
            account: account === null ? fixedAccount('AP') : account.code,
            amountMinor: amount,
            partyId: account === null ? claim.supplierPartyId : null,
          },
          {
            id: Ulid.generate(this.clock),
            account: fixedAccount('WARRANTY_EXPENSE'),
            amountMinor: -amount,
            partyId: null,
          },
        ];
        if (rejectEntry({ lines }) !== null) {
          throw new AppError(ErrorCode.INTERNAL_ERROR, 'That settlement could not be posted');
        }

        recoveryJournalEntryId = Ulid.generate(this.clock);
        await this.claims.postRecovery(tx, ctx, {
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          journalEntryId: recoveryJournalEntryId,
          businessDate,
          entryMode: entryModeFor(businessDate, today),
          lines,
        });
      }

      // A unit sent away is with the supplier, and back on the shelf when it
      // returns — the serial history has to be able to say where the item is.
      if (claim.inventoryUnitId !== null) {
        if (to === 'SENT_TO_SUPPLIER') {
          await this.serials.setStatus(tx, ctx, claim.inventoryUnitId, 'WITH_SUPPLIER');
        } else if (to === 'RETURNED_TO_CUSTOMER' && settlement !== 'REPLACED') {
          /*
           * Back to whoever had it. Usually that is the customer who bought it,
           * and the row still carries the sale and the date it went — nothing
           * along the claim ever cleared them — so `SOLD` is both true and
           * allowed by `inventory_units_sold_has_sale` (migration 0033).
           *
           * A claim may also be raised on a unit that was never sold: something
           * found faulty on the shelf, looked up by its serial. That one has no
           * sale to name, so writing `SOLD` would break the same constraint
           * that broke the replacement path. It goes back where it came from.
           */
          const unit = await this.serials.findById(tx, ctx, claim.inventoryUnitId);
          const wasSold = unit !== null && unit.saleId !== null && unit.soldDate !== null;
          await this.serials.setStatus(
            tx,
            ctx,
            claim.inventoryUnitId,
            wasSold ? 'SOLD' : 'IN_STOCK',
          );
        }
      }

      const ok = await this.claims.moveClaim(tx, ctx, {
        claimId: claim.id,
        expectedVersion: command.version,
        status: to,
        settlementType: settlement,
        settlementNote: command.note ?? claim.settlementNote,
        sentToSupplierDate: to === 'SENT_TO_SUPPLIER' ? businessDate : claim.sentToSupplierDate,
        settledDate: to === 'SETTLED' ? businessDate : claim.settledDate,
        closedAt: to === 'CLOSED' ? this.clock.now() : null,
        replacementUnitId: command.replacementUnitId ?? claim.replacementUnitId,
        replacementJournalEntryId,
        recoveryJournalEntryId,
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this claim — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'warranty_claim',
        entityId: claim.id,
        action: 'UPDATE',
        before: { status: claim.status, settlement: claim.settlementType ?? 'none' },
        after: { status: to, settlement: settlement ?? 'none' },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'warranty.claim.moved',
        aggregateType: 'warranty_claim',
        aggregateId: claim.id,
        payload: { status: to, settlement },
      });

      return this.detailWithin(tx, ctx, claim.id);
    });
  }

  async detail(input: {
    readonly ctx: TenantContext;
    readonly claimId: string;
  }): Promise<WarrantyClaimResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      await this.access.require(tx, input.ctx, Permission.WARRANTY_CLAIM_VIEW);
      return this.detailWithin(tx, input.ctx, input.claimId);
    });
  }

  async list(input: {
    readonly ctx: TenantContext;
    readonly status?: string | undefined;
    readonly search?: string | undefined;
    readonly openOnly?: boolean | undefined;
    readonly limit: number;
  }): Promise<WarrantyClaimListResponse> {
    return this.uow.run(input.ctx, async (tx) => {
      const { ctx } = input;
      await this.access.require(tx, ctx, Permission.WARRANTY_CLAIM_VIEW);
      const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      const today = this.clock.businessDate(ctx.timezone);

      const rows = await this.claims.listClaims(tx, ctx, {
        status: input.status,
        search: input.search,
        openOnly: input.openOnly,
        limit: input.limit,
      });
      return { data: rows.map((row) => toClaimResponse(row, today, showMoney)) };
    });
  }

  private async detailWithin(
    tx: Tx,
    ctx: TenantContext,
    claimId: string,
  ): Promise<WarrantyClaimResponse> {
    const claim = await this.claims.findClaim(tx, ctx, claimId);
    if (claim === null) throw new AppError(ErrorCode.NOT_FOUND, 'That claim was not found');
    const showMoney = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
    return toClaimResponse(claim, this.clock.businessDate(ctx.timezone), showMoney);
  }

  private async assertWarrantyOn(tx: Tx, ctx: TenantContext): Promise<void> {
    const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
    if (values.get(SettingKey.WARRANTY_ENABLED) !== 'ON') {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Warranty is switched off for this shop — turn it on in Settings',
      );
    }
  }
}

function toCandidate(unit: SerialUnitRow, today: string): ClaimCandidateResponse {
  const customerEnd =
    unit.soldDate === null ? null : warrantyEndDate(unit.soldDate, unit.customerWarrantyMonths);
  const supplierEnd = warrantyEndDate(unit.receivedDate, unit.supplierWarrantyMonths);

  return {
    inventoryUnitId: unit.id,
    serialNo: unit.serialNo,
    productId: unit.productId,
    displayName: unit.displayName,
    saleId: unit.saleId,
    invoiceNumber: unit.invoiceNumber,
    soldDate: unit.soldDate,
    customerPartyId: unit.customerPartyId,
    customerName: unit.customerName,
    customerPhone: null,
    purchaseId: unit.purchaseId,
    supplierPartyId: unit.supplierPartyId,
    supplierName: unit.supplierName,
    customerWarrantyEnd: customerEnd,
    supplierWarrantyEnd: supplierEnd,
    customerWarrantyLive: warrantyCoversOn(customerEnd, today),
    supplierWarrantyLive: warrantyCoversOn(supplierEnd, today),
  };
}

function toClaimResponse(
  claim: WarrantyClaimRow,
  today: string,
  showMoney: boolean,
): WarrantyClaimResponse {
  return {
    id: claim.id,
    claimNumber: claim.claimNumber,
    status: claim.status as WarrantyClaimResponse['status'],
    settlement: claim.settlementType as WarrantyClaimResponse['settlement'],
    settlementNote: claim.settlementNote,
    customerPartyId: claim.customerPartyId,
    customerName: claim.customerName,
    customerPhone: claim.customerPhone,
    productId: claim.productId,
    displayName: claim.displayName,
    serialNo: claim.serialNo,
    invoiceNumber: claim.invoiceNumber,
    supplierPartyId: claim.supplierPartyId,
    supplierName: claim.supplierName,
    complaint: claim.complaint,
    handling: claim.handling as WarrantyClaimResponse['handling'],
    courierName: claim.courierName,
    receivedDate: claim.receivedDate,
    sentToSupplierDate: claim.sentToSupplierDate,
    settledDate: claim.settledDate,
    customerWarrantyEnd: claim.customerWarrantyEnd,
    supplierWarrantyEnd: claim.supplierWarrantyEnd,
    customerWarrantyLive: warrantyCoversOn(claim.customerWarrantyEnd, today),
    supplierWarrantyLive: warrantyCoversOn(claim.supplierWarrantyEnd, today),
    ...(showMoney ? { warrantyCostMinor: claim.warrantyCostMinor } : {}),
    nextStatuses: [...nextClaimStatuses(claim.status as ClaimStatus)],
    version: claim.version,
  };
}

export { settlementRecoversValue, settlementReturnsGoods };
