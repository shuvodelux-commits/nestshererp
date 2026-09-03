import {
  costIssue,
  rejectSale,
  salePosting,
  saleTotals,
  stockValueMinor,
  unitCostFromMoneyMinor,
} from '@sher/core-domain';
import type { CostLayer, SaleRejection } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type { SaleResponse } from '@sher/core-contracts';
import { Money, QTY_SCALE, Qty, Ulid, formatForDisplay } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { ProductRepository } from '../catalog/product-repository';
import type { InventoryRepository } from '../inventory/inventory-repository';
import type { SerialRepository } from '../inventory/serial-repository';
import type { MoneyRepository } from '../money/money-repository';
import { entryModeFor } from '../notes/create-note-service';
import type { ManagePartiesService } from '../parties/manage-parties-service';
import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from '../purchasing/payment-account';
import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type {
  VendorReceiptRow,
  VendorStockRepository,
} from '../vendors/vendor-stock-repository';
import type { NewLotConsumption, NewSaleLine, SaleRepository } from './sale-repository';
import { toSaleResponse } from './sale-view';
import type { CancelSaleService } from './cancel-sale-service';

/**
 * Selling at the counter (Phase 6, §5.7, §5.8, §5.11).
 *
 * **WRITE CLASS: T** (R-D). One transaction runs the whole path: permission →
 * idempotency → period guard → customer → costing → the document → lot
 * consumptions, stock movements, the moving-average cache and one journal entry
 * → audit + outbox → commit. Goods that left the shelf without the money being
 * recorded is not half a sale; it is a wrong one.
 *
 * **Everything a shop sells enters here.** A quotation and a sales order seed
 * this screen and post nothing themselves (§5.7, A14) — neither is a second way
 * to take stock out.
 *
 * The POS shows every figure instantly by running `saleTotals` in the browser;
 * this service runs the *same* function on what the client sent and ignores any
 * total the client thought it had. One arithmetic, two places it is displayed.
 */

export interface SaleLineInput {
  readonly productId: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly lineDiscountMinor: number;
  readonly source: 'OWN_STOCK' | 'VENDOR_CONSIGNMENT';
  readonly vendorPartyId: string | null;
  readonly vendorUnitCostMinor: number | null;
  readonly allocations: readonly {
    readonly sourceType: 'OWNED' | 'VENDOR' | 'NEGATIVE';
    readonly qty: number;
    readonly vendorPartyId: string | null;
    readonly serialUnitIds: readonly string[];
  }[];
}

export interface SalePaymentInput {
  readonly accountCode: string;
  readonly amountMinor: number;
}

export interface CreateSaleCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly partyId: string | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerGuardianName: string | null;
  readonly customerAddress: string | null;
  readonly saveAsCustomer: boolean;
  readonly businessDate?: string | undefined;
  readonly dueDate: string | null;
  readonly lines: readonly SaleLineInput[];
  readonly discountMinor: number;
  readonly payments: readonly SalePaymentInput[];
  readonly overpaymentHandling: 'CHANGE' | 'ADVANCE';
  readonly allowNegativeStock: boolean;
  readonly notes: string | null;
  readonly correctionOf?: string | null | undefined;
  readonly correctionVersion?: number | null | undefined;
  /**
   * The number the machine already printed (Phase 12.4, §8).
   *
   * Set **only** by sync replay, for a sale typed while the shop was offline:
   * the customer walked out with that number on paper, so the document must
   * post under it and never under a fresh one. The number is taken out of that
   * device's own counter as it is used, so the server can never hand it to a
   * second sale.
   *
   * Absent for every online sale, which allocates in the ordinary way.
   */
  readonly saleNumber?: string | undefined;
}

/**
 * `S-2026-A-000123` taken apart: the year, the machine, and that machine's own
 * sequence (Phase 12.4, §8).
 *
 * Anything that is not exactly that shape is refused rather than guessed at —
 * a number the server cannot read is a number it cannot promise never to issue
 * again, and the promise is the point.
 */
function parseDeviceNumber(
  value: string,
): { readonly year: number; readonly deviceCode: string; readonly sequence: number } {
  const match = /^[A-Z]+-(\d{4})-([A-Z0]{1,3})-(\d{6,})$/.exec(value);
  if (match === null) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `${value} is not a sale number this shop can accept`,
    );
  }
  return {
    year: Number(match[1]),
    deviceCode: String(match[2]),
    sequence: Number(match[3]),
  };
}

/** Domain refusal → the sentence a shopkeeper reads. The rule stays in the domain. */
const REFUSALS: Record<SaleRejection, string> = {
  SALE_HAS_NO_LINES: 'Add at least one item to this sale',
  AMOUNT_NOT_INTEGER_MINOR: 'Enter valid amounts',
  LINE_QUANTITY_NOT_POSITIVE: 'Every item needs a quantity greater than zero',
  LINE_PRICE_NEGATIVE: 'A selling price cannot be less than zero',
  LINE_DISCOUNT_NEGATIVE: 'A discount cannot be less than zero',
  LINE_DISCOUNT_EXCEEDS_LINE: 'A line discount is larger than the line itself',
  DISCOUNT_NEGATIVE: 'A discount cannot be less than zero',
  PAID_NEGATIVE: 'The amount received cannot be less than zero',
  DISCOUNT_EXCEEDS_ITEMS: 'The discount is larger than the goods on this bill',
  SALE_HAS_NO_VALUE: 'This sale comes to nothing — check the prices',
};

export class CreateSaleService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly parties: PartyRepository,
    private readonly partyService: ManagePartiesService,
    private readonly products: ProductRepository,
    private readonly inventory: InventoryRepository,
    private readonly serials: SerialRepository,
    private readonly vendorStock: VendorStockRepository,
    private readonly money: MoneyRepository,
    private readonly sales: SaleRepository,
    private readonly settings: SettingsRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly cancellations?: CancelSaleService,
  ) {}

  async create(command: CreateSaleCommand): Promise<SaleResponse> {
    const paidMinor = command.payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
    const draft = {
      lines: command.lines.map((line) => ({
        productId: line.productId,
        qty: line.qty,
        unitPriceMinor: line.unitPriceMinor,
        lineDiscountMinor: line.lineDiscountMinor,
      })),
      discountMinor: command.discountMinor,
      paidMinor,
    };
    const rejection = rejectSale(draft);
    if (rejection !== null) throw new AppError(ErrorCode.VALIDATION_FAILED, REFUSALS[rejection]);

    const fingerprint = JSON.stringify([
      command.partyId,
      command.customerPhone,
      command.businessDate ?? null,
      command.dueDate,
      command.lines,
      command.discountMinor,
      command.payments,
      command.overpaymentHandling,
      command.correctionOf ?? null,
      command.correctionVersion ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.SALE_CREATE);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different sale',
          );
        }
        return replay.response as SaleResponse;
      }
      const posted = await this.sales.findSaleIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted, []);

      if (command.correctionOf !== undefined && command.correctionOf !== null) {
        if (this.cancellations === undefined || command.correctionVersion === undefined || command.correctionVersion === null) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'The original invoice version is required for correction');
        }
        await this.cancellations.cancelWithin(tx, {
          ctx,
          saleId: command.correctionOf,
          version: command.correctionVersion,
          reason: 'Corrected at the counter',
        });
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      await this.periods.assertOpen(tx, ctx, businessDate);
      if (businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A sale cannot be dated in the future');
      }
      if (command.dueDate !== null && command.dueDate < businessDate) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'The due date cannot be before the sale date',
        );
      }

      const totals = saleTotals(draft);
      const overpaidMinor = totals.changeMinor;
      const advanceMinor = command.overpaymentHandling === 'ADVANCE' ? overpaidMinor : 0;
      const dueMinor = totals.dueMinor;

      /*
       * §5.8's guest rule, and the whole of the owner's instruction of
       * 2026-08-25: a fully settled sale stays on the shop's walk-in party and
       * creates nobody, because a zero balance has nobody to name. The moment
       * the sale leaves a due — or keeps money as an advance — the balance has
       * to belong to somebody the ledger can point at, so the customer is
       * created **inside this transaction**: either both succeed or neither
       * does. `saveAsCustomer` is the explicit third case, never implied.
       */
      const needsParty = dueMinor > 0 || advanceMinor > 0 || command.saveAsCustomer;
      const customer = await this.resolveCustomer(tx, ctx, command, needsParty, businessDate);

      /*
       * Resolved before anything is written, so a drawer nobody opened stops
       * the sale at the counter rather than after the stock has moved. The
       * refusal carries `CASH_DAY_NOT_STARTED`, which is what lets the POS
       * offer `দিন শুরু করুন` without the cashier losing the cart.
       */
      const resolvedPayments = [];
      for (const payment of command.payments) {
        const account = await resolvePaymentAccount(
          { access: this.access, money: this.money },
          tx,
          ctx,
          payment.accountCode,
          businessDate,
        );
        resolvedPayments.push({ ...payment, account });
      }

      const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
      const method = values.get(SettingKey.SALE_COSTING_METHOD) === 'AVERAGE' ? 'AVERAGE' : 'FIFO';
      const negativePolicy = String(values.get(SettingKey.NEGATIVE_STOCK_POLICY) ?? 'WARN');
      const consignmentOn = values.get(SettingKey.VENDOR_CONSIGNMENT_ENABLED) === 'ON';
      /*
       * §5.13, owner decision 2026-08-26. Under BLOCK an expired batch stops
       * being sellable stock: the picker passes over it, so a customer gets
       * whatever is still good and the rest becomes an ordinary shortage —
       * answered by vendor sourcing or the negative-stock policy, exactly as
       * any other shortage is. Under WARN and ALLOW expired goods *are*
       * sellable, so nothing is skipped and the sale simply says so.
       */
      const expiredPolicy = String(values.get(SettingKey.EXPIRED_STOCK_SALE_POLICY) ?? 'BLOCK');

      const location =
        (await this.inventory.findDefaultLocation(tx, ctx)) ??
        (await this.inventory.createDefaultLocation(tx, ctx, Ulid.generate(this.clock)));

      /*
       * Positions and remaining lot quantities are carried in maps rather than
       * re-read per line: a cart may list the same product twice, and re-reading
       * would cost the second line from lots the first line has already emptied.
       */
      const positions = new Map<
        string,
        { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean }
      >();
      const layersByProduct = new Map<string, CostLayer[]>();
      const vendorLots = new Map<string, Awaited<ReturnType<VendorStockRepository['listSellableLots']>>>();
      const saleLines: NewSaleLine[] = [];
      const vendorPayables = new Map<string, number>();
      const warnings: string[] = [];
      let cogsMinor = 0;

      for (const [index, lineTotals] of totals.lines.entries()) {
        const input = command.lines[index];
        if (input === undefined) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid cart');
        const product = await this.products.findById(tx, ctx, input.productId);
        if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
        if (product.status === 'INACTIVE') {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            `“${product.name}” is no longer sold — remove it from the cart`,
            // §5.26's envelope carries the machine-readable half beside the
            // sentence. Phase 12.4 reads it: a sale refused because the shop
            // stopped selling something is a different Sync Issue, with
            // different things a manager can do about it, than a sale whose
            // figures were typed wrong.
            { reason: 'PRODUCT_INACTIVE', productId: product.id },
          );
        }

        let position = positions.get(product.id);
        if (position === undefined) {
          const stored = await this.inventory.findStockPosition(tx, ctx, product.id);
          position = {
            qtyOnHand: stored?.qtyOnHand ?? 0,
            avgUnitCost: stored?.avgUnitCost ?? 0,
            costStateId: stored?.costStateId ?? Ulid.generate(this.clock),
            exists: stored?.costStateId !== null && stored?.costStateId !== undefined,
          };
        }

        const line = await this.mixedStockLine(
          tx,
          ctx,
          {
            index,
            input,
            lineTotals,
            product,
            position,
            location,
            method,
            layersByProduct,
            vendorLots,
            negativePolicy,
            expiredOn: expiredPolicy === 'BLOCK' ? businessDate : null,
            allowNegativeStock: command.allowNegativeStock,
            warnings,
            consignmentOn,
          },
          vendorPayables,
        );

        positions.set(product.id, {
          qtyOnHand: line.costState.qtyOnHand,
          avgUnitCost: line.costState.avgUnitCost,
          costStateId: line.costState.id,
          // From here on the row exists: either it already did, or this line is
          // about to create it. A later line for the same product must update
          // what this one wrote, not insert it a second time.
          exists: true,
        });
        cogsMinor += line.costMinor;
        saleLines.push(line);

        if (line.costMinor > lineTotals.netAmountMinor) {
          warnings.push(
            `“${product.name}” sold for ${Money(lineTotals.netAmountMinor).format()} but cost ${Money(line.costMinor).format()}`,
          );
        }
      }

      /*
       * What the shop actually took, after change was handed back.
       *
       * Change never entered the drawer, so it must not reach the ledger: a
       * customer handing over 300 for a 240 bill and taking 60 back leaves 240
       * in the till, and `DR CASH 300` would put the drawer permanently 60
       * ahead of the money in it.
       *
       * Computed once and used for both the posting and the sale's own payment
       * rows (owner request 2026-09-03). They were derived separately before,
       * and drifted: the document netted the change and the journal did not, so
       * a legal `overpaymentHandling: 'CHANGE'` request reached
       * `salePosting` with more paid than the bill and died on its
       * "Money taken beyond the bill must be held as an advance" guard — a
       * 500 on a request the contract allows. An advance is never netted; it is
       * money the shop genuinely kept and `CR CUSTOMER_ADVANCE` is where it
       * goes.
       *
       * Taken off the last rows first, and carried back through them until it
       * is used up. The change comes out of the note handed over last, which is
       * the final row — but it is not always big enough to cover it: paying a
       * 240 bill with 300 in cash and 10 by card leaves 70 of change and only
       * 10 on the card row, and stopping at that row would leave 60 of the
       * customer's change posted as money the shop kept.
       */
      const changeGivenMinor = overpaidMinor - advanceMinor;
      let changeLeftMinor = changeGivenMinor;
      const settledPayments = resolvedPayments
        .slice()
        .reverse()
        .map((payment) => {
          const taken = Math.min(changeLeftMinor, payment.amountMinor);
          changeLeftMinor -= taken;
          return { ...payment, amountMinor: payment.amountMinor - taken };
        })
        .reverse()
        .filter((payment) => payment.amountMinor > 0);

      const posting = salePosting(totals, {
        partyId: customer.partyId,
        payments: settledPayments.map((payment) => ({
          account: payment.account.code,
          amountMinor: payment.amountMinor,
        })),
        cogsMinor,
        advanceMinor,
        vendorPayables: [...vendorPayables].map(([vendorPartyId, amountMinor]) => ({
          vendorPartyId,
          amountMinor,
        })),
      });

      const saleId = Ulid.generate(this.clock);
      const year = Number(businessDate.slice(0, 4));
      /*
       * A sale made offline arrives carrying the number the counter printed.
       * Reserving it moves that device's counter past it rather than issuing a
       * new one, which is the whole of "synchronization never renumbers a sale".
       */
      const printed = command.saleNumber === undefined ? null : parseDeviceNumber(command.saleNumber);
      let number: string;
      if (printed === null) {
        number = await this.numbering.allocate(tx, ctx, 'SALE', year);
      } else {
        await this.numbering.reserve(tx, ctx, 'SALE', printed.year, printed.deviceCode, printed.sequence);
        number = command.saleNumber as string;
      }

      await this.sales.insertSale(tx, ctx, {
        id: saleId,
        number,
        operationId: command.operationId,
        partyId: customer.partyId,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerGuardianName: command.customerGuardianName,
        customerAddress: command.customerAddress,
        locationId: location.id,
        dueDate: command.dueDate,
        itemsTotalMinor: totals.itemsTotalMinor,
        discountMinor: totals.discountMinor,
        grandTotalMinor: totals.grandTotalMinor,
        cogsMinor,
        // What the shop actually kept: change handed back never belonged to it.
        paidMinor: paidMinor - changeGivenMinor,
        sessionId: resolvedPayments.find((payment) => payment.account.sessionId !== null)?.account
          .sessionId ?? null,
        notes: command.notes,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
        lines: saleLines,
        // The same netted list the journal was posted from, so the document and
        // the ledger can never again disagree about what the drawer took.
        payments: settledPayments.map((payment, index) => ({
          id: Ulid.generate(this.clock),
          lineNo: index + 1,
          accountCode: payment.account.code,
          amountMinor: payment.amountMinor,
          sessionId: payment.account.sessionId,
        })),
      });

      for (const line of saleLines) {
        if (line.serialUnitIds.length === 0) continue;
        const serialsSold = await this.serials.markSold(tx, ctx, {
          unitIds: line.serialUnitIds,
          saleId,
          saleLineId: line.id,
          customerPartyId: customer.partyId,
          soldDate: businessDate,
          customerWarrantyMonths:
            (await this.products.findById(tx, ctx, line.productId))?.warrantyMonths ?? null,
        });
        if (serialsSold !== line.serialUnitIds.length) {
          throw new AppError(
            ErrorCode.CONFLICT_STALE_VERSION,
            'One of the selected serial units was sold by another checkout — review the allocation',
          );
        }
      }

      await this.audit.append(tx, ctx, {
        entityType: 'sale',
        entityId: saleId,
        action: 'CREATE',
        before: null,
        after: {
          number,
          partyId: customer.partyId,
          grandTotalMinor: String(totals.grandTotalMinor),
          paidMinor: String(paidMinor),
          dueMinor: String(dueMinor),
          cogsMinor: String(cogsMinor),
          businessDate,
          lineCount: String(saleLines.length),
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'sale.posted',
        aggregateType: 'sale',
        aggregateId: saleId,
        payload: { partyId: customer.partyId, grandTotalMinor: totals.grandTotalMinor },
      });

      const response = await this.detail(tx, ctx, saleId, warnings);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  /**
   * Who this invoice belongs to (§5.8).
   *
   * A named customer is used as given. Otherwise the sale posts on the walk-in
   * party — unless it must carry a balance, in which case the customer is
   * created here, through `ManagePartiesService.createWithin`, so an invoice's
   * customer obeys exactly the validation, permissions, audit and D-02 phone
   * uniqueness a typed-in one does. There is one party writer (A11, A14).
   */
  private async resolveCustomer(
    tx: Tx,
    ctx: TenantContext,
    command: CreateSaleCommand,
    needsParty: boolean,
    businessDate: string,
  ): Promise<{ partyId: string; name: string; phone: string | null }> {
    const typedName = command.customerName?.trim() ?? '';
    const typedPhone = command.customerPhone?.trim() ?? '';

    if (command.partyId !== null) {
      const party = await this.parties.findById(tx, ctx, command.partyId);
      if (party === null) throw new AppError(ErrorCode.NOT_FOUND, 'Customer not found');
      if (!party.roles.includes('CUSTOMER') && !party.roles.includes('VENDOR')) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `“${party.name}” is neither a customer nor a vendor`,
        );
      }
      if (party.status === 'INACTIVE') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `“${party.name}” is no longer in use — reactivate them first`,
        );
      }
      if (party.roles.includes('VENDOR') && command.payments.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A vendor credit sale must post in full first — record their payment as a separate receipt afterward',
          { reason: 'VENDOR_PAYMENT_MUST_BE_SEPARATE' },
        );
      }
      return {
        partyId: party.id,
        name: typedName === '' ? party.name : typedName,
        phone: typedPhone === '' ? party.phone : typedPhone,
      };
    }

    if (!needsParty) {
      const walkIn = await this.parties.findWalkInCustomer(tx, ctx);
      if (walkIn === null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This shop has no walk-in customer');
      }
      return {
        partyId: walkIn.id,
        name: typedName === '' ? walkIn.name : typedName,
        phone: typedPhone === '' ? null : typedPhone,
      };
    }

    if (typedName === '' || typedPhone === '') {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'A sale that leaves money owing needs the customer’s name and phone',
        { reason: 'CUSTOMER_REQUIRED' },
      );
    }

    /*
     * A phone that already belongs to a customer is that customer, not a
     * duplicate: D-02 makes the number unique among customers, and a counter
     * that refused the sale here would be refusing a returning customer.
     */
    const existingId = await this.parties.findCustomerIdByPhone(tx, ctx, typedPhone);
    if (existingId !== null) {
      const existing = await this.parties.findById(tx, ctx, existingId);
      if (existing !== null && existing.status === 'ACTIVE') {
        return { partyId: existing.id, name: existing.name, phone: existing.phone };
      }
    }

    const created = await this.partyService.createWithin(
      tx,
      ctx,
      {
        name: typedName,
        roles: ['CUSTOMER'],
        phone: typedPhone,
        address: command.customerAddress,
        guardianName: command.customerGuardianName,
        nid: null,
        email: null,
        notes: null,
        customerGroupId: null,
        creditLimitMinor: null,
        opening: null,
      },
      'POS',
    );
    void businessDate;
    return { partyId: created.id, name: created.name, phone: created.phone };
  }

  /**
   * Resolve one requested cart quantity into immutable inventory origins.
   *
   * Non-serial goods always take every sellable owned unit first. Serial goods
   * are different: the selected physical units are the quantity, so no source
   * is invented merely because a stock-position number says it exists.
   */
  private async mixedStockLine(
    tx: Tx,
    ctx: TenantContext,
    args: {
      index: number;
      input: SaleLineInput;
      lineTotals: { qty: number; unitPriceMinor: number; lineDiscountMinor: number; lineTotalMinor: number; discountShareMinor: number; netAmountMinor: number };
      product: {
        id: string;
        name: string;
        tracksExpiry: boolean;
        tracksSerial: boolean;
        purchasePriceMinor: number;
      };
      position: { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean };
      location: { id: string };
      method: 'FIFO' | 'AVERAGE';
      layersByProduct: Map<string, CostLayer[]>;
      vendorLots: Map<
        string,
        Awaited<ReturnType<VendorStockRepository['listSellableLots']>>
      >;
      negativePolicy: string;
      /** The date expired batches stop counting, or null when they still do. */
      expiredOn: string | null;
      allowNegativeStock: boolean;
      warnings: string[];
      consignmentOn: boolean;
    },
    vendorPayables: Map<string, number>,
  ): Promise<NewSaleLine> {
    const { input, lineTotals, product, position, location } = args;

    let layers = args.layersByProduct.get(product.id);
    if (layers === undefined) {
      layers = [
        ...(await this.inventory.listCostLayers(tx, ctx, product.id, location.id)),
      ] as CostLayer[];
      args.layersByProduct.set(product.id, layers);
    }
    const available: CostLayer[] = layers;
    const sellableOwnedQty = available
      .filter(
        (layer) =>
          layer.qtyRemaining > 0 &&
          (args.expiredOn === null ||
            layer.expiryDate === null ||
            layer.expiryDate >= args.expiredOn),
      )
      .reduce((sum, layer) => sum + layer.qtyRemaining, 0);

    /*
     * The provisional cost of stock that is not there (D-19) is the product's
     * own purchase price when the shop has no average yet — the only figure
     * that exists before anything has been bought.
     */
    const provisional =
      position.avgUnitCost > 0
        ? position.avgUnitCost
        : unitCostFromMoneyMinor(product.purchasePriceMinor);
    /*
     * FEFO only when the lots can actually support it.
     *
     * `costIssue` orders an expiry-tracked issue by expiry date and refuses a
     * lot without one — correctly, because "earliest expiry first" is
     * meaningless when some batches have no date. But a purchase line's expiry
     * is **optional even for a tracked product** (owner decision 2026-08-24,
     * recorded with Phase 5 as the thing to revisit when FEFO ships), so a shop
     * can hold a mix. Refusing the sale would punish the counter for how the
     * bill was typed weeks ago.
     *
     * So: date every open lot and the goods go out earliest-expiry-first; leave
     * one undated and this product falls back to FIFO for that sale. Nothing is
     * guessed and no sale is blocked. Making expiry mandatory on a tracked
     * product is the real fix and belongs on the purchase screen, not here.
     */
    type AllocationInput = SaleLineInput['allocations'][number];
    let requestedAllocations: readonly AllocationInput[] = input.allocations;
    if (requestedAllocations.length === 0) {
      if (product.tracksSerial) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Select exactly ${formatForDisplay(input.qty, QTY_SCALE)} serial units for “${product.name}”`,
        );
      }
      const ownedQty = Math.min(input.qty, sellableOwnedQty);
      const shortageQty = Qty(input.qty).subtract(Qty(ownedQty)).raw;
      requestedAllocations = [
        ...(ownedQty > 0
          ? [{ sourceType: 'OWNED' as const, qty: ownedQty, vendorPartyId: null, serialUnitIds: [] }]
          : []),
        ...(shortageQty > 0 && input.source === 'VENDOR_CONSIGNMENT'
          ? [{
              sourceType: 'VENDOR' as const,
              qty: shortageQty,
              vendorPartyId: input.vendorPartyId,
              serialUnitIds: [],
            }]
          : shortageQty > 0
            ? [{ sourceType: 'NEGATIVE' as const, qty: shortageQty, vendorPartyId: null, serialUnitIds: [] }]
            : []),
      ];
    }

    for (const allocation of requestedAllocations) {
      if (!Number.isSafeInteger(allocation.qty) || allocation.qty <= 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Every stock allocation needs a quantity greater than zero');
      }
    }
    const allocatedQty = requestedAllocations.reduce((sum, allocation) => sum + allocation.qty, 0);
    if (allocatedQty !== input.qty) {
      throw new AppError(
        ErrorCode.INSUFFICIENT_STOCK,
        `Allocate all ${formatForDisplay(input.qty, QTY_SCALE)} units of “${product.name}” before checkout`,
        {
          reason: 'STOCK_ALLOCATION_INCOMPLETE',
          requestedQty: String(input.qty),
          allocatedQty: String(allocatedQty),
          remainingQty: String(input.qty - allocatedQty),
        },
      );
    }

    const vendorIds = new Set(
      requestedAllocations
        .filter((allocation) => allocation.sourceType === 'VENDOR')
        .map((allocation) => allocation.vendorPartyId)
        .filter((id): id is string => id !== null),
    );
    if (vendorIds.size > 1) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'One vendor may supply one cart line');
    }

    const ownedRequested = requestedAllocations
      .filter((allocation) => allocation.sourceType === 'OWNED')
      .reduce((sum, allocation) => sum + allocation.qty, 0);
    const vendorRequested = requestedAllocations
      .filter((allocation) => allocation.sourceType === 'VENDOR')
      .reduce((sum, allocation) => sum + allocation.qty, 0);
    const negativeRequested = requestedAllocations
      .filter((allocation) => allocation.sourceType === 'NEGATIVE')
      .reduce((sum, allocation) => sum + allocation.qty, 0);

    if (!product.tracksSerial && ownedRequested !== Math.min(input.qty, sellableOwnedQty)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Available own stock for “${product.name}” must be used first`,
        { reason: 'OWN_STOCK_FIRST', ownedQty: String(Math.min(input.qty, sellableOwnedQty)) },
      );
    }
    if (negativeRequested > 0) {
      if (product.tracksSerial) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Negative stock is not available for serial-tracked products');
      }
      if (args.negativePolicy === 'BLOCK') {
        throw new AppError(ErrorCode.INSUFFICIENT_STOCK, 'Negative stock is switched off for this shop', {
          reason: 'NEGATIVE_STOCK_BLOCKED',
          productId: product.id,
          shortageQty: String(negativeRequested),
        });
      }
      if (args.negativePolicy === 'WARN' && !args.allowNegativeStock) {
        throw new AppError(
          ErrorCode.INSUFFICIENT_STOCK,
          `Confirm the ${formatForDisplay(negativeRequested, QTY_SCALE)} negative-stock units for “${product.name}”`,
          { reason: 'NEGATIVE_STOCK_CONFIRM', productId: product.id, shortageQty: String(negativeRequested) },
        );
      }
      args.warnings.push(
        `“${product.name}” includes ${formatForDisplay(negativeRequested, QTY_SCALE)} negative-stock units — their cost is provisional`,
      );
    }
    if (vendorRequested > 0 && !args.consignmentOn) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'Vendor consignment stock is switched off for this shop');
    }

    const sourceAllocations: NewSaleLine['sourceAllocations'][number][] = [];
    const consumptions: NewLotConsumption[] = [];
    const serialIds: string[] = [];
    let ownCostMinor = 0;
    let vendorCostMinor = 0;
    let ownProvisional = false;

    if (product.tracksSerial) {
      const allSelected = requestedAllocations.flatMap((allocation) => allocation.serialUnitIds);
      const expectedCount = input.qty / QTY_SCALE;
      if (!Number.isSafeInteger(expectedCount) || allSelected.length !== expectedCount) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Select exactly ${formatForDisplay(input.qty, QTY_SCALE)} serial units for “${product.name}”`,
        );
      }
      if (new Set(allSelected).size !== allSelected.length) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The same serial unit cannot be selected twice');
      }
      for (const allocation of requestedAllocations) {
        if (allocation.qty !== allocation.serialUnitIds.length * QTY_SCALE) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'A serial allocation quantity must equal its exact selected serial units',
          );
        }
      }
      const selected = await this.serials.findAvailableByIds(tx, ctx, product.id, allSelected);
      if (selected.length !== allSelected.length) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'One or more selected serial units are no longer available');
      }
      const byId = new Map(selected.map((unit) => [unit.id, unit] as const));

      for (const allocation of requestedAllocations) {
        for (const unitId of allocation.serialUnitIds) {
          const unit = byId.get(unitId);
          if (unit === undefined) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Selected serial unit was not found');
          if (
            args.expiredOn !== null &&
            unit.expiryDate !== null &&
            unit.expiryDate < args.expiredOn
          ) {
            throw new AppError(
              ErrorCode.VALIDATION_FAILED,
              `Serial ${unit.serialNo} belongs to expired stock and cannot be sold`,
            );
          }
          serialIds.push(unit.id);
          if (allocation.sourceType === 'OWNED') {
            if (unit.vendorPartyId !== null || unit.lotId === null) {
              throw new AppError(ErrorCode.VALIDATION_FAILED, `Serial ${unit.serialNo} is not owned shop stock`);
            }
            const layerAt = available.findIndex((candidate) => candidate.id === unit.lotId);
            const layer = layerAt < 0 ? undefined : available[layerAt];
            if (layer === undefined || layer.qtyRemaining < QTY_SCALE) {
              throw new AppError(ErrorCode.INSUFFICIENT_STOCK, `Serial ${unit.serialNo} has no sellable owned lot stock`);
            }
            const unitCost = args.method === 'AVERAGE' ? position.avgUnitCost : layer.unitCost;
            const after = Qty(layer.qtyRemaining).subtract(Qty(QTY_SCALE)).raw;
            available[layerAt] = { ...layer, qtyRemaining: after };
            ownCostMinor += stockValueMinor(QTY_SCALE, unitCost);
            consumptions.push({
              id: Ulid.generate(this.clock),
              lotId: layer.id,
              qty: QTY_SCALE,
              unitCostUsed: unitCost,
              closesLot: after === 0,
            });
            sourceAllocations.push({
              id: Ulid.generate(this.clock),
              sourceType: 'OWNED',
              qty: QTY_SCALE,
              ownedLotId: layer.id,
              vendorPartyId: null,
              vendorStockReceiptId: null,
              vendorLotId: null,
              inventoryUnitId: unit.id,
              unitCostUsed: unitCost,
            });
          } else if (allocation.sourceType === 'VENDOR') {
            if (
              allocation.vendorPartyId === null ||
              unit.vendorPartyId !== allocation.vendorPartyId ||
              unit.vendorStockReceiptId === null ||
              unit.vendorLotId === null
            ) {
              throw new AppError(ErrorCode.VALIDATION_FAILED, `Serial ${unit.serialNo} does not belong to the selected vendor stock`);
            }
            const key = `${allocation.vendorPartyId}:${product.id}`;
            let vendorLayers = args.vendorLots.get(key);
            if (vendorLayers === undefined) {
              vendorLayers = [...(await this.vendorStock.listSellableLots(tx, ctx, allocation.vendorPartyId, product.id))];
              args.vendorLots.set(key, vendorLayers);
            }
            const at = vendorLayers.findIndex((candidate) => candidate.lotId === unit.vendorLotId);
            const vendorLayer = at < 0 ? undefined : vendorLayers[at];
            if (vendorLayer === undefined || vendorLayer.lotQtyRemaining < QTY_SCALE) {
              throw new AppError(ErrorCode.INSUFFICIENT_STOCK, `Serial ${unit.serialNo} is no longer available from this vendor`);
            }
            const remaining = Qty(vendorLayer.lotQtyRemaining).subtract(Qty(QTY_SCALE)).raw;
            vendorLayers = vendorLayers.map((candidate, index) =>
              index === at ? { ...candidate, lotQtyRemaining: remaining } : candidate,
            );
            args.vendorLots.set(key, vendorLayers);
            const value = stockValueMinor(QTY_SCALE, vendorLayer.vendorUnitCost);
            vendorCostMinor += value;
            sourceAllocations.push({
              id: Ulid.generate(this.clock),
              sourceType: 'VENDOR',
              qty: QTY_SCALE,
              ownedLotId: null,
              vendorPartyId: allocation.vendorPartyId,
              vendorStockReceiptId: unit.vendorStockReceiptId,
              vendorLotId: unit.vendorLotId,
              inventoryUnitId: unit.id,
              unitCostUsed: vendorLayer.vendorUnitCost,
            });
          }
        }
      }
    } else {
      if (ownedRequested > 0) {
        const byExpiry = product.tracksExpiry && available.every((layer) => layer.expiryDate !== null);
        const issue = costIssue(
          args.method,
          available,
          ownedRequested,
          position.avgUnitCost,
          provisional,
          byExpiry,
          args.expiredOn,
        );
        if (issue.shortageQty !== 0) {
          throw new AppError(ErrorCode.INSUFFICIENT_STOCK, `Owned stock for “${product.name}” changed — review the allocation`);
        }
        ownCostMinor += issue.valueMinor;
        for (const allocation of issue.allocations) {
          const at = available.findIndex((candidate) => candidate.id === allocation.lotId);
          const layer = at < 0 ? undefined : available[at];
          if (layer === undefined) throw new AppError(ErrorCode.INTERNAL_ERROR, 'Owned stock lot was not found');
          const after = Qty(layer.qtyRemaining).subtract(Qty(allocation.qty)).raw;
          available[at] = { ...layer, qtyRemaining: after };
          consumptions.push({
            id: Ulid.generate(this.clock),
            lotId: allocation.lotId,
            qty: allocation.qty,
            unitCostUsed: args.method === 'AVERAGE' ? position.avgUnitCost : allocation.unitCost,
            closesLot: after === 0,
          });
          sourceAllocations.push({
            id: Ulid.generate(this.clock),
            sourceType: 'OWNED',
            qty: allocation.qty,
            ownedLotId: allocation.lotId,
            vendorPartyId: null,
            vendorStockReceiptId: null,
            vendorLotId: null,
            inventoryUnitId: null,
            unitCostUsed: args.method === 'AVERAGE' ? position.avgUnitCost : allocation.unitCost,
          });
        }
      }
      if (negativeRequested > 0) {
        const negativeCost = position.avgUnitCost > 0 ? position.avgUnitCost : provisional;
        ownCostMinor += stockValueMinor(negativeRequested, negativeCost);
        ownProvisional = true;
        sourceAllocations.push({
          id: Ulid.generate(this.clock),
          sourceType: 'NEGATIVE',
          qty: negativeRequested,
          ownedLotId: null,
          vendorPartyId: null,
          vendorStockReceiptId: null,
          vendorLotId: null,
          inventoryUnitId: null,
          unitCostUsed: negativeCost,
        });
      }
      if (vendorRequested > 0) {
        const vendorPartyId = [...vendorIds][0];
        if (vendorPartyId === undefined) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, `Select a vendor for “${product.name}”`);
        }
        const key = `${vendorPartyId}:${product.id}`;
        let vendorLayers: readonly VendorReceiptRow[] | undefined = args.vendorLots.get(key);
        if (vendorLayers === undefined) {
          vendorLayers = [...(await this.vendorStock.listSellableLots(tx, ctx, vendorPartyId, product.id))];
        }
        let remaining = vendorRequested;
        for (let at = 0; at < vendorLayers.length && remaining > 0; at += 1) {
          const vendorLayer: VendorReceiptRow | undefined = vendorLayers[at];
          if (vendorLayer === undefined || vendorLayer.lotQtyRemaining <= 0) continue;
          const qty = Math.min(remaining, vendorLayer.lotQtyRemaining);
          const after: number = Qty(vendorLayer.lotQtyRemaining).subtract(Qty(qty)).raw;
          vendorLayers = vendorLayers.map((candidate, index) =>
            index === at ? { ...candidate, lotQtyRemaining: after } : candidate,
          );
          remaining = Qty(remaining).subtract(Qty(qty)).raw;
          vendorCostMinor += stockValueMinor(qty, vendorLayer.vendorUnitCost);
          sourceAllocations.push({
            id: Ulid.generate(this.clock),
            sourceType: 'VENDOR',
            qty,
            ownedLotId: null,
            vendorPartyId,
            vendorStockReceiptId: vendorLayer.id,
            vendorLotId: vendorLayer.lotId,
            inventoryUnitId: null,
            unitCostUsed: vendorLayer.vendorUnitCost,
          });
        }
        args.vendorLots.set(key, vendorLayers);
        if (remaining > 0) {
          throw new AppError(
            ErrorCode.INSUFFICIENT_STOCK,
            `Only ${formatForDisplay(vendorRequested - remaining, QTY_SCALE)} recorded vendor units of “${product.name}” are available`,
            { reason: 'VENDOR_STOCK_INSUFFICIENT', availableQty: String(vendorRequested - remaining) },
          );
        }
      }
    }

    if (vendorCostMinor > 0) {
      const vendorPartyId = [...vendorIds][0];
      if (vendorPartyId === undefined) throw new AppError(ErrorCode.INTERNAL_ERROR, 'Vendor allocation is missing its vendor');
      vendorPayables.set(vendorPartyId, (vendorPayables.get(vendorPartyId) ?? 0) + vendorCostMinor);
    }

    /*
     * The moving average does not change when stock leaves (DR13.5) — only the
     * quantity does. That is what makes AVERAGE stable across a day of selling.
     */
    const ownedPositionIssue = ownedRequested + negativeRequested;
    const qtyOnHand = Qty(position.qtyOnHand).subtract(Qty(ownedPositionIssue)).raw;

    return {
      id: Ulid.generate(this.clock),
      lineNo: args.index + 1,
      productId: product.id,
      locationId: location.id,
      qty: lineTotals.qty,
      unitPriceMinor: lineTotals.unitPriceMinor,
      lineDiscountMinor: lineTotals.lineDiscountMinor,
      lineTotalMinor: lineTotals.lineTotalMinor,
      discountShareMinor: lineTotals.discountShareMinor,
      netAmountMinor: lineTotals.netAmountMinor,
      costMinor: ownCostMinor + vendorCostMinor,
      source: ownedPositionIssue > 0 ? 'OWN_STOCK' : 'VENDOR_CONSIGNMENT',
      vendorPartyId: vendorIds.size === 1 ? ([...vendorIds][0] ?? null) : null,
      vendorUnitCost: null,
      isProvisionalCost: ownProvisional,
      movementId: Ulid.generate(this.clock),
      vendorLot: null,
      consumptions,
      sourceAllocations,
      serialUnitIds: serialIds,
      costState: {
        id: position.costStateId,
        exists: position.exists,
        avgUnitCost: position.avgUnitCost,
        qtyOnHand,
        qtyChange: ownedPositionIssue,
      },
    };
  }

  private async detail(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    warnings: readonly string[],
  ): Promise<SaleResponse> {
    const detail = await this.sales.findSaleById(tx, ctx, id);
    if (detail === null) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');
    const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
    return toSaleResponse(detail, showCost, warnings);
  }
}
