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
 * Canonicalize only the bounded JSON-safe original create fields.
 * JSONB loses object key order; retries of semantically identical bodies
 * must compare equal regardless of serialized property order.
 *
 * This immutable SHA-256 content digest is not a financial checksum and must never
 * be recomputed after a draft has been edited or recycled.
 */
async function draftCreateFingerprint(input: CreatePurchaseDraftRequest): Promise<string> {
  let nodes = 0;
  function ordered(value: unknown, depth: number): string {
    nodes += 1;
    if (nodes > 20_000 || depth > 48) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Draft create payload is too deeply nested');
    }
    if (value === null || typeof value !== 'object') {
      const primitive = JSON.stringify(value);
      if (primitive === undefined) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Draft contains unsupported JSON values');
      }
      return primitive;
    }
    if (Array.isArray(value)) return '[' + value.map(item => ordered(item, depth + 1)).join(',') + ']';
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' +
        ordered((value as Record<string, unknown>)[key], depth + 1))
      .join(',') + '}';
  }
  const fingerprint = ordered({
    label: input.label,
    supplierName: input.supplierName,
    itemCount: input.itemCount,
    grandTotalMinor: input.grandTotalMinor,
    cart: input.cart,
  }, 0);
  if (fingerprint.length > 125_000) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'Draft create payload is too large');
  }
  // Store only a fixed-size digest, never a duplicate copy of the entire
  // supplier/serial/payment snapshot. Web Crypto works in Node 20 and browsers.
  const bytes = new TextEncoder().encode(fingerprint);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value =>
    value.toString(16).padStart(2, '0')).join('');
}

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
      recoverableUntilEpochMs: row.deletedAt
        ? row.deletedAt.getTime() + RECOVERY_WINDOW_MS
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
      const fingerprint = await draftCreateFingerprint(input);
      const replay = (row: PurchaseDraftRow): PurchaseDraftResponse => {
        if (row.createFingerprint !== fingerprint) {
          throw new AppError(ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'Draft creation key already belongs to a different request');
        }
        return this.respond(row);
      };
      const previous = await this.purchases.findPurchaseDraftByOperationId(
        tx, ctx, input.operationId,
      );
      if (previous) return replay(previous);

      const draft: PurchaseDraftInput = {
        id: Ulid.generate(this.clock),
        operationId: input.operationId,
        createFingerprint: fingerprint,
        label: input.label,
        supplierName: input.supplierName,
        itemCount: input.itemCount,
        grandTotalMinor: input.grandTotalMinor,
        cart: input.cart,
        businessDate: this.clock.businessDate(ctx.timezone),
      };
      const inserted = await this.purchases.insertPurchaseDraft(tx, ctx, draft);
      if (inserted) return this.respond(inserted);

      // Another transaction won the unique tenant+operation race. PostgreSQL
      // READ COMMITTED sees its committed row after ON CONFLICT DO NOTHING.
      const winner = await this.purchases.findPurchaseDraftByOperationId(
        tx, ctx, input.operationId,
      );
      if (!winner) {
        throw new AppError(ErrorCode.INTERNAL_ERROR,
          'Purchase draft create conflict could not be resolved');
      }
      return replay(winner);
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
