import {
  catalogNameKey,
  isValidCatalogName,
  normalizeCatalogName,
} from '@sher/core-domain';
import {
  AppError,
  catalogMetadataV1ResponseSchema,
  createCatalogMetadataV1BrandRequestSchema,
  createCatalogMetadataV1CategoryRequestSchema,
  createCatalogMetadataV1UnitRequestSchema,
  ErrorCode,
  Permission,
  SettingKey,
} from '@sher/core-contracts';
import type { CatalogMetadataV1Response } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter, AuditValues } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { CatalogMetadataV1CreationRepository } from './catalog-metadata-v1-creation-repository';
import type { CatalogMetadataV1Repository } from './catalog-metadata-v1-repository';

export interface CreateCatalogMetadataV1Command {
  readonly ctx: TenantContext;
  readonly input: unknown;
}

type MasterKind = 'unit' | 'brand' | 'category';

/**
 * MOD-002 T02A/P4a: application-only, opt-in metadata CREATE.
 *
 * This service is intentionally NOT registered in Nest and contains no SQL.
 * P4b must insert English name + optional Bengali metadata in the SAME
 * existing master row, then append audit and outbox in this one transaction.
 *
 * The legacy name-only catalog create routes and the accepted metadata-v1
 * GET/PATCH service remain unchanged. No two-request create-then-edit flow.
 */
export class CreateCatalogMetadataV1Service {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly catalog: CatalogMetadataV1Repository,
    private readonly creation: CatalogMetadataV1CreationRepository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async createUnit(command: CreateCatalogMetadataV1Command): Promise<CatalogMetadataV1Response> {
    const parsed = createCatalogMetadataV1UnitRequestSchema.safeParse(command.input);
    if (!parsed.success) throw invalidBody();
    return this.create({
      ctx: command.ctx,
      kind: 'unit',
      permission: Permission.UNIT_MANAGE,
      name: parsed.data.name,
      nameBn: parsed.data.nameBn ?? null,
      symbol: parsed.data.symbol ?? null,
    });
  }

  async createBrand(command: CreateCatalogMetadataV1Command): Promise<CatalogMetadataV1Response> {
    const parsed = createCatalogMetadataV1BrandRequestSchema.safeParse(command.input);
    if (!parsed.success) throw invalidBody();
    return this.create({
      ctx: command.ctx,
      kind: 'brand',
      permission: Permission.BRAND_MANAGE,
      name: parsed.data.name,
      nameBn: parsed.data.nameBn ?? null,
    });
  }

  async createCategory(command: CreateCatalogMetadataV1Command): Promise<CatalogMetadataV1Response> {
    const parsed = createCatalogMetadataV1CategoryRequestSchema.safeParse(command.input);
    if (!parsed.success) throw invalidBody();
    return this.create({
      ctx: command.ctx,
      kind: 'category',
      permission: Permission.CATEGORY_MANAGE,
      name: parsed.data.name,
      nameBn: parsed.data.nameBn ?? null,
      parentId: parsed.data.parentId,
    });
  }

  private async create(command: {
    readonly ctx: TenantContext;
    readonly kind: MasterKind;
    readonly permission: Permission;
    readonly name: string;
    readonly nameBn: string | null;
    readonly symbol?: string | null;
    readonly parentId?: string | null;
  }): Promise<CatalogMetadataV1Response> {
    if (!isValidCatalogName(command.name)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter a name of 1 to 120 characters');
    }
    const name = normalizeCatalogName(command.name);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx, kind, nameBn } = command;
      await this.accessControl.require(tx, ctx, command.permission);

      // The legacy catalog rules apply: tenant-scoped uniqueness for units/
      // brands and sibling-scoped uniqueness for categories. SQL's existing
      // unique indexes remain authoritative for concurrent identical creates.
      let parentName: string | null = null;
      let parentId: string | null = null;
      if (kind === 'category') {
        parentId = command.parentId ?? null;
        if (parentId !== null) {
          const parent = await this.catalog.findCategory(tx, ctx, parentId);
          if (parent === null) {
            throw new AppError(ErrorCode.NOT_FOUND, 'That category was not found');
          }
          if (parent.parentId !== null) {
            throw new AppError(
              ErrorCode.VALIDATION_FAILED,
              `${parent.name} is already a subcategory. Categories go two levels deep, not three.`,
            );
          }
          parentName = parent.name;
        }
      }

      const existing = kind === 'unit'
        ? await this.catalog.listUnits(tx, ctx)
        : kind === 'brand'
          ? await this.catalog.listBrands(tx, ctx)
          : (await this.catalog.listCategories(tx, ctx)).filter(
              (entry) => entry.parentId === parentId,
            );
      const conflict = existing.find(
        (entry) => catalogNameKey(entry.name) === catalogNameKey(name),
      );
      if (conflict !== undefined) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `${conflict.name} already exists as a ${kind}`,
        );
      }

      const id = Ulid.generate(this.clock);
      const version = 1;
      let after: AuditValues;
      let payload: Record<string, unknown>;

      if (kind === 'unit') {
        const symbol = command.symbol ?? null;
        await this.creation.insertUnit(tx, ctx, { id, name, nameBn, symbol, version });
        after = { name, nameBn, symbol };
        payload = { name, nameBn, symbol };
      } else if (kind === 'brand') {
        await this.creation.insertBrand(tx, ctx, { id, name, nameBn, version });
        after = { name, nameBn };
        payload = { name, nameBn };
      } else {
        await this.creation.insertCategory(tx, ctx, {
          id, name, nameBn, parentId, version,
        });
        after = { name, nameBn, parent: parentName };
        payload = { name, nameBn, parentId };
      }

      await this.audit.append(tx, ctx, {
        entityType: kind,
        entityId: id,
        action: 'CREATE',
        before: null,
        after,
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: `${kind}.created`,
        aggregateType: kind,
        aggregateId: id,
        payload,
      });

      // One strict response, read under the SAME RLS transaction; a second
      // HTTP request or a second transaction would break create atomicity.
      return this.readCatalog(tx, ctx);
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

function invalidBody(): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid catalog metadata create request');
}
