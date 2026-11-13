import {
  AppError,
  catalogMetadataV1ResponseSchema,
  ErrorCode,
  patchCatalogMetadataV1BrandRequestSchema,
  patchCatalogMetadataV1CategoryRequestSchema,
  patchCatalogMetadataV1UnitRequestSchema,
  Permission,
  SettingKey,
} from '@sher/core-contracts';
import type {
  CatalogMetadataV1Brand,
  CatalogMetadataV1Category,
  CatalogMetadataV1Response,
  CatalogMetadataV1Unit,
  PatchCatalogMetadataV1BrandRequest,
  PatchCatalogMetadataV1CategoryRequest,
  PatchCatalogMetadataV1UnitRequest,
} from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { AuditValues, AuditWriter } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { CatalogMetadataV1Repository } from './catalog-metadata-v1-repository';

type MetadataRow = CatalogMetadataV1Unit | CatalogMetadataV1Brand | CatalogMetadataV1Category;
type MetadataKind = 'unit' | 'brand' | 'category';

export interface ListCatalogMetadataV1Command {
  readonly ctx: TenantContext;
}

export interface PatchCatalogMetadataV1UnitCommand {
  readonly ctx: TenantContext;
  readonly id: string;
  readonly input: PatchCatalogMetadataV1UnitRequest;
}

export interface PatchCatalogMetadataV1BrandCommand {
  readonly ctx: TenantContext;
  readonly id: string;
  readonly input: PatchCatalogMetadataV1BrandRequest;
}

export interface PatchCatalogMetadataV1CategoryCommand {
  readonly ctx: TenantContext;
  readonly id: string;
  readonly input: PatchCatalogMetadataV1CategoryRequest;
}

/**
 * MOD-002 T02A application seam; deliberately NOT wired to an HTTP route yet.
 *
 * Reuses the same tenant UoW, permissions, settings, audit and outbox as the
 * existing ManageCatalogService. A subsequent adapter must implement its port
 * on the SAME master rows, not on an independent metadata table.
 *
 * Master-data updates have no cash-session, journal, inventory or period impact.
 * Each metadata update, audit row and outbox event is one atomic transaction.
 */
export class ManageCatalogMetadataV1Service {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly catalog: CatalogMetadataV1Repository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async list({ ctx }: ListCatalogMetadataV1Command): Promise<CatalogMetadataV1Response> {
    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_VIEW);
      return this.readCatalog(tx, ctx);
    });
  }

  async patchUnit(command: PatchCatalogMetadataV1UnitCommand): Promise<CatalogMetadataV1Response> {
    const parsed = patchCatalogMetadataV1UnitRequestSchema.safeParse(command.input);
    if (!parsed.success) throw invalidMetadataBody();
    const patch = parsed.data;
    return this.patchOne({
      ctx: command.ctx,
      id: command.id,
      expectedVersion: patch.expectedVersion,
      permission: Permission.UNIT_MANAGE,
      entityType: 'unit',
      find: (tx) => this.catalog.findUnit(tx, command.ctx, command.id),
      write: (tx) => this.catalog.compareAndSetUnit(tx, command.ctx, command.id,
        patch.expectedVersion, {
          ...(patch.nameBn !== undefined ? { nameBn: patch.nameBn } : {}),
          ...(patch.symbol !== undefined ? { symbol: patch.symbol } : {}),
        }),
    });
  }

  async patchBrand(command: PatchCatalogMetadataV1BrandCommand): Promise<CatalogMetadataV1Response> {
    const parsed = patchCatalogMetadataV1BrandRequestSchema.safeParse(command.input);
    if (!parsed.success) throw invalidMetadataBody();
    const patch = parsed.data;
    return this.patchOne({
      ctx: command.ctx,
      id: command.id,
      expectedVersion: patch.expectedVersion,
      permission: Permission.BRAND_MANAGE,
      entityType: 'brand',
      find: (tx) => this.catalog.findBrand(tx, command.ctx, command.id),
      write: (tx) => this.catalog.compareAndSetBrand(tx, command.ctx, command.id,
        patch.expectedVersion, { nameBn: patch.nameBn }),
    });
  }

  async patchCategory(command: PatchCatalogMetadataV1CategoryCommand): Promise<CatalogMetadataV1Response> {
    const parsed = patchCatalogMetadataV1CategoryRequestSchema.safeParse(command.input);
    if (!parsed.success) throw invalidMetadataBody();
    const patch = parsed.data;
    return this.patchOne({
      ctx: command.ctx,
      id: command.id,
      expectedVersion: patch.expectedVersion,
      permission: Permission.CATEGORY_MANAGE,
      entityType: 'category',
      find: (tx) => this.catalog.findCategory(tx, command.ctx, command.id),
      write: (tx) => this.catalog.compareAndSetCategory(tx, command.ctx, command.id,
        patch.expectedVersion, { nameBn: patch.nameBn }),
    });
  }

  private async patchOne(input: {
    readonly ctx: TenantContext;
    readonly id: string;
    readonly expectedVersion: number;
    readonly permission: Permission;
    readonly entityType: MetadataKind;
    readonly find: (tx: Tx) => Promise<MetadataRow | null>;
    readonly write: (tx: Tx) => Promise<MetadataRow | null>;
  }): Promise<CatalogMetadataV1Response> {
    return this.uow.run(input.ctx, async (tx) => {
      await this.accessControl.require(tx, input.ctx, input.permission);
      const before = await input.find(tx);
      if (before === null) {
        // An ID from another tenant or an archived master must not be revealed.
        throw new AppError(ErrorCode.NOT_FOUND, 'That catalog entry was not found');
      }
      if (before.version !== input.expectedVersion) throw stale();

      // The adapter must enforce expectedVersion in UPDATE's WHERE, atomically.
      // The read check alone is never an adequate concurrent-write guard.
      const after = await input.write(tx);
      if (after === null) throw stale();

      if (after.id !== before.id || after.name !== before.name ||
          after.version !== before.version + 1 ||
          ('parentId' in before &&
            (!('parentId' in after) || before.parentId !== after.parentId))) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Catalog adapter returned an invalid update');
      }

      await this.audit.append(tx, input.ctx, {
        entityType: input.entityType,
        entityId: input.id,
        action: 'UPDATE',
        before: toAuditValues(before),
        after: toAuditValues(after),
        source: 'API',
      });

      await this.outbox.append(tx, input.ctx, {
        eventType: `${input.entityType}.updated`,
        aggregateType: input.entityType,
        aggregateId: input.id,
        payload: {
          name: after.name,
          nameBn: after.nameBn,
          ...('symbol' in after ? { symbol: after.symbol } : {}),
          version: after.version,
        },
      });

      return this.readCatalog(tx, input.ctx);
    });
  }

  private async readCatalog(tx: Tx, ctx: TenantContext): Promise<CatalogMetadataV1Response> {
    const [units, brands, categories, stored] = await Promise.all([
      this.catalog.listUnits(tx, ctx),
      this.catalog.listBrands(tx, ctx),
      this.catalog.listCategories(tx, ctx),
      this.settings.listStored(tx, ctx),
    ]);
    const values = settingValuesOf(stored);
    // Strict validation proves that nullable fields were not lost by a
    // mistakenly reused legacy projection. No synthesized Bangla labels.
    return catalogMetadataV1ResponseSchema.parse({
      units,
      brands,
      categories,
      features: {
        productOffers: isFeatureOn(values, SettingKey.PRODUCT_OFFERS_ENABLED),
        expiryTracking: isFeatureOn(values, SettingKey.EXPIRY_TRACKING_ENABLED),
        serialTracking: isFeatureOn(values, SettingKey.SERIAL_TRACKING_ENABLED),
        warranty: isFeatureOn(values, SettingKey.WARRANTY_ENABLED),
        customerGroups: isFeatureOn(values, SettingKey.CUSTOMER_GROUPS_ENABLED),
        vendors: isFeatureOn(values, SettingKey.VENDOR_MANAGEMENT_ENABLED),
      },
    });
  }
}

function toAuditValues(row: MetadataRow): AuditValues {
  return {
    name: row.name,
    nameBn: row.nameBn,
    ...('symbol' in row ? { symbol: row.symbol } : {}),
  };
}

function stale(): AppError {
  return new AppError(ErrorCode.CONFLICT_STALE_VERSION,
    'This catalog entry was modified. Refresh before saving.');
}

function invalidMetadataBody(): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid catalog metadata request');
}
