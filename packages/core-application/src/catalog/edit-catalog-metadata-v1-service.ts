import { catalogNameKey, isValidCatalogName, normalizeCatalogName } from '@sher/core-domain';
import {
  AppError, ErrorCode, Permission, SettingKey,
  catalogMetadataV1ResponseSchema, catalogMetadataV1UnitSchema,
  catalogMetadataV1BrandSchema, catalogMetadataV1CategorySchema,
  editCatalogMetadataV1UnitRequestSchema, editCatalogMetadataV1BrandRequestSchema,
  editCatalogMetadataV1CategoryRequestSchema,
} from '@sher/core-contracts';
import type {
  CatalogMetadataV1Response, CatalogMetadataV1Unit,
  CatalogMetadataV1Brand, CatalogMetadataV1Category,
} from '@sher/core-contracts';
import type { AccessControl } from '../ports/access-control';
import type { AuditValues, AuditWriter } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { SettingsRepository } from '../settings/settings-repository';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { CatalogMetadataV1Repository } from './catalog-metadata-v1-repository';
import type {
  CatalogFullEditUnit, CatalogMetadataV1FullEditRepository,
} from './catalog-metadata-v1-full-edit-repository';

type Kind = 'unit' | 'brand' | 'category';
type Row = CatalogMetadataV1Unit | CatalogMetadataV1Brand | CatalogMetadataV1Category;

export interface EditCatalogMetadataV1Command {
  readonly ctx: TenantContext;
  readonly id: string;
  readonly input: unknown;
}

/**
 * MOD-002 P6b: application-only single-transaction bilingual master edit.
 * No Nest route/DI, SQL, migration, cash, stock or financial changes here.
 * The future P6c port MUST CAS every edited field in ONE PostgreSQL UPDATE.
 */
export class EditCatalogMetadataV1Service {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly catalog: CatalogMetadataV1Repository,
    private readonly fullEdit: CatalogMetadataV1FullEditRepository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async editUnit(command: EditCatalogMetadataV1Command): Promise<CatalogMetadataV1Response> {
    const result = editCatalogMetadataV1UnitRequestSchema.safeParse(command.input);
    if (!result.success) throw badInput();
    const value = result.data;
    return this.editOne({
      ctx: command.ctx, id: command.id, kind: 'unit',
      permission: Permission.UNIT_MANAGE, expectedVersion: value.expectedVersion,
      edit: {
        name: value.name,
        ...(value.nameBn !== undefined ? { nameBn: value.nameBn } : {}),
        ...(value.symbol !== undefined ? { symbol: value.symbol } : {}),
      },
      find: tx => this.catalog.findUnit(tx, command.ctx, command.id),
      list: tx => this.catalog.listUnits(tx, command.ctx),
      cas: (tx, edit) => this.fullEdit.compareAndSetUnit(
        tx, command.ctx, command.id, value.expectedVersion, edit),
    });
  }

  async editBrand(command: EditCatalogMetadataV1Command): Promise<CatalogMetadataV1Response> {
    const result = editCatalogMetadataV1BrandRequestSchema.safeParse(command.input);
    if (!result.success) throw badInput();
    const value = result.data;
    return this.editOne({
      ctx: command.ctx, id: command.id, kind: 'brand',
      permission: Permission.BRAND_MANAGE, expectedVersion: value.expectedVersion,
      edit: { name: value.name, ...(value.nameBn !== undefined ? { nameBn: value.nameBn } : {}) },
      find: tx => this.catalog.findBrand(tx, command.ctx, command.id),
      list: tx => this.catalog.listBrands(tx, command.ctx),
      cas: (tx, edit) => this.fullEdit.compareAndSetBrand(
        tx, command.ctx, command.id, value.expectedVersion, edit),
    });
  }

  async editCategory(command: EditCatalogMetadataV1Command): Promise<CatalogMetadataV1Response> {
    const result = editCatalogMetadataV1CategoryRequestSchema.safeParse(command.input);
    if (!result.success) throw badInput();
    const value = result.data;
    return this.editOne({
      ctx: command.ctx, id: command.id, kind: 'category',
      permission: Permission.CATEGORY_MANAGE, expectedVersion: value.expectedVersion,
      edit: { name: value.name, ...(value.nameBn !== undefined ? { nameBn: value.nameBn } : {}) },
      find: tx => this.catalog.findCategory(tx, command.ctx, command.id),
      list: tx => this.catalog.listCategories(tx, command.ctx),
      cas: (tx, edit) => this.fullEdit.compareAndSetCategory(
        tx, command.ctx, command.id, value.expectedVersion, edit),
    });
  }

  private async editOne(args: {
    readonly ctx: TenantContext;
    readonly id: string;
    readonly kind: Kind;
    readonly permission: Permission;
    readonly expectedVersion: number;
    readonly edit: CatalogFullEditUnit;
    readonly find: (tx: Tx) => Promise<Row | null>;
    readonly list: (tx: Tx) => Promise<readonly Row[]>;
    readonly cas: (tx: Tx, edit: CatalogFullEditUnit) => Promise<Row | null>;
  }): Promise<CatalogMetadataV1Response> {
    if (!isValidCatalogName(args.edit.name)) throw badInput();
    const name = normalizeCatalogName(args.edit.name);
    const edit = { ...args.edit, name };
    return this.uow.run(args.ctx, async tx => {
      // Always check CURRENT grants inside the same tenant UoW, not old JWT hints.
      await this.access.require(tx, args.ctx, args.permission);
      const before = await args.find(tx);
      if (before === null) throw new AppError(ErrorCode.NOT_FOUND, 'Catalog entry not found');
      if (before.version !== args.expectedVersion) throw stale();

      const candidates = await args.list(tx);
      const clash = candidates.find(other =>
        other.id !== before.id &&
        (args.kind !== 'category' ||
          ('parentId' in before && 'parentId' in other && before.parentId === other.parentId)) &&
        catalogNameKey(other.name) === catalogNameKey(name));
      if (clash) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A catalog entry with this name already exists');
      }

      // One version-checked full-row CAS; never chain a legacy name-only rename
      // and a Bengali metadata PATCH, even within a transaction.
      const after = await args.cas(tx, edit);
      if (after === null) throw stale();
      assertAfter(args.kind, before, after, edit);

      await this.audit.append(tx, args.ctx, {
        entityType: args.kind, entityId: args.id, action: 'UPDATE',
        before: toAudit(before), after: toAudit(after), source: 'API',
      });
      await this.outbox.append(tx, args.ctx, {
        eventType: args.kind + '.updated',
        aggregateType: args.kind,
        aggregateId: args.id,
        payload: {
          name: after.name, nameBn: after.nameBn,
          ...('symbol' in after ? { symbol: after.symbol } : {}),
          ...('parentId' in after ? { parentId: after.parentId } : {}),
          version: after.version,
        },
      });
      // Strict versioned projection under the SAME transaction.
      return this.readCatalog(tx, args.ctx);
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
      units, brands, categories,
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

function assertAfter(kind: Kind, before: Row, after: Row, edit: CatalogFullEditUnit): void {
  const schema = kind === 'unit' ? catalogMetadataV1UnitSchema
    : kind === 'brand' ? catalogMetadataV1BrandSchema : catalogMetadataV1CategorySchema;
  const shape = schema.safeParse(after);
  const expectedNameBn = edit.nameBn !== undefined ? edit.nameBn : before.nameBn;
  const invalid = !shape.success ||
    after.id !== before.id ||
    after.name !== edit.name ||
    after.nameBn !== expectedNameBn ||
    after.version !== before.version + 1 ||
    (kind === 'unit' &&
      (!('symbol' in before) || !('symbol' in after) ||
        after.symbol !== (edit.symbol !== undefined ? edit.symbol : before.symbol))) ||
    (kind === 'category' &&
      (!('parentId' in before) || !('parentId' in after) ||
        after.parentId !== before.parentId));
  if (invalid) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'Catalog adapter returned an invalid full edit');
  }
}

function toAudit(row: Row): AuditValues {
  return {
    name: row.name, nameBn: row.nameBn,
    ...('symbol' in row ? { symbol: row.symbol } : {}),
    ...('parentId' in row ? { parentId: row.parentId } : {}),
    version: row.version,
  };
}
function stale(): AppError {
  return new AppError(ErrorCode.CONFLICT_STALE_VERSION, 'This catalog entry changed. Refresh and retry.');
}
function badInput(): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid full catalog edit request');
}
