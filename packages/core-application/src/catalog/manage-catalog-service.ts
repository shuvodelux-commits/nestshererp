import { catalogNameKey, isValidCatalogName, normalizeCatalogName } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type { CatalogResponse, RemoveCatalogEntryResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { CatalogEntry, CatalogRepository, CategoryEntry } from './catalog-repository';
import type { ProductRepository } from './product-repository';

/**
 * The vocabulary a product is described with: units of measure (D-10), brands
 * and categories (§5.5). Phase 2, path 2.1.
 *
 * **WRITE CLASS: M** (R-D). Master data: tenant context → permission → load →
 * invariant → persist → audit + outbox → commit, in one transaction. No period
 * guard, no journal, no stock movement and no document number, because renaming
 * a brand is none of those things — imitating those steps here with no-ops is
 * explicitly forbidden.
 *
 * **No idempotency key.** R-D3 asks for one on a Class M creation "when a retry
 * could duplicate a record". It cannot here: names are unique per tenant,
 * case-insensitively, enforced by a unique index. A resubmitted "add brand
 * Pran" is refused as a duplicate rather than creating a second Pran, which is
 * the outcome an idempotency key would have bought.
 *
 * Removal follows §3.6 exactly: a name nothing refers to is **deleted**, a name
 * something already carries is **archived** (soft-deleted), so existing products
 * keep reading correctly while the name stops being offered for new ones.
 */
export interface ListCatalogCommand {
  readonly ctx: TenantContext;
}

export interface SaveCatalogNameCommand {
  readonly ctx: TenantContext;
  readonly name: string;
}

export interface EditCatalogNameCommand extends SaveCatalogNameCommand {
  readonly id: string;
}

export interface CreateCategoryCommand extends SaveCatalogNameCommand {
  readonly parentId: string | null;
}

export interface RemoveCatalogEntryCommand {
  readonly ctx: TenantContext;
  readonly id: string;
}

export class ManageCatalogService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly catalog: CatalogRepository,
    private readonly products: ProductRepository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  /**
   * Every list in one response. Reading the vocabulary needs no code of its own:
   * a product form cannot be drawn without it, so product view is what admits
   * the caller.
   */
  async list(command: ListCatalogCommand): Promise<CatalogResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_VIEW);
      return this.readCatalog(tx, ctx);
    });
  }

  /* ------------------------------------------------------------------ units */

  async createUnit(command: SaveCatalogNameCommand): Promise<CatalogResponse> {
    return this.create(command, {
      permission: Permission.UNIT_MANAGE,
      entityType: 'unit',
      existing: (tx, ctx) => this.catalog.listUnits(tx, ctx),
      insert: (tx, ctx, entry) => this.catalog.insertUnit(tx, ctx, entry),
    });
  }

  async renameUnit(command: EditCatalogNameCommand): Promise<CatalogResponse> {
    return this.rename(command, {
      permission: Permission.UNIT_MANAGE,
      entityType: 'unit',
      find: (tx, ctx, id) => this.catalog.findUnit(tx, ctx, id),
      existing: (tx, ctx) => this.catalog.listUnits(tx, ctx),
      rename: (tx, ctx, id, name) => this.catalog.renameUnit(tx, ctx, id, name),
    });
  }

  async removeUnit(command: RemoveCatalogEntryCommand): Promise<RemoveCatalogEntryResponse> {
    return this.remove(command, {
      permission: Permission.UNIT_MANAGE,
      entityType: 'unit',
      find: (tx, ctx, id) => this.catalog.findUnit(tx, ctx, id),
      countReferences: (tx, ctx, id) => this.products.countUsingUnit(tx, ctx, id),
      archive: (tx, ctx, id) => this.catalog.archiveUnit(tx, ctx, id),
      hardDelete: (tx, ctx, id) => this.catalog.deleteUnit(tx, ctx, id),
    });
  }

  /* ----------------------------------------------------------------- brands */

  async createBrand(command: SaveCatalogNameCommand): Promise<CatalogResponse> {
    return this.create(command, {
      permission: Permission.BRAND_MANAGE,
      entityType: 'brand',
      existing: (tx, ctx) => this.catalog.listBrands(tx, ctx),
      insert: (tx, ctx, entry) => this.catalog.insertBrand(tx, ctx, entry),
    });
  }

  async renameBrand(command: EditCatalogNameCommand): Promise<CatalogResponse> {
    return this.rename(command, {
      permission: Permission.BRAND_MANAGE,
      entityType: 'brand',
      find: (tx, ctx, id) => this.catalog.findBrand(tx, ctx, id),
      existing: (tx, ctx) => this.catalog.listBrands(tx, ctx),
      rename: (tx, ctx, id, name) => this.catalog.renameBrand(tx, ctx, id, name),
    });
  }

  async removeBrand(command: RemoveCatalogEntryCommand): Promise<RemoveCatalogEntryResponse> {
    return this.remove(command, {
      permission: Permission.BRAND_MANAGE,
      entityType: 'brand',
      find: (tx, ctx, id) => this.catalog.findBrand(tx, ctx, id),
      countReferences: (tx, ctx, id) => this.products.countUsingBrand(tx, ctx, id),
      archive: (tx, ctx, id) => this.catalog.archiveBrand(tx, ctx, id),
      hardDelete: (tx, ctx, id) => this.catalog.deleteBrand(tx, ctx, id),
    });
  }

  /* ------------------------------------------------------------- categories */

  async createCategory(command: CreateCategoryCommand): Promise<CatalogResponse> {
    const { ctx } = command;
    const name = this.requireName(command.name);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.CATEGORY_MANAGE);

      const parent = await this.resolveParent(tx, ctx, command.parentId);
      const siblings = (await this.catalog.listCategories(tx, ctx)).filter(
        (candidate) => candidate.parentId === command.parentId,
      );
      this.assertNameFree(siblings, name, 'category');

      const entry: CategoryEntry = {
        id: Ulid.generate(this.clock),
        name,
        parentId: command.parentId,
      };
      await this.catalog.insertCategory(tx, ctx, entry);

      await this.audit.append(tx, ctx, {
        entityType: 'category',
        entityId: entry.id,
        action: 'CREATE',
        before: null,
        after: { name, parent: parent === null ? null : parent.name },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'category.created',
        aggregateType: 'category',
        aggregateId: entry.id,
        payload: { name, parentId: command.parentId },
      });

      return this.readCatalog(tx, ctx);
    });
  }

  async renameCategory(command: EditCatalogNameCommand): Promise<CatalogResponse> {
    const { ctx } = command;
    const name = this.requireName(command.name);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.CATEGORY_MANAGE);

      const before = await this.catalog.findCategory(tx, ctx, command.id);
      if (before === null) throw notFound('category');

      const siblings = (await this.catalog.listCategories(tx, ctx)).filter(
        (candidate) => candidate.parentId === before.parentId && candidate.id !== command.id,
      );
      this.assertNameFree(siblings, name, 'category');

      await this.catalog.renameCategory(tx, ctx, command.id, name);
      await this.audit.append(tx, ctx, {
        entityType: 'category',
        entityId: command.id,
        action: 'UPDATE',
        before: { name: before.name },
        after: { name },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'category.updated',
        aggregateType: 'category',
        aggregateId: command.id,
        payload: { name },
      });

      return this.readCatalog(tx, ctx);
    });
  }

  async removeCategory(command: RemoveCatalogEntryCommand): Promise<RemoveCatalogEntryResponse> {
    return this.remove(command, {
      permission: Permission.CATEGORY_MANAGE,
      entityType: 'category',
      find: (tx, ctx, id) => this.catalog.findCategory(tx, ctx, id),
      countBlockers: (tx, ctx, id) => this.catalog.countSubcategories(tx, ctx, id),
      blockerRefusal:
        'This category still has subcategories. Remove them first, or remove one of them instead.',
      countReferences: (tx, ctx, id) => this.products.countUsingCategory(tx, ctx, id),
      archive: (tx, ctx, id) => this.catalog.archiveCategory(tx, ctx, id),
      hardDelete: (tx, ctx, id) => this.catalog.deleteCategory(tx, ctx, id),
    });
  }

  /* ------------------------------------------------------- shared mechanics */

  private async readCatalog(tx: Tx, ctx: TenantContext): Promise<CatalogResponse> {
    const [units, brands, categories, stored] = await Promise.all([
      this.catalog.listUnits(tx, ctx),
      this.catalog.listBrands(tx, ctx),
      this.catalog.listCategories(tx, ctx),
      this.settings.listStored(tx, ctx),
    ]);

    // §5.21 in the order that matters: what the shop has switched on decides
    // which fields the product form may offer at all (UI-09).
    const values = settingValuesOf(stored);

    return {
      features: {
        productOffers: isFeatureOn(values, SettingKey.PRODUCT_OFFERS_ENABLED),
        expiryTracking: isFeatureOn(values, SettingKey.EXPIRY_TRACKING_ENABLED),
        serialTracking: isFeatureOn(values, SettingKey.SERIAL_TRACKING_ENABLED),
        warranty: isFeatureOn(values, SettingKey.WARRANTY_ENABLED),
        customerGroups: isFeatureOn(values, SettingKey.CUSTOMER_GROUPS_ENABLED),
        vendors: isFeatureOn(values, SettingKey.VENDOR_MANAGEMENT_ENABLED),
      },
      units: units.map((unit) => ({ id: unit.id, name: unit.name })),
      brands: brands.map((brand) => ({ id: brand.id, name: brand.name })),
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        parentId: category.parentId,
      })),
    };
  }

  private async create(
    command: SaveCatalogNameCommand,
    kind: {
      permission: Permission;
      entityType: string;
      existing: (tx: Tx, ctx: TenantContext) => Promise<readonly CatalogEntry[]>;
      insert: (tx: Tx, ctx: TenantContext, entry: CatalogEntry) => Promise<void>;
    },
  ): Promise<CatalogResponse> {
    const { ctx } = command;
    const name = this.requireName(command.name);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, kind.permission);
      this.assertNameFree(await kind.existing(tx, ctx), name, kind.entityType);

      const entry: CatalogEntry = { id: Ulid.generate(this.clock), name };
      await kind.insert(tx, ctx, entry);

      await this.audit.append(tx, ctx, {
        entityType: kind.entityType,
        entityId: entry.id,
        action: 'CREATE',
        before: null,
        after: { name },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: `${kind.entityType}.created`,
        aggregateType: kind.entityType,
        aggregateId: entry.id,
        payload: { name },
      });

      return this.readCatalog(tx, ctx);
    });
  }

  private async rename(
    command: EditCatalogNameCommand,
    kind: {
      permission: Permission;
      entityType: string;
      find: (tx: Tx, ctx: TenantContext, id: string) => Promise<CatalogEntry | null>;
      existing: (tx: Tx, ctx: TenantContext) => Promise<readonly CatalogEntry[]>;
      rename: (tx: Tx, ctx: TenantContext, id: string, name: string) => Promise<void>;
    },
  ): Promise<CatalogResponse> {
    const { ctx } = command;
    const name = this.requireName(command.name);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, kind.permission);

      const before = await kind.find(tx, ctx, command.id);
      if (before === null) throw notFound(kind.entityType);

      const others = (await kind.existing(tx, ctx)).filter((entry) => entry.id !== command.id);
      this.assertNameFree(others, name, kind.entityType);

      await kind.rename(tx, ctx, command.id, name);
      await this.audit.append(tx, ctx, {
        entityType: kind.entityType,
        entityId: command.id,
        action: 'UPDATE',
        before: { name: before.name },
        after: { name },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: `${kind.entityType}.updated`,
        aggregateType: kind.entityType,
        aggregateId: command.id,
        payload: { name },
      });

      return this.readCatalog(tx, ctx);
    });
  }

  private async remove(
    command: RemoveCatalogEntryCommand,
    kind: {
      permission: Permission;
      entityType: string;
      find: (tx: Tx, ctx: TenantContext, id: string) => Promise<CatalogEntry | null>;
      /**
       * Rows that make the removal impossible rather than merely historical — a
       * category's own subcategories. Refused with `blockerRefusal`.
       */
      countBlockers?: (tx: Tx, ctx: TenantContext, id: string) => Promise<number>;
      blockerRefusal?: string;
      /** How many products still carry this; decides archive versus delete (§3.6). */
      countReferences: (tx: Tx, ctx: TenantContext, id: string) => Promise<number>;
      archive: (tx: Tx, ctx: TenantContext, id: string) => Promise<void>;
      hardDelete: (tx: Tx, ctx: TenantContext, id: string) => Promise<void>;
    },
  ): Promise<RemoveCatalogEntryResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, kind.permission);

      const before = await kind.find(tx, ctx, command.id);
      if (before === null) throw notFound(kind.entityType);

      if (kind.countBlockers !== undefined && kind.blockerRefusal !== undefined) {
        const blockers = await kind.countBlockers(tx, ctx, command.id);
        if (blockers > 0) throw new AppError(ErrorCode.VALIDATION_FAILED, kind.blockerRefusal);
      }

      const references = await kind.countReferences(tx, ctx, command.id);

      // §3.6: soft delete if referenced, hard delete only if never used.
      const outcome = references > 0 ? 'ARCHIVED' : 'DELETED';
      if (references > 0) await kind.archive(tx, ctx, command.id);
      else await kind.hardDelete(tx, ctx, command.id);

      await this.audit.append(tx, ctx, {
        entityType: kind.entityType,
        entityId: command.id,
        action: outcome === 'ARCHIVED' ? 'ARCHIVE' : 'DELETE',
        before: { name: before.name },
        after: null,
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: `${kind.entityType}.removed`,
        aggregateType: kind.entityType,
        aggregateId: command.id,
        payload: { name: before.name, outcome },
      });

      return { outcome };
    });
  }

  /**
   * A subcategory may not have children: §5.5 describes
   * category/group/subcategory, which is two levels, and a third would give the
   * same product two competing group filters.
   */
  private async resolveParent(
    tx: Tx,
    ctx: TenantContext,
    parentId: string | null,
  ): Promise<CategoryEntry | null> {
    if (parentId === null) return null;

    const parent = await this.catalog.findCategory(tx, ctx, parentId);
    if (parent === null) throw notFound('category');
    if (parent.parentId !== null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `${parent.name} is already a subcategory. Categories go two levels deep, not three.`,
      );
    }
    return parent;
  }

  private requireName(value: string): string {
    if (!isValidCatalogName(value)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter a name of 1 to 120 characters');
    }
    return normalizeCatalogName(value);
  }

  /**
   * Case-insensitive duplicate detection, matching the `lower(name)` unique
   * index in migration 0007. Checked here so the shopkeeper is told which name
   * clashed; the index is what makes it true under a concurrent second save.
   */
  private assertNameFree(
    existing: readonly CatalogEntry[],
    name: string,
    entityType: string,
  ): void {
    const key = catalogNameKey(name);
    const clash = existing.find((entry) => catalogNameKey(entry.name) === key);
    if (clash !== undefined) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `${clash.name} already exists as a ${entityType}`,
      );
    }
  }
}

function notFound(entityType: string): AppError {
  // Another tenant's row is simply not found — never a 403 (§5.26).
  return new AppError(ErrorCode.NOT_FOUND, `That ${entityType} was not found`);
}
