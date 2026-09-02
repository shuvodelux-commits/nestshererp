import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  OfflineSale,
  OfflineSnapshotResponse,
  PartyResponse,
  ProductResponse,
  SnapshotIncludes,
} from '@sher/core-contracts';
import { occupiesWriterSlot } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';

import type { UserRepository } from '../auth/registration-repository';
import type { ManageProductsService } from '../catalog/manage-products-service';
import type { ManagePartiesService } from '../parties/manage-parties-service';
import type { SaleQueryService } from '../sales/sale-query-service';
import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { DeviceRepository } from './device-repository';

/**
 * The shop's readable data, packed for the one machine allowed to hold it
 * (§5.23, Phase 12.3, owner decisions 2026-08-31).
 *
 * **This service composes; it does not query.** Products and parties come back
 * through `ManageProductsService.list` and `ManagePartiesService.list` — the
 * very calls the online screens make — page after page until the tenant is
 * exhausted. Reading the tables directly would have been faster and would have
 * created a second definition of what a product is: the offline copy would
 * carry a cost price the online list hides, or miss a computed field the screen
 * needs, and nobody would notice until a shopkeeper compared two screens.
 *
 * Three consequences fall out of that choice, all of them wanted:
 *
 * 1. **Permissions are inherited, not re-implemented.** The list services
 *    already refuse a caller without `catalog.product.view` and already drop
 *    cost from the response without `inventory.cost.view`. So a cashier's
 *    refresh writes a cashier's view to the disk — the copy can never hold
 *    something no screen would be allowed to show. `includes` records what was
 *    taken, and the Offline & Devices card prints it.
 * 2. **A missing permission is a smaller snapshot, not a failure.** A cashier
 *    who may not see suppliers still gets the catalogue and the customers,
 *    because refusing the whole download would leave the counter machine with
 *    nothing on the day the line goes down.
 * 3. **Nothing here is a document.** No sale, no journal line, no lot. This
 *    slice reads, and `OFFLINE_READY` stays reserved for the build where the
 *    shop can genuinely trade.
 *
 * Only the machine holding the shop's offline authority may ask. The gate of
 * D-24 decides whether a device *may* keep data; this decides whether it may
 * *have* it, and the two answers must not come apart.
 */

/**
 * The shape of the rows the device stores. Bumped whenever a stored column
 * changes meaning, which makes an old copy discardable rather than
 * misreadable — a device that finds a version it does not know throws its copy
 * away and downloads again.
 */
/*
 * Bumped to 2 by Phase 12.4: the copy now carries the people who may sign in
 * offline and the sales they may look up, so a copy written by a 12.3 build is
 * discarded and downloaded again rather than read as if it had them.
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/**
 * How far back the sales history reaches (§13, owner decision 2026-09-02:
 * twelve months).
 *
 * Balances never depend on it — those ride on the party rows, which carry what
 * the ledger says — so pruning history can never change a figure. Unpaid sales
 * come regardless of age, because an invoice somebody still owes on is open
 * work whenever it was written.
 */
const SALES_HISTORY_MONTHS = 12;

/**
 * Rows per page while packing. Large enough that a 20,000-product wholesaler is
 * a handful of round trips inside one transaction each, small enough that no
 * single query builds a response a shop's server has to hold whole.
 */
const PAGE_SIZE = 200;

/**
 * The most rows of one kind a snapshot will carry.
 *
 * Not a storage ceiling — the owner's direction of 2026-08-31 is explicit that
 * no arbitrary byte limit is imposed, and the D-24 gate already measures this
 * tenant's real estimate against the machine's real free space. This is a
 * runaway stop: a tenant with a million parties would otherwise pack forever
 * and time the request out with nothing to show for it. A shop that reaches it
 * is told, rather than silently given a truncated shelf.
 */
const MAX_ROWS_PER_KIND = 50_000;

export class SnapshotService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly devices: DeviceRepository,
    private readonly products: ManageProductsService,
    private readonly parties: ManagePartiesService,
    private readonly users: UserRepository,
    private readonly sales: SaleQueryService,
    private readonly clock: Clock,
  ) {}

  async build(ctx: TenantContext, publicKey: string): Promise<OfflineSnapshotResponse> {
    const { held, takenByName, offlineUsers } = await this.uow.run(ctx, async (tx) => {
      const device = await this.devices.findByPublicKey(tx, ctx, publicKey);
      if (device === null) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This computer has not registered itself yet',
        );
      }

      /*
       * `occupiesWriterSlot` covers ACTIVE and DRAINING alike. A draining
       * machine is finishing its work, not starting new work, so it may keep
       * reading what it already holds — and refusing it here would blank the
       * screens of the very machine being handed over.
       */
      if (!occupiesWriterSlot(device.status)) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'This computer is not the shop’s offline computer, so it cannot keep a copy of the shop’s data',
        );
      }

      const user = await this.users.findSummary(tx, ctx, ctx.userId);
      return {
        held: await this.access.permissionsOf(tx, ctx),
        takenByName: user?.displayName ?? 'Someone',
        /*
         * Who may open this counter while it is disconnected (§9). Read here,
         * inside the same transaction that proved this machine holds the
         * writer slot, because the answer is about this machine and no other.
         */
        offlineUsers: await this.devices.offlineUsers(tx, ctx, device.id),
      };
    });

    const today = this.clock.businessDate(ctx.timezone);
    const salesSince = monthsBefore(today, SALES_HISTORY_MONTHS);

    const includes: SnapshotIncludes = {
      products: held.includes(Permission.PRODUCT_VIEW),
      customers: held.includes(Permission.CUSTOMER_VIEW),
      suppliers: held.includes(Permission.SUPPLIER_VIEW),
      vendors: held.includes(Permission.VENDOR_VIEW),
      cost: held.includes(Permission.COST_VIEW),
      users: offlineUsers.length > 0,
      sales: held.includes(Permission.SALE_VIEW),
    };

    if (!includes.products && !includes.customers && !includes.suppliers && !includes.vendors) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'You cannot see any of the shop’s lists, so there is nothing to keep on this computer',
      );
    }

    return {
      takenAt: this.clock.now().toISOString(),
      takenByName,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      includes,
      products: includes.products ? await this.allProducts(ctx) : [],
      customers: includes.customers ? await this.allParties(ctx, 'CUSTOMER') : [],
      suppliers: includes.suppliers ? await this.allParties(ctx, 'SUPPLIER') : [],
      /*
       * Vendors are a licensed feature, and the list service refuses when it is
       * off. That is not a snapshot failure — a shop without vendors simply has
       * none — so the refusal is turned into an empty list and `includes.vendors`
       * still says the permission was held.
       */
      vendors: includes.vendors ? await this.allPartiesIfEnabled(ctx, 'VENDOR') : [],
      users: offlineUsers.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        username: user.username,
        pinHash: user.pinHash,
        permissions: [...user.permissions],
      })),
      sales: includes.sales ? await this.recentSales(ctx, salesSince) : [],
      salesSince: includes.sales ? salesSince : null,
    };
  }

  /**
   * Twelve months of sales, plus every unpaid one however old.
   *
   * Read through `SaleQueryService.list` — the very call the sales screen makes
   * — so permissions are inherited rather than re-implemented and the offline
   * list cannot hold a sale the online list would refuse to show. Two passes,
   * because "recent" and "still owed" are different questions and a shop with a
   * two-year-old unpaid invoice needs the answer to both.
   */
  private async recentSales(ctx: TenantContext, since: string): Promise<OfflineSale[]> {
    const byId = new Map<string, OfflineSale>();

    for (const query of [{ fromDate: since }, { unpaidOnly: true }]) {
      let cursor: string | undefined;
      for (;;) {
        const page = await this.sales.list(ctx, {
          ...query,
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const sale of page.items) {
          byId.set(sale.id, {
            id: sale.id,
            number: sale.number,
            businessDate: sale.businessDate,
            partyId: sale.partyId,
            customerName: sale.customerName,
            customerPhone: sale.customerPhone,
            grandTotalMinor: sale.grandTotalMinor,
            paidMinor: sale.paidMinor,
            dueMinor: sale.dueMinor,
            status: sale.status,
          });
        }
        if (page.nextCursor === null || page.items.length === 0) break;
        if (byId.size >= MAX_ROWS_PER_KIND) throw tooMany('sales');
        cursor = page.nextCursor;
      }
    }

    return [...byId.values()];
  }

  private async allProducts(ctx: TenantContext): Promise<ProductResponse[]> {
    const rows: ProductResponse[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.products.list({
        ctx,
        limit: PAGE_SIZE,
        // Sorted by id, which is also the keyset cursor: any other order can
        // repeat or skip a row when the page boundary lands on a tie.
        sort: 'name',
        ...(cursor === undefined ? {} : { cursor }),
      });
      rows.push(...page.data);

      if (!page.page.hasMore || page.page.nextCursor === null) break;
      if (rows.length >= MAX_ROWS_PER_KIND) throw tooMany('products');
      cursor = page.page.nextCursor;
    }

    return rows;
  }

  private async allParties(
    ctx: TenantContext,
    role: 'CUSTOMER' | 'SUPPLIER' | 'VENDOR',
  ): Promise<PartyResponse[]> {
    const rows: PartyResponse[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.parties.list({
        ctx,
        role,
        limit: PAGE_SIZE,
        sort: 'name',
        ...(cursor === undefined ? {} : { cursor }),
      });
      rows.push(...page.data);

      if (!page.page.hasMore || page.page.nextCursor === null) break;
      if (rows.length >= MAX_ROWS_PER_KIND) throw tooMany('customers or suppliers');
      cursor = page.page.nextCursor;
    }

    return rows;
  }

  private async allPartiesIfEnabled(
    ctx: TenantContext,
    role: 'VENDOR',
  ): Promise<PartyResponse[]> {
    try {
      return await this.allParties(ctx, role);
    } catch (cause) {
      // Only the feature switch is swallowed. A permission refusal cannot reach
      // here (the caller checked), and anything else is a real failure that
      // must stop the download rather than quietly shrink it.
      if (cause instanceof AppError && cause.code === ErrorCode.FEATURE_DISABLED) return [];
      throw cause;
    }
  }
}

/**
 * The same day of the month, N months earlier, as a business date.
 *
 * Deliberately not `new Date()` arithmetic on an instant: business dates are
 * tenant-local days (§3.5), and subtracting milliseconds from an instant lands
 * a day out whenever a shop's timezone and the server's disagree.
 */
function monthsBefore(businessDate: string, months: number): string {
  const year = Number(businessDate.slice(0, 4));
  const month = Number(businessDate.slice(5, 7));
  const day = businessDate.slice(8, 10);
  const total = year * 12 + (month - 1) - months;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${String(newYear).padStart(4, '0')}-${String(newMonth).padStart(2, '0')}-${day}`;
}

function tooMany(kind: string): AppError {
  return new AppError(
    ErrorCode.VALIDATION_FAILED,
    `This shop has too many ${kind} to keep a copy on one computer. Tell support before working offline.`,
  );
}
