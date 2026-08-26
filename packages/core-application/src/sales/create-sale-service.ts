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
import { Money, Qty, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { ProductRepository } from '../catalog/product-repository';
import type { InventoryRepository } from '../inventory/inventory-repository';
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
import type { NewLotConsumption, NewSaleLine, SaleRepository } from './sale-repository';
import { toSaleResponse } from './sale-view';

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
    private readonly money: MoneyRepository,
    private readonly sales: SaleRepository,
    private readonly settings: SettingsRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
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

        const line =
          input.source === 'VENDOR_CONSIGNMENT'
            ? this.consignmentLine(
                { index, input, lineTotals, product, position, location, consignmentOn },
                vendorPayables,
              )
            : await this.ownStockLine(tx, ctx, {
                index,
                input,
                lineTotals,
                product,
                position,
                location,
                method,
                layersByProduct,
                negativePolicy,
                expiredOn: expiredPolicy === 'BLOCK' ? businessDate : null,
                allowNegativeStock: command.allowNegativeStock,
                warnings,
              });

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

      const posting = salePosting(totals, {
        partyId: customer.partyId,
        payments: resolvedPayments.map((payment) => ({
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
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'SALE',
        Number(businessDate.slice(0, 4)),
      );

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
        paidMinor: paidMinor - (overpaidMinor - advanceMinor),
        sessionId: resolvedPayments.find((payment) => payment.account.sessionId !== null)?.account
          .sessionId ?? null,
        notes: command.notes,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        journalEntryId: Ulid.generate(this.clock),
        journalLines: posting.lines.map((line) => ({ id: Ulid.generate(this.clock), ...line })),
        lines: saleLines,
        payments: resolvedPayments.map((payment, index) => ({
          id: Ulid.generate(this.clock),
          lineNo: index + 1,
          accountCode: payment.account.code,
          // The change handed back comes out of the row that overpaid, so the
          // drawer holds what it physically holds. An advance is kept in full.
          amountMinor:
            index === resolvedPayments.length - 1
              ? payment.amountMinor - (overpaidMinor - advanceMinor)
              : payment.amountMinor,
          sessionId: payment.account.sessionId,
        })).filter((payment) => payment.amountMinor > 0),
      });

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
      if (!party.roles.includes('CUSTOMER')) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, `“${party.name}” is not a customer`);
      }
      if (party.status === 'INACTIVE') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `“${party.name}” is no longer in use — reactivate them first`,
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

  /** A line sold from the shop's own shelf: lots are consumed and COGS is real. */
  private async ownStockLine(
    tx: Tx,
    ctx: TenantContext,
    args: {
      index: number;
      input: SaleLineInput;
      lineTotals: { qty: number; unitPriceMinor: number; lineDiscountMinor: number; lineTotalMinor: number; discountShareMinor: number; netAmountMinor: number };
      product: { id: string; name: string; tracksExpiry: boolean; purchasePriceMinor: number };
      position: { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean };
      location: { id: string };
      method: 'FIFO' | 'AVERAGE';
      layersByProduct: Map<string, CostLayer[]>;
      negativePolicy: string;
      /** The date expired batches stop counting, or null when they still do. */
      expiredOn: string | null;
      allowNegativeStock: boolean;
      warnings: string[];
    },
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
    const byExpiry =
      product.tracksExpiry && available.every((layer) => layer.expiryDate !== null);
    const issue = costIssue(
      args.method,
      available,
      input.qty,
      position.avgUnitCost,
      provisional,
      byExpiry,
      args.expiredOn,
    );


    if (issue.shortageQty > 0) {
      /*
       * What the shopkeeper is told has to be what they can actually sell.
       * With expired batches skipped, "only 5 in stock" would be a lie about
       * two of them, so the figure counts sellable units and the sentence names
       * the expired ones separately — the shop then knows to look at Inventory
       * rather than at the shelf (owner decision 2026-08-26).
       */
      const sellableQty =
        args.expiredOn === null
          ? Math.max(position.qtyOnHand, 0)
          : available
              .filter(
                (layer) => layer.expiryDate === null || layer.expiryDate >= (args.expiredOn ?? ''),
              )
              .reduce((sum, layer) => sum + Math.max(layer.qtyRemaining, 0), 0);
      const expiredQty = Math.max(Math.max(position.qtyOnHand, 0) - sellableQty, 0);
      const expiredNote =
        expiredQty > 0 ? ` — ${Qty(expiredQty).format()} expired and cannot be sold` : '';

      // §5.7's negative-stock policy. `BLOCK` refuses; `WARN` needs the cashier
      // to have seen and accepted it, which is what `allowNegativeStock` is;
      // `ALLOW` posts and labels the cost provisional (D-19).
      if (args.negativePolicy === 'BLOCK') {
        throw new AppError(
          ErrorCode.INSUFFICIENT_STOCK,
          sellableQty <= 0 && expiredQty > 0
            ? `Product expired. This batch cannot be sold`
            : `Only ${Qty(sellableQty).format()} of “${product.name}” can be sold${expiredNote}`,
          {
            reason: 'NEGATIVE_STOCK_BLOCKED',
            productId: product.id,
            shortageQty: String(issue.shortageQty),
            expiredQty: String(expiredQty),
          },
        );
      }
      if (args.negativePolicy === 'WARN' && !args.allowNegativeStock) {
        throw new AppError(
          ErrorCode.INSUFFICIENT_STOCK,
          `Only ${Qty(sellableQty).format()} of “${product.name}” can be sold${expiredNote} — confirm to sell anyway`,
          {
            reason: 'NEGATIVE_STOCK_CONFIRM',
            productId: product.id,
            shortageQty: String(issue.shortageQty),
            expiredQty: String(expiredQty),
          },
        );
      }
      args.warnings.push(
        `“${product.name}” was sold below the stock on hand — its cost is provisional until the goods are bought`,
      );
    }

    // Lots are spent in this map so a second line for the same product sees
    // what the first one took, before any of it reaches the database.
    const consumptions: NewLotConsumption[] = issue.allocations.map((allocation) => {
      const at = available.findIndex((candidate) => candidate.id === allocation.lotId);
      const layer = at === -1 ? undefined : available[at];
      const before = layer?.qtyRemaining ?? 0;
      const after = Qty(before).subtract(Qty(allocation.qty)).raw;
      if (layer !== undefined) available[at] = { ...layer, qtyRemaining: after };
      return {
        id: Ulid.generate(this.clock),
        lotId: allocation.lotId,
        qty: allocation.qty,
        unitCostUsed: allocation.unitCost,
        closesLot: after === 0,
      };
    });

    /*
     * The moving average does not change when stock leaves (DR13.5) — only the
     * quantity does. That is what makes AVERAGE stable across a day of selling.
     */
    const qtyOnHand = Qty(position.qtyOnHand).subtract(Qty(input.qty)).raw;

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
      costMinor: issue.valueMinor,
      source: 'OWN_STOCK',
      vendorPartyId: null,
      vendorUnitCost: null,
      isProvisionalCost: issue.provisional,
      movementId: Ulid.generate(this.clock),
      vendorLot: null,
      consumptions,
      costState: {
        id: position.costStateId,
        exists: position.exists,
        avgUnitCost: position.avgUnitCost,
        qtyOnHand,
      },
    };
  }

  /**
   * A line sourced from a vendor at the moment of sale (§5.7, DR13.10).
   *
   * The goods were never the shop's, so they were never in `INVENTORY` and
   * never in the owned valuation (INV-04). The deemed purchase creates the lot
   * and consumes it in the same breath — the lot exists so the sale has a
   * costed origin the movement trail can point at — and the vendor becomes
   * owed exactly what the shopkeeper said their goods cost.
   */
  private consignmentLine(
    args: {
      index: number;
      input: SaleLineInput;
      lineTotals: { qty: number; unitPriceMinor: number; lineDiscountMinor: number; lineTotalMinor: number; discountShareMinor: number; netAmountMinor: number };
      product: { id: string; name: string };
      position: { qtyOnHand: number; avgUnitCost: number; costStateId: string; exists: boolean };
      location: { id: string };
      consignmentOn: boolean;
    },
    vendorPayables: Map<string, number>,
  ): NewSaleLine {
    const { input, lineTotals, product, position, location } = args;
    if (!args.consignmentOn) {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Vendor sourcing is switched off for this shop',
      );
    }
    if (input.vendorPartyId === null || input.vendorUnitCostMinor === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Say which vendor “${product.name}” came from, and what they charge`,
      );
    }

    const unitCost = unitCostFromMoneyMinor(input.vendorUnitCostMinor);
    const costMinor = stockValueMinor(input.qty, unitCost);
    vendorPayables.set(
      input.vendorPartyId,
      (vendorPayables.get(input.vendorPartyId) ?? 0) + costMinor,
    );

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
      costMinor,
      source: 'VENDOR_CONSIGNMENT',
      vendorPartyId: input.vendorPartyId,
      vendorUnitCost: unitCost,
      isProvisionalCost: false,
      movementId: Ulid.generate(this.clock),
      vendorLot: { id: Ulid.generate(this.clock), unitCost },
      consumptions: [],
      // Consignment goods are not owned, so the shop's own position is
      // untouched — the quantity that leaves was never counted as its stock.
      costState: {
        id: position.costStateId,
        exists: position.exists,
        avgUnitCost: position.avgUnitCost,
        qtyOnHand: position.qtyOnHand,
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
