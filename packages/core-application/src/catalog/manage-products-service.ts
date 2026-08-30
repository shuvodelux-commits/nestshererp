import {
  blankToNull,
  displayNameOf,
  isValidCatalogName,
  normalizeCatalogName,
  offerAppliesAt,
  rejectConversion,
  rejectPricing,
  stockStatus,
  stockValueMinor,
  searchProducts,
} from '@sher/core-domain';
import type { ConversionRejection, PricingRejection, ProductStatus } from '@sher/core-domain';
import { AppError, defaultDirectionFor, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type { ProductSort, SortDirection } from '@sher/core-contracts';
import type {
  GeneratedBarcodeResponse,
  ProductListResponse,
  ProductResponse,
} from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { businessDateAt, endOfBusinessDay, startOfBusinessDay, Ulid } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { InventoryRepository } from '../inventory/inventory-repository';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { CatalogRepository } from './catalog-repository';
import type {
  ProductEdit,
  ProductFilter,
  ProductRepository,
  ProductRow,
} from './product-repository';

/**
 * Products (Phase 2, path 2.2, §5.5).
 *
 * **WRITE CLASS: M** (R-D). Master data: tenant context → permission → feature
 * gate → idempotency → load → invariants and optimistic lock → persist → audit +
 * outbox → commit, in one transaction. No period guard, no journal entry and no
 * stock movement — a product is not a document, and inventing those steps here
 * would be the fake write path R-D explicitly forbids.
 *
 * **Opening stock is not written here.** §5.5 defaults it to `0` and sends an
 * authorised opening entry "through the normal stock-opening service", which is
 * Phase 3. A quantity written from this form would be stock with no movement and
 * no journal behind it — INV-02 and INV-05 would both be false immediately.
 *
 * **Cost never leaves without `inventory.cost.view`.** `purchasePriceMinor` is
 * *deleted from the response object*, not zeroed or blanked (UI-40, §5.26: "the
 * column is absent from the API response"). Hiding a column in Vue while the API
 * still sends it means anyone can read it in the network tab.
 */
export interface ListProductsCommand {
  readonly ctx: TenantContext;
  readonly search?: string | undefined;
  readonly brandId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly status?: ProductStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  /** Which header was tapped, and which way (UI-46). */
  readonly sort?: ProductSort | undefined;
  readonly direction?: SortDirection | undefined;
}

export interface GetProductCommand {
  readonly ctx: TenantContext;
  readonly productId: string;
}

/** The fields §5.5 defines, as they arrive from the form or a CSV row. */
export interface ProductInput {
  readonly name: string;
  readonly baseUnitId: string;
  readonly purchasePriceMinor: number;
  readonly sellingPriceMinor: number;
  readonly minStockQty: number;
  readonly brandId: string | null;
  readonly categoryId: string | null;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly description: string | null;
  readonly defaultDiscountType: 'FIXED_AMOUNT' | 'PERCENTAGE' | null;
  readonly defaultDiscountValue: number | null;
  readonly offerEnabled: boolean;
  readonly offerPriceMinor: number | null;
  /** Tenant-local day; converted to an instant here, never in SQL (§3.5). */
  readonly offerStartDate: string | null;
  readonly offerEndDate: string | null;
  readonly tracksExpiry: boolean;
  readonly tracksSerial: boolean;
  /**
   * The optional conversion (D-41): one unit, and how many base units it holds.
   * Both or neither — half a rule is what turns a purchase of 5 Pipes into 5
   * Feet of stock.
   */
  readonly conversionUnitId: string | null;
  readonly conversionFactorQty: number | null;
  /**
   * Phase 8, all optional (owner decisions 2026-08-26). The usual supplier is
   * what the purchase planner assumes; the minimum order is the smallest that
   * supplier will sell; the two warranty figures are months, one clock running
   * from the sale and the other from the delivery.
   */
  readonly usualSupplierId: string | null;
  readonly minOrderQty: number | null;
  readonly warrantyMonths: number | null;
  readonly supplierWarrantyMonths: number | null;
}

export interface CreateProductCommand {
  readonly ctx: TenantContext;
  /** Client-generated ULID, reused verbatim on retry (§5.26, UI-34). */
  readonly operationId: string;
  readonly input: ProductInput;
}

export interface UpdateProductCommand {
  readonly ctx: TenantContext;
  readonly productId: string;
  readonly version: number;
  readonly input: ProductInput;
}

export interface SetProductStatusCommand {
  readonly ctx: TenantContext;
  readonly productId: string;
  readonly status: ProductStatus;
}

export interface ProductIdCommand {
  readonly ctx: TenantContext;
  readonly productId: string;
}

const ENTITY_TYPE = 'product';
const DEFAULT_LIMIT = 50;
/** §3.7's numbering, used for a generated product barcode. See `generateBarcode`. */
const BARCODE_DOC_TYPE = 'PRODUCT_BARCODE';

const PRICING_MESSAGES: Record<PricingRejection, string> = {
  PRICE_NOT_A_WHOLE_MINOR_UNIT: 'Enter prices as whole poisha',
  PRICE_NEGATIVE: 'A price cannot be less than zero',
  DISCOUNT_VALUE_WITHOUT_TYPE: 'Choose whether the discount is an amount or a percentage',
  DISCOUNT_TYPE_WITHOUT_VALUE: 'Enter how much the discount is',
  DISCOUNT_NEGATIVE: 'A discount cannot be less than zero',
  DISCOUNT_PERCENT_ABOVE_100: 'A percentage discount cannot be more than 100%',
  DISCOUNT_ABOVE_SELLING_PRICE:
    'The discount is more than the selling price, which would make the price negative',
  OFFER_PRICE_NOT_POSITIVE: 'Enter the offer price',
  OFFER_WINDOW_ENDS_BEFORE_IT_STARTS: 'The offer cannot end before it starts',
};

const CONVERSION_MESSAGES: Record<ConversionRejection, string> = {
  CONVERSION_UNIT_WITHOUT_FACTOR: 'Enter how many base units one of them contains',
  CONVERSION_FACTOR_WITHOUT_UNIT: 'Choose the unit this product also comes in',
  CONVERSION_FACTOR_NOT_POSITIVE: 'A conversion must be more than zero base units',
  CONVERSION_UNIT_IS_THE_BASE_UNIT:
    'The conversion unit has to be different from the base unit — it is what converts to it',
};

export class ManageProductsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly products: ProductRepository,
    private readonly catalog: CatalogRepository,
    private readonly settings: SettingsRepository,
    private readonly idempotency: IdempotencyStore,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    /** Read-only here: the §3.6 delete guard asks it whether stock ever moved. */
    private readonly inventory: InventoryRepository,
  ) {}

  async list(command: ListProductsCommand): Promise<ProductListResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_VIEW);
      const showCost = await this.maySeeCost(tx, ctx);

      const sort = command.sort ?? 'name';

      // Sorting by a figure the caller may not read hands them the figure.
      // Ordering by purchase price without `inventory.cost.view` ranks every
      // product by cost, which is the very thing UI-40 keeps out of the response
      // body. Refused rather than silently re-sorted: a list that came back in a
      // different order than asked is worse than being told no.
      if (sort === 'purchasePrice' && !showCost) {
        throw new AppError(
          'PERMISSION_DENIED',
          'You cannot sort by purchase price without permission to see cost',
        );
      }

      const limit = command.limit ?? DEFAULT_LIMIT;
      const filter: ProductFilter = {
        search: command.search ?? null,
        brandId: command.brandId ?? null,
        categoryId: command.categoryId ?? null,
        status: command.status ?? null,
        cursor: command.cursor ?? null,
        sort,
        direction: command.direction ?? defaultDirectionFor(sort),
        // One more than asked for, so "is there another page" is answered by the
        // same query rather than by a second count (§3.9 keyset paging).
        limit: limit + 1,
      };

      const [rows, counts] = await Promise.all([
        this.products.list(tx, ctx, filter),
        this.products.count(tx, ctx, filter),
      ]);

      /*
       * The same ranking the counter uses (`searchProducts`), so a shopkeeper
       * who learns what `sam a15` finds at the till finds the same thing, in
       * the same order, on the Products screen. Without a search term it is a
       * no-op and the caller's own sort stands.
       */
      const ranked = searchProducts(command.search ?? '', rows);
      const hasMore = ranked.length > limit;
      const page = hasMore ? ranked.slice(0, limit) : ranked;
      const now = this.clock.now();
      const method = await this.valuationMethod(tx, ctx);

      return {
        data: page.map((row) => this.toResponse(ctx, row, showCost, now, method)),
        page: {
          nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
          hasMore,
        },
        summary: counts,
      };
    });
  }

  /** One product — the Detail screen (UI-22). */
  async get(command: GetProductCommand): Promise<ProductResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_VIEW);
      const showCost = await this.maySeeCost(tx, ctx);

      const row = await this.requireProduct(tx, ctx, command.productId);

      return this.toResponse(ctx, row, showCost, this.clock.now(), await this.valuationMethod(tx, ctx));
    });
  }

  async create(command: CreateProductCommand): Promise<ProductResponse> {
    const { ctx } = command;
    const fingerprint = JSON.stringify(command.input);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_CREATE);

      /*
       * R-D3: a Class M creation is idempotent "when a retry could duplicate a
       * record". It could here — two products may legitimately share a name, so
       * there is no natural key for a unique index to catch a replay with, which
       * is exactly why the operation id is checked.
       *
       * The 30-day fast path is therefore the whole guarantee here, unlike a
       * document (R-C10), and that is a deliberate limit: an offline device
       * replaying a months-old product creation would create a second row. Sync
       * arrives in Phase 12 and must reconcile master data by identity, not by
       * hoping this table still holds the key.
       */
      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used with a different product',
          );
        }
        return replayed.response as ProductResponse;
      }

      const response = await this.createWithin(tx, ctx, command.input, 'API');

      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }

  /**
   * Creating one product inside a transaction the **caller** owns.
   *
   * Split out for the guided CSV import (§5.6), which must post a whole file
   * all-or-nothing: one file is one transaction (R-D5), so the importer cannot
   * call `create` once per row — each call would open and commit its own. It
   * calls this instead, and every rule a typed-in product passes, an imported
   * one passes too: the same permission, the same `validate`, the same insert,
   * the same audit and outbox rows. There is one product writer (A11, A14).
   *
   * Idempotency stays with the caller: a form submission is idempotent on its
   * own row, an import on the whole file.
   */
  async createWithin(
    tx: Tx,
    ctx: TenantContext,
    input: ProductInput,
    source: string,
  ): Promise<ProductResponse> {
    await this.accessControl.require(tx, ctx, Permission.PRODUCT_CREATE);

    const clean = await this.validate(tx, ctx, input, null);
    const id = Ulid.generate(this.clock);

    await this.products.insert(tx, ctx, { id, ...clean });

    await this.audit.append(tx, ctx, {
      entityType: ENTITY_TYPE,
      entityId: id,
      action: 'CREATE',
      before: null,
      after: this.auditValues(clean),
      source,
    });
    await this.outbox.append(tx, ctx, {
      eventType: 'product.created',
      aggregateType: ENTITY_TYPE,
      aggregateId: id,
      payload: { name: clean.name, sku: clean.sku },
    });

    const created = await this.requireProduct(tx, ctx, id);
    return this.toResponse(
      ctx,
      created,
      await this.maySeeCost(tx, ctx),
      this.clock.now(),
      await this.valuationMethod(tx, ctx),
    );
  }

  async update(command: UpdateProductCommand): Promise<ProductResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_EDIT);

      const before = await this.requireProduct(tx, ctx, command.productId);
      const clean = await this.validate(tx, ctx, command.input, command.productId);

      // D-32: optimistic lock. Two people editing one product must not have the
      // second save silently overwrite the first — the second is told instead.
      const saved = await this.products.update(
        tx,
        ctx,
        command.productId,
        command.version,
        clean,
      );
      if (!saved) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this product while you were editing it. Reopen it and try again.',
        );
      }


      /*
       * §5.5: "Posted historical documents never change when product master data
       * changes." Nothing here touches a document — the invoice line keeps its own
       * snapshot of the price and discount that were applied (§5.5, §5.7). This
       * audit row is what connects "the price changed" to "the old invoices did
       * not", which is the question an owner asks months later.
       */
      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: command.productId,
        action: 'UPDATE',
        before: this.auditValues(before),
        after: this.auditValues(clean),
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'product.updated',
        aggregateType: ENTITY_TYPE,
        aggregateId: command.productId,
        payload: { name: clean.name },
      });

      const updated = await this.requireProduct(tx, ctx, command.productId);
      return this.toResponse(ctx, updated, await this.maySeeCost(tx, ctx), this.clock.now(), await this.valuationMethod(tx, ctx));
    });
  }

  /**
   * §5.5: "Inactive products remain in history but are excluded from new POS
   * selection and new purchasing unless explicitly reactivated."
   *
   * G2.3: status and stock are independent. Nothing here reads a quantity, and
   * nothing later may infer inactive from zero stock.
   */
  async setStatus(command: SetProductStatusCommand): Promise<ProductResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_DEACTIVATE);

      const before = await this.requireProduct(tx, ctx, command.productId);
      await this.products.setStatus(tx, ctx, command.productId, command.status);

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: command.productId,
        action: command.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE',
        before: { status: before.status },
        after: { status: command.status },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'product.status_changed',
        aggregateType: ENTITY_TYPE,
        aggregateId: command.productId,
        payload: { status: command.status },
      });

      const updated = await this.requireProduct(tx, ctx, command.productId);
      return this.toResponse(ctx, updated, await this.maySeeCost(tx, ctx), this.clock.now(), await this.valuationMethod(tx, ctx));
    });
  }

  /**
   * §5.5's "product barcode generation", for goods that arrive without one —
   * loose rice, a tailor's own make.
   *
   * The value comes from the existing `NumberingService` (§3.7:
   * `{PREFIX}-{YYYY}-{NNNNNN}`, allocated under `SELECT … FOR UPDATE`), so it is
   * unique per tenant with no gaps and no second counter mechanism to get wrong.
   * It is **not** an EAN-13: no part of v4 specifies a symbology, and inventing a
   * GS1 in-store numbering scheme would be a fabricated business rule (R-A5).
   * Scanners read it as keyboard input terminated by Enter (UI-38), which any
   * Code 128 label satisfies.
   */
  /**
   * A product's thumbnail (owner decision 2026-08-25): upload, replace, remove.
   *
   * **WRITE CLASS: M.** Deliberately not a media library — no gallery, no
   * variants, no alt text. The bytes arrive already resized by the browser and
   * are stored with the tenant's own data, so a backup carries them and an
   * on-prem install needs no object store.
   */
  async saveImage(command: {
    readonly ctx: TenantContext;
    readonly productId: string;
    readonly image: { readonly mime: string; readonly dataBase64: string } | null;
  }): Promise<ProductResponse> {
    const { ctx } = command;
    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_EDIT);
      const before = await this.products.findById(tx, ctx, command.productId);
      if (before === null) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');

      const bytes =
        command.image === null ? null : Buffer.from(command.image.dataBase64, 'base64');
      // The migration's CHECK is the last word on size; refusing here means the
      // shopkeeper is told rather than shown a database error.
      if (bytes !== null && bytes.length > 262144) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That picture is too large');
      }

      await this.products.setImage(
        tx,
        ctx,
        command.productId,
        command.image === null || bytes === null
          ? null
          : { mime: command.image.mime, bytes },
      );

      await this.audit.append(tx, ctx, {
        entityType: 'product',
        entityId: command.productId,
        action: 'UPDATE',
        before: null,
        after: { image: command.image === null ? 'removed' : 'set' },
        source: 'API',
      });

      const updated = await this.requireProduct(tx, ctx, command.productId);
      return this.toResponse(
        ctx,
        updated,
        await this.maySeeCost(tx, ctx),
        this.clock.now(),
        await this.valuationMethod(tx, ctx),
      );
    });
  }

  /** The bytes themselves, for the tag on the POS grid and the product form. */
  async image(
    ctx: TenantContext,
    productId: string,
  ): Promise<{ readonly mime: string; readonly bytes: Uint8Array }> {
    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_VIEW);
      const image = await this.products.findImage(tx, ctx, productId);
      if (image === null) throw new AppError(ErrorCode.NOT_FOUND, 'This product has no picture');
      return image;
    });
  }

  async generateBarcode(command: ProductIdCommand): Promise<GeneratedBarcodeResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_EDIT);

      const product = await this.requireProduct(tx, ctx, command.productId);
      if (product.barcode !== null) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This product already has a barcode. Clear it first if you want a new one.',
        );
      }

      const year = Number(this.clock.businessDate(ctx.timezone).slice(0, 4));
      const barcode = await this.numbering.allocate(tx, ctx, BARCODE_DOC_TYPE, year);
      await this.products.setBarcode(tx, ctx, command.productId, barcode);

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: command.productId,
        action: 'UPDATE',
        before: { barcode: null },
        after: { barcode },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'product.updated',
        aggregateType: ENTITY_TYPE,
        aggregateId: command.productId,
        payload: { barcode },
      });

      return { barcode };
    });
  }

  /**
   * §3.6: master data is hard-deleted "only if never used", and soft-deleted once
   * something refers to it. A product that has never been stocked is genuinely
   * removable; one with any movement behind it is refused and the caller is told
   * to deactivate instead, which keeps every posted document that names it.
   *
   * **Every later module that references a product must add its count to
   * `assertNeverUsed`.** The check belongs in one named place rather than being
   * left to a foreign key to fail with a 500.
   */
  async deleteProduct(command: ProductIdCommand): Promise<void> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PRODUCT_DELETE);

      const before = await this.requireProduct(tx, ctx, command.productId);
      await this.assertNeverUsed(tx, ctx, command.productId);

      await this.products.deleteUnused(tx, ctx, command.productId);

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: command.productId,
        action: 'DELETE',
        before: this.auditValues(before),
        after: null,
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'product.deleted',
        aggregateType: ENTITY_TYPE,
        aggregateId: command.productId,
        payload: { name: before.name },
      });
    });
  }

  /* ------------------------------------------------------- shared mechanics */

  /**
   * Everything that must be true of a product before it is stored, in one place
   * so the single-product form and the CSV import (path 2.4) cannot disagree —
   * DRY applies to rules.
   */
  async validate(
    tx: Tx,
    ctx: TenantContext,
    input: ProductInput,
    /** The product being edited, so its own codes do not clash with themselves. */
    selfId: string | null,
  ): Promise<ProductEdit> {
    if (!isValidCatalogName(input.name)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter a product name');
    }
    const name = normalizeCatalogName(input.name);

    const values = settingValuesOf(await this.settings.listStored(tx, ctx));
    const offersOn = isFeatureOn(values, SettingKey.PRODUCT_OFFERS_ENABLED);
    const expiryOn = isFeatureOn(values, SettingKey.EXPIRY_TRACKING_ENABLED);
    const serialOn = isFeatureOn(values, SettingKey.SERIAL_TRACKING_ENABLED);

    /*
     * §5.21: `Plan → Feature → Setting → Permission → Access`, and "turning a
     * feature off hides new-use UI but preserves historical data". A product that
     * already carries an offer keeps it; what is refused is *setting* one while
     * the feature is off, which would be data nobody can see or manage.
     */
    const wantsOffer =
      input.offerEnabled ||
      input.offerPriceMinor !== null ||
      input.defaultDiscountType !== null ||
      input.offerStartDate !== null ||
      input.offerEndDate !== null;
    if (wantsOffer && !offersOn) {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Product offers and default discounts are switched off in Settings',
      );
    }
    if (input.tracksExpiry && !expiryOn) {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Expiry tracking is switched off in Settings',
      );
    }
    if (input.tracksSerial && !serialOn) {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Serial tracking is switched off in Settings',
      );
    }

    const offerStartAt =
      input.offerStartDate === null ? null : startOfBusinessDay(input.offerStartDate, ctx.timezone);
    /*
     * The end day is stored as its **last instant** in the shop's own timezone,
     * so an offer "until the 7th" runs through the whole of the 7th. The bound is
     * inclusive, which is what `offerAppliesAt` compares against, and the response
     * converts the instant back to the day the shopkeeper chose — the server owns
     * both directions, so no client can be a day out (§3.5).
     */
    const offerEndAt =
      input.offerEndDate === null ? null : endOfBusinessDay(input.offerEndDate, ctx.timezone);

    const rejection = rejectPricing({
      purchasePriceMinor: input.purchasePriceMinor,
      sellingPriceMinor: input.sellingPriceMinor,
      defaultDiscountType: input.defaultDiscountType,
      defaultDiscountValue: input.defaultDiscountValue,
      offerPriceMinor: input.offerPriceMinor,
      offerStartAt,
      offerEndAt,
    });
    if (rejection !== null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, PRICING_MESSAGES[rejection]);
    }

    if (!Number.isSafeInteger(input.minStockQty) || input.minStockQty < 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A reorder level cannot be less than zero');
    }

    // The base unit, brand and category must be this tenant's own live rows.
    const baseUnit = await this.catalog.findUnit(tx, ctx, input.baseUnitId);
    if (baseUnit === null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose a unit this product is counted in');
    }
    if (input.brandId !== null && (await this.catalog.findBrand(tx, ctx, input.brandId)) === null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That brand was not found');
    }
    if (
      input.categoryId !== null &&
      (await this.catalog.findCategory(tx, ctx, input.categoryId)) === null
    ) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That category was not found');
    }

    const sku = blankToNull(input.sku);
    const barcode = blankToNull(input.barcode);
    if (sku !== null) {
      const owner = await this.products.findIdBySku(tx, ctx, sku);
      if (owner !== null && owner !== selfId) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, `Another product already uses the code ${sku}`);
      }
    }
    if (barcode !== null) {
      const owner = await this.products.findIdByBarcode(tx, ctx, barcode);
      if (owner !== null && owner !== selfId) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Another product already uses the barcode ${barcode}`,
        );
      }
    }

    /*
     * D-41's optional conversion. The shape rule — both halves or neither, a
     * positive factor, and not the base unit itself — is the domain's; this
     * layer only turns the refusal into words and checks the unit is one of this
     * tenant's own live rows.
     */
    const conversionRejection = rejectConversion(
      input.baseUnitId,
      blankToNull(input.conversionUnitId),
      input.conversionFactorQty,
    );
    if (conversionRejection !== null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, CONVERSION_MESSAGES[conversionRejection]);
    }

    const conversionUnitId = blankToNull(input.conversionUnitId);
    if (
      conversionUnitId !== null &&
      (await this.catalog.findUnit(tx, ctx, conversionUnitId)) === null
    ) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That unit was not found');
    }

    return {
        name,
        baseUnitId: input.baseUnitId,
        purchasePriceMinor: input.purchasePriceMinor,
        sellingPriceMinor: input.sellingPriceMinor,
        minStockQty: input.minStockQty,
        brandId: input.brandId,
        categoryId: input.categoryId,
        sku,
        barcode,
        description: blankToNull(input.description),
        defaultDiscountType: input.defaultDiscountType,
        defaultDiscountValue: input.defaultDiscountValue,
        offerEnabled: input.offerEnabled,
        offerPriceMinor: input.offerPriceMinor,
        offerStartAt,
        offerEndAt,
      tracksExpiry: input.tracksExpiry,
      tracksSerial: input.tracksSerial,
      conversionUnitId,
      conversionFactorQty: conversionUnitId === null ? null : input.conversionFactorQty,
      usualSupplierId: input.usualSupplierId,
      minOrderQty: input.minOrderQty,
      warrantyMonths: input.warrantyMonths,
      supplierWarrantyMonths: input.supplierWarrantyMonths,
    };
  }

  /** §5.26: cost is its own permission, checked on every read that could carry it. */
  private async maySeeCost(tx: Tx, ctx: TenantContext): Promise<boolean> {
    const held = await this.accessControl.permissionsOf(tx, ctx);
    return held.includes(Permission.COST_VIEW);
  }

  private async requireProduct(tx: Tx, ctx: TenantContext, id: string): Promise<ProductRow> {
    const product = await this.products.findById(tx, ctx, id);
    // Another tenant's product is simply not found — never a 403 (§5.26).
    if (product === null) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
    return product;
  }

  /**
   * §3.6: a product nothing refers to is removable; one with history is not.
   *
   * Stock is the first real referrer. Every movement — opening, adjustment, and
   * from Phase 5/6 purchases and sales — writes a `stock_movements` row, so one
   * question answers all of them, and it is asked **inside the transaction**
   * rather than trusting a quantity the dialog happened to be showing: a
   * product can read as zero on hand and still have a lifetime of movements
   * behind it, every one of which names it on a posted document.
   *
   * Phase 5 and Phase 6 must still add anything that references a product
   * *without* moving stock — a quotation line, a purchase order line — for the
   * same reason.
   */
  private async assertNeverUsed(tx: Tx, ctx: TenantContext, productId: string): Promise<void> {
    if (await this.inventory.productHasStockHistory(tx, ctx, productId)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'This product has stock history, so it cannot be deleted. Deactivate it instead — it will stop appearing in new sales and purchases, and everything already recorded stays as it is.',
      );
    }
  }

  /**
   * R-D4: money on both sides of an audited change, as stored integers. An audit
   * trail that rounds is not evidence.
   */
  private auditValues(product: ProductEdit | ProductRow): Record<string, string | number | null> {
    return {
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      sellingPriceMinor: product.sellingPriceMinor,
      purchasePriceMinor: product.purchasePriceMinor,
      minStockQty: product.minStockQty,
      defaultDiscountType: product.defaultDiscountType,
      defaultDiscountValue: product.defaultDiscountValue,
      offerPriceMinor: product.offerEnabled ? product.offerPriceMinor : null,
    };
  }

  private toResponse(
    ctx: TenantContext,
    row: ProductRow,
    showCost: boolean,
    now: Date,
    method: 'FIFO' | 'AVERAGE',
  ): ProductResponse {
    const { timezone } = ctx;

    /*
     * Built without the cost, which is then added only for a caller who holds
     * `inventory.cost.view`. Constructed this way round rather than deleted
     * afterwards, so the field cannot survive by accident (UI-40, R-E8).
     */
    const response: ProductResponse = {
      id: row.id,
      name: row.name,
      displayName: displayNameOf(row.brandName, row.name),
      brandId: row.brandId,
      brandName: row.brandName,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      parentCategoryName: row.parentCategoryName,
      sku: row.sku,
      barcode: row.barcode,
      description: row.description,
      baseUnitId: row.baseUnitId,
      baseUnitName: row.baseUnitName,
      sellingPriceMinor: row.sellingPriceMinor,
      minStockQty: row.minStockQty,
      status: row.status,
      defaultDiscountType: row.defaultDiscountType,
      defaultDiscountValue: row.defaultDiscountValue,
      offerEnabled: row.offerEnabled,
      offerPriceMinor: row.offerPriceMinor,
      // Back to the tenant-local days the shopkeeper actually chose (§3.5,
      // UI-33). Both bounds are inclusive, so both read straight across.
      offerStartDate:
        row.offerStartAt === null ? null : businessDateAt(row.offerStartAt, timezone),
      offerEndDate: row.offerEndAt === null ? null : businessDateAt(row.offerEndAt, timezone),
      offerLive: offerAppliesAt(
        {
          enabled: row.offerEnabled,
          offerPriceMinor: row.offerPriceMinor,
          offerStartAt: row.offerStartAt,
          offerEndAt: row.offerEndAt,
        },
        now,
      ),
      hasImage: row.hasImage,
      tracksExpiry: row.tracksExpiry,
      tracksSerial: row.tracksSerial,
      stockQty: row.stockQty,
      stockStatus: stockStatus(row.stockQty, row.minStockQty),
      hasStockHistory: row.hasStockHistory,
      usualSupplierId: row.usualSupplierId,
      usualSupplierName: row.usualSupplierName,
      minOrderQty: row.minOrderQty,
      warrantyMonths: row.warrantyMonths,
      supplierWarrantyMonths: row.supplierWarrantyMonths,
      /*
       * D-41: one conversion or none. Present only when the product genuinely
       * carries both halves — the schema, the migration's CHECK and the domain
       * all agree on that, so a client never has to guess what half a rule means.
       */
      conversion:
        row.conversionUnitId === null || row.conversionFactorQty === null
          ? null
          : {
              unitId: row.conversionUnitId,
              unitName: row.conversionUnitName ?? '',
              factorQty: row.conversionFactorQty,
            },
      version: row.version,
    };

    // UI-40 / R-E8: absent, not zeroed. A hidden column the API still sends is
    // readable in the network tab by anyone. Stock **value** is a cost figure
    // and goes with it; stock **quantity** is not, and stays.
    return showCost
      ? {
          ...response,
          purchasePriceMinor: row.purchasePriceMinor,
          stockValueMinor: this.stockValueOf(row, method),
        }
      : response;
  }

  /**
   * The valuation basis the tenant is actually on (D-05, INV-05).
   *
   * Under `FIFO` a product is worth the sum of its remaining lots; under
   * `AVERAGE` it is quantity times the moving average. Sending the wrong one
   * would put a figure on this list that disagrees with the valuation report
   * over the same stock, and INV-10 calls two reports disagreeing a blocking
   * defect rather than a rounding excuse.
   */
  private async valuationMethod(tx: Tx, ctx: TenantContext): Promise<'FIFO' | 'AVERAGE'> {
    const values = settingValuesOf(await this.settings.listStored(tx, ctx));
    return values.get(SettingKey.SALE_COSTING_METHOD) === 'AVERAGE' ? 'AVERAGE' : 'FIFO';
  }

  private stockValueOf(row: ProductRow, method: 'FIFO' | 'AVERAGE'): number {
    if (method === 'AVERAGE') {
      return row.stockQty <= 0 ? 0 : stockValueMinor(row.stockQty, row.avgUnitCost);
    }
    return row.lotValueMinor;
  }
}
