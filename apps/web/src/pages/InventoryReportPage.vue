<script setup lang="ts">
import type {
  CostAdjustmentRow,
  InventoryLot,
  InventoryOverviewResponse,
  InventoryValuationResponse,
  OpeningStockResponse,
  StockAdjustmentRow,
} from '@sher/core-contracts';
import { Money, Qty, UnitCost } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import { computed, onMounted, ref } from 'vue';

import {
  fetchCostAdjustments,
  fetchInventory,
  fetchInventoryLots,
  fetchInventoryValuation,
  fetchOpeningStock,
  fetchStockAdjustments,
} from '../api/inventory';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Inventory Report (§5.10) — the cross-product views.
 *
 * Per-product work (adjust, lots, opening) lives on the Products row menu,
 * because it belongs to a product. What is left here is what has **no single
 * product to hang from**: what the whole shelf is worth, what is running out,
 * what was written off this month, and why a valuation figure moved.
 *
 * Every figure comes from stock movements and journal lines (INV-10). Nothing
 * on this page is computed in Vue — the sections render what the server
 * derived, and the valuation card shows the server's own reconciliation against
 * the `INVENTORY` account rather than a subtraction done here.
 */
const session = useSession();

const canSeeCost = computed(() => session.can('inventory.cost.view'));
const canViewLots = computed(() => session.can('inventory.lot.view'));

const fromDate = ref('');
const toDate = ref('');

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);

const overview = ref<InventoryOverviewResponse>({ stock: [], movements: [] });
const valuation = ref<InventoryValuationResponse | null>(null);
const adjustments = ref<readonly StockAdjustmentRow[]>([]);
const costAdjustments = ref<readonly CostAdjustmentRow[]>([]);
const lots = ref<readonly InventoryLot[]>([]);
const expiring = ref<readonly InventoryLot[]>([]);

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'LOAD_FAILED', message: fallback };
}

function range() {
  return {
    ...(fromDate.value === '' ? {} : { fromDate: fromDate.value }),
    ...(toDate.value === '' ? {} : { toDate: toDate.value }),
  };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  const token = session.accessToken.value ?? '';

  try {
    overview.value = await fetchInventory(token, { ...range(), limit: 200 });
    adjustments.value = await fetchStockAdjustments(token, { ...range(), limit: 200 });
  } catch (cause) {
    error.value = describe(cause, 'The inventory report could not be loaded. Try again.');
    loading.value = false;
    return;
  }

  // Each of the remaining sections is permission-gated and optional: one of
  // them failing must not blank the whole report, so their errors stay local.
  if (canViewLots.value) {
    try {
      const [all, expiringOnly] = await Promise.all([
        fetchInventoryLots(token, { limit: 100, sort: 'businessDate', direction: 'DESC' }),
        fetchInventoryLots(token, {
          limit: 100,
          sort: 'expiryDate',
          direction: 'ASC',
          expiringOnly: true,
          status: 'OPEN',
        }),
      ]);
      lots.value = all.data;
      expiring.value = expiringOnly.data;
    } catch {
      lots.value = [];
      expiring.value = [];
    }
  }

  if (canSeeCost.value) {
    try {
      valuation.value = await fetchInventoryValuation(token);
    } catch {
      valuation.value = null;
    }
    try {
      costAdjustments.value = await fetchCostAdjustments(token, { ...range(), limit: 200 });
    } catch {
      costAdjustments.value = [];
    }
  }

  loading.value = false;
}

onMounted(load);
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);

function clearRange(): void {
  fromDate.value = '';
  toDate.value = '';
  void load();
}

/** Worst first — the point of the section is what to reorder today. */
const lowStock = computed(() =>
  [...overview.value.stock]
    .filter((row) => row.stockStatus === 'LOW_STOCK' || row.stockStatus === 'ZERO_STOCK' || row.stockStatus === 'NEGATIVE_STOCK')
    .sort((left, right) => left.qtyOnHand - right.qtyOnHand),
);

/** §5.10's Damaged & Written-off: everything that left for a reason, not a sale. */
const writtenOff = computed(() => adjustments.value.filter((row) => row.direction === 'OUT'));

const reasonLabels: Record<string, string> = {
  DAMAGE: 'Damaged',
  RECOUNT: 'Recount',
  THEFT_LOSS: 'Lost or stolen',
  OTHER: 'Other',
};

const costReasonLabels: Record<string, string> = {
  BACKDATE: 'Backdated document',
  EDIT: 'Document edited',
  LANDED_COST: 'Landed cost added',
  SYNC_TRUE_UP: 'Corrected after sync',
  NEGATIVE_STOCK_TRUE_UP: 'Negative stock settled',
};

function money(minor: number | undefined): string {
  return minor === undefined ? '—' : `৳${Money(minor).format()}`;
}

const totalWrittenOffMinor = computed(() =>
  writtenOff.value.reduce((sum, row) => sum + (row.valueMinor ?? 0), 0),
);

/* ------------------------------------------------------ the "Why?" drill-down */

/**
 * §5.20's explainability requirement: every figure opens the transaction that
 * produced it. A movement names its source document, and this shows it without
 * leaving the report.
 */
const sourceOpen = ref(false);
const sourceLoading = ref(false);
const sourceError = ref<{ code: string; message: string } | null>(null);
const sourceOpening = ref<OpeningStockResponse | null>(null);
const sourceAdjustment = ref<StockAdjustmentRow | null>(null);

async function openSource(sourceType: string, sourceId: string): Promise<void> {
  sourceOpen.value = true;
  sourceLoading.value = true;
  sourceError.value = null;
  sourceOpening.value = null;
  sourceAdjustment.value = null;

  // An adjustment is already fully loaded on this page — asking the server
  // again for a row it just sent would be a round trip for nothing.
  if (sourceType === 'STOCK_ADJUSTMENT') {
    sourceAdjustment.value = adjustments.value.find((row) => row.id === sourceId) ?? null;
    if (sourceAdjustment.value === null) {
      sourceError.value = {
        code: 'OUT_OF_RANGE',
        message: 'That adjustment is outside the dates shown. Widen the range to see it.',
      };
    }
    sourceLoading.value = false;
    return;
  }

  if (sourceType !== 'OPENING_STOCK') {
    sourceError.value = {
      code: 'SOURCE_NOT_AVAILABLE',
      message: 'This source module is not available yet.',
    };
    sourceLoading.value = false;
    return;
  }

  try {
    sourceOpening.value = await fetchOpeningStock(session.accessToken.value ?? '', sourceId);
  } catch (cause) {
    sourceError.value = describe(cause, 'The source transaction could not be loaded.');
  } finally {
    sourceLoading.value = false;
  }
}
</script>

<template>
  <AppShell
    title="Inventory Report"
    :breadcrumb="['Dashboard', 'Inventory Report']"
    help-bn="স্টকের হিসাব — কত আছে, কত দাম, কী নষ্ট হয়েছে"
  >
    <form class="filters" @submit.prevent="load">
      <div class="field">
        <label for="report-from">From <span>শুরুর তারিখ</span></label>
        <DateOnlyPicker input-id="report-from" v-model="fromDate" />
      </div>
      <div class="field">
        <label for="report-to">To <span>শেষ তারিখ</span></label>
        <DateOnlyPicker input-id="report-to" v-model="toDate" />
      </div>
      <button type="submit" class="btn btn-secondary">Apply</button>
      <button
        v-if="fromDate !== '' || toDate !== ''"
        type="button"
        class="btn btn-ghost"
        @click="clearRange"
      >
        Clear
      </button>
    </form>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading the inventory report">
      <div class="skeleton skeleton-table" />
    </div>

    <AppCard v-else-if="error !== null" title="Could not load the inventory report">
      <ErrorNotice :code="error.code" :message="error.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <!-- ------------------------------------------------------- valuation -->
      <div v-if="valuation !== null" class="stats-grid">
        <StatCard
          label="Stock value"
          :value="`৳${Money(valuation.totalValueMinor).format()}`"
          :detail="`${valuation.method} — স্টকের হিসাব করা মূল্য`"
          icon="pi-box"
          tone="slate"
        />
        <StatCard
          label="In the ledger"
          :value="`৳${Money(valuation.inventoryAccountMinor).format()}`"
          detail="জার্নালে থাকা একই হিসাব"
          icon="pi-book"
          tone="blue"
        />
        <StatCard
          label="Do they agree?"
          :value="valuation.reconciled ? 'Yes' : `৳${Money(valuation.differenceMinor).format()} off`"
          :detail="valuation.reconciled ? 'স্টক ও জার্নাল মিলেছে' : 'হিসাবে অমিল — যাচাই করুন'"
          :icon="valuation.reconciled ? 'pi-check-circle' : 'pi-exclamation-triangle'"
          :tone="valuation.reconciled ? 'green' : 'amber'"
        />
      </div>

      <!-- -------------------------------------------------------- low stock -->
      <AppCard title="Low and out of stock" subtitle="যা ফুরিয়ে আসছে — আগে এগুলো কিনুন">
        <EmptyState v-if="lowStock.length === 0" icon="pi-check-circle" title="Nothing is running low">
          Every product is above its reorder level.
        </EmptyState>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product<small>পণ্য</small></th>
                <th class="num">On hand<small>এখন আছে</small></th>
                <th class="num">Reorder at<small>কত হলে কিনবেন</small></th>
                <th>Status<small>অবস্থা</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in lowStock" :key="`${row.productId}:${row.locationId ?? 'none'}`">
                <td>
                  <strong>{{ row.productName }}</strong>
                  <small>{{ row.baseUnitName }}</small>
                </td>
                <td class="num">{{ Qty(row.qtyOnHand).format() }}</td>
                <td class="num">{{ Qty(row.minStockQty).format() }}</td>
                <td>
                  <span
                    class="pill"
                    :class="row.stockStatus === 'LOW_STOCK' ? 'pill-warn' : 'pill-bad'"
                  >
                    {{ row.stockStatus.replaceAll('_', ' ').toLowerCase() }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <!-- --------------------------------------------------- stock overview -->
      <AppCard title="Stock on hand" subtitle="প্রতিটি পণ্যের বর্তমান স্টক">
        <EmptyState v-if="overview.stock.length === 0" icon="pi-box" title="No stock recorded yet">
          Record what you already hold as a product's opening stock, or receive it on a purchase.
        </EmptyState>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product<small>পণ্য</small></th>
                <th>Where<small>কোথায়</small></th>
                <th class="num">On hand<small>এখন আছে</small></th>
                <th v-if="canSeeCost" class="num">Value<small>মূল্য</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in overview.stock" :key="`${row.productId}:${row.locationId ?? 'none'}`">
                <td>
                  <strong>{{ row.productName }}</strong>
                  <small>{{ row.baseUnitName }}</small>
                </td>
                <td>{{ row.locationName ?? 'Not stocked yet' }}</td>
                <td class="num">{{ Qty(row.qtyOnHand).format() }}</td>
                <td v-if="canSeeCost" class="num">{{ money(row.valueMinor) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <!-- ------------------------------------------- damaged & written off -->
      <AppCard title="Damaged and written off" subtitle="নষ্ট, হারানো ও গুনে কম পাওয়া">
        <EmptyState v-if="writtenOff.length === 0" icon="pi-check-circle" title="Nothing written off">
          Stock removed for damage, loss or a recount appears here with its reason and value.
        </EmptyState>
        <template v-else>
          <p v-if="canSeeCost" class="total-line">
            Written off in this period: <strong>{{ money(totalWrittenOffMinor) }}</strong>
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date<small>তারিখ</small></th>
                  <th>Product<small>পণ্য</small></th>
                  <th>Reason<small>কারণ</small></th>
                  <th class="num">Quantity<small>পরিমাণ</small></th>
                  <th v-if="canSeeCost" class="num">Value<small>মূল্য</small></th>
                  <th>By<small>কে করেছে</small></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in writtenOff" :key="row.id">
                  <td>{{ row.businessDate }}</td>
                  <td>
                    <strong>{{ row.productName }}</strong>
                    <small>{{ row.number }}</small>
                  </td>
                  <td>
                    {{ reasonLabels[row.reason] ?? row.reason }}
                    <small v-if="row.note !== null">{{ row.note }}</small>
                  </td>
                  <td class="num">{{ Qty(row.qtyDelta).format() }}</td>
                  <td v-if="canSeeCost" class="num">{{ money(row.valueMinor) }}</td>
                  <td>{{ row.createdByName }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </AppCard>

      <!-- --------------------------------------------------- stock movements -->
      <AppCard title="Stock movements" subtitle="প্রতিটি স্টক পরিবর্তনের হিসাব">
        <EmptyState v-if="overview.movements.length === 0" icon="pi-history" title="No movements yet">
          Stock never changes silently. Every posted movement is listed here with its source.
        </EmptyState>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date<small>তারিখ</small></th>
                <th>Product<small>পণ্য</small></th>
                <th>Source<small>কোন লেনদেন</small></th>
                <th class="num">Quantity<small>পরিমাণ</small></th>
                <th v-if="canSeeCost" class="num">Unit cost<small>প্রতি একক খরচ</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in overview.movements" :key="row.id">
                <td>{{ row.businessDate }}</td>
                <td><strong>{{ row.productName }}</strong></td>
                <td>
                  <button
                    type="button"
                    class="linkish source-link"
                    @click="openSource(row.sourceType, row.sourceId)"
                  >
                    {{ row.sourceNumber }}
                  </button>
                  <small>{{ row.sourceType.replaceAll('_', ' ').toLowerCase() }}</small>
                </td>
                <td class="num">
                  <span class="pill" :class="row.direction === 'IN' ? 'pill-ok' : 'pill-warn'">
                    {{ row.direction === 'IN' ? 'in' : 'out' }}
                  </span>
                  {{ Qty(row.qty).format() }}
                </td>
                <td v-if="canSeeCost" class="num">
                  {{ row.unitCost === undefined ? '—' : `৳${UnitCost(row.unitCost).format()}` }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <!-- ------------------------------------------------------------ expiry -->
      <AppCard v-if="canViewLots" title="Expiry" subtitle="মেয়াদ শেষের তারিখ অনুযায়ী">
        <EmptyState v-if="expiring.length === 0" icon="pi-calendar" title="Nothing tracks expiry">
          Batches with an expiry date appear here, soonest first, once expiry tracking is on for a
          product.
        </EmptyState>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Expiry<small>মেয়াদ শেষ</small></th>
                <th>Product<small>পণ্য</small></th>
                <th>Batch<small>চালান</small></th>
                <th class="num">Left<small>বাকি</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="lot in expiring" :key="lot.id">
                <td>{{ lot.expiryDate }}</td>
                <td><strong>{{ lot.productName }}</strong></td>
                <td>{{ lot.sourceNumber }}</td>
                <td class="num">{{ Qty(lot.qtyRemaining).format() }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <!-- -------------------------------------------------------------- lots -->
      <AppCard v-if="canViewLots" title="Stock batches" subtitle="সব পণ্যের চালান একসাথে">
        <EmptyState v-if="lots.length === 0" icon="pi-box" title="No batches yet">
          A batch appears when stock arrives — from an opening figure, a purchase, or an
          adjustment that added units.
        </EmptyState>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date<small>তারিখ</small></th>
                <th>Product<small>পণ্য</small></th>
                <th>Source<small>কোন লেনদেন</small></th>
                <th class="num">Came in<small>যত এসেছিল</small></th>
                <th class="num">Left<small>বাকি</small></th>
                <th v-if="canSeeCost" class="num">Value left<small>বাকির মূল্য</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="lot in lots" :key="lot.id">
                <td>{{ lot.businessDate }}</td>
                <td><strong>{{ lot.productName }}</strong></td>
                <td>{{ lot.sourceNumber }}</td>
                <td class="num">{{ Qty(lot.qtyReceived).format() }}</td>
                <td class="num">{{ Qty(lot.qtyRemaining).format() }}</td>
                <td v-if="canSeeCost" class="num">{{ money(lot.valueMinor) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <!-- --------------------------------------------------- cost adjustments -->
      <AppCard
        v-if="canSeeCost"
        title="Cost adjustments"
        subtitle="স্টকের মূল্য কেন বদলেছে"
      >
        <EmptyState v-if="costAdjustments.length === 0" icon="pi-calculator" title="No cost corrections">
          When a backdated purchase, a landed cost or a negative-stock settlement changes what
          past stock was worth, the correction is explained here rather than rewriting history.
        </EmptyState>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date<small>তারিখ</small></th>
                <th>Product<small>পণ্য</small></th>
                <th>Why<small>কারণ</small></th>
                <th>Document<small>কোন কাগজ</small></th>
                <th class="num">Amount<small>পরিমাণ</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in costAdjustments" :key="row.id">
                <td>{{ row.businessDate }}</td>
                <td><strong>{{ row.productName }}</strong></td>
                <td>{{ costReasonLabels[row.reason] ?? row.reason }}</td>
                <td>{{ row.documentRef }}</td>
                <td class="num">{{ money(row.amountMinor) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <p v-if="!canSeeCost" class="fine">
        Stock values and cost corrections are not shown to your role, and are not sent to this
        screen at all.
      </p>
    </template>

    <!-- §5.20 "Why?": the transaction behind the movement, without leaving here -->
    <Dialog
      v-model:visible="sourceOpen"
      modal
      header="Source transaction — মূল লেনদেন"
      :style="{ width: 'min(36rem, 94vw)' }"
    >
      <div v-if="sourceLoading" class="skeleton skeleton-table source-skeleton" aria-busy="true" />
      <ErrorNotice
        v-else-if="sourceError !== null"
        :code="sourceError.code"
        :message="sourceError.message"
      />
      <div v-else-if="sourceOpening !== null" class="source-detail">
        <div><span>Reference</span><strong>{{ sourceOpening.number }}</strong></div>
        <div><span>Product</span><strong>{{ sourceOpening.productName }}</strong></div>
        <div><span>Date</span><strong>{{ sourceOpening.businessDate }}</strong></div>
        <div><span>Where</span><strong>{{ sourceOpening.locationName }}</strong></div>
        <div><span>Opening quantity</span><strong>{{ Qty(sourceOpening.qty).format() }}</strong></div>
        <div v-if="sourceOpening.expiryDate">
          <span>Expiry</span><strong>{{ sourceOpening.expiryDate }}</strong>
        </div>
        <div v-if="sourceOpening.unitCost !== undefined">
          <span>Unit cost</span><strong>৳{{ UnitCost(sourceOpening.unitCost).format() }}</strong>
        </div>
        <div v-if="sourceOpening.valueMinor !== undefined">
          <span>Total value</span><strong>৳{{ Money(sourceOpening.valueMinor).format() }}</strong>
        </div>
      </div>
      <div v-else-if="sourceAdjustment !== null" class="source-detail">
        <div><span>Reference</span><strong>{{ sourceAdjustment.number }}</strong></div>
        <div><span>Product</span><strong>{{ sourceAdjustment.productName }}</strong></div>
        <div><span>Date</span><strong>{{ sourceAdjustment.businessDate }}</strong></div>
        <div>
          <span>Reason</span>
          <strong>{{ reasonLabels[sourceAdjustment.reason] ?? sourceAdjustment.reason }}</strong>
        </div>
        <div><span>Quantity</span><strong>{{ Qty(sourceAdjustment.qtyDelta).format() }}</strong></div>
        <div v-if="sourceAdjustment.valueMinor !== undefined">
          <span>Value</span><strong>{{ money(sourceAdjustment.valueMinor) }}</strong>
        </div>
        <div><span>Entered by</span><strong>{{ sourceAdjustment.createdByName }}</strong></div>
        <div v-if="sourceAdjustment.note !== null">
          <span>Note</span><strong>{{ sourceAdjustment.note }}</strong>
        </div>
      </div>
    </Dialog>
  </AppShell>
</template>

<style scoped>
.filters label span {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sher-space-3);
  margin-bottom: var(--sher-space-4);
}

.skeleton-table {
  height: 320px;
}

.retry {
  margin-top: var(--sher-space-4);
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

.total-line {
  margin: 0 0 var(--sher-space-3);
  color: var(--sher-text-muted);
  font-variant-numeric: tabular-nums;
}

.source-link {
  font-weight: 600;
}

.source-skeleton {
  height: 8rem;
}

.source-detail {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sher-space-3);
}

.source-detail div {
  padding: 10px 12px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
}

.source-detail span,
.source-detail strong {
  display: block;
}

.source-detail span {
  color: var(--sher-text-muted);
  font-size: 11px;
  margin-bottom: 2px;
}

@media (max-width: 1023px) {
  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>
