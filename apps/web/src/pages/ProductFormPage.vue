<script setup lang="ts">
import type { CatalogResponse, ProductResponse, SaveProductRequest } from '@sher/core-contracts';
import {
  pricePerBaseUnit,
  pricePerConversionUnit,
  splitToMixed,
  toBaseQty,
} from '@sher/core-domain';
import { Money, parseMoney, parseQty, Qty, Ulid, SystemClock } from '@sher/shared-utils';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { createCatalogEntry, EMPTY_CATALOG, fetchCatalog } from '../api/catalog';
import { ApiError } from '../api/client';
import {
  createProduct,
  deleteProduct,
  fetchProduct,
  generateProductBarcode,
  updateProduct,
} from '../api/products';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import QuickAddSelect from '../components/QuickAddSelect.vue';

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
const route = useRoute();
const router = useRouter();

const productId = computed(() => {
  const id = route.params['id'];
  return typeof id === 'string' && id !== 'new' ? id : null;
});
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
const serialOn = computed(() => catalog.value.features.serialTracking);

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
const discountType = ref<'' | 'FIXED_AMOUNT' | 'PERCENTAGE'>('');
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
  return `${Qty(mixed.conversionQty).format()} ${conversionUnitName.value} + ${Qty(mixed.baseQty).format()} ${baseUnitName.value}`;
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
    five: Qty(five).format(),
    total: Qty(toBaseQty({ conversionQty: five, baseQty: five }, factor)).format(),
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
  name.value = product.name;
  baseUnitId.value = product.baseUnitId;
  purchasePrice.value = moneyText(product.purchasePriceMinor);
  sellingPrice.value = moneyText(product.sellingPriceMinor);
  minStock.value = Qty(product.minStockQty).format();
  brandId.value = product.brandId ?? '';
  sku.value = product.sku ?? '';
  barcode.value = product.barcode ?? '';
  currentBarcode.value = product.barcode;
  description.value = product.description ?? '';
  offerEnabled.value = product.offerEnabled;
  offerPrice.value = moneyText(product.offerPriceMinor);
  offerStartDate.value = product.offerStartDate ?? '';
  offerEndDate.value = product.offerEndDate ?? '';
  discountType.value = product.defaultDiscountType ?? '';
  discountValue.value =
    product.defaultDiscountValue === null ? '' : moneyText(product.defaultDiscountValue);
  tracksExpiry.value = product.tracksExpiry;
  tracksSerial.value = product.tracksSerial;
  version.value = product.version;
  conversionUnitId.value = product.conversion?.unitId ?? '';
  conversionFactor.value =
    product.conversion === null ? '' : Qty(product.conversion.factorQty).format();
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

  const offerMinor = offerEnabled.value ? parseMoney(offerPrice.value) : null;
  if (offerEnabled.value && offerMinor === null) {
    formError.value = { code: 'VALIDATION_FAILED', message: 'Enter the offer price' };
    return null;
  }

  const discountMinor =
    discountType.value === '' ? null : parseMoney(discountValue.value);
  if (discountType.value !== '' && discountMinor === null) {
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
    defaultDiscountType: discountType.value === '' ? null : discountType.value,
    defaultDiscountValue: discountMinor,
    offerEnabled: offerEnabled.value,
    offerPriceMinor: offerMinor,
    offerStartDate: offerStartDate.value === '' ? null : offerStartDate.value,
    offerEndDate: offerEndDate.value === '' ? null : offerEndDate.value,
    tracksExpiry: tracksExpiry.value,
    tracksSerial: tracksSerial.value,
    conversionUnitId: hasUnit ? conversionUnitId.value : null,
    conversionFactorQty: conversionQty,
  };
}

async function save(): Promise<void> {
  formError.value = null;
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
      // UI-36: land on the saved record, showing what the server actually stored.
      await router.push(`/products/${created.id}`);
    } else {
      const saved = await updateProduct(session.accessToken.value ?? '', productId.value, {
        ...payload,
        version: version.value,
      });
      fill(saved);
      formError.value = null;
      notice.value = 'Changes saved.';
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

async function remove(): Promise<void> {
  if (productId.value === null) return;
  busy.value = true;
  formError.value = null;
  try {
    await deleteProduct(session.accessToken.value ?? '', productId.value);
    await router.push('/products');
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
  <AppShell
    :title="isNew ? 'Add product' : name"
    :breadcrumb="['Dashboard', 'Products', isNew ? 'Add' : 'Edit']"
    help-bn="নাম, ইউনিট আর দাম — এই কয়টাই আবশ্যক"
  >
    <template #actions>
      <button type="button" class="btn btn-ghost" @click="router.push('/products')">
        <i class="pi pi-arrow-left" aria-hidden="true" />
        Back to products
      </button>
    </template>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading the product">
      <div class="skeleton skeleton-form" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not open this product">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="router.push('/products')">
        Back to products
      </button>
    </AppCard>

    <form v-else class="form" @submit.prevent="save">
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>
      <ErrorNotice v-if="formError !== null" :code="formError.code" :message="formError.message" />

      <AppCard
        icon="pi-shopping-bag"
        title="What it is"
        subtitle="Basic information about your product."
      >
        <div class="field">
          <label for="product-name">
            Product name
            <span class="label-bn">পণ্যের নাম</span>
          </label>
          <input id="product-name" v-model="name" type="text" required :disabled="!canSave" />
          <p class="help">
            Kept separate from the brand, so a product reads as Brand + Name and renaming the
            brand renames it everywhere.
          </p>
        </div>

        <!--
          D-39 / UI-45: each of these can create what it is picking, inline,
          without leaving the half-filled product behind.
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
            add-label="New brand"
            add-placeholder="Pran"
            :disabled="!canSave"
            :create="addBrand"
          />

          <QuickAddSelect
            v-model="baseUnitId"
            field-id="product-unit"
            label="Stock unit"
            label-bn="স্টক যে এককে হিসাব হবে"
            :options="catalog.units"
            :can-add="canManageUnits"
            add-label="New unit"
            add-placeholder="Gaz"
            add-hint="What the goods are counted in. Every conversion rule is measured against it."
            :disabled="!canSave"
            required
            :create="addUnit"
          />
        </div>

        <div class="row">
          <QuickAddSelect
            v-model="categoryId"
            field-id="product-category"
            label="Category"
            label-bn="ক্যাটাগরি"
            empty-label="No category"
            :options="parentCategories"
            :can-add="canManageCategories"
            add-label="New category"
            add-placeholder="Drinks"
            :disabled="!canSave"
            :create="addCategory"
          />

          <QuickAddSelect
            v-if="categoryId !== ''"
            v-model="subcategoryId"
            field-id="product-subcategory"
            label="Subcategory"
            label-bn="সাবক্যাটাগরি"
            empty-label="None"
            :options="subcategories"
            :can-add="canManageCategories"
            add-label="New subcategory"
            add-placeholder="Soft drinks"
            :disabled="!canSave"
            :create="addSubcategory"
          />
        </div>
      </AppCard>

      <AppCard
        icon="pi-tag"
        title="Prices and stock level"
        subtitle="Set your prices, and when to be told that stock is running low."
      >
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
              <span class="label-bn">ক্রয় মূল্য</span>
            </label>
            <input
              id="purchase-price"
              v-model="purchasePrice"
              type="text"
              inputmode="decimal"
              required
              :disabled="!canSave"
            />
            <p class="sher-bn">আপনি কত দিয়ে কেনেন</p>
          </div>

          <div class="field">
            <label for="selling-price">
              Selling price (৳ per {{ priceUnitName }})
              <span class="label-bn">বিক্রয় মূল্য</span>
            </label>
            <input
              id="selling-price"
              v-model="sellingPrice"
              type="text"
              inputmode="decimal"
              required
              :disabled="!canSave"
            />
            <p class="sher-bn">আপনি কত দামে বিক্রি করেন</p>
          </div>

          <div class="field">
            <label for="min-stock">
              Reorder level
              <span class="label-bn">পুনরায় অর্ডার করার স্তর</span>
            </label>
            <input
              id="min-stock"
              v-model="minStock"
              type="text"
              inputmode="decimal"
              :disabled="!canSave"
            />
            <p class="help">Warn me when stock falls to this many {{ baseUnitName }}.</p>
            <p v-if="minStockMixed !== null" class="help mixed-read-back">
              That is {{ minStockMixed }}.
            </p>
          </div>
        </div>

        <p v-if="priceUnit === 'CONVERSION'" class="fine">
          Saved as a price per {{ baseUnitName }}. If it does not divide evenly it is rounded to
          the nearest poisha, and the form will show you what was stored.
        </p>

        <p class="fine">
          Opening stock starts at zero for every product. Entering what you actually have comes
          with the inventory module, so that it is recorded as a real stock movement.
        </p>
      </AppCard>

      <AppCard
        icon="pi-barcode"
        title="Codes"
        subtitle="Optional. A barcode is what lets the counter scan it."
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

        <div class="field">
          <label for="product-description">
            Description
            <span class="label-bn">বর্ণনা</span>
          </label>
          <textarea
            id="product-description"
            v-model="description"
            rows="2"
            :disabled="!canSave"
          />
        </div>
      </AppCard>

      <!--
        UI-09: feature-dependent sections are absent while the feature is off,
        not greyed out — the server refuses them, so offering them would be a
        control that 403s.
      -->
      <AppCard
        v-if="offersOn"
        icon="pi-percentage"
        title="Offer and standing discount"
        subtitle="A discount that applies every time, or an offer that runs for a few days."
      >
        <div class="row">
          <div class="field">
            <label for="discount-type">
              Standing discount
              <span class="label-bn">স্থায়ী ছাড়</span>
            </label>
            <select id="discount-type" v-model="discountType" :disabled="!canSave">
              <option value="">None</option>
              <option value="FIXED_AMOUNT">A fixed amount off</option>
              <option value="PERCENTAGE">A percentage off</option>
            </select>
          </div>

          <div v-if="discountType !== ''" class="field">
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
            <input id="offer-start" v-model="offerStartDate" type="date" :disabled="!canSave" />
          </div>

          <div class="field">
            <label for="offer-end">Runs until</label>
            <input id="offer-end" v-model="offerEndDate" type="date" :disabled="!canSave" />
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
      <AppCard
        icon="pi-box"
        title="Units"
        subtitle="How this product is counted, and whether it is also bought or sold another way."
        subtitle-bn="কোন এককে স্টক হবে, আর কোন এককে কেনা বা বিক্রি হয় — সেটি ঠিক করুন"
      >
        <div class="unit-panels">
          <div class="unit-panel">
            <div class="field">
              <label for="stock-unit">
                I keep stock in
                <span class="label-bn">আমি স্টক রাখি</span>
              </label>
              <select id="stock-unit" v-model="baseUnitId" :disabled="!canSave" required>
                <option v-for="unit in catalog.units" :key="unit.id" :value="unit.id">
                  {{ unit.name }}
                </option>
              </select>
              <p class="sher-bn">পণ্যটি কীসে গোনা হয় — পিস, কার্টন, কেজি</p>
            </div>
          </div>

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
              add-label="New unit"
              add-placeholder="Pipe"
              :disabled="!canSave"
              :create="addUnit"
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

      <AppCard v-if="expiryOn || serialOn" icon="pi-tags" title="How each item is followed">
        <label v-if="expiryOn" class="check">
          <input v-model="tracksExpiry" type="checkbox" :disabled="!canSave" />
          <span>Record an expiry date for each batch of this product</span>
        </label>
        <label v-if="serialOn" class="check">
          <input v-model="tracksSerial" type="checkbox" :disabled="!canSave" />
          <span>Follow each unit of this product by its serial number</span>
        </label>
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
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="router.push('/products')">
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
  </AppShell>
</template>

<style scoped>
/* Fields, cards, callouts, buttons and dialogs come from `design/components.css`. */
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
  max-width: 900px;
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
  margin-bottom: var(--sher-space-4);
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
