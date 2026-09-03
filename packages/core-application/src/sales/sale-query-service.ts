import { searchProducts, stockStatus } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type {
  CustomerStandingResponse,
  InvoiceSettings,
  PosProductList,
  PosProductQuery,
  SaleDraftResponse,
  SaleListQuery,
  SaleListResponse,
  SaleResponse,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { SaleRepository } from './sale-repository';
import { toSaleListItem, toSaleResponse } from './sale-view';

const DEFAULT_LIMIT = 50;

/** The invoice-design defaults a shop that has never opened the screen gets. */
const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = {
  language: 'EN',
  defaultTemplate: 'A4',
  showLogo: true,
  showBusinessBlock: true,
  showCustomerBlock: true,
  showSku: false,
  showBarcode: false,
  showDiscount: true,
  showPaymentBreakdown: true,
  showDue: true,
  showAmountInWords: true,
  headerText: null,
  showHeaderText: true,
  invoiceTitle: null,
  businessNameEn: null,
  proprietorName: null,
  proprietorNote: null,
  businessDescription: null,
  businessPhone2: null,
  contactPhones: [],
  mfsNumbers: [],
  terms: [],
  paymentTermsDays: 0,
  paymentTermsLabel: null,
  thermalPaper: '80mm',
  showSignatureLines: true,
  hasLogo: false,
  businessName: null,
  businessAddress: null,
  businessPhone: null,
  footerText: null,
  termsText: null,
  businessPadEnabled: false,
  businessPadTopMm: 40,
  pageMarginMm: 10,
};

/**
 * Reading what has been sold (§5.7, §5.8).
 *
 * Every figure here is derived in the query that produced the row it belongs to
 * — an invoice's outstanding amount, a customer's due, a product's stock — so
 * the list, its tiles, the invoice screen and the Receive Payment dialog are
 * four readings of one expression rather than four copies that drift.
 */
export class SaleQueryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly sales: SaleRepository,
    private readonly parties: PartyRepository,
    private readonly settings: SettingsRepository,
    private readonly clock: Clock,
  ) {}

  async list(ctx: TenantContext, query: SaleListQuery): Promise<SaleListResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALE_VIEW);
      const limit = query.limit ?? DEFAULT_LIMIT;
      const filter = {
        search: query.search ?? null,
        partyId: query.partyId ?? null,
        fromDate: query.fromDate ?? null,
        toDate: query.toDate ?? null,
        unpaidOnly: query.unpaidOnly ?? false,
        // Phase 12.4 (§18): the list can be narrowed to what was typed during
        // an outage. Absent means every invoice, whatever the line was doing.
        ...(query.origin === undefined || query.origin === 'ALL' ? {} : { origin: query.origin }),
        cursor: query.cursor ?? null,
        // One more than asked for, so "is there another page" is answered by
        // the same query rather than a second count (§3.9 keyset paging).
        limit: limit + 1,
      };

      const [rows, totals] = await Promise.all([
        this.sales.listSales(tx, ctx, filter),
        this.sales.totals(tx, ctx, filter),
      ]);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const asOf = this.clock.businessDate(ctx.timezone);

      return {
        items: page.map((row) => toSaleListItem(row, asOf)),
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        totals,
      };
    });
  }

  async detail(ctx: TenantContext, id: string): Promise<SaleResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALE_VIEW);
      const detail = await this.sales.findSaleById(tx, ctx, id);
      if (detail === null) throw new AppError(ErrorCode.NOT_FOUND, 'Sale not found');
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      return toSaleResponse(detail, showCost, [], this.clock.businessDate(ctx.timezone));
    });
  }

  /**
   * What the POS customer panel shows the moment a customer or phone resolves.
   *
   * The due and the advance come from journal lines (INV-06), never from adding
   * invoices up — §5.8 is explicit about that, and a screen that recomputed
   * them would be a second answer to what a customer owes.
   */
  async customerStanding(
    ctx: TenantContext,
    partyId: string,
  ): Promise<CustomerStandingResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.CUSTOMER_VIEW);
      const party = await this.parties.findById(tx, ctx, partyId);
      if (party === null) throw new AppError(ErrorCode.NOT_FOUND, 'Customer not found');

      const [standing, invoices] = await Promise.all([
        this.sales.customerStanding(tx, ctx, partyId),
        this.sales.listOpenInvoices(tx, ctx, partyId, []),
      ]);

      return {
        partyId: party.id,
        name: party.name,
        phone: party.phone,
        dueMinor: standing.dueMinor,
        advanceMinor: standing.advanceMinor,
        creditLimitMinor: party.creditLimitMinor,
        openInvoices: invoices.map((invoice) => ({
          id: invoice.id,
          number: invoice.number,
          businessDate: invoice.businessDate,
          dueDate: invoice.dueDate,
          grandTotalMinor: invoice.grandTotalMinor,
          outstandingMinor: invoice.outstandingMinor,
        })),
      };
    });
  }

  /**
   * The POS grid (§5.7).
   *
   * ACTIVE products only, and a product stays selectable at zero or negative
   * stock — visibility is never a substitute for the negative-stock policy,
   * which is what actually decides whether the sale may post.
   *
   * The purchase price is the eye's figure, and it is **omitted** for a caller
   * without `inventory.cost.view` (UI-40, R-E8): a cashier who cannot see cost
   * must not be able to read it off the wire either.
   */
  async posProducts(ctx: TenantContext, query: PosProductQuery): Promise<PosProductList> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALE_CREATE);
      const limit = query.limit ?? 24;
      const permissions = await this.access.permissionsOf(tx, ctx);
      const showCost = permissions.includes(Permission.COST_VIEW);

      const values = effectiveSettings(settingValuesOf(await this.settings.listStored(tx, ctx)));
      const dealerPricingOn = values.get(SettingKey.DEALER_PRICING_ENABLED) === 'ON';
      // Only BLOCK takes expired units off the tile: under WARN and ALLOW they
      // really are sellable, so the grid keeps counting them.
      const expiredOn =
        String(values.get(SettingKey.EXPIRED_STOCK_SALE_POLICY) ?? 'BLOCK') === 'BLOCK'
          ? this.clock.businessDate(ctx.timezone)
          : null;

      let customerGroupId: string | null = null;
      if (dealerPricingOn && query.customerPartyId !== undefined) {
        const party = await this.parties.findById(tx, ctx, query.customerPartyId);
        customerGroupId = party?.customerGroupId ?? null;
      }

      const rows = await this.sales.listPosProducts(tx, ctx, {
        expiredOn,
        search: query.search ?? null,
        barcode: query.barcode ?? null,
        categoryId: query.categoryId ?? null,
        brandId: query.brandId ?? null,
        customerGroupId,
        cursor: query.cursor ?? null,
        limit: limit + 1,
      });

      /*
       * Ranked by the same domain rule the counter uses while typing, so the
       * list that appears and the list that arrives are in the same order —
       * anything else reads as the screen changing its mind. Exact barcode
       * first, then code, name, name prefix, word prefix, anywhere; stock
       * breaks ties only.
       */
      const ranked = searchProducts(query.search ?? '', rows);
      const hasMore = ranked.length > limit;
      const page = hasMore ? ranked.slice(0, limit) : ranked;
      const wanted = query.stockStatus;

      const items = page
        .map((row) => {
          const status = stockStatus(row.qtyOnHand, row.minStockQty);
          const base = {
            id: row.id,
            name: row.name,
            sku: row.sku,
            barcode: row.barcode,
            brandName: row.brandName,
            categoryName: row.categoryName,
            unitName: row.unitName,
            sellingPriceMinor: row.sellingPriceMinor,
            groupPriceMinor: dealerPricingOn ? row.groupPriceMinor : null,
            qtyOnHand: row.qtyOnHand,
            sellableOwnedQty: row.sellableOwnedQty,
            minStockQty: row.minStockQty,
            stockStatus: status,
            hasImage: row.hasImage,
            searchText: row.searchText,
            tracksSerial: row.tracksSerial,
          };
          return showCost ? { ...base, purchasePriceMinor: row.purchasePriceMinor } : base;
        })
        .filter((item) => wanted === undefined || item.stockStatus === wanted);

      return {
        items,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        negativeStockPolicy: String(
          values.get(SettingKey.NEGATIVE_STOCK_POLICY) ?? 'BLOCK',
        ) as PosProductList['negativeStockPolicy'],
      };
    });
  }

  /**
   * The parked carts (§5.7, owner decision 2026-08-26).
   *
   * Behind `sale.invoice.create`: a draft is a sale in the making, so whoever
   * may sell may park one, and whoever may not, may not see one either.
   */
  async listDrafts(ctx: TenantContext): Promise<readonly SaleDraftResponse[]> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALE_CREATE);
      const rows = await this.sales.listDrafts(tx, ctx, 50);
      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        customerName: row.customerName,
        itemCount: row.itemCount,
        grandTotalMinor: row.grandTotalMinor,
        businessDate: row.businessDate,
        savedAt: row.savedAt.toISOString(),
        cart: row.cart,
      }));
    });
  }

  async saveDraft(
    ctx: TenantContext,
    draft: Omit<SaleDraftResponse, 'id' | 'businessDate' | 'savedAt'>,
  ): Promise<SaleDraftResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALE_CREATE);
      const id = Ulid.generate(this.clock);
      const businessDate = this.clock.businessDate(ctx.timezone);
      await this.sales.saveDraft(tx, ctx, {
        id,
        label: draft.label,
        customerName: draft.customerName,
        itemCount: draft.itemCount,
        grandTotalMinor: draft.grandTotalMinor,
        cart: draft.cart,
        businessDate,
      });
      return { ...draft, id, businessDate, savedAt: this.clock.now().toISOString() };
    });
  }

  /** A draft is deleted outright: there is nothing posted to reverse (§3.6). */
  async deleteDraft(ctx: TenantContext, id: string): Promise<void> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALE_CREATE);
      await this.sales.deleteDraft(tx, ctx, id);
    });
  }

  /** §5.8's invoice design settings, with the catalogue defaults filled in. */
  async invoiceSettings(ctx: TenantContext): Promise<InvoiceSettings> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALE_VIEW);
      const stored = await this.sales.findInvoiceSettings(tx, ctx);
      return stored ?? DEFAULT_INVOICE_SETTINGS;
    });
  }
}

export { DEFAULT_INVOICE_SETTINGS };
