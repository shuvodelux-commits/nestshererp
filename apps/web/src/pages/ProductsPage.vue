<script setup lang="ts">
import { qtyText } from '../components/money/money-text';
import type {
  CatalogResponse,
  ProductResponse,
  ProductSort,
  ProductSummary,
  SortDirection,
} from '@sher/core-contracts';
import { defaultDirectionFor } from '@sher/core-contracts';
import { Money, Qty } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Menu from 'primevue/menu';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { EMPTY_CATALOG, fetchCatalog } from '../api/catalog';
import { ApiError } from '../api/client';
import { deleteProduct, fetchProducts, setProductStatus } from '../api/products';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import ProductForm from '../components/ProductForm.vue';
import SearchField from '../components/SearchField.vue';
import SortableHeader from '../components/SortableHeader.vue';
import StockAdjustDialog from '../components/StockAdjustDialog.vue';
import StockLotsDialog from '../components/StockLotsDialog.vue';
import OfflineBar from '../components/offline/OfflineBar.vue';
import {
  asOfText,
  NEEDS_INTERNET,
  NEEDS_INTERNET_BN,
} from '../components/offline/offline-text';
import AppShell from '../components/shell/AppShell.vue';
import { useConnectivity } from '../offline/connectivity';
import { useSnapshot } from '../offline/snapshot';

/**
 * Products — the product working hub (§5.5, owner decision 2026-08-20).
 *
 * M04 and the per-product half of M12 are **one screen**, because a shopkeeper
 * thinks about a product, not about which module owns its quantity. Everything
 * done to one product happens from its `⋯` row menu and opens as a modal over
 * this list (UI-50): the shopkeeper keeps their place, and the changed row is
 * behind the dialog when it closes, which is its own confirmation.
 *
 * What is *not* here is the cross-product reporting — valuation, movements,
 * the damage trail — which has no single product to hang from and lives on the
 * Inventory Report (§5.10).
 *
 * Actions the caller cannot perform are **absent from the menu, not disabled**
 * (UI-09), and the server refuses them independently either way (R-D2).
 */
const session = useSession();
const router = useRouter();

/*
 * Phase 12.3. The list itself needs no branch here: `fetchProducts` reads the
 * local copy when the server cannot be reached, and hands back the same
 * response shape either way. What the page has to know is only what a person
 * must be told — that it is offline, and how old the numbers are.
 */
const { isOffline } = useConnectivity();
const { stored } = useSnapshot();

/** The clock time on the copy, for the "as of" beside a stock figure. */
const storedAt = computed<string | null>(() => {
  const takenAt = stored.value?.takenAt;
  if (takenAt === undefined) return null;
  const taken = Date.parse(takenAt);
  if (Number.isNaN(taken)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(taken);
});

const canCreate = computed(() => session.can('catalog.product.create'));
const canEdit = computed(() => session.can('catalog.product.edit'));
const canDeactivate = computed(() => session.can('catalog.product.deactivate'));
const canDelete = computed(() => session.can('catalog.product.delete'));
const canViewLots = computed(() => session.can('inventory.lot.view'));
/** Absent from the response without it — this only decides the columns (UI-40). */
const canSeeCost = computed(() => session.can('inventory.cost.view'));

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const products = ref<ProductResponse[]>([]);
const summary = ref<ProductSummary>({ total: 0, active: 0, inactive: 0, withoutBarcode: 0 });
const nextCursor = ref<string | null>(null);
const catalog = ref<CatalogResponse>(EMPTY_CATALOG);

/**
 * "No filter" is a value the dropdown can actually hold, not an empty string.
 *
 * PrimeVue reads an empty model as *nothing chosen* and draws the placeholder,
 * so a filter resting on its own default ("All brands") came out blank — five
 * empty boxes that read as broken rather than as unfiltered.
 */
const ANY = 'any';

const search = ref('');
const brandId = ref(ANY);
const categoryId = ref(ANY);
const subcategoryId = ref(ANY);
const status = ref(ANY);
const stockStatus = ref(ANY);

const busy = ref(false);
const notice = ref<string | null>(null);

const parentCategories = computed(() =>
  catalog.value.categories.filter((row) => row.parentId === null),
);
const subcategories = computed(() =>
  categoryId.value === ANY
    ? []
    : catalog.value.categories.filter((row) => row.parentId === categoryId.value),
);
const brandOptions = computed(() => [{ id: ANY, name: 'All brands' }, ...catalog.value.brands]);
const categoryOptions = computed(() => [
  { id: ANY, name: 'All categories' },
  ...parentCategories.value,
]);
const subcategoryOptions = computed(() => [
  {
    id: ANY,
    name: `All of ${parentCategories.value.find((row) => row.id === categoryId.value)?.name ?? 'category'}`,
  },
  ...subcategories.value,
]);
const statusOptions = [
  { value: ANY, label: 'Active and inactive' },
  { value: 'ACTIVE', label: 'Active only' },
  { value: 'INACTIVE', label: 'Inactive only' },
];
/**
 * §5.7's stock-status filter, now that stock exists. Applied to the loaded page
 * rather than sent to the server: `stockStatus` is derived from the reorder
 * level per row, not an indexed column, and filtering it in SQL would mean a
 * keyset cursor over a computed value. Stated plainly so nobody reads it as a
 * business rule living in Vue — the *classification* is the server's (§5.10),
 * this only chooses which of the returned rows to draw.
 */
const stockStatusOptions = [
  { value: ANY, label: 'Any stock level' },
  { value: 'IN_STOCK', label: 'In stock' },
  { value: 'LOW_STOCK', label: 'Low stock' },
  { value: 'ZERO_STOCK', label: 'Out of stock' },
  { value: 'NEGATIVE_STOCK', label: 'Negative stock' },
];

const filtersActive = computed(
  () =>
    search.value !== '' ||
    brandId.value !== ANY ||
    categoryId.value !== ANY ||
    subcategoryId.value !== ANY ||
    status.value !== ANY ||
    stockStatus.value !== ANY,
);

const visibleProducts = computed(() =>
  stockStatus.value === ANY
    ? products.value
    : products.value.filter((product) => product.stockStatus === stockStatus.value),
);

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

/** UI-31/UI-32: formatted by shared-utils, right-aligned, two decimals, ৳. */
function money(minor: number | undefined): string {
  return minor === undefined ? '—' : `৳${Money(minor).format()}`;
}

function currentQuery(cursor: string | null = null) {
  return {
    ...(search.value === '' ? {} : { search: search.value }),
    ...(brandId.value === ANY ? {} : { brandId: brandId.value }),
    // The narrower of the two wins: a subcategory is a category.
    ...(subcategoryId.value !== ANY
      ? { categoryId: subcategoryId.value }
      : categoryId.value === ANY
        ? {}
        : { categoryId: categoryId.value }),
    ...(status.value === ANY ? {} : { status: status.value as 'ACTIVE' | 'INACTIVE' }),
    ...(cursor === null ? {} : { cursor }),
    sort: sort.value,
    direction: direction.value,
  };
}

/**
 * Which header is tapped, and which way (UI-46).
 *
 * Tapping the column already sorted reverses it; tapping a different one starts
 * that column at its own natural direction — text A-first, numbers biggest-first
 * — because "show me the reorder levels" means the ones needing attention.
 */
const sort = ref<ProductSort>('name');
const direction = ref<SortDirection>('ASC');

function sortBy(column: string): void {
  const next = column as ProductSort;

  if (sort.value === next) {
    direction.value = direction.value === 'ASC' ? 'DESC' : 'ASC';
  } else {
    sort.value = next;
    direction.value = defaultDirectionFor(next);
  }

  // A new order is a new list, so paging starts again from the top rather than
  // appending the second page of the old order underneath the first of the new.
  void load();
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const page = await fetchProducts(session.accessToken.value ?? '', currentQuery());
    products.value = [...page.data];
    summary.value = page.summary;
    nextCursor.value = page.page.nextCursor;
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
}

/** Keyset paging: the next page is appended, never re-fetched from an offset. */
async function showMore(): Promise<void> {
  if (nextCursor.value === null || busy.value) return;
  busy.value = true;
  try {
    const page = await fetchProducts(
      session.accessToken.value ?? '',
      currentQuery(nextCursor.value),
    );
    products.value = [...products.value, ...page.data];
    nextCursor.value = page.page.nextCursor;
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    catalog.value = await fetchCatalog(session.accessToken.value ?? '');
  } catch {
    // The filter dropdowns are a convenience; the list itself still works, and
    // its own failure is what the error card is for.
  }
  await load();
});

// Choosing a different category invalidates whichever subcategory was chosen.
watch(categoryId, () => {
  subcategoryId.value = ANY;
});

function clearFilters(): void {
  search.value = '';
  brandId.value = ANY;
  categoryId.value = ANY;
  subcategoryId.value = ANY;
  status.value = ANY;
  stockStatus.value = ANY;
  void load();
}

/* ------------------------------------------------------------- the row menu */

const menu = ref<InstanceType<typeof Menu> | null>(null);
const menuProduct = ref<ProductResponse | null>(null);

/**
 * One menu instance, repositioned — not one per row. A hundred products would
 * otherwise mean a hundred mounted popups.
 */
const menuItems = computed(() => {
  const product = menuProduct.value;
  if (product === null) return [];

  const items: Array<Record<string, unknown>> = [];

  if (canEdit.value) {
    items.push({ label: 'Edit', icon: 'pi pi-pencil', command: () => openForm(product) });
  }
  if (canEdit.value) {
    items.push({ label: 'Stock', icon: 'pi pi-sliders-h', command: () => (adjusting.value = product) });
  }
  if (canViewLots.value) {
    items.push({ label: 'Lots', icon: 'pi pi-box', command: () => (viewingLots.value = product) });
  }
  if (canDeactivate.value) {
    items.push({
      label: product.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate',
      icon: product.status === 'ACTIVE' ? 'pi pi-ban' : 'pi pi-check-circle',
      command: () => (confirmingStatus.value = product),
    });
  }
  // §3.6: a product with stock history cannot be removed, so the action that
  // would always be refused is not offered. The server refuses it regardless.
  if (canDelete.value && !product.hasStockHistory) {
    items.push({ separator: true });
    items.push({
      label: 'Delete',
      icon: 'pi pi-trash',
      class: 'row-menu-danger',
      command: () => (confirmingDelete.value = product),
    });
  }

  return items;
});

function openMenu(event: Event, product: ProductResponse): void {
  menuProduct.value = product;
  menu.value?.toggle(event);
}

/* ------------------------------------------------------------ the form dialog */

const editing = ref<ProductResponse | null>(null);
const creating = ref(false);
const formOpen = computed({
  get: () => creating.value || editing.value !== null,
  set: (open: boolean) => {
    if (!open) closeForm();
  },
});

function openForm(product: ProductResponse): void {
  editing.value = product;
  creating.value = false;
}

function closeForm(): void {
  editing.value = null;
  creating.value = false;
}

/**
 * UI-64: a save returns to the list that launched it, refreshed in place — the
 * shopkeeper keeps their filters, their sort and their position.
 */
async function onSaved(): Promise<void> {
  closeForm();
  await load();
}

/* ----------------------------------------------- deactivate / reactivate / delete */

const confirmingStatus = ref<ProductResponse | null>(null);
const confirmingDelete = ref<ProductResponse | null>(null);

async function toggleStatus(): Promise<void> {
  const product = confirmingStatus.value;
  if (product === null) return;

  busy.value = true;
  try {
    const next = product.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await setProductStatus(session.accessToken.value ?? '', product.id, next);
    notice.value =
      next === 'INACTIVE'
        ? `${product.displayName} will not appear in new sales or purchases. Nothing recorded about it changes.`
        : `${product.displayName} can be sold and purchased again.`;
    confirmingStatus.value = null;
    await load();
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

async function removeProduct(): Promise<void> {
  const product = confirmingDelete.value;
  if (product === null) return;

  busy.value = true;
  try {
    await deleteProduct(session.accessToken.value ?? '', product.id);
    notice.value = `${product.displayName} was deleted.`;
    confirmingDelete.value = null;
    await load();
  } catch (cause) {
    // The server's own refusal — including "this has stock history, deactivate
    // it instead" — is what the shopkeeper reads, not a guess made here.
    loadError.value = describe(cause);
    confirmingDelete.value = null;
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------------- stock dialogs */

const adjusting = ref<ProductResponse | null>(null);
const viewingLots = ref<ProductResponse | null>(null);

async function onAdjusted(): Promise<void> {
  const name = adjusting.value?.displayName ?? 'Stock';
  adjusting.value = null;
  notice.value = `${name} stock updated.`;
  await load();
}

/** The stock column's own colour, by what it means for the shop. */
function stockPill(product: ProductResponse): string {
  if (product.stockStatus === 'NEGATIVE_STOCK') return 'pill-bad';
  if (product.stockStatus === 'ZERO_STOCK') return 'pill-bad';
  if (product.stockStatus === 'LOW_STOCK') return 'pill-warn';
  return 'pill-ok';
}
</script>

<template>
  <AppShell
    title="Products"
    :breadcrumb="['Dashboard', 'Products']"
    help-bn="আপনার দোকানের সব পণ্য — দাম, স্টক আর হিসাব এখানে"
  >
    <template #actions>
      <!-- §5.6: the same list is where a whole catalogue arrives from a file. -->
      <Button
        v-if="canCreate"
        label="Import"
        icon="pi pi-upload"
        severity="secondary"
        :disabled="isOffline"
        @click="router.push('/import?type=PRODUCTS')"
      />
      <Button
        v-if="canCreate"
        label="Add product"
        icon="pi pi-plus"
        :disabled="isOffline"
        @click="creating = true"
      />
      <!--
        Owner decision 2026-08-31: a saving action greys out and says why, and
        is never hidden. Hiding is what an unauthorised action gets; being
        offline is a passing condition, and a button that vanished would read
        as the feature being gone.
      -->
      <span v-if="isOffline" class="needs-internet">
        {{ NEEDS_INTERNET }}
        <span class="label-bn">{{ NEEDS_INTERNET_BN }}</span>
      </span>
    </template>

    <OfflineBar />

    <!-- UI-25: filters are visible, and what is filtered is readable at a glance -->
    <form class="filters" @submit.prevent="load">
      <div class="field grow">
        <SearchField
          v-model="search"
          field-id="product-search"
          label="Search products"
          placeholder="Any part of a name, brand, category, code or barcode — in any order"
          @search="load"
        />
      </div>

      <div class="field">
        <label for="filter-brand">Brand</label>
        <Select
          v-model="brandId"
          input-id="filter-brand"
          :options="brandOptions"
          option-label="name"
          option-value="id"
          :filter="catalog.brands.length > 8"
          filter-placeholder="Search brands"
          append-to="self"
          fluid
          @change="load"
        />
      </div>

      <div class="field">
        <label for="filter-category">Category</label>
        <Select
          v-model="categoryId"
          input-id="filter-category"
          :options="categoryOptions"
          option-label="name"
          option-value="id"
          :filter="parentCategories.length > 8"
          filter-placeholder="Search categories"
          append-to="self"
          fluid
          @change="load"
        />
      </div>

      <div v-if="subcategories.length > 0" class="field">
        <label for="filter-subcategory">Subcategory</label>
        <Select
          v-model="subcategoryId"
          input-id="filter-subcategory"
          :options="subcategoryOptions"
          option-label="name"
          option-value="id"
          :filter="subcategories.length > 8"
          filter-placeholder="Search subcategories"
          append-to="self"
          fluid
          @change="load"
        />
      </div>

      <div class="field">
        <label for="filter-stock">Stock</label>
        <Select
          v-model="stockStatus"
          input-id="filter-stock"
          :options="stockStatusOptions"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
        />
      </div>

      <div class="field">
        <label for="filter-status">Status</label>
        <Select
          v-model="status"
          input-id="filter-status"
          :options="statusOptions"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
          @change="load"
        />
      </div>

      <Button
        v-if="filtersActive"
        type="button"
        label="Clear"
        severity="secondary"
        text
        @click="clearFilters"
      />
    </form>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading products">
      <div class="skeleton skeleton-table" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not load your products">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

      <EmptyState
        v-if="products.length === 0 && !filtersActive"
        icon="pi-box"
        title="No products yet"
      >
        A product needs a name, a unit, its two prices and a reorder level. You can record what
        you already have on the shelf in the same breath, as its opening stock.
        <template #action>
          <button v-if="canCreate" type="button" class="btn btn-primary" @click="creating = true">
            Add the first product
          </button>
        </template>
      </EmptyState>

      <EmptyState
        v-else-if="visibleProducts.length === 0"
        icon="pi-search"
        title="Nothing matched"
      >
        No product matches these filters.
        <template #action>
          <button type="button" class="btn btn-ghost" @click="clearFilters">
            Clear the filters
          </button>
        </template>
      </EmptyState>

      <template v-else>
        <!--
          Phase 18.4 — the same rows as cards below 640px (owner decision
          2026-09-03). On a phone the table below slid sideways and took the
          selling price and the stock figure off the right-hand edge, which are
          the two things somebody standing in front of the shelf opened this
          screen for. Same data, same actions, one shape at a time; the desktop
          table is untouched.
        -->
        <ul class="list-cards">
          <li
            v-for="product in visibleProducts"
            :key="`card-${product.id}`"
            class="list-card"
            :class="{ 'is-inactive': product.status === 'INACTIVE' }"
          >
            <span class="list-card-title">
              <button type="button" class="linkish name" @click="openForm(product)">
                {{ product.displayName }}
              </button>
              <span v-if="product.offerLive" class="pill pill-info">Offer on</span>
            </span>

            <span class="list-card-amount">{{ money(product.sellingPriceMinor) }}</span>

            <p class="list-card-sub">
              {{ product.categoryName ?? 'No category' }} · {{ product.baseUnitName }}
            </p>

            <div class="list-card-foot">
              <span class="stock-line">
                Stock {{ qtyText(product.stockQty) }}
                <span
                  v-if="product.stockStatus !== 'IN_STOCK'"
                  class="pill"
                  :class="stockPill(product)"
                >
                  {{ product.stockStatus === 'LOW_STOCK' ? 'Low' : product.stockStatus === 'ZERO_STOCK' ? 'Out' : 'Negative' }}
                </span>
                <span v-if="isOffline && storedAt !== null" class="as-of">
                  {{ asOfText(storedAt) }}
                </span>
              </span>

              <span v-if="product.status !== 'ACTIVE'" class="pill pill-bad">Inactive</span>

              <button
                type="button"
                class="row-menu-trigger card-menu"
                :aria-label="`Actions for ${product.displayName}`"
                aria-haspopup="true"
                :disabled="isOffline"
                :title="isOffline ? NEEDS_INTERNET : ''"
                @click="openMenu($event, product)"
              >
                <i class="pi pi-ellipsis-h" aria-hidden="true" />
              </button>
            </div>
          </li>
        </ul>

        <div class="table-wrap">
          <table>
            <thead>
              <!--
                UI-46: every one of these sorts on tap. The `⋯` column does not,
                and is a plain `th` — it holds one action, not a value to order by.
              -->
              <tr>
                <SortableHeader
                  column="name"
                  label="Product"
                  label-bn="পণ্যের নাম"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <SortableHeader
                  column="categoryName"
                  label="Category"
                  label-bn="ধরন"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <SortableHeader
                  v-if="canSeeCost"
                  column="purchasePrice"
                  label="Purchase"
                  label-bn="কেনা দর"
                  numeric
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <SortableHeader
                  column="sellingPrice"
                  label="Selling"
                  label-bn="বিক্রয় দর"
                  numeric
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <!--
                  Not sortable — `stockQty` has no sort key in the contract —
                  but drawn with the same label box as the columns that are, so
                  the header row reads as one row.
                -->
                <th class="num">
                  <span class="th-label">
                    Stock
                    <span class="sher-bn header-bn">স্টক</span>
                  </span>
                </th>
                <!--
                  Phase 18.3 (owner decision 2026-09-03) — column trimming.
                  `Stock value` used to sit here. Nobody acts on one product's
                  valuation from the product list: it is the Inventory Report's
                  whole subject, where it is totalled, reconciled to the journal
                  and provable (INV-05). Here it was a per-row number that
                  narrowed every column beside it and answered nothing.
                -->

                <SortableHeader
                  column="status"
                  label="Status"
                  label-bn="চালু আছে কি না"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <th class="actions-col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="product in visibleProducts"
                :key="product.id"
                :class="{ 'is-inactive': product.status === 'INACTIVE' }"
              >
                <td>
                  <button type="button" class="linkish name" @click="openForm(product)">
                    {{ product.displayName }}
                  </button>
                  <span v-if="product.offerLive" class="pill pill-info">Offer on</span>
                  <small>{{ product.baseUnitName }}</small>
                </td>
                <td>
                  <span v-if="product.parentCategoryName !== null" class="muted">
                    {{ product.parentCategoryName }} ›
                  </span>
                  {{ product.categoryName ?? '—' }}
                </td>
                <td v-if="canSeeCost" class="num">{{ money(product.purchasePriceMinor) }}</td>
                <td class="num">{{ money(product.sellingPriceMinor) }}</td>
                <td class="num">
                  {{ qtyText(product.stockQty) }}
                  <span
                    v-if="product.stockStatus !== 'IN_STOCK'"
                    class="pill"
                    :class="stockPill(product)"
                  >
                    {{ product.stockStatus === 'LOW_STOCK' ? 'Low' : product.stockStatus === 'ZERO_STOCK' ? 'Out' : 'Negative' }}
                  </span>
                  <!--
                    Owner decision 2026-08-31: offline, the number is shown as
                    it stands with the time it was taken beside it. A
                    shopkeeper knows their own shelf better than any screen and
                    wants a starting figure; hiding it does not make the shelf
                    less countable, and the bar above has already said the data
                    is old.
                  -->
                  <span v-if="isOffline && storedAt !== null" class="as-of">
                    {{ asOfText(storedAt) }}
                  </span>
                </td>
                <td>
                  <span v-if="product.status === 'ACTIVE'" class="pill pill-ok">Active</span>
                  <span v-else class="pill pill-bad">Inactive</span>
                </td>
                <td class="actions">
                  <button
                    type="button"
                    class="row-menu-trigger"
                    :aria-label="`Actions for ${product.displayName}`"
                    aria-haspopup="true"
                    v-tooltip.left="'Edit, stock, lots and more'"
                    :disabled="isOffline"
                    :title="isOffline ? NEEDS_INTERNET : ''"
                    @click="openMenu($event, product)"
                  >
                    <i class="pi pi-ellipsis-h" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- One popup for every row, repositioned on open. -->
        <Menu ref="menu" :model="menuItems" popup />

        <!-- §2.7.I: pagination sits bottom-right. Keyset, so forward only. -->
        <div class="paging">
          <span class="muted">Showing {{ visibleProducts.length }} of {{ summary.total }}</span>
          <button
            v-if="nextCursor !== null"
            type="button"
            class="btn btn-ghost"
            :disabled="busy"
            @click="showMore"
          >
            {{ busy ? 'Loading…' : 'Show more' }}
          </button>
        </div>
      </template>

      <p v-if="!canSeeCost" class="fine">
        Purchase price and stock value are not shown to your role, and are not sent to this
        screen at all.
      </p>
    </template>

    <!-- ------------------------------------------------------- add / edit -->
    <Dialog
      v-model:visible="formOpen"
      modal
      :header="creating ? 'Add product — নতুন পণ্য' : 'Edit product — পণ্যের তথ্য'"
      :style="{ width: 'min(52rem, 96vw)' }"
    >
      <ProductForm
        :key="editing?.id ?? 'new'"
        :product-id="editing?.id ?? null"
        @saved="onSaved"
        @deleted="onSaved"
        @close="closeForm"
      />
    </Dialog>

    <StockAdjustDialog :product="adjusting" @close="adjusting = null" @adjusted="onAdjusted" />
    <StockLotsDialog :product="viewingLots" @close="viewingLots = null" />

    <!-- --------------------------------------------- deactivate / reactivate -->
    <div v-if="confirmingStatus !== null" class="scrim" @click.self="confirmingStatus = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>
          {{ confirmingStatus.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate' }}
          {{ confirmingStatus.displayName }}?
        </h2>
        <p class="lede">
          <template v-if="confirmingStatus.status === 'ACTIVE'">
            It stops appearing in new sales and new purchases. Everything already recorded about
            it stays exactly as it is, and you can reactivate it at any time.
          </template>
          <template v-else> It can be sold and purchased again straight away. </template>
        </p>
        <p class="sher-bn">
          {{
            confirmingStatus.status === 'ACTIVE'
              ? 'পণ্যটি আর নতুন বিক্রি বা কেনায় দেখা যাবে না — পুরনো হিসাব ঠিক থাকবে'
              : 'পণ্যটি আবার বিক্রি ও কেনায় ব্যবহার করা যাবে'
          }}
        </p>

        <div class="dialog-actions">
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="busy"
            @click="confirmingStatus = null"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn"
            :class="confirmingStatus.status === 'ACTIVE' ? 'btn-danger' : 'btn-primary'"
            :disabled="busy"
            @click="toggleStatus"
          >
            {{ busy ? 'Saving…' : confirmingStatus.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------------ delete -->
    <div v-if="confirmingDelete !== null" class="scrim" @click.self="confirmingDelete = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Delete {{ confirmingDelete.displayName }}?</h2>
        <p class="lede">
          Nothing has ever been stocked, bought or sold for this product, so it can be removed
          completely. This cannot be undone.
        </p>
        <p class="sher-bn">পণ্যটি একেবারে মুছে যাবে — আর ফেরানো যাবে না</p>

        <div class="dialog-actions">
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="busy"
            @click="confirmingDelete = null"
          >
            Cancel
          </button>
          <button type="button" class="btn btn-danger" :disabled="busy" @click="removeProduct">
            {{ busy ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
/* Phase 12.3 — the offline markers. Both are quiet on purpose: the bar at the
   top of the page is what states the condition, and these only stop a figure
   or a button being read as something it is not. */
.needs-internet {
  display: grid;
  align-self: center;
  font-size: 12px;
  line-height: 1.2;
  color: var(--sher-text-muted);
}

.as-of {
  display: block;
  font-size: 11px;
  color: var(--sher-text-muted);
}

/*
 * Buttons, fields, tables, badges, dialogs and skeletons come from
 * `design/components.css`. What is left is the filter bar, the row menu trigger
 * and the paging line.
 */
.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton-table {
  height: 320px;
}

.retry {
  margin-top: var(--sher-space-4);
}

/* UI-32: money and quantity right-aligned, with tabular figures. */
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

th small {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.name {
  font-weight: 600;
}

td small {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
}

.muted {
  color: var(--sher-text-muted);
}

td .pill {
  margin-left: 8px;
}

/* An inactive product still reads, but stops competing with the active ones. */
tbody tr.is-inactive td:not(.actions) {
  color: var(--sher-text-muted);
}

.actions-col,
td.actions {
  width: 44px;
  text-align: right;
}

/* 40px stays the touch target even though the glyph is small (UI-59). */
.row-menu-trigger {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--sher-radius);
  background: transparent;
  color: var(--sher-text-muted);
  cursor: pointer;
}

.row-menu-trigger:hover,
.row-menu-trigger:focus-visible {
  border-color: var(--sher-line-strong);
  background: var(--sher-sunken);
  color: var(--sher-text);
}

.paging {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sher-space-3);
  margin-top: var(--sher-space-4);
  font-size: var(--sher-text-sm);
}

/* Phase 18.4 — the phone card list. The shape is `design/components.css`'s. */
.list-card.is-inactive {
  opacity: 0.65;
}

.stock-line {
  margin-right: auto;
  font-size: var(--sher-text-sm);
  font-variant-numeric: tabular-nums;
}

/* 44px, so the ⋯ is a thumb target rather than a mouse target (UI-42). */
.card-menu {
  min-width: 44px;
  min-height: 44px;
}
</style>

<style>
/* Not scoped: the menu renders in a popup outside this component's tree. */
.row-menu-danger .p-menu-item-label,
.row-menu-danger .p-menu-item-icon {
  color: var(--sher-bad);
}
</style>
