import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  CreatePurchaseDraftRequest,
  PurchaseDraftResponse,
  UpdatePurchaseDraftRequest,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type {
  PurchaseDraftInput,
  PurchaseDraftRow,
  PurchaseRepository,
} from './purchase-repository';

const RECOVERY_WINDOW_MS = 30 * 86_400_000;
const MAX_LIST_ROWS = 100;

/**
 * Class M, non-posting data. Drafts have no invoice number, stock movement,
 * supplier payable, money movement, cash session or accounting entry.
 * The only operations here target purchase_drafts in the caller's tenant UOW.
 */
export class PurchaseDraftService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly purchases: PurchaseRepository,
    private readonly clock: Clock,
  ) {}

  private async authorize(tx: Tx, ctx: TenantContext): Promise<void> {
    await this.access.require(tx, ctx, Permission.PURCHASE_CREATE);
    // The saved cart includes supplier costs and actual intended payment details.
    // Do not give its JSON to roles that may create bills but cannot see costs.
    await this.access.require(tx, ctx, Permission.COST_VIEW);
  }

  private respond(row: PurchaseDraftRow): PurchaseDraftResponse {
    return {
      id: row.id,
      label: row.label,
      supplierName: row.supplierName,
      itemCount: row.itemCount,
      grandTotalMinor: row.grandTotalMinor,
      cart: row.cart,
      businessDate: row.businessDate,
      savedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      recoverableUntil: row.deletedAt
        ? new Date(row.deletedAt.getTime() + RECOVERY_WINDOW_MS).toISOString()
        : null,
    };
  }

  async list(ctx: TenantContext, state: 'active' | 'deleted'): Promise<readonly PurchaseDraftResponse[]> {
    return this.uow.run(ctx, async (tx) => {
      await this.authorize(tx, ctx);
      const rows = await this.purchases.listPurchaseDrafts(tx, ctx, state, MAX_LIST_ROWS);
      return rows.map((row) => this.respond(row));
    });
  }

  async detail(ctx: TenantContext, id: string): Promise<PurchaseDraftResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.authorize(tx, ctx);
      const row = await this.purchases.findPurchaseDraft(tx, ctx, id);
      if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Draft not found');
      return this.respond(row);
    });
  }

  async create(ctx: TenantContext, input: CreatePurchaseDraftRequest): Promise<PurchaseDraftResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.authorize(tx, ctx);
      const draft: PurchaseDraftInput = {
        id: Ulid.generate(this.clock),
        label: input.label,
        supplierName: input.supplierName,
        itemCount: input.itemCount,
        grandTotalMinor: input.grandTotalMinor,
        cart: input.cart,
        businessDate: this.clock.businessDate(ctx.timezone),
      };
      const row = await this.purchases.insertPurchaseDraft(tx, ctx, draft);
      return this.respond(row);
    });
  }

  async update(ctx: TenantContext, id: string, input: UpdatePurchaseDraftRequest): Promise<PurchaseDraftResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.authorize(tx, ctx);
      const current = await this.purchases.findPurchaseDraft(tx, ctx, id);
      if (!current || current.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, 'Draft not found');
      if (current.version !== input.expectedVersion) {
        throw new AppError(ErrorCode.CONFLICT_STALE_VERSION, 'Draft changed on another device. Reload before saving.');
      }
      const updated = await this.purchases.updatePurchaseDraft(tx, ctx, id, input.expectedVersion, {
        label: input.label,
        supplierName: input.supplierName,
        itemCount: input.itemCount,
        grandTotalMinor: input.grandTotalMinor,
        cart: input.cart,
      });
      if (!updated) throw new AppError(ErrorCode.CONFLICT_STALE_VERSION, 'Draft changed on another device. Reload before saving.');
      return this.respond(updated);
    });
  }

  async recycle(ctx: TenantContext, id: string, expectedVersion: number): Promise<PurchaseDraftResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.authorize(tx, ctx);
      const current = await this.purchases.findPurchaseDraft(tx, ctx, id);
      if (!current || current.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, 'Draft not found');
      if (current.version !== expectedVersion) {
        throw new AppError(ErrorCode.CONFLICT_STALE_VERSION, 'Draft changed. Reopen deletion confirmation.');
      }
      const updated = await this.purchases.setPurchaseDraftDeletion(tx, ctx, id, expectedVersion, this.clock.now());
      if (!updated) throw new AppError(ErrorCode.CONFLICT_STALE_VERSION, 'Draft changed. Reopen deletion confirmation.');
      return this.respond(updated);
    });
  }

  async restore(ctx: TenantContext, id: string, expectedVersion: number): Promise<PurchaseDraftResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.authorize(tx, ctx);
      const current = await this.purchases.findPurchaseDraft(tx, ctx, id);
      if (!current || !current.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, 'Deleted draft not found');
      if (current.version !== expectedVersion) {
        throw new AppError(ErrorCode.CONFLICT_STALE_VERSION, 'Draft changed. Reload before restoring.');
      }
      if (this.clock.now().getTime() >= current.deletedAt.getTime() + RECOVERY_WINDOW_MS) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The 30-day draft recovery window has expired.');
      }
      const updated = await this.purchases.setPurchaseDraftDeletion(tx, ctx, id, expectedVersion, null);
      if (!updated) throw new AppError(ErrorCode.CONFLICT_STALE_VERSION, 'Draft changed. Reload before restoring.');
      return this.respond(updated);
    });
  }
}
