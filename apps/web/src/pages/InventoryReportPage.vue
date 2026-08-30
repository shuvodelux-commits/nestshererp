<script setup lang="ts">
import type {
  CostAdjustmentRow,
  ExpirySummary,
  InventoryLot,
  InventoryOverviewResponse,
  InventoryValuationResponse,
  OpeningStockResponse,
  ReportRow,
  StockAdjustmentRow,
} from '@sher/core-contracts';
import { Money, Qty, UnitCost } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
  fetchCostAdjustments,
  fetchInventory,
  fetchInventoryLots,
  fetchInventoryValuation,
  fetchOpeningStock,
  fetchStockAdjustments,
} from '../api/inventory';
import { fetchStockReport } from '../api/reports';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import { taka, qtyText } from '../components/money/money-text';
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
const router = useRouter();
const lots = ref<readonly InventoryLot[]>([]);
const expiring = ref<readonly InventoryLot[]>([]);
/**
 * Which of the Expiry card's three questions is being asked.
 *
 * `null` is the plain list every dated batch appears in, soonest first — what
 * the card showed before the filters existed, and still the default.
 */
const expiryFilter = ref<'EXPIRED' | 'SOON' | 'MISSING' | null>(null);
const expirySummary = ref<ExpirySummary | null>(null);

/*
 * Phase 9 folded the Stock report into this page rather than building a second
 * screen that answers the same question (owner decision 2026-08-30). Cost of
 * goods sold and margin per product are the two views the inventory endpoints
 * cannot serve, because both need sales data the stock tables do not carry —
 * so they come from `/reports/stock`, and everything else on this page still
 * comes from where it always did.
 */
const cogsRows = ref<readonly ReportRow[]>([]);
const marginRows = ref<readonly ReportRow[]>([]);


async function setExpiryFilter(next: 'EXPIRED' | 'SOON' | 'MISSING'): Promise<void> {
  // Clicking the chip that is already on turns it off, back to the full list.
  expiryFilter.value = expiryFilter.value === next ? null : next;
  await loadExpiring();
}

async function loadExpiring(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const page = await fetchInventoryLots(token, {
      limit: 100,
      sort: 'expiryDate',
      direction: 'ASC',
      status: 'OPEN',
      // The MISSING list is the one place the card asks for batches *without* a
      // date, so `expiringOnly` — which means "has a date" — has to come off.
      ...(expiryFilter.value === null
        ? { expiringOnly: true }
        : { expiry: expiryFilter.value }),
    });
    expiring.value = page.data;
    expirySummary.value = page.expiry ?? expirySummary.value;
  } catch {
    expiring.value = [];
  }
}

/** Red once it is past, amber inside the shop's window, plain before that. */
function expiryTone(date: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return 'expiry-past';
  const days = expirySummary.value?.warnDays ?? 30;
  const edge = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return date <= edge ? 'expiry-soon' : '';
}

/** The date is set where everything else about a product is set (§5.13). */
function openProduct(productId: string): void {
  void router.push({ path: `/products/${productId}` });
}



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
      expirySummary.value = expiringOnly.expiry ?? null;
    } catch {
      lots.value = [];
      expiring.value = [];
      expirySummary.value = null;
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
    // Both need a range; without one the shop's whole history would be summed
    // into a single meaningless row, so they use the month by default.
    const period = { from: fromDate.value === '' ? monthStart() : fromDate.value,
                     to: toDate.value === '' ? todayDate() : toDate.value };
    try {
      const [cogs, margin] = await Promise.all([
        fetchStockReport(token, { ...period, view: 'COGS' }),
        fetchStockReport(token, { ...period, view: 'MARGIN' }),
      ]);
      cogsRows.value = cogs.rows;
      marginRows.value = margin.rows;
    } catch {
      cogsRows.value = [];
      marginRows.value = [];
    }
  }

  loading.value = false;
}

onMounted(load);
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);

/** Today and the first of this month, for the two sales-derived sections. */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function monthStart(): string {
  return `${todayDate().slice(0, 7)}-01`;
}

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
    title="Stock report"
    :breadcrumb="['Dashboard', 'Reports', 'Stock']"
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
                <td class="num">{{ qtyText(row.qtyOnHand) }}</td>
                <td class="num">{{ qtyText(row.minStockQty) }}</td>
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
                <td class="num">{{ qtyText(row.qtyOnHand) }}</td>
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
                  <td class="num">{{ qtyText(row.qtyDelta) }}</td>
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
                  {{ qtyText(row.qty) }}
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
        <!--
          Three questions a shopkeeper actually asks, counted by the same query
          as the rows under them (§2.7.I): what is dead, what is about to die,
          and what nobody has dated. Nothing here posts — the two ways to clear
          a batch open the screens that already do it (owner decision
          2026-08-26).
        -->
        <div class="expiry-filters no-print">
          <button
            type="button"
            :class="{ 'chip--on': expiryFilter === 'EXPIRED' }"
            class="chip chip--danger"
            @click="setExpiryFilter('EXPIRED')"
          >
            Expired <small>মেয়াদ শেষ</small>
            <b>{{ expirySummary?.expiredCount ?? 0 }}</b>
          </button>
          <button
            type="button"
            :class="{ 'chip--on': expiryFilter === 'SOON' }"
            class="chip chip--warn"
            @click="setExpiryFilter('SOON')"
          >
            Expiring soon <small>{{ expirySummary?.warnDays ?? 30 }} দিনের মধ্যে</small>
            <b>{{ expirySummary?.soonCount ?? 0 }}</b>
          </button>
          <button
            type="button"
            :class="{ 'chip--on': expiryFilter === 'MISSING' }"
            class="chip"
            @click="setExpiryFilter('MISSING')"
          >
            Missing date <small>তারিখ নেই</small>
            <b>{{ expirySummary?.missingCount ?? 0 }}</b>
          </button>
          <span v-if="expirySummary?.expiredValueMinor" class="expiry-loss">
            Expired stock is worth {{ taka(expirySummary.expiredValueMinor) }}
          </span>
        </div>

        <EmptyState v-if="expiring.length === 0" icon="pi-calendar" title="Nothing to show">
          <template v-if="expiryFilter === null">
            Batches with an expiry date appear here, soonest first, once expiry tracking is on for
            a product.
          </template>
          <template v-else>Nothing in this list right now.</template>
        </EmptyState>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Expiry<small>মেয়াদ শেষ</small></th>
                <th>Product<small>পণ্য</small></th>
                <th>Batch<small>চালান</small></th>
                <th class="num">Left<small>বাকি</small></th>
                <th class="no-print" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="lot in expiring" :key="lot.id">
                <td>
                  <span v-if="lot.expiryDate === null" class="badge badge--missing">
                    No date — তারিখ নেই
                  </span>
                  <span v-else :class="expiryTone(lot.expiryDate)">{{ lot.expiryDate }}</span>
                </td>
                <td><strong>{{ lot.productName }}</strong></td>
                <td>{{ lot.sourceNumber }}</td>
                <td class="num">{{ qtyText(lot.qtyRemaining) }}</td>
                <td class="num no-print">
                  <button
                    v-if="lot.sourceType === 'PURCHASE'"
                    type="button"
                    class="link"
                    @click="router.push({ path: `/purchases/${lot.sourceId}` })"
                  >
                    Return to supplier
                  </button>
                  <button type="button" class="link" @click="openProduct(lot.productId)">
                    {{ lot.expiryDate === null ? 'Set expiry date' : 'Open product' }}
                  </button>
                </td>
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
                <td class="num">{{ qtyText(lot.qtyReceived) }}</td>
                <td class="num">{{ qtyText(lot.qtyRemaining) }}</td>
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

      <!-- ------------------------------------------ cost of goods sold (§5.20) -->
      <AppCard
        v-if="canSeeCost && cogsRows.length > 0"
        title="Cost of goods sold"
        subtitle="বিক্রি হওয়া পণ্যের কেনা দাম — দিন অনুযায়ী"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date<small>তারিখ</small></th>
                <th class="num">Entries<small>কয়টি লেনদেন</small></th>
                <th class="num">Cost of goods sold<small>বিক্রির কেনা দাম</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in cogsRows" :key="row.key">
                <td>{{ row.label }}</td>
                <td class="num">{{ row.count }}</td>
                <td class="num">{{ money(row.amountMinor) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <!-- ------------------------------------------------ margin per product -->
      <AppCard
        v-if="canSeeCost && marginRows.length > 0"
        title="Margin per product"
        subtitle="কোন পণ্যে কত লাভ"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product<small>পণ্য</small></th>
                <th class="num">Sold<small>বিক্রি হয়েছে</small></th>
                <th class="num">Earned<small>বিক্রির টাকা</small></th>
                <th class="num">Cost<small>কেনা দাম</small></th>
                <th class="num">Profit<small>লাভ</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in marginRows" :key="row.key">
                <td><strong>{{ row.label }}</strong></td>
                <td class="num">{{ qtyText(row.qty) }}</td>
                <td class="num">{{ money(row.amountMinor) }}</td>
                <td class="num">{{ money(row.costMinor ?? 0) }}</td>
                <td class="num">{{ money(row.profitMinor ?? 0) }}</td>
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
        <div><span>Opening quantity</span><strong>{{ qtyText(sourceOpening.qty) }}</strong></div>
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
        <div><span>Quantity</span><strong>{{ qtyText(sourceAdjustment.qtyDelta) }}</strong></div>
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
.expiry-filters {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--sher-line-strong);
  border-radius: 999px;
  background: transparent;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.chip small {
  color: var(--sher-text-muted);
  font-size: 0.72rem;
}

.chip b {
  font-variant-numeric: tabular-nums;
}

.chip--on {
  border-color: var(--sher-primary, #2563eb);
  background: var(--sher-primary-soft, #eff6ff);
}

.chip--danger.chip--on {
  border-color: var(--sher-danger-line, #fca5a5);
  background: var(--sher-danger-soft, #fef2f2);
}

.chip--warn.chip--on {
  border-color: var(--sher-warn-line);
  background: var(--sher-warn-soft, #fffbeb);
}

.expiry-loss {
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}

.expiry-past {
  color: var(--sher-danger-text, #b91c1c);
  font-weight: 600;
}

.expiry-soon {
  color: var(--sher-warn-text, #92400e);
  font-weight: 600;
}

.badge--missing {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  border: 1px dashed var(--sher-line-strong);
  font-size: 0.75rem;
  color: var(--sher-text-muted);
}

.link {
  border: 0;
  background: none;
  padding: 0 0.35rem;
  font: inherit;
  font-size: 0.8rem;
  color: var(--sher-primary, #2563eb);
  cursor: pointer;
}

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
