<script setup lang="ts">
import { qtyText } from './money/money-text';
import type { InventoryLot, InventoryLotSort, ProductResponse, SortDirection } from '@sher/core-contracts';
import { Money, Qty, UnitCost } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import { fetchInventoryLots } from '../api/inventory';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import EmptyState from './EmptyState.vue';
import ErrorNotice from './ErrorNotice.vue';
import SortableHeader from './SortableHeader.vue';

/**
 * Which batch a product's stock came from (§5.11) — the `Lots` action on the
 * Products row menu.
 *
 * Read-only, always. A lot is changed by the document that consumed it, never
 * by editing this table, and **no row can show a negative remaining quantity**:
 * DR13.11 and INV-03 say a lot cannot go below zero, and the `OVERSOLD` rows
 * with `-1` remaining in the old build were a defect, not a feature. Selling
 * beyond stock is handled by the negative-stock true-up (DR13.7), which lives
 * on the product's position rather than on a lot.
 */
const props = defineProps<{ product: ProductResponse | null }>();
const emit = defineEmits<{ (event: 'close'): void }>();

const session = useSession();

/**
 * "No filter" is a value the dropdown can hold. PrimeVue reads an empty model
 * as *nothing chosen* and draws the placeholder instead, which left the filter
 * resting on its own default looking like an empty box.
 */
const ANY = 'any';

const lotStatusOptions = [
  { label: 'All batches', value: ANY },
  { label: 'Still has stock', value: 'OPEN' },
  { label: 'Used up', value: 'CLOSED' },
];

const visible = computed({
  get: () => props.product !== null,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const lots = ref<InventoryLot[]>([]);
const status = ref<typeof ANY | 'OPEN' | 'CLOSED'>(ANY);
const sort = ref<InventoryLotSort>('businessDate');
const direction = ref<SortDirection>('DESC');
const nextCursor = ref<string | null>(null);

async function load(append = false): Promise<void> {
  const product = props.product;
  if (product === null) return;
  loading.value = true;
  error.value = null;
  try {
    const page = await fetchInventoryLots(session.accessToken.value ?? '', {
      productId: product.id,
      limit: 50,
      sort: sort.value,
      direction: direction.value,
      ...(status.value === ANY ? {} : { status: status.value }),
      ...(append && nextCursor.value !== null ? { cursor: nextCursor.value } : {}),
    });
    lots.value = append ? [...lots.value, ...page.data] : [...page.data];
    nextCursor.value = page.page.nextCursor;
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'LOAD_FAILED', message: 'The batches could not be loaded. Try again.' };
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.product?.id,
  (id) => {
    if (id === undefined) return;
    lots.value = [];
    nextCursor.value = null;
    void load();
  },
  { immediate: true },
);

function sortBy(column: string): void {
  const next = column as InventoryLotSort;
  if (sort.value === next) {
    direction.value = direction.value === 'ASC' ? 'DESC' : 'ASC';
  } else {
    sort.value = next;
    direction.value = ['qtyReceived', 'qtyRemaining', 'businessDate'].includes(next) ? 'DESC' : 'ASC';
  }
  void load();
}

const totalRemaining = computed(() =>
  qtyText(lots.value.reduce((sum, lot) => sum + lot.qtyRemaining, 0)),
);
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Stock batches — কোন চালানের পণ্য"
    :style="{ width: 'min(72rem, 96vw)' }"
  >
    <template v-if="product !== null">
      <div class="lot-toolbar">
        <div>
          <strong>{{ product.displayName }}</strong>
          <span>{{ totalRemaining }} {{ product.baseUnitName }} left across these batches</span>
        </div>
        <div class="field">
          <label for="lot-status">Show <span>কোনগুলো দেখবেন</span></label>
          <Select
            v-model="status"
            input-id="lot-status"
            :options="lotStatusOptions"
            option-label="label"
            option-value="value"
            append-to="self"
            @change="load()"
          />
        </div>
      </div>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />
      <div v-else-if="loading && lots.length === 0" class="skeleton skeleton-table" aria-busy="true" aria-label="Loading batches" />
      <EmptyState v-else-if="lots.length === 0" icon="pi-box" title="No batches yet">
        A batch appears when stock arrives — from an opening figure, a purchase, or a stock
        adjustment that added units.
      </EmptyState>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <SortableHeader column="businessDate" label="Date" label-bn="তারিখ" :active="sort" :direction="direction" @sort="sortBy" />
              <th>Source<small>কোন লেনদেন থেকে</small></th>
              <SortableHeader column="qtyReceived" label="Came in" label-bn="যত এসেছিল" numeric :active="sort" :direction="direction" @sort="sortBy" />
              <SortableHeader column="qtyRemaining" label="Left" label-bn="এখন বাকি" numeric :active="sort" :direction="direction" @sort="sortBy" />
              <SortableHeader column="expiryDate" label="Expiry" label-bn="মেয়াদ" :active="sort" :direction="direction" @sort="sortBy" />
              <SortableHeader column="status" label="Status" label-bn="অবস্থা" :active="sort" :direction="direction" @sort="sortBy" />
              <th v-if="lots[0]?.actualUnitCost !== undefined" class="num">Unit cost<small>প্রতি একক খরচ</small></th>
              <th v-if="lots[0]?.valueMinor !== undefined" class="num">Value left<small>বাকি স্টকের মূল্য</small></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="lot in lots" :key="lot.id">
              <td>{{ lot.businessDate }}</td>
              <td>
                <strong>{{ lot.sourceNumber }}</strong>
                <small>{{ lot.sourceType.replaceAll('_', ' ').toLowerCase() }}</small>
              </td>
              <td class="num">{{ qtyText(lot.qtyReceived) }}</td>
              <td class="num">{{ qtyText(lot.qtyRemaining) }}</td>
              <td>{{ lot.expiryDate ?? '—' }}</td>
              <td>
                <span class="pill" :class="lot.status === 'OPEN' ? 'pill-ok' : ''">
                  {{ lot.status === 'OPEN' ? 'Has stock' : 'Used up' }}
                </span>
              </td>
              <td v-if="lot.actualUnitCost !== undefined" class="num">
                ৳{{ UnitCost(lot.actualUnitCost).format() }}
              </td>
              <td v-if="lot.valueMinor !== undefined" class="num">
                ৳{{ Money(lot.valueMinor).format() }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="nextCursor !== null" class="paging">
        <button type="button" class="btn btn-ghost" :disabled="loading" @click="load(true)">
          {{ loading ? 'Loading…' : 'Show more' }}
        </button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.lot-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sher-space-3);
  margin-bottom: var(--sher-space-3);
  flex-wrap: wrap;
}

.lot-toolbar > div:first-child {
  display: grid;
  gap: 2px;
}

.lot-toolbar span {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
}

.lot-toolbar .field {
  margin: 0;
  min-width: 12rem;
}

.lot-toolbar label span {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
  font-weight: 400;
}

th small {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
  font-weight: 400;
}

td small {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.paging {
  display: flex;
  justify-content: center;
  margin-top: var(--sher-space-3);
}
</style>
