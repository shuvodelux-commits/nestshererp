<script setup lang="ts">
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
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { EMPTY_CATALOG, fetchCatalog } from '../api/catalog';
import { ApiError } from '../api/client';
import { fetchProducts, setProductStatus } from '../api/products';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import SortableHeader from '../components/SortableHeader.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * The Products screen (Phase 2, §5.5) — a List screen (UI-22): filter bar →
 * table → paging.
 *
 * Filters are visible on the screen rather than behind a menu (UI-25), and cover
 * what §5.5 and §5.7 name: free text over name, code, barcode and brand, plus
 * brand, category, subcategory and status.
 *
 * The **stock-status filter** §5.7 also lists is deliberately not here: stock
 * arrives in Phase 3, and a filter over figures that do not exist yet would
 * either do nothing or lie.
 *
 * Paging is keyset (§3.9, `OFFSET` banned): "Show more" carries the last row's
 * id back to the server, which is what keeps the list fast as a shop's catalog
 * grows.
 */
const session = useSession();
const router = useRouter();

const canCreate = computed(() => session.can('catalog.product.create'));
const canEdit = computed(() => session.can('catalog.product.edit'));
const canDeactivate = computed(() => session.can('catalog.product.deactivate'));
/** Absent from the response without it — this only decides the column (UI-40). */
const canSeeCost = computed(() => session.can('inventory.cost.view'));

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const products = ref<ProductResponse[]>([]);
const summary = ref<ProductSummary>({ total: 0, active: 0, inactive: 0, withoutBarcode: 0 });
const nextCursor = ref<string | null>(null);
const catalog = ref<CatalogResponse>(EMPTY_CATALOG);

const search = ref('');
const brandId = ref('');
const categoryId = ref('');
const subcategoryId = ref('');
const status = ref('');

const busy = ref(false);
const notice = ref<string | null>(null);

const parentCategories = computed(() =>
  catalog.value.categories.filter((row) => row.parentId === null),
);
const subcategories = computed(() =>
  categoryId.value === ''
    ? []
    : catalog.value.categories.filter((row) => row.parentId === categoryId.value),
);
const brandOptions = computed(() => [
  { id: '', name: 'All brands' },
  ...catalog.value.brands,
]);
const categoryOptions = computed(() => [
  { id: '', name: 'All categories' },
  ...parentCategories.value,
]);
const subcategoryOptions = computed(() => [
  {
    id: '',
    name: `All of ${parentCategories.value.find((row) => row.id === categoryId.value)?.name ?? 'category'}`,
  },
  ...subcategories.value,
]);
const statusOptions = [
  { value: '', label: 'Active and inactive' },
  { value: 'ACTIVE', label: 'Active only' },
  { value: 'INACTIVE', label: 'Inactive only' },
];

const filtersActive = computed(
  () =>
    search.value !== '' ||
    brandId.value !== '' ||
    categoryId.value !== '' ||
    subcategoryId.value !== '' ||
    status.value !== '',
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

/**
 * A reorder level is a scaled quantity, so it is formatted by `shared-utils`
 * too (UI-31). Dividing by a thousand here would be arithmetic on a quantity in
 * a component, which R-C3 and B8 both forbid.
 */
function qty(raw: number): string {
  return Qty(raw).format();
}

function currentQuery(cursor: string | null = null) {
  return {
    ...(search.value === '' ? {} : { search: search.value }),
    ...(brandId.value === '' ? {} : { brandId: brandId.value }),
    // The narrower of the two wins: a subcategory is a category.
    ...(subcategoryId.value !== ''
      ? { categoryId: subcategoryId.value }
      : categoryId.value === ''
        ? {}
        : { categoryId: categoryId.value }),
    ...(status.value === '' ? {} : { status: status.value as 'ACTIVE' | 'INACTIVE' }),
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
  subcategoryId.value = '';
});

function clearFilters(): void {
  search.value = '';
  brandId.value = '';
  categoryId.value = '';
  subcategoryId.value = '';
  status.value = '';
  void load();
}

/* --------------------------------------------------------- deactivate */

const confirming = ref<ProductResponse | null>(null);

async function toggleStatus(): Promise<void> {
  const product = confirming.value;
  if (product === null) return;

  busy.value = true;
  try {
    const next = product.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await setProductStatus(session.accessToken.value ?? '', product.id, next);
    notice.value =
      next === 'INACTIVE'
        ? `${product.displayName} will not appear in new sales or purchases. Nothing recorded about it changes.`
        : `${product.displayName} can be sold and purchased again.`;
    confirming.value = null;
    await load();
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

function openProduct(product: ProductResponse): void {
  void router.push(`/products/${product.id}`);
}
</script>

<template>
  <AppShell
    title="Products"
    :breadcrumb="['Dashboard', 'Products']"
    help-bn="আপনার দোকানের সব পণ্য — দাম, ইউনিট আর বারকোড এখানে"
  >
    <template #actions>
      <Button
        v-if="canCreate"
        label="Add product"
        icon="pi pi-plus"
        @click="router.push('/products/new')"
      />
    </template>

    <!-- UI-25: filters are visible, and what is filtered is readable at a glance -->
    <form class="filters" @submit.prevent="load">
      <div class="field grow">
        <label for="product-search">Search</label>
        <InputText
          id="product-search"
          v-model="search"
          type="search"
          placeholder="Name, code, barcode or brand"
          fluid
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

      <Button type="submit" label="Search" severity="secondary" outlined />
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
        A product needs a name, a unit, its two prices and a reorder level. Stock comes later,
        when the inventory module arrives — every product starts at zero.
        <template #action>
          <button
            v-if="canCreate"
            type="button"
            class="btn btn-primary"
            @click="router.push('/products/new')"
          >
            Add the first product
          </button>
        </template>
      </EmptyState>

      <EmptyState v-else-if="products.length === 0" icon="pi-search" title="Nothing matched">
        No product matches these filters.
        <template #action>
          <button type="button" class="btn btn-ghost" @click="clearFilters">Clear the filters</button>
        </template>
      </EmptyState>

      <template v-else>
        <div class="table-wrap">
          <table>
            <thead>
              <!--
                UI-46: every one of these sorts on tap. `Actions` does not, and
                is a plain `th` — it holds buttons, not a value to order by.
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
                  column="barcode"
                  label="Code / barcode"
                  label-bn="বারকোড"
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
                  column="unitName"
                  label="Unit"
                  label-bn="একক"
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
                  column="minStockQty"
                  label="Reorder at"
                  label-bn="যত কমে গেলে আবার আনতে হবে"
                  numeric
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <SortableHeader
                  column="status"
                  label="Status"
                  label-bn="চালু আছে কি না"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <th class="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="product in products"
                :key="product.id"
                :class="{ 'is-inactive': product.status === 'INACTIVE' }"
              >
                <td>
                  <button type="button" class="linkish name" @click="openProduct(product)">
                    {{ product.displayName }}
                  </button>
                  <span v-if="product.offerLive" class="pill pill-info">Offer on</span>
                </td>
                <td class="mono">
                  <span v-if="product.sku !== null">{{ product.sku }}</span>
                  <span v-if="product.sku !== null && product.barcode !== null"> · </span>
                  <span v-if="product.barcode !== null">{{ product.barcode }}</span>
                  <span v-if="product.sku === null && product.barcode === null">—</span>
                </td>
                <td>
                  <span v-if="product.parentCategoryName !== null" class="muted">
                    {{ product.parentCategoryName }} ›
                  </span>
                  {{ product.categoryName ?? '—' }}
                </td>
                <td>{{ product.baseUnitName }}</td>
                <td class="num">{{ money(product.sellingPriceMinor) }}</td>
                <td v-if="canSeeCost" class="num">{{ money(product.purchasePriceMinor) }}</td>
                <td class="num">{{ product.minStockQty === 0 ? '—' : qty(product.minStockQty) }}</td>
                <td>
                  <span v-if="product.status === 'ACTIVE'" class="pill pill-ok">Active</span>
                  <span v-else class="pill pill-bad">Inactive</span>
                </td>
                <td class="actions">
                  <button v-if="canEdit" type="button" class="linkish" @click="openProduct(product)">
                    Edit
                  </button>
                  <button
                    v-if="canDeactivate"
                    type="button"
                    class="linkish"
                    :class="{ danger: product.status === 'ACTIVE' }"
                    @click="confirming = product"
                  >
                    {{ product.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- §2.7.I: pagination sits bottom-right. Keyset, so forward only. -->
        <div class="paging">
          <span class="muted">Showing {{ products.length }} of {{ summary.total }}</span>
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
        Purchase price is not shown to your role, and is not sent to this screen at all.
      </p>
    </template>

    <!-- --------------------------------------------- deactivate / reactivate -->
    <div v-if="confirming !== null" class="scrim" @click.self="confirming = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>
          {{ confirming.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate' }}
          {{ confirming.displayName }}?
        </h2>
        <p class="lede">
          <template v-if="confirming.status === 'ACTIVE'">
            It stops appearing in new sales and new purchases. Everything already recorded about
            it stays exactly as it is, and you can reactivate it at any time.
          </template>
          <template v-else> It can be sold and purchased again straight away. </template>
        </p>
        <p class="sher-bn">
          {{
            confirming.status === 'ACTIVE'
              ? 'পণ্যটি আর নতুন বিক্রি বা কেনায় দেখা যাবে না — পুরনো হিসাব ঠিক থাকবে'
              : 'পণ্যটি আবার বিক্রি ও কেনায় ব্যবহার করা যাবে'
          }}
        </p>

        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="confirming = null">
            Cancel
          </button>
          <button
            type="button"
            class="btn"
            :class="confirming.status === 'ACTIVE' ? 'btn-danger' : 'btn-primary'"
            :disabled="busy"
            @click="toggleStatus"
          >
            {{ busy ? 'Saving…' : confirming.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate' }}
          </button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
/*
 * Buttons, fields, tables, badges, dialogs and skeletons come from
 * `design/components.css`. What is left is the filter bar and paging line.
 */
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--sher-space-3);
  margin-bottom: var(--sher-space-5);
}

.filters .field {
  margin: 0;
  min-width: 170px;
}

.filters .field.grow {
  flex: 1 1 260px;
}

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

.name {
  font-weight: 600;
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

.paging {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sher-space-3);
  margin-top: var(--sher-space-4);
  font-size: var(--sher-text-sm);
}
</style>
