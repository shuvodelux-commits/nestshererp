import { searchProducts } from '@sher/core-domain';
import type { GlobalSearchGroup, GlobalSearchHit } from '@sher/core-contracts';
import { Permission, SettingKey } from '@sher/core-contracts';

import type { ProductRepository } from '../catalog/product-repository';
import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { SettingsRepository } from '../settings/settings-repository';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { PurchaseRepository } from '../purchasing/purchase-repository';
import type { SaleRepository } from '../sales/sale-repository';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';

export interface GlobalSearchCommand {
  readonly ctx: TenantContext;
  readonly q: string;
  readonly limit?: number | undefined;
}

/** Enough to recognise the row you meant, few enough to read without scrolling. */
const DEFAULT_LIMIT = 5;

/**
 * Global Search (Phase 18.1, §5.5 · §5.6 · §5.7 · §5.9).
 *
 * **This service writes nothing and decides nothing.** It asks the repositories
 * the Products, Parties, Sales and Purchases screens already ask, with the
 * filters those screens already pass, and ranks products with the same
 * `searchProducts` the counter ranks with — so a shopkeeper who learns what
 * `sam a15` finds at the till finds the same thing, in the same order, from the
 * top bar.
 *
 * **Why one transaction rather than four use-case calls.** The obvious shape
 * would be to call `ManageProductsService.list` and its three siblings, but
 * each of those opens its own transaction (R-D1), and one keystroke would open
 * four. Worse, each ends in `accessControl.require`, which *throws* — and a
 * palette must **omit** the groups a cashier may not read, not fail because
 * they may not read one of them. So the permission set is read once here, the
 * repositories are called inside that single transaction, and no query logic is
 * duplicated: every filter below is the same struct the owning list builds.
 *
 * **Nothing behind a second permission is returned.** A product's cost, a
 * party's balance and an invoice's profit all need rights this endpoint does
 * not evaluate, so no hit carries any of them. What comes back is what the
 * corresponding list would show a person who may open it at all.
 */
export class GlobalSearchService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly products: ProductRepository,
    private readonly parties: PartyRepository,
    private readonly sales: SaleRepository,
    private readonly purchases: PurchaseRepository,
    private readonly settings: SettingsRepository,
  ) {}

  async search(command: GlobalSearchCommand): Promise<{ groups: GlobalSearchGroup[] }> {
    const { ctx } = command;
    const query = command.q.trim();
    const limit = command.limit ?? DEFAULT_LIMIT;
    if (query === '') return { groups: [] };

    return this.uow.run(ctx, async (tx) => {
      const held = new Set(await this.accessControl.permissionsOf(tx, ctx));
      const may = (permission: string): boolean => held.has(permission);

      // Read once. Vendors are a §5.21 toggle, and a shop with it off must not
      // be told a vendor group exists at all (UI-09).
      const vendorsOn = may(Permission.VENDOR_VIEW)
        ? isFeatureOn(settingValuesOf(await this.settings.listStored(tx, ctx)), SettingKey.VENDOR_MANAGEMENT_ENABLED)
        : false;

      const groups = await Promise.all([
        may(Permission.PRODUCT_VIEW) ? this.productGroup(tx, ctx, query, limit) : null,
        may(Permission.CUSTOMER_VIEW) ? this.partyGroup(tx, ctx, 'CUSTOMER', 'Customers', query, limit) : null,
        may(Permission.SUPPLIER_VIEW) ? this.partyGroup(tx, ctx, 'SUPPLIER', 'Suppliers', query, limit) : null,
        vendorsOn ? this.partyGroup(tx, ctx, 'VENDOR', 'Vendors', query, limit) : null,
        may(Permission.SALE_VIEW) ? this.saleGroup(tx, ctx, query, limit) : null,
        may(Permission.PURCHASE_VIEW) ? this.purchaseGroup(tx, ctx, query, limit) : null,
      ]);

      // Goods, people, paper — and an empty group is dropped rather than drawn,
      // because a heading with nothing under it reads as a failure.
      return { groups: groups.filter((group): group is GlobalSearchGroup => group !== null && group.hits.length > 0) };
    });
  }

  /**
   * The same two steps the Products list takes: the database narrows with
   * `ILIKE` over the precomputed `search_text`, then the domain ranks what came
   * back. The over-fetch is deliberate — ranking can only reorder rows it was
   * given, so asking for exactly five would let a barcode-exact match lose to
   * five alphabetically earlier partial ones.
   */
  private async productGroup(
    tx: Tx,
    ctx: TenantContext,
    query: string,
    limit: number,
  ): Promise<GlobalSearchGroup> {
    const rows = await this.products.list(tx, ctx, {
      search: query,
      brandId: null,
      categoryId: null,
      status: null,
      cursor: null,
      sort: 'name',
      direction: 'ASC',
      limit: limit * 6,
    });

    const hits = searchProducts(query, rows)
      .slice(0, limit)
      .map((row): GlobalSearchHit => ({
        kind: 'PRODUCT',
        id: row.id,
        title: row.name,
        // What tells two similar products apart at a glance, in the order a
        // person would say it out loud.
        subtitle: [row.brandName, row.sku, row.barcode].filter((part): part is string => part !== null && part !== '').join(' · ') || null,
        amountMinor: row.sellingPriceMinor,
        date: null,
      }));

    return { kind: 'PRODUCT', label: 'Products', hits };
  }

  private async partyGroup(
    tx: Tx,
    ctx: TenantContext,
    role: 'CUSTOMER' | 'SUPPLIER' | 'VENDOR',
    label: string,
    query: string,
    limit: number,
  ): Promise<GlobalSearchGroup> {
    const rows = await this.parties.list(tx, ctx, {
      role,
      search: query,
      groupId: null,
      status: null,
      cursor: null,
      sort: 'name',
      direction: 'ASC',
      limit,
    });

    return {
      kind: role,
      label,
      hits: rows.map((row): GlobalSearchHit => ({
        kind: role,
        id: row.id,
        title: row.name,
        // The phone, because two customers share a name far more often than a
        // number, and it is what the shop reads back to confirm.
        subtitle: row.phone,
        amountMinor: null,
        date: null,
      })),
    };
  }

  private async saleGroup(
    tx: Tx,
    ctx: TenantContext,
    query: string,
    limit: number,
  ): Promise<GlobalSearchGroup> {
    const rows = await this.sales.listSales(tx, ctx, {
      search: query,
      partyId: null,
      fromDate: null,
      toDate: null,
      unpaidOnly: false,
      cursor: null,
      limit,
    });

    return {
      kind: 'SALE',
      label: 'Sales invoices',
      hits: rows.map((row): GlobalSearchHit => ({
        kind: 'SALE',
        id: row.id,
        title: row.number,
        subtitle: row.status === 'VOIDED' ? `${row.customerName} · Voided` : row.customerName,
        amountMinor: row.grandTotalMinor,
        date: row.businessDate,
      })),
    };
  }

  private async purchaseGroup(
    tx: Tx,
    ctx: TenantContext,
    query: string,
    limit: number,
  ): Promise<GlobalSearchGroup> {
    const rows = await this.purchases.listPurchases(tx, ctx, {
      search: query,
      supplierPartyId: null,
      fromDate: null,
      toDate: null,
      settlement: 'ALL',
      cursor: null,
      limit,
    });

    return {
      kind: 'PURCHASE',
      label: 'Purchase bills',
      hits: rows.map((row): GlobalSearchHit => ({
        kind: 'PURCHASE',
        id: row.id,
        title: row.number,
        subtitle: row.status === 'VOIDED' ? `${row.supplierName} · Voided` : row.supplierName,
        amountMinor: row.grandTotalMinor,
        date: row.businessDate,
      })),
    };
  }
}
