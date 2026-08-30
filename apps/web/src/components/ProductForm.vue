<script setup lang="ts">
import { qtyText } from './money/money-text';
import type {
  CatalogResponse,
  InventoryLot,
  ProductResponse,
  SaveProductRequest,
} from '@sher/core-contracts';
import {
  pricePerBaseUnit,
  pricePerConversionUnit,
  splitToMixed,
  toBaseQty,
} from '@sher/core-domain';
import { Money, parseMoney, parseQty, Qty, Ulid, SystemClock } from '@sher/shared-utils';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import {
  createCatalogEntry,
  EMPTY_CATALOG,
  fetchCatalog,
  removeCatalogEntry,
  renameCatalogEntry,
  type CatalogKind,
} from '../api/catalog';
import { ApiError } from '../api/client';
import { fetchInventoryLots, recordOpeningStock, setLotExpiry } from '../api/inventory';
import { fetchParties } from '../api/parties';
import {
  createProduct,
  deleteProduct,
  fetchProduct,
  generateProductBarcode,
  updateProduct,
  removeProductImage,
  saveProductImage,
} from '../api/products';
import { useSession } from '../auth/session';
import AppCard from './AppCard.vue';
import { resizeImage } from './sales/image-upload';
import DateOnlyPicker from './DateOnlyPicker.vue';
import ErrorNotice from './ErrorNotice.vue';
import HelpTip from './HelpTip.vue';
import QuickAddSelect from './QuickAddSelect.vue';

/**
 * "None" is a value the dropdown can hold. PrimeVue reads an empty model as
 * *nothing chosen* and draws the placeholder instead, which left the field
 * looking blank when the product simply has no default discount.
 */
const NO_DISCOUNT = 'none';

const discountTypeOptions = [
  { label: 'None', value: NO_DISCOUNT },
  { label: 'A fixed amount off', value: 'FIXED_AMOUNT' },
  { label: 'A percentage off', value: 'PERCENTAGE' },
];

/**
 * Add or edit a product (Phase 2, §5.5) — a Form screen (UI-22): single column,
 * grouped fields, one save.
 *
 * **Only five fields are required**, exactly the §5.5 set: name, unit, both
 * prices and the reorder level. Everything else is optional, and G2.2 forbids
 * making an optional field mandatory because a column exists.
 *
 * **Feature-dependent fields are hidden, not disabled** (UI-09): offers, expiry
 * and serial appear only while the shop has that feature on in Settings, because
 * the server refuses them otherwise and a control that 403s should never be
 * drawn.
 *
 * Money is parsed and formatted by `shared-utils` (UI-31): what is typed becomes
 * integer poisha before it leaves this screen, and no arithmetic on it happens
 * here.
 */
const clock = new SystemClock();
const session = useSession();

/**
 * The form itself, with no opinion about what surrounds it.
 *
 * §5.5 makes Products the working hub, so this opens as a dialog over the list
 * (UI-50) — but `/products/:id` is still a real route (UI-13) and a shopkeeper
 * may have it bookmarked. Both render **this** component, so there is one form,
 * one set of validations and one save path rather than two that drift apart.
 */
const props = defineProps<{
  /** `null` is a new product. */
  productId: string | null;
}>();

const emit = defineEmits<{
  /** Saved successfully — the caller decides where to go next (UI-64). */
  (event: 'saved', product: ProductResponse): void;
  /** Cancelled, or deleted, or the form could not be loaded. */
  (event: 'close'): void;
  (event: 'deleted'): void;
}>();

const productId = computed(() => props.productId);
const isNew = computed(() => productId.value === null);

const canEdit = computed(() => session.can('catalog.product.edit'));
const canCreate = computed(() => session.can('catalog.product.create'));
const canDelete = computed(() => session.can('catalog.product.delete'));
const canSave = computed(() => (isNew.value ? canCreate.value : canEdit.value));

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const formError = ref<{ code: string; message: string } | null>(null);
/** What just happened, shown above the form (UI-30: a toast is never the record). */
const notice = ref<string | null>(null);
const busy = ref(false);

const catalog = ref<CatalogResponse>(EMPTY_CATALOG);

/*
 * Which optional sections this shop has switched on (§5.21). They arrive with
 * the catalog, so the form needs no settings permission of its own — a
 * storekeeper who may add a product does not thereby hold `settings.setting.view`.
 */
const offersOn = computed(() => catalog.value.features.productOffers);
const expiryOn = computed(() => catalog.value.features.expiryTracking);

/**
 * The batches this product still holds, and their dates (§5.13).
 *
 * Loaded only for a saved product that tracks expiry — a new one has no stock
 * yet, and a product that does not track expiry has no dates to set. Saving is
 * per batch and immediate: it is one field, and a shopkeeper working down a
 * list of undated batches should not have to press Save at the bottom.
 */
const batches = ref<readonly InventoryLot[]>([]);
const batchDates = ref<Record<string, string>>({});
const savingBatch = ref<string | null>(null);

async function loadBatches(): Promise<void> {
  const token = session.accessToken.value;
  const id = productId.value;
  if (token === null || id === null) return;
  try {
    const page = await fetchInventoryLots(token, {
      productId: id,
      status: 'OPEN',
      limit: 50,
      sort: 'expiryDate',
      direction: 'ASC',
    });
    batches.value = page.data.filter((lot) => lot.qtyRemaining > 0);
    batchDates.value = Object.fromEntries(
      batches.value.map((lot) => [lot.id, lot.expiryDate ?? '']),
    );
  } catch {
    batches.value = [];
  }
}

async function saveBatchExpiry(lotId: string, value: string): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  batchDates.value = { ...batchDates.value, [lotId]: value };
  savingBatch.value = lotId;
  try {
    await setLotExpiry(token, lotId, value === '' ? null : value);
    await loadBatches();
  } catch (cause) {
    formError.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not save that expiry date' };
  } finally {
    savingBatch.value = null;
  }
}

const serialOn = computed(() => catalog.value.features.serialTracking);
const warrantyOn = computed(() => catalog.value.features.warranty);

/** Whole months, or nothing. A blank box means the product carries no warranty. */
function positiveMonths(text: string): number | null {
  const months = Number(text.trim());
  return Number.isSafeInteger(months) && months > 0 ? months : null;
}

/**
 * Suppliers, for the optional `usual supplier` box.
 *
 * Loaded beside the catalogue rather than with it: a shop that never fills the
 * box in should not pay for the list, and a form that failed to load it is
 * still a usable form with one fewer convenience.
 */
async function loadSuppliers(): Promise<void> {
  try {
    const response = await fetchParties(session.accessToken.value ?? '', {
      role: 'SUPPLIER',
      limit: 200,
    });
    suppliers.value = response.data.map((party) => ({ id: party.id, name: party.name }));
  } catch {
    suppliers.value = [];
  }
}

/** The edited product's version, carried back on save for the D-32 lock. */
const version = ref(1);
const currentBarcode = ref<string | null>(null);

/*
 * The form's own state. Money and quantity are held as the text the shopkeeper
 * typed and converted once, on save — holding them as minor units would mean
 * reformatting on every keystroke.
 */
const name = ref('');
const baseUnitId = ref('');
const purchasePrice = ref('');
const sellingPrice = ref('');
const minStock = ref('0');
const openingStock = ref('0');
const openingExpiryDate = ref('');
const openingOperationId = ref(Ulid.generate(clock));
const brandId = ref('');
const categoryId = ref('');
const subcategoryId = ref('');
const sku = ref('');
const barcode = ref('');
const description = ref('');

const offerEnabled = ref(false);
const offerPrice = ref('');
const offerStartDate = ref('');
const offerEndDate = ref('');
const discountType = ref<typeof NO_DISCOUNT | 'FIXED_AMOUNT' | 'PERCENTAGE'>(NO_DISCOUNT);
const discountValue = ref('');

const tracksExpiry = ref(false);
const tracksSerial = ref(false);

/*
 * D-41: one optional conversion unit, not a list. A product has a base unit;
 * when it needs it, it also has one conversion unit and a factor —
 * `1 Pipe = 20 Feet`. Both empty means an ordinary single-unit product, and
 * nothing on this screen behaves any differently for one.
 */
const conversionUnitId = ref('');
/*
 * Phase 8, all optional (owner decisions 2026-08-26). The usual supplier is what
 * the purchase planner assumes; the minimum order is the smallest that supplier
 * will sell; warranty months are what the customer and the shop are each
 * covered for. Left blank, each simply does not apply.
 */
const usualSupplierId = ref('');
const minOrderQty = ref('');
const warrantyMonths = ref('');
const supplierWarrantyMonths = ref('');
const suppliers = ref<Array<{ id: string; name: string }>>([]);
const conversionFactor = ref('');

/**
 * Whether the shopkeeper has said this product comes in a second unit.
 *
 * A tick rather than a "no second unit" option in the list, because that is the
 * shape of the decision: most products come in one unit, and the two fields that
 * carry the rule — the unit and the factor — mean nothing until the answer is
 * yes, so they are absent until then rather than sitting there empty (UI-09).
 */
const hasSecondUnit = ref(false);

function toggleSecondUnit(on: boolean): void {
  hasSecondUnit.value = on;
  if (on) return;

  // Unticking is a real answer — "no, it does not" — so it clears both halves.
  // Leaving one behind would be half a rule, which D-41 and the server refuse.
  conversionUnitId.value = '';
  usualSupplierId.value = '';
  minOrderQty.value = '';
  warrantyMonths.value = '';
  supplierWarrantyMonths.value = '';
  conversionFactor.value = '';
  priceUnit.value = 'BASE';
}

/**
 * Which unit the two price boxes are being typed in. Purely a way of entering
 * and reading them — what is sent, and what is stored, is always **per base
 * unit** (D-41).
 */
const priceUnit = ref<'BASE' | 'CONVERSION'>('BASE');

/**
 * One operation id per user intent (UI-34): generated when the form opens and
 * reused on every retry of the same save, so a resubmitted create is recognised
 * as the same one rather than creating a second product.
 */
const operationId = ref(Ulid.generate(clock));

const parentCategories = computed(() =>
  catalog.value.categories.filter((row) => row.parentId === null),
);
const subcategories = computed(() =>
  categoryId.value === ''
    ? []
    : catalog.value.categories.filter((row) => row.parentId === categoryId.value),
);
/** Any unit except the base one — `1 Feet = 3 Feet` is a contradiction, not a rule. */
const spareUnits = computed(() =>
  catalog.value.units.filter((unit) => unit.id !== baseUnitId.value),
);

const conversionUnitName = computed(
  () => catalog.value.units.find((unit) => unit.id === conversionUnitId.value)?.name ?? '',
);

/** The factor as a scale-3 integer, or null while it is empty or not a number. */
const factorQty = computed(() => {
  if (conversionUnitId.value === '' || conversionFactor.value.trim() === '') return null;
  const parsed = parseQty(conversionFactor.value);
  return parsed !== null && parsed > 0 ? parsed : null;
});

/** Whether the price toggle and the mixed read-back have anything to work with. */
const conversionReady = computed(() => factorQty.value !== null);

/**
 * The unit the price boxes are currently in. Falls back to the base unit the
 * moment the conversion becomes incomplete, so the label can never claim a
 * price is "per Pipe" while there is no Pipe.
 */
const priceUnitName = computed(() =>
  priceUnit.value === 'CONVERSION' && conversionReady.value
    ? conversionUnitName.value
    : baseUnitName.value,
);

/**
 * The reorder level read back the way a shopkeeper counts it — `105 Feet` shown
 * as `5 Pipe + 5 Feet`. The split is the domain's, not this component's (B8).
 */
const minStockMixed = computed(() => {
  const factor = factorQty.value;
  if (factor === null) return null;
  const raw = parseQty(minStock.value === '' ? '0' : minStock.value);
  if (raw === null || raw === 0) return null;

  const mixed = splitToMixed(raw, factor);
  if (mixed.conversionQty === 0) return null;
  return `${qtyText(mixed.conversionQty)} ${conversionUnitName.value} + ${qtyText(mixed.baseQty)} ${baseUnitName.value}`;
});

/**
 * The worked example the Units card teaches with: five of each, added up.
 *
 * The sum is `toBaseQty` — the domain's, and the same function the ledger will
 * use — never a multiplication written in this component (B8). An example that
 * did its own arithmetic could quietly disagree with what actually gets stored,
 * which is worse than no example at all.
 */
const conversionExample = computed(() => {
  const factor = factorQty.value;
  const five = parseQty('5');
  if (factor === null || five === null) return null;

  return {
    five: qtyText(five),
    total: qtyText(toBaseQty({ conversionQty: five, baseQty: five }, factor)),
  };
});

/*
 * D-39 / UI-45 — quick add from the point of use.
 *
 * A shopkeeper adding the first bottle of a new brand should not have to
 * abandon a half-typed product to go and file the brand first. Each of these
 * calls the **same** catalog use case the Catalog setup screen calls: one write
 * path, one set of rules, one audit trail. Nothing here creates a placeholder.
 *
 * Every write returns the whole catalog, so the new row is found by asking which
 * id was not there before — no name matching, no guessing at what the server
 * normalised the name to.
 */
const canManageUnits = computed(() => session.can('catalog.unit.manage'));
const canManageBrands = computed(() => session.can('catalog.brand.manage'));
const canManageCategories = computed(() => session.can('catalog.category.manage'));

async function quickAdd(
  kind: 'units' | 'brands' | 'categories',
  payload: { name: string } | { name: string; parentId: string | null },
  before: readonly { readonly id: string }[],
): Promise<string> {
  const updated = await createCatalogEntry(session.accessToken.value ?? '', kind, payload);
  catalog.value = updated;

  const known = new Set(before.map((row) => row.id));
  const list =
    kind === 'units' ? updated.units : kind === 'brands' ? updated.brands : updated.categories;
  const created = list.find((row) => !known.has(row.id));
  if (created === undefined) throw new Error('The catalog did not come back with the new entry');
  return created.id;
}

function addUnit(name: string): Promise<string> {
  return quickAdd('units', { name }, catalog.value.units);
}

function addBrand(name: string): Promise<string> {
  return quickAdd('brands', { name }, catalog.value.brands);
}

function addCategory(name: string): Promise<string> {
  return quickAdd('categories', { name, parentId: null }, catalog.value.categories);
}

/** A subcategory belongs to whichever category is chosen (§5.5, two levels). */
function addSubcategory(name: string): Promise<string> {
  return quickAdd(
    'categories',
    { name, parentId: categoryId.value },
    catalog.value.categories,
  );
}
/* ------------------------------------------------- manage a list (UI-51) */

/**
 * The grid button on each picker opens that list, where it is added to, renamed
 * and tidied.
 *
 * These call the same endpoints the Catalog screen calls — one write path, one
 * set of validations, one audit trail (R-D, DRY). The catalog is replaced with
 * whatever the server returns rather than patched locally, so a name the server
 * normalised is the name shown.
 *
 * Curried per kind so each picker is handed its own pair, instead of the page
 * holding a "which list is open" variable that the handlers then read — that
 * indirection is how a rename ends up applied to the wrong list.
 */
function renameIn(kind: CatalogKind) {
  return async (id: string, name: string): Promise<void> => {
    catalog.value = await renameCatalogEntry(session.accessToken.value ?? '', kind, id, name);
  };
}

/**
 * §3.6's delete-or-archive. The server decides which, and its answer is what the
 * caller is told — this never claims "deleted" when the answer was "archived".
 */
function removeIn(kind: CatalogKind) {
  return async (id: string): Promise<string> => {
    const result = await removeCatalogEntry(session.accessToken.value ?? '', kind, id);
    catalog.value = await fetchCatalog(session.accessToken.value ?? '');
    void loadSuppliers();

    return result.outcome === 'ARCHIVED'
      ? 'It is still used by some products, so it was archived rather than deleted. Nothing those products record has changed.'
      : 'Removed. Nothing was using it.';
  };
}

const renameCategory = renameIn('categories');
const removeCategory = removeIn('categories');
const renameBrand = renameIn('brands');
const removeBrand = removeIn('brands');
const renameUnit = renameIn('units');
const removeUnit = removeIn('units');

/** A picture's own failure, said in words a shopkeeper can act on. */
function describeWith(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: fallback };
}

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

/** Minor units back to the text a person edits — via shared-utils (UI-31). */
function moneyText(minor: number | null | undefined): string {
  return minor === null || minor === undefined ? '' : Money(minor).format().replace(/,/g, '');
}

function fill(product: ProductResponse): void {
  hasPicture.value = product.hasImage;
  name.value = product.name;
  baseUnitId.value = product.baseUnitId;
  purchasePrice.value = moneyText(product.purchasePriceMinor);
  sellingPrice.value = moneyText(product.sellingPriceMinor);
  minStock.value = qtyText(product.minStockQty);
  brandId.value = product.brandId ?? '';
  sku.value = product.sku ?? '';
  barcode.value = product.barcode ?? '';
  currentBarcode.value = product.barcode;
  description.value = product.description ?? '';
  offerEnabled.value = product.offerEnabled;
  offerPrice.value = moneyText(product.offerPriceMinor);
  offerStartDate.value = product.offerStartDate ?? '';
  offerEndDate.value = product.offerEndDate ?? '';
  discountType.value = product.defaultDiscountType ?? NO_DISCOUNT;
  discountValue.value =
    product.defaultDiscountValue === null ? '' : moneyText(product.defaultDiscountValue);
  tracksExpiry.value = product.tracksExpiry;
  tracksSerial.value = product.tracksSerial;
  version.value = product.version;
  conversionUnitId.value = product.conversion?.unitId ?? '';
  usualSupplierId.value = product.usualSupplierId ?? '';
  minOrderQty.value = product.minOrderQty === null ? '' : qtyText(product.minOrderQty);
  warrantyMonths.value = product.warrantyMonths === null ? '' : String(product.warrantyMonths);
  supplierWarrantyMonths.value =
    product.supplierWarrantyMonths === null ? '' : String(product.supplierWarrantyMonths);
  conversionFactor.value =
    product.conversion === null ? '' : qtyText(product.conversion.factorQty);
  hasSecondUnit.value = product.conversion !== null;
  // Prices are always stored per base unit, so a reopened form starts there.
  priceUnit.value = 'BASE';

  // A subcategory is stored as the product's category; the two selects are the
  // shop's own way of finding it.
  const chosen = catalog.value.categories.find((row) => row.id === product.categoryId);
  if (chosen === undefined) {
    categoryId.value = '';
    subcategoryId.value = '';
  } else if (chosen.parentId === null) {
    categoryId.value = chosen.id;
    subcategoryId.value = '';
  } else {
    categoryId.value = chosen.parentId;
    subcategoryId.value = chosen.id;
  }
}

onMounted(async () => {
  loading.value = true;
  try {
    catalog.value = await fetchCatalog(session.accessToken.value ?? '');

    if (productId.value !== null) {
      fill(await fetchProduct(session.accessToken.value ?? '', productId.value));
      // Batches only matter for a saved product that tracks expiry, and `fill`
      // is what tells us whether it does.
      if (tracksExpiry.value) await loadBatches();
    } else {
      baseUnitId.value = catalog.value.units[0]?.id ?? '';
    }
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
});

/* -------------------------------------------------------------- saving */

const canSubmit = computed(
  () =>
    !busy.value &&
    canSave.value &&
    name.value.trim() !== '' &&
    baseUnitId.value !== '' &&
    purchasePrice.value.trim() !== '' &&
    sellingPrice.value.trim() !== '',
);

/**
 * Turns what was typed into the request, in minor units.
 *
 * A field that is not a number returns `null` from `parseMoney`/`parseQty` and
 * this stops with a message naming it — never a silently rounded or coerced
 * value (R-C3).
 */
function toRequest(): SaveProductRequest | null {
  const purchaseMinor = parseMoney(purchasePrice.value);
  const sellingMinor = parseMoney(sellingPrice.value);
  const minStockRaw = parseQty(minStock.value === '' ? '0' : minStock.value);
  const openingStockRaw = parseQty(openingStock.value === '' ? '0' : openingStock.value);

  if (purchaseMinor === null || sellingMinor === null) {
    formError.value = {
      code: 'VALIDATION_FAILED',
      message: 'Enter both prices as an amount, with at most two decimal places',
    };
    return null;
  }
  if (minStockRaw === null) {
    formError.value = {
      code: 'VALIDATION_FAILED',
      message: 'Enter the reorder level as a quantity, with at most three decimal places',
    };
    return null;
  }
  if (openingStockRaw === null || openingStockRaw < 0) {
    formError.value = { code: 'VALIDATION_FAILED', message: 'Enter opening stock as zero or a positive quantity, with at most three decimal places' };
    return null;
  }
  if (isNew.value && openingStockRaw > 0 && tracksExpiry.value && openingExpiryDate.value === '') {
    formError.value = { code: 'VALIDATION_FAILED', message: 'Enter the expiry date for the opening batch' };
    return null;
  }

  const offerMinor = offerEnabled.value ? parseMoney(offerPrice.value) : null;
  if (offerEnabled.value && offerMinor === null) {
    formError.value = { code: 'VALIDATION_FAILED', message: 'Enter the offer price' };
    return null;
  }

  const discountMinor =
    discountType.value === NO_DISCOUNT ? null : parseMoney(discountValue.value);
  if (discountType.value !== NO_DISCOUNT && discountMinor === null) {
    formError.value = { code: 'VALIDATION_FAILED', message: 'Enter how much the discount is' };
    return null;
  }

  /*
   * D-41: both halves or neither. The server refuses half a rule too — this
   * check is here so the person is told before a round trip, not instead of it.
   */
  const hasUnit = conversionUnitId.value !== '';
  const hasFactor = conversionFactor.value.trim() !== '';
  if (hasUnit !== hasFactor) {
    formError.value = {
      code: 'VALIDATION_FAILED',
      message: hasUnit
        ? `Enter how many ${baseUnitName.value} one ${conversionUnitName.value} contains`
        : 'Choose the unit this product also comes in',
    };
    return null;
  }

  const conversionQty = hasUnit ? parseQty(conversionFactor.value) : null;
  if (hasUnit && (conversionQty === null || conversionQty <= 0)) {
    formError.value = {
      code: 'VALIDATION_FAILED',
      message: `Enter how many ${baseUnitName.value} one ${conversionUnitName.value} contains`,
    };
    return null;
  }

  /*
   * The two price boxes may be being typed **per conversion unit**. What leaves
   * this screen is always per base unit (D-41), converted by the domain — a
   * component may not do arithmetic on money (B8, R-C3, UI-31).
   *
   * This direction can round: ৳105.05 per Pipe over 20 Feet is ৳5.2525 per Foot,
   * and money is stored at two decimals, so D-31 rounds it half-up once to
   * ৳5.25. `fill()` then shows what was actually stored, rather than letting the
   * screen keep claiming a figure the database does not hold.
   */
  const perBase = (minor: number): number =>
    priceUnit.value === 'CONVERSION' && conversionQty !== null
      ? pricePerBaseUnit(minor, conversionQty)
      : minor;

  return {
    name: name.value.trim(),
    baseUnitId: baseUnitId.value,
    purchasePriceMinor: perBase(purchaseMinor),
    sellingPriceMinor: perBase(sellingMinor),
    minStockQty: minStockRaw,
    brandId: brandId.value === '' ? null : brandId.value,
    categoryId:
      subcategoryId.value !== ''
        ? subcategoryId.value
        : categoryId.value === ''
          ? null
          : categoryId.value,
    sku: sku.value.trim() === '' ? null : sku.value.trim(),
    barcode: barcode.value.trim() === '' ? null : barcode.value.trim(),
    description: description.value.trim() === '' ? null : description.value.trim(),
    defaultDiscountType: discountType.value === NO_DISCOUNT ? null : discountType.value,
    defaultDiscountValue: discountMinor,
    offerEnabled: offerEnabled.value,
    offerPriceMinor: offerMinor,
    offerStartDate: offerStartDate.value === '' ? null : offerStartDate.value,
    offerEndDate: offerEndDate.value === '' ? null : offerEndDate.value,
    tracksExpiry: tracksExpiry.value,
    tracksSerial: tracksSerial.value,
    conversionUnitId: hasUnit ? conversionUnitId.value : null,
    conversionFactorQty: conversionQty,
    usualSupplierId: usualSupplierId.value === '' ? null : usualSupplierId.value,
    minOrderQty: parseQty(minOrderQty.value),
    warrantyMonths: positiveMonths(warrantyMonths.value),
    supplierWarrantyMonths: positiveMonths(supplierWarrantyMonths.value),
  };
}

async function save(): Promise<void> {
  formError.value = null;

  /*
   * The disabled submit button is not the guard — pressing Enter in a text field
   * submits the form without going near it. The server refuses an incomplete
   * product correctly, but as a round trip and an error code, where the
   * shopkeeper deserves to be told on the spot what is still missing.
   */
  if (!canSubmit.value) {
    formError.value = {
      code: 'VALIDATION_FAILED',
      message: 'Fill in the name, unit and both prices before saving',
    };
    return;
  }

  const payload = toRequest();
  if (payload === null) return;

  busy.value = true;
  try {
    if (productId.value === null) {
      const created = await createProduct(
        session.accessToken.value ?? '',
        payload,
        operationId.value,
      );
      const openingQty = parseQty(openingStock.value === '' ? '0' : openingStock.value) ?? 0;
      if (openingQty > 0) {
        await recordOpeningStock(session.accessToken.value ?? '', {
          productId: created.id,
          qty: openingQty,
          expiryDate: tracksExpiry.value ? openingExpiryDate.value : null,
        }, openingOperationId.value);
      }
      // UI-36/UI-64: the caller decides where a save returns to — the list
      // behind the dialog, or the saved record when this is the route.
      emit('saved', created);
    } else {
      const saved = await updateProduct(session.accessToken.value ?? '', productId.value, {
        ...payload,
        version: version.value,
      });
      fill(saved);
      formError.value = null;
      notice.value = 'Changes saved.';
      emit('saved', saved);
    }
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

async function generateBarcode(): Promise<void> {
  if (productId.value === null) return;
  busy.value = true;
  formError.value = null;
  try {
    const generated = await generateProductBarcode(
      session.accessToken.value ?? '',
      productId.value,
    );
    barcode.value = generated.barcode;
    currentBarcode.value = generated.barcode;
    notice.value = `Barcode ${generated.barcode} was generated. Print it on a label for the shelf.`;
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

const confirmingDelete = ref(false);

/* The picture, saved the moment it is chosen (see the card's comment). */
const hasPicture = ref(false);
const pickedPicture = ref<string | null>(null);
const pictureVersion = ref(0);
const pictureUrl = computed(() =>
  pickedPicture.value ??
  (hasPicture.value && productId.value !== null
    ? `/api/v1/products/${productId.value}/image?v=${String(pictureVersion.value)}`
    : null),
);

async function onPicturePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const token = session.accessToken.value;
  if (file === undefined || token === null || productId.value === null) return;
  try {
    const resized = await resizeImage(file, 320);
    pickedPicture.value = resized.previewUrl;
    await saveProductImage(token, productId.value, {
      mime: resized.mime,
      dataBase64: resized.dataBase64,
    });
    hasPicture.value = true;
    pictureVersion.value += 1;
  } catch (cause) {
    formError.value = describeWith(cause, 'Could not save that picture');
  } finally {
    input.value = '';
  }
}

async function dropPicture(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || productId.value === null) return;
  try {
    await removeProductImage(token, productId.value);
    hasPicture.value = false;
    pickedPicture.value = null;
    pictureVersion.value += 1;
  } catch (cause) {
    formError.value = describeWith(cause, 'Could not remove the picture');
  }
}

async function remove(): Promise<void> {
  if (productId.value === null) return;
  busy.value = true;
  formError.value = null;
  try {
    await deleteProduct(session.accessToken.value ?? '', productId.value);
    emit('deleted');
  } catch (cause) {
    formError.value = describe(cause);
    confirmingDelete.value = false;
  } finally {
    busy.value = false;
  }
}

/**
 * Switching the price boxes between units rewrites what is displayed, using the
 * domain's own conversion — the stored figure is untouched until Save.
 */
function switchPriceUnit(next: 'BASE' | 'CONVERSION'): void {
  const factor = factorQty.value;
  if (next === priceUnit.value || factor === null) return;

  const convert = (text: string): string => {
    const minor = parseMoney(text);
    if (minor === null) return text;
    const moved =
      next === 'CONVERSION' ? pricePerConversionUnit(minor, factor) : pricePerBaseUnit(minor, factor);
    return moneyText(moved);
  };

  purchasePrice.value = convert(purchasePrice.value);
  sellingPrice.value = convert(sellingPrice.value);
  priceUnit.value = next;
}

const baseUnitName = computed(
  () => catalog.value.units.find((unit) => unit.id === baseUnitId.value)?.name ?? 'base unit',
);
</script>

<template>
  <div class="product-form-host">
    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading the product">
      <div class="skeleton skeleton-form" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not open this product">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="emit('close')">
        Back to products
      </button>
    </AppCard>

    <form v-else class="form" @submit.prevent="save">
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>
      <ErrorNotice v-if="formError !== null" :code="formError.code" :message="formError.message" />

      <!--
        The order here is the order a shopkeeper thinks in, set by the owner
        2026-08-19: what it is → how it is classified and counted → what it
        costs and sells for → how much there is. Everything a product can exist
        without is folded away below (UI-50).

        **This first card carries no heading.** It is not a section of the form,
        it is the form — every other card is the optional part folded under it —
        and a title above the very first field said only that a product form is
        about products. Removed by owner decision 2026-08-19; `AppCard` already
        drops its header when no title is given, so nothing else changes.
      -->
      <AppCard class="product-core-card">
        <div class="field">
          <label for="product-name">
            Product name
            <span class="label-bn">পণ্যের নাম</span>
          </label>
          <input
            id="product-name"
            v-model="name"
            type="text"
            placeholder="e.g. PVC Pipe 1&quot;"
            required
            :disabled="!canSave"
          />
        </div>

        <!--
          D-39 / UI-45: each of these creates what it is picking, inline, without
          losing the half-filled product. UI-51 adds Manage beside them, so a
          wrong category is fixed here rather than on a settings screen.
        -->
        <div class="row">
          <QuickAddSelect
            v-model="brandId"
            field-id="product-brand"
            label="Brand"
            label-bn="ব্র্যান্ড"
            empty-label="No brand"
            :options="catalog.brands"
            :can-add="canManageBrands"
            add-placeholder="e.g. RFL"
            :can-manage="canManageBrands"
            :disabled="!canSave"
            :create="addBrand"
            :rename="renameBrand"
            :remove="removeBrand"
          />

          <QuickAddSelect
            v-model="categoryId"
            field-id="product-category"
            label="Category"
            label-bn="ধরন"
            empty-label="Select category..."
            :options="parentCategories"
            :can-add="canManageCategories"
            add-placeholder="e.g. Fittings"
            :can-manage="canManageCategories"
            :disabled="!canSave"
            :create="addCategory"
            :rename="renameCategory"
            :remove="removeCategory"
          />

          <QuickAddSelect
            v-model="baseUnitId"
            field-id="product-unit"
            label="Unit"
            label-bn="একক"
            empty-label="Select unit..."
            :options="catalog.units"
            :can-add="canManageUnits"
            add-placeholder="e.g. Gaz"
            help="What you count this product in — piece, carton, kilo, foot. Everything is stored in this unit, and any second unit you add is measured against it."
            help-bn="এই পণ্যটি আপনি কীসে গোনেন — পিস, কার্টন, কেজি, ফুট। সব হিসাব এই এককেই রাখা হয়।"
            :can-manage="canManageUnits"
            :disabled="!canSave"
            required
            :create="addUnit"
            :rename="renameUnit"
            :remove="removeUnit"
          />
        </div>

        <!--
          D-41: prices are **stored per base unit**, always. This only changes
          which unit they are typed and read in, and the conversion is the
          domain's — never arithmetic in this component (B8, UI-31).
        -->
        <div v-if="conversionReady" class="price-unit" role="group" aria-label="Type the prices per">
          <button
            type="button"
            class="chip"
            :class="{ 'is-current': priceUnit === 'BASE' }"
            :aria-pressed="priceUnit === 'BASE'"
            @click="switchPriceUnit('BASE')"
          >
            Price is per {{ baseUnitName }}
          </button>
          <button
            type="button"
            class="chip"
            :class="{ 'is-current': priceUnit === 'CONVERSION' }"
            :aria-pressed="priceUnit === 'CONVERSION'"
            @click="switchPriceUnit('CONVERSION')"
          >
            Price is per {{ conversionUnitName }}
          </button>
        </div>

        <div class="row">
          <div class="field">
            <label for="purchase-price">
              Purchase price (৳ per {{ priceUnitName }})
              <span class="label-bn">কেনা দাম</span>
              <HelpTip
                label="Purchase price"
                text="What the goods cost you. Staff without permission to see cost never see this figure anywhere — not on the list, not in an export."
                text-bn="আপনার কেনা দাম। যাদের দাম দেখার অনুমতি নেই, তারা এটি কোথাও দেখতে পাবে না।"
              />
            </label>
            <input
              id="purchase-price"
              v-model="purchasePrice"
              type="text"
              inputmode="decimal"
              placeholder="0"
              required
              :disabled="!canSave"
            />
          </div>

          <div class="field">
            <label for="selling-price">
              Selling price (৳ per {{ priceUnitName }})
              <span class="label-bn">বিক্রির দাম</span>
            </label>
            <input
              id="selling-price"
              v-model="sellingPrice"
              type="text"
              inputmode="decimal"
              placeholder="0"
              required
              :disabled="!canSave"
            />
          </div>
        </div>

        <div class="row">
          <div class="field">
            <label for="min-stock">
              Minimum stock
              <span class="label-bn">যত কমে গেলে আবার আনতে হবে</span>
              <HelpTip
                label="Minimum stock"
                text="A warning line, not an order. Nothing is bought automatically — SherERP only tells you when stock has fallen this low, so you can decide."
                text-bn="এটি শুধু সতর্ক করে, নিজে থেকে কিছু কেনে না। স্টক এতটা কমে গেলে আপনাকে জানানো হবে, সিদ্ধান্ত আপনার।"
              />
            </label>
            <input
              id="min-stock"
              v-model="minStock"
              type="text"
              inputmode="decimal"
              placeholder="5"
              :disabled="!canSave"
            />
            <p v-if="minStockMixed !== null" class="help mixed-read-back">
              That is {{ minStockMixed }}.
            </p>
          </div>
          <div v-if="isNew" class="field">
            <label for="opening-stock">
              Opening / Current Stock
              <span class="label-bn">এখন হাতে থাকা স্টক</span>
              <HelpTip
                label="Opening stock"
                text="How much you physically have now. Leave zero for a new item. SherERP records a real opening movement at the purchase price above."
                text-bn="এখন দোকানে যত আছে। নতুন পণ্য হলে শূন্য রাখুন।"
              />
            </label>
            <input id="opening-stock" v-model="openingStock" type="text" inputmode="decimal" placeholder="0" :disabled="!canSave" />
          </div>
          <div v-if="isNew && tracksExpiry" class="field">
            <label for="opening-expiry">
              Opening batch expiry
              <span class="label-bn">শুরুর স্টকের মেয়াদ শেষ হওয়ার তারিখ</span>
            </label>
            <DateOnlyPicker input-id="opening-expiry" v-model="openingExpiryDate" :disabled="!canSave" />
          </div>
        </div>

        <!--
          Moved up out of the folded "Codes" card by owner decision 2026-08-19.
          It is what a shopkeeper writes about the goods — the size, the colour,
          what it fits — and filing that behind a section named after barcodes
          meant nobody found it. It stays optional; nothing refuses a save
          without it.
        -->
        <div class="field">
          <label for="product-description">
            Description
            <span class="label-bn">বর্ণনা</span>
          </label>
          <textarea
            id="product-description"
            v-model="description"
            rows="2"
            placeholder="Size, colour, what it fits — anything worth remembering."
            :disabled="!canSave"
          />
        </div>
      </AppCard>

      <!--
        The picture (owner decision 2026-08-25). Only offered once the product
        exists: it is saved on the spot rather than with the form, because a
        photo is not a field somebody edits and reverts — they choose it and
        expect to see it. A shop that never uploads one loses nothing; the POS
        grid draws the product's letters instead.
      -->
      <AppCard
        v-if="productId !== null"
        collapsible
        icon="pi-image"
        title="Picture"
        subtitle="Optional. It shows on the POS grid."
        subtitle-bn="বিক্রির পর্দায় ছবি দেখা যাবে"
      >
        <div class="picture">
          <div class="picture__box">
            <img v-if="pictureUrl" :src="pictureUrl" :alt="name" />
            <span v-else>No picture</span>
          </div>
          <div class="picture__actions">
            <input type="file" accept="image/*" :disabled="!canSave" @change="onPicturePicked" />
            <button
              v-if="hasPicture"
              type="button"
              class="btn btn-danger"
              :disabled="!canSave || busy"
              @click="dropPicture"
            >
              Remove picture
            </button>
            <p class="help">
              Resized to 320px before it is saved, so a phone photo becomes a few
              kilobytes rather than four megabytes.
            </p>
          </div>
        </div>
      </AppCard>

      <!--
        Optional from here down, so these fold away (§2.7 audience rule). A first
        product needs a name, a unit, two prices and a reorder level — showing
        twenty-five fields instead of six reads as a demand for information the
        shopkeeper may not have, which is where people give up and go back to the
        notebook. Collapsed, never hidden: one tap opens each.
      -->
      <AppCard
        collapsible
        :force-open="formError !== null"
        icon="pi-barcode"
        title="Codes"
        subtitle="Optional. A barcode is what lets the counter scan it."
        subtitle-bn="বারকোড থাকলে কাউন্টারে স্ক্যান করে বিক্রি করা যায়"
      >
        <div class="row">
          <div class="field">
            <label for="product-sku">
              Product code (SKU)
              <span class="label-bn">প্রোডাক্ট কোড</span>
            </label>
            <input id="product-sku" v-model="sku" type="text" :disabled="!canSave" />
          </div>

          <div class="field">
            <label for="product-barcode">
              Barcode
              <span class="label-bn">বারকোড</span>
            </label>
            <input id="product-barcode" v-model="barcode" type="text" :disabled="!canSave" />
            <p class="help">
              Type the barcode printed on the packet, or generate one for goods that have none.
            </p>
          </div>

          <div v-if="!isNew && canEdit && currentBarcode === null" class="field align-end">
            <button type="button" class="btn btn-ghost" :disabled="busy" @click="generateBarcode">
              Generate a barcode
            </button>
          </div>
        </div>
      </AppCard>

      <!--
        UI-09: feature-dependent sections are absent while the feature is off,
        not greyed out — the server refuses them, so offering them would be a
        control that 403s.
      -->
      <AppCard
        v-if="offersOn"
        collapsible
        :force-open="formError !== null"
        icon="pi-percentage"
        title="Offer and standing discount"
        subtitle="A discount that applies every time, or an offer that runs for a few days."
        subtitle-bn="সব সময়ের ছাড়, বা কয়েক দিনের জন্য বিশেষ দাম"
      >
        <div class="row">
          <div class="field">
            <label for="discount-type">
              Standing discount
              <span class="label-bn">স্থায়ী ছাড়</span>
            </label>
            <Select input-id="discount-type" v-model="discountType" :options="discountTypeOptions" option-label="label" option-value="value" :disabled="!canSave" fluid />
          </div>

          <div v-if="discountType !== NO_DISCOUNT" class="field">
            <label for="discount-value">
              {{ discountType === 'PERCENTAGE' ? 'Percent off (%)' : 'Amount off (৳)' }}
            </label>
            <input
              id="discount-value"
              v-model="discountValue"
              type="text"
              inputmode="decimal"
              :disabled="!canSave"
            />
          </div>
        </div>

        <label class="check">
          <input v-model="offerEnabled" type="checkbox" :disabled="!canSave" />
          <span>
            Run a promotional offer on this product
            <span class="sher-bn check-bn">এই পণ্যে একটি প্রচারমূলক অফার চালান</span>
          </span>
        </label>

        <div v-if="offerEnabled" class="row">
          <div class="field">
            <label for="offer-price">Offer price (৳)</label>
            <input
              id="offer-price"
              v-model="offerPrice"
              type="text"
              inputmode="decimal"
              :disabled="!canSave"
            />
          </div>

          <div class="field">
            <label for="offer-start">Runs from</label>
            <DateOnlyPicker input-id="offer-start" v-model="offerStartDate" :disabled="!canSave" />
          </div>

          <div class="field">
            <label for="offer-end">Runs until</label>
            <DateOnlyPicker input-id="offer-end" v-model="offerEndDate" :disabled="!canSave" />
            <p class="help">The offer covers the whole of this day.</p>
          </div>
        </div>

        <p class="fine">
          The normal selling price above is never replaced — an offer sits beside it, and the
          product goes back to its own price the day the offer ends.
        </p>
      </AppCard>

      <!--
        D-41 — one optional conversion unit. Most products never leave the left
        half of this card; the ones that do buy in one unit and sell in another.
      -->
      <!--
        The base unit is asked once, above. A second control bound to the same
        value is two places to change one thing -- and two chances for them to
        disagree in the reader's head.
      -->
      <AppCard
        collapsible
        :force-open="formError !== null"
        icon="pi-box"
        title="Second unit"
        subtitle="Only if this product is also bought or sold another way."
        subtitle-bn="এই পণ্যটি অন্য এককেও কেনা বা বেচা হলে এখানে ঠিক করুন"
      >
        <div class="unit-panels">
          <div class="unit-panel" :class="{ 'is-on': hasSecondUnit }">
            <label class="check">
              <input
                id="has-second-unit"
                type="checkbox"
                :checked="hasSecondUnit"
                :disabled="!canSave"
                @change="toggleSecondUnit(($event.target as HTMLInputElement).checked)"
              />
              <span>
                This product is also bought or sold in another unit
                <span class="sher-bn check-bn">এই পণ্যটি অন্য এককেও কেনা বা বিক্রি করা হয়</span>
              </span>
            </label>

            <QuickAddSelect
              v-if="hasSecondUnit"
              v-model="conversionUnitId"
              field-id="conversion-unit"
              label="Other unit"
              label-bn="অন্য একক"
              empty-label="Choose a unit"
              :options="spareUnits"
              :can-add="canManageUnits"
              add-placeholder="e.g. Pipe"
              :can-manage="canManageUnits"
              :disabled="!canSave"
              :create="addUnit"
              :rename="renameUnit"
              :remove="removeUnit"
            />
          </div>
        </div>

        <div v-if="hasSecondUnit && conversionUnitId !== ''" class="conversion">
          <div class="conversion-text">
            <span class="conversion-label">
              Conversion
              <span class="label-bn">রূপান্তর</span>
            </span>
            <span class="fine">1 {{ conversionUnitName }} contains</span>
            <span class="sher-bn">১ {{ conversionUnitName }} = কয় {{ baseUnitName }}</span>
          </div>

          <div class="equation">
            <span class="unit-box">1</span>
            <span class="unit-box is-name">{{ conversionUnitName }}</span>
            <span class="equals" aria-hidden="true">=</span>
            <div class="field factor">
              <input
                id="conversion-factor"
                v-model="conversionFactor"
                type="text"
                inputmode="decimal"
                placeholder="20"
                :disabled="!canSave"
                :aria-label="`How many ${baseUnitName} one ${conversionUnitName} contains`"
              />
            </div>
            <span class="unit-box is-name">{{ baseUnitName }}</span>
          </div>
        </div>

        <template v-if="hasSecondUnit">
          <div v-if="conversionExample !== null" class="callout is-warn">
            <i class="pi pi-lightbulb callout-icon" aria-hidden="true" />
            <div class="callout-body">
              <p class="callout-title">Example</p>
              <p>
                <strong>
                  {{ conversionExample.five }} {{ conversionUnitName }} +
                  {{ conversionExample.five }} {{ baseUnitName }} = {{ conversionExample.total }}
                  {{ baseUnitName }}
                </strong>
              </p>
              <p>
                Stock is counted in {{ baseUnitName }}. Where it helps, SherERP reads it back to
                you the way you count it.
              </p>
              <p class="sher-bn">
                স্টক {{ baseUnitName }} এককে হিসাব হবে। দরকার হলে SherERP আপনার গোনার নিয়মেই
                দেখাবে।
              </p>
            </div>
          </div>

          <div class="callout is-info">
            <i class="pi pi-info-circle callout-icon" aria-hidden="true" />
            <div class="callout-body">
              <p>No arithmetic to do yourself — SherERP converts between the two units.</p>
              <p class="sher-bn">জটিল হিসাবের দরকার নেই — SherERP নিজেই রূপান্তর করে নেবে।</p>
            </div>
          </div>
        </template>

        <p v-else class="fine">
          Most products come in one unit only. Leave this as it is, and nothing else on this
          screen changes.
        </p>
      </AppCard>

      <AppCard
        v-if="expiryOn || serialOn"
        collapsible
        :force-open="formError !== null"
        icon="pi-tags"
        title="How each item is followed"
        subtitle-bn="মেয়াদ বা সিরিয়াল নম্বর ধরে রাখতে চাইলে"
      >
        <label v-if="expiryOn" class="check">
          <input id="tracks-expiry" v-model="tracksExpiry" type="checkbox" :disabled="!canSave" />
          <span>Record an expiry date for each batch of this product<span class="sher-bn check-bn">প্রতিটি চালানের মেয়াদ শেষ হওয়ার তারিখ রাখুন</span></span>
        </label>
        <label v-if="serialOn" class="check">
          <input v-model="tracksSerial" type="checkbox" :disabled="!canSave" />
          <span>Follow each unit of this product by its serial number</span>
        </label>

        <!--
          Phase 8: four optional boxes, none of them required to save a product.
          The planner reads the first two and the warranty screens read the last
          two; a shop that uses neither never has to fill any of them in.
        -->
        <div class="sher-grid two">
          <div class="field">
            <label for="usual-supplier">
              Usual supplier <span class="sher-bn">সাধারণত কার কাছে কেনেন</span>
            </label>
            <select id="usual-supplier" v-model="usualSupplierId" :disabled="!canSave">
              <option value="">Work it out from past purchases</option>
              <option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">
                {{ supplier.name }}
              </option>
            </select>
          </div>
          <div class="field">
            <label for="min-order">
              Minimum order <span class="sher-bn">সবচেয়ে কম কত কেনা যায়</span>
            </label>
            <input
              id="min-order"
              v-model="minOrderQty"
              inputmode="decimal"
              :disabled="!canSave"
              placeholder="e.g. 5 — leave blank for no minimum"
            />
          </div>
          <div v-if="warrantyOn" class="field">
            <label for="warranty-months">
              Warranty for the customer <span class="sher-bn">কাস্টমারের ওয়ারেন্টি (মাস)</span>
            </label>
            <input
              id="warranty-months"
              v-model="warrantyMonths"
              inputmode="numeric"
              :disabled="!canSave"
              placeholder="12 — counted from the day they buy it"
            />
          </div>
          <div v-if="warrantyOn" class="field">
            <label for="supplier-warranty-months">
              Warranty from the supplier <span class="sher-bn">সাপ্লায়ারের ওয়ারেন্টি (মাস)</span>
            </label>
            <input
              id="supplier-warranty-months"
              v-model="supplierWarrantyMonths"
              inputmode="numeric"
              :disabled="!canSave"
              placeholder="12 — counted from the day it arrives"
            />
          </div>
        </div>
      </AppCard>

      <!--
        The batches this product has in stock, with their dates (§5.13, owner
        decision 2026-08-26).

        Stock bought before dates were required — and everything imported from
        an old ledger — has no date, never expires and never blocks. This is
        where the shopkeeper fills those in: on the form they already open to
        change anything else about the product, not on a screen of its own.
      -->
      <AppCard v-if="!isNew && tracksExpiry && batches.length > 0" title="Batches in stock" subtitle="চালান ও মেয়াদ">
        <table class="batches">
          <thead>
            <tr>
              <th>Batch <small>চালান</small></th>
              <th class="num">Left <small>বাকি</small></th>
              <th>Expiry date <small>মেয়াদ শেষ</small></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in batches" :key="batch.id">
              <td>
                <strong>{{ batch.sourceNumber }}</strong>
                <small>{{ batch.businessDate }}</small>
              </td>
              <td class="num">{{ qtyText(batch.qtyRemaining) }}</td>
              <td>
                <DateOnlyPicker
                  :input-id="`batch-expiry-${batch.id}`"
                  :model-value="batchDates[batch.id] ?? ''"
                  :disabled="!canSave || savingBatch === batch.id"
                  @update:model-value="(value: string) => void saveBatchExpiry(batch.id, value)"
                />
                <small v-if="batch.expiryDate === null" class="batch-missing">
                  No date yet — this batch never expires until one is set
                </small>
              </td>
            </tr>
          </tbody>
        </table>
      </AppCard>

      <!-- UI-22: a form has a sticky save bar. -->
      <div class="save-bar">
        <button
          v-if="!isNew && canDelete"
          type="button"
          class="btn btn-danger"
          :disabled="busy"
          @click="confirmingDelete = true"
        >
          Delete
        </button>
        <span class="spacer" />
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button v-if="canSave" type="submit" class="btn btn-primary" :disabled="!canSubmit">
          {{ busy ? 'Saving…' : isNew ? 'Add product' : 'Save changes' }}
        </button>
      </div>

      <p v-if="!canSave" class="fine">
        You can see this product, but not change it. Ask the business owner to make the change.
      </p>
    </form>

    <div v-if="confirmingDelete" class="scrim" @click.self="confirmingDelete = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Delete {{ name }}?</h2>
        <p class="lede">
          Deleting is only possible while nothing at all refers to this product. Once it has been
          bought or sold, deactivate it instead — that keeps every past record readable.
        </p>
        <ErrorNotice
          v-if="formError !== null"
          :code="formError.code"
          :message="formError.message"
        />
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="confirmingDelete = false">
            Cancel
          </button>
          <button type="button" class="btn btn-danger" :disabled="busy" @click="remove">
            {{ busy ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.batches {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.batches th,
.batches td {
  padding: 0.4rem 0.35rem;
  border-bottom: 1px solid var(--sher-line);
  text-align: left;
  vertical-align: middle;
}

.batches th small,
.batches td small {
  display: block;
  font-size: 0.72rem;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.batches .num {
  text-align: right;
}

.batch-missing {
  color: var(--sher-warn-text, #92400e);
}

.picture {
  display: flex;
  gap: var(--sher-space-4, 16px);
  align-items: flex-start;
}

.picture__box {
  display: grid;
  place-items: center;
  width: 96px;
  height: 96px;
  flex: none;
  border: 1px dashed var(--sher-line-strong);
  border-radius: var(--sher-radius-md, 10px);
  background: var(--sher-sunken);
  color: var(--sher-text-faint);
  font-size: 11px;
  overflow: hidden;
}

.picture__box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.picture__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* Fields, cards, callouts, buttons and dialogs come from `design/components.css`. */
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
  max-width: 900px;
}

/* The required product fields read as distinct steps instead of one dense block. */
.product-core-card > :deep(div) {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.product-core-card .price-unit {
  margin: 0;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-4);
}

.row .field {
  flex: 1 1 200px;
  margin: 0;
}

.price-unit {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
  /* It was sitting hard against the picker row above, reading as part of it
     rather than as a choice about the prices below. */
  margin: var(--sher-space-4) 0;
}

.price-unit-label {
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}

.chip {
  appearance: none;
  cursor: pointer;
  padding: 5px 12px;
  border: 1px solid var(--sher-line);
  border-radius: 999px;
  background: var(--sher-surface);
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
  font-weight: 500;
}

.chip.is-current {
  border-color: var(--sher-nav-active-fg);
  color: var(--sher-nav-active-fg);
  font-weight: 600;
}

.conversion {
  align-items: flex-end;
  padding-bottom: var(--sher-space-3);
  border-bottom: 1px solid var(--sher-line);
  margin-bottom: var(--sher-space-3);
}

.align-end {
  display: flex;
  align-items: flex-end;
  flex: 0 0 auto;
}

.check {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  font-size: var(--sher-text-base);
}

.check input {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

/* The Bangla sits under its English tick label rather than beside it: the
   sentence is already a line long, and two of them side by side wrap badly. */
.check-bn {
  display: block;
}

/*
 * The two halves of the Units card, side by side: what stock is counted in, and
 * whether the shop also buys or sells it another way. Reading them as one row
 * is the point — the second unit is defined *against* the first.
 */
.unit-panels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--sher-space-4);
}

.unit-panel {
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
  padding: var(--sher-space-4);
}

/* Once the answer is yes, the panel carries the rule and says so. */
.unit-panel.is-on {
  background: var(--sher-primary-softer);
  border-color: var(--sher-info-line);
}

.unit-panel .check {
  align-items: flex-start;
  padding-top: 0;
}

.conversion {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sher-space-4);
  margin-top: var(--sher-space-4);
}

.conversion-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 150px;
}

.conversion-label {
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

/* `1 Pipe = 20 Feet`, read left to right. Only the factor is typed: the two
   units are the ones already chosen above, so they are shown, not asked for
   again — a second control for the same field is a second answer waiting to
   disagree with the first. */
.equation {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
  flex-wrap: wrap;
}

.unit-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--sher-control-h);
  min-width: 52px;
  padding: 0 14px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
  color: var(--sher-text-muted);
  font-size: var(--sher-text-base);
  font-variant-numeric: tabular-nums;
}

.unit-box.is-name {
  color: var(--sher-text);
  font-weight: 500;
  font-variant-numeric: normal;
}

.equals {
  color: var(--sher-text-muted);
  font-weight: 600;
}

.factor {
  width: 96px;
  flex: 0 0 auto;
}

.factor input {
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.save-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  padding: var(--sher-space-4) 0;
  background: var(--sher-bg);
  border-top: 1px solid var(--sher-line);
}

.spacer {
  margin-left: auto;
}

.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton-form {
  height: 420px;
}

.retry {
  margin-top: var(--sher-space-4);
}
</style>
