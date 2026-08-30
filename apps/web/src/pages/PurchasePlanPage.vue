<script setup lang="ts">
import type {
  CatalogResponse,
  PartyResponse,
  PlannerRowResponse,
  ProductResponse,
  PurchasePlanLineRequest,
  PurchasePlanListResponse,
  SupplierOrderListResponse,
} from '@sher/core-contracts';
import { allocateBudget, planTotals } from '@sher/core-domain';
import { Qty } from '@sher/shared-utils';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchParties } from '../api/parties';
import { fetchCatalog } from '../api/catalog';
import { fetchProducts } from '../api/products';
import {
  createPurchasePlan,
  decidePurchasePlan,
  deletePurchasePlan,
  fetchPlannerSuggestions,
  fetchPurchasePlans,
  fetchSupplierOrders,
} from '../api/purchase-plans';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import QuickAddProductDialog from '../components/catalog/QuickAddProductDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import AmountInput from '../components/fields/AmountInput.vue';
import { taka, qtyText } from '../components/money/money-text';

/**
 * Purchase Planner · কী কী কিনবেন (§5.9, owner rework 2026-08-26).
 *
 * **Three views of one job**, because that is the job's real shape: work out
 * what to buy, agree it, then order it.
 *
 *   Planner       → analyse the shelf, tick what to buy, save it as a draft
 *   Saved Plans   → approve or reject; approving is what makes the orders
 *   Supplier Orders → open one, print or share it, convert it to a purchase
 *
 * **Nothing here posts anything.** Even approving posts nothing — it produces
 * paper. Stock, lots and the supplier's ledger happen only when an order is
 * converted and the ordinary New Purchase screen saves.
 *
 * **Analysing is a button, not a side effect.** The first cut reloaded on every
 * change and the owner could not tell how to begin; now the sequence is
 * explicit — set the four numbers, press `Analyze Stock`, then decide.
 *
 * **Quantities are the shopkeeper's.** `Suggested` is what the shop's own sales
 * imply; `Planned Qty` is what they decide, and ticking `Use` is what puts a
 * row on the plan at all. `Auto Fit Budget` fills the planned column in for
 * them, in priority order, and is equally a button rather than something that
 * happens while they type.
 */
const session = useSession();
const router = useRouter();

type Tab = 'PLANNER' | 'PLANS' | 'ORDERS';
const tab = ref<Tab>('PLANNER');

/* ----------------------------------------------------------------- planner */
const rows = ref<readonly PlannerRowResponse[]>([]);
/** Ticked rows, by product. Only these reach the saved plan. */
const used = ref<Record<string, boolean>>({});
/** Planned quantity in whole units, as typed. */
const planned = ref<Record<string, number>>({});
/** A row's supplier, overridable per line. */
const supplierOf = ref<Record<string, string>>({});

/*
 * "Everything" and "nobody" are real choices, so they get real values.
 *
 * A `Select` option whose value is `null` cannot be matched against a `null`
 * model, so it draws blank and misbehaves when picked (owner report
 * 2026-08-26). Sentinels are chosen at the edge and turned back into `null`
 * where the request is built, so nothing below this file ever sees them.
 */
const ALL_SUPPLIERS = 'ALL';
const NO_SUPPLIER = 'NONE';

const scope = ref<string>(ALL_SUPPLIERS);
const lookBackDays = ref(30);
const coverDays = ref(30);
const budgetTaka = ref(0);
const planDate = ref('');
const planNotes = ref('');
const search = ref('');
const addProductId = ref<string | null>(null);

const suppliers = ref<readonly PartyResponse[]>([]);
const products = ref<readonly ProductResponse[]>([]);
/** Units for the quick-add dialog; it needs a base unit and nothing else. */
const catalog = ref<CatalogResponse | null>(null);
const addingNew = ref(false);
const analysing = ref(false);
const saving = ref(false);
const analysed = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const historyOptions = [7, 15, 30, 60, 90].map((d) => ({ label: `${d} days`, value: d }));

const scopeOptions = computed(() => [
  { label: 'All Inventory', value: ALL_SUPPLIERS },
  ...suppliers.value.map((party) => ({ label: party.name, value: party.id })),
]);
const supplierOptions = computed(() => [
  { label: 'Unassigned', value: NO_SUPPLIER },
  ...suppliers.value.map((party) => ({ label: party.name, value: party.id })),
]);
const productOptions = computed(() =>
  products.value.map((product) => ({ label: product.displayName, value: product.id })),
);

const showMoney = computed(() => rows.value.some((row) => row.unitCostMinor !== undefined));
const budgetMinor = computed(() => (budgetTaka.value > 0 ? Math.round(budgetTaka.value * 100) : null));

/** What the table shows, after the plan search box. */
const visibleRows = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (term === '') return rows.value;
  return rows.value.filter(
    (row) =>
      row.displayName.toLowerCase().includes(term) ||
      (row.supplierName ?? '').toLowerCase().includes(term) ||
      row.priority.toLowerCase().includes(term),
  );
});

const chosen = computed(() =>
  rows.value.filter((row) => used.value[row.productId] === true && qtyOf(row.productId) > 0),
);

const totals = computed(() =>
  planTotals(
    chosen.value.map((row) => ({
      qty: Math.round(qtyOf(row.productId) * 1000),
      unitCostMinor: row.unitCostMinor ?? 0,
      sellingPriceMinor: row.sellingPriceMinor ?? 0,
    })),
  ),
);

const criticalCount = computed(() => rows.value.filter((r) => r.priority === 'CRITICAL').length);
const highCount = computed(() => rows.value.filter((r) => r.priority === 'HIGH').length);

function qtyOf(productId: string): number {
  return planned.value[productId] ?? 0;
}

function setQty(productId: string, units: number): void {
  planned.value = { ...planned.value, [productId]: Math.max(units, 0) };
  // Typing a quantity is the shopkeeper saying they want it; ticking the box
  // for them saves a second click they would always make.
  if (units > 0 && used.value[productId] !== true) {
    used.value = { ...used.value, [productId]: true };
  }
}

function investmentOf(row: PlannerRowResponse): number {
  return Math.round(qtyOf(row.productId) * 1000 * (row.unitCostMinor ?? 0) / 1000);
}

function expectedSalesOf(row: PlannerRowResponse): number {
  return Math.round(qtyOf(row.productId) * 1000 * (row.sellingPriceMinor ?? 0) / 1000);
}

/** Read the shelf. Explicit, so the shopkeeper knows where the numbers came from. */
async function analyze(): Promise<void> {
  analysing.value = true;
  failure.value = null;
  try {
    const response = await fetchPlannerSuggestions(session.accessToken.value ?? '', {
      lookBackDays: lookBackDays.value,
      coverDays: coverDays.value,
      ...(scope.value === ALL_SUPPLIERS ? {} : { supplierPartyId: scope.value }),
      limit: 300,
    });
    rows.value = response.data;

    // A fresh analysis is a fresh set of numbers; carrying yesterday's ticks
    // and quantities over would apply old decisions to new figures.
    used.value = {};
    planned.value = {};
    supplierOf.value = Object.fromEntries(
      response.data.map((row) => [row.productId, row.supplierPartyId ?? NO_SUPPLIER]),
    );
    analysed.value = true;
  } catch (cause) {
    failure.value = describe(cause, 'The planner could not be loaded');
  } finally {
    analysing.value = false;
  }
}

/**
 * Spend the budget down the ranked list.
 *
 * The same `allocateBudget` the server would run, on the same numbers — the
 * screen is not allowed a second opinion about how a budget is shared out.
 */
function autoFitBudget(): void {
  if (budgetMinor.value === null) {
    failure.value = { code: 'VALIDATION_FAILED', message: 'Enter a purchase budget first' };
    return;
  }
  failure.value = null;

  const allocation = allocateBudget(
    rows.value.map((row) => ({
      productId: row.productId,
      priority: row.priority,
      wantedQty: row.suggestedQty,
      unitCostMinor: row.unitCostMinor ?? 0,
      sellingPriceMinor: row.sellingPriceMinor ?? 0,
      packQty: row.packQty,
      minOrderQty: row.minOrderQty,
    })),
    budgetMinor.value,
  );

  const nextPlanned: Record<string, number> = {};
  const nextUsed: Record<string, boolean> = {};
  for (const line of allocation.lines) {
    nextPlanned[line.productId] = line.fundedQty / 1000;
    nextUsed[line.productId] = line.fundedQty > 0;
  }
  planned.value = nextPlanned;
  used.value = nextUsed;
}

/** Take the whole suggestion for every row that needs one. */
function useAllSuggested(): void {
  const nextPlanned: Record<string, number> = {};
  const nextUsed: Record<string, boolean> = {};
  for (const row of rows.value) {
    nextPlanned[row.productId] = row.suggestedQty / 1000;
    nextUsed[row.productId] = row.suggestedQty > 0;
  }
  planned.value = nextPlanned;
  used.value = nextUsed;
}

/** Anything can be planned, including something with no stock movement at all. */
function addExistingProduct(): void {
  const productId = addProductId.value;
  if (productId === null) return;
  addProductId.value = null;

  if (rows.value.some((row) => row.productId === productId)) {
    used.value = { ...used.value, [productId]: true };
    return;
  }

  const product = products.value.find((candidate) => candidate.id === productId);
  if (product === undefined) return;

  rows.value = [
    ...rows.value,
    {
      productId: product.id,
      displayName: product.displayName,
      unitName: product.baseUnitName,
      supplierPartyId: product.usualSupplierId,
      supplierName: product.usualSupplierName,
      supplierSource: product.usualSupplierId === null ? 'NONE' : 'USUAL',
      stockQty: product.stockQty,
      minStockQty: product.minStockQty,
      soldQty: 0,
      sellingDays: 0,
      dailySalesQty: 0,
      coverDays: null,
      pendingQty: 0,
      priority: 'LOW',
      suggestedQty: 0,
      plannedQty: 0,
      partlyFunded: false,
      fromHistory: false,
      packQty: product.conversion?.factorQty ?? null,
      minOrderQty: product.minOrderQty,
      ...(product.purchasePriceMinor === undefined
        ? {}
        : {
            unitCostMinor: product.purchasePriceMinor,
            sellingPriceMinor: product.sellingPriceMinor,
            investmentMinor: 0,
            expectedProfitMinor: 0,
          }),
    },
  ];
  supplierOf.value = {
    ...supplierOf.value,
    [product.id]: product.usualSupplierId ?? NO_SUPPLIER,
  };
  used.value = { ...used.value, [product.id]: true };
}

/**
 * A product created from here is on the plan immediately.
 *
 * The shopkeeper opened the dialog *because* they wanted to buy it, so making
 * them find it again in the picker afterwards would be a step that exists for
 * the software's convenience rather than theirs.
 */
function onProductCreated(product: ProductResponse): void {
  addingNew.value = false;
  products.value = [product, ...products.value];
  addProductId.value = product.id;
  addExistingProduct();
}

/** The sentinel turned back into what the API means by "nobody yet". */
function supplierIdOf(row: PlannerRowResponse): string | null {
  const chosenSupplier = supplierOf.value[row.productId] ?? NO_SUPPLIER;
  return chosenSupplier === NO_SUPPLIER ? null : chosenSupplier;
}

async function savePlan(): Promise<void> {
  const lines: PurchasePlanLineRequest[] = chosen.value.map((row) => ({
    productId: row.productId,
    plannedQty: Math.round(qtyOf(row.productId) * 1000),
    supplierPartyId: supplierIdOf(row),
  }));

  if (lines.length === 0) {
    failure.value = {
      code: 'VALIDATION_FAILED',
      message: 'Tick at least one product and give it a quantity',
    };
    return;
  }

  saving.value = true;
  failure.value = null;
  try {
    await createPurchasePlan(session.accessToken.value ?? '', {
      notes: planNotes.value.trim() === '' ? null : planNotes.value.trim(),
      lookBackDays: lookBackDays.value,
      coverDays: coverDays.value,
      budgetMinor: budgetMinor.value,
      lines,
      ...(planDate.value === '' ? {} : { businessDate: planDate.value }),
    });
    planNotes.value = '';
    await loadPlans();
    tab.value = 'PLANS';
  } catch (cause) {
    failure.value = describe(cause, 'The plan could not be saved');
  } finally {
    saving.value = false;
  }
}

/* ------------------------------------------------------------ saved plans */
const plans = ref<PurchasePlanListResponse['data']>([]);
const deleting = ref<PurchasePlanListResponse['data'][number] | null>(null);
const busy = ref(false);

async function loadPlans(): Promise<void> {
  try {
    const response = await fetchPurchasePlans(session.accessToken.value ?? '', { limit: 100 });
    plans.value = response.data;
  } catch (cause) {
    failure.value = describe(cause, 'Saved plans could not be loaded');
  }
}

async function decide(
  plan: PurchasePlanListResponse['data'][number],
  decision: 'APPROVED' | 'REJECTED',
): Promise<void> {
  busy.value = true;
  failure.value = null;
  try {
    await decidePurchasePlan(session.accessToken.value ?? '', plan.id, {
      decision,
      version: plan.version,
    });
    await Promise.all([loadPlans(), loadOrders()]);
    if (decision === 'APPROVED') tab.value = 'ORDERS';
  } catch (cause) {
    failure.value = describe(cause, 'The plan could not be updated');
  } finally {
    busy.value = false;
  }
}

async function removePlan(): Promise<void> {
  const plan = deleting.value;
  if (plan === null) return;
  busy.value = true;
  try {
    await deletePurchasePlan(session.accessToken.value ?? '', plan.id, plan.version);
    deleting.value = null;
    await loadPlans();
  } catch (cause) {
    failure.value = describe(cause, 'The plan could not be deleted');
  } finally {
    busy.value = false;
  }
}

/* -------------------------------------------------------- supplier orders */
const orders = ref<SupplierOrderListResponse['data']>([]);

async function loadOrders(): Promise<void> {
  try {
    const response = await fetchSupplierOrders(session.accessToken.value ?? '');
    orders.value = response.data;
  } catch (cause) {
    failure.value = describe(cause, 'Supplier orders could not be loaded');
  }
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'FAILED', message: `${fallback}. Try again.` };
}

const planStatusLabels: Record<string, string> = {
  DRAFT: 'Draft · খসড়া',
  APPROVED: 'Approved · অনুমোদিত',
  REJECTED: 'Rejected · বাতিল',
};
const orderStatusLabels: Record<string, string> = {
  OPEN: 'Open · খোলা',
  CONVERTED: 'Purchased · কেনা হয়েছে',
  CANCELLED: 'Cancelled · বাতিল',
};
const priorityLabels: Record<string, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

onMounted(async () => {
  const token = session.accessToken.value ?? '';
  await Promise.all([loadPlans(), loadOrders()]);
  try {
    const [supplierList, productList, catalogue] = await Promise.all([
      fetchParties(token, { role: 'SUPPLIER', limit: 200 }),
      fetchProducts(token, { status: 'ACTIVE', limit: 200 }),
      fetchCatalog(token),
    ]);
    suppliers.value = supplierList.data;
    products.value = productList.data;
    catalog.value = catalogue;
  } catch {
    // Pickers that could not load cost a convenience, not the screen.
  }
});
</script>

<template>
  <AppShell title="Purchase Planner" help-bn="কী কী কিনবেন — হিসাব করে ঠিক করুন">
    <div class="tabs no-print">
      <Button
        label="Planner"
        :severity="tab === 'PLANNER' ? undefined : 'secondary'"
        :outlined="tab !== 'PLANNER'"
        @click="tab = 'PLANNER'"
      />
      <Button
        label="Saved Plans"
        :severity="tab === 'PLANS' ? undefined : 'secondary'"
        :outlined="tab !== 'PLANS'"
        @click="tab = 'PLANS'"
      />
      <Button
        label="Supplier Orders"
        :severity="tab === 'ORDERS' ? undefined : 'secondary'"
        :outlined="tab !== 'ORDERS'"
        @click="tab = 'ORDERS'"
      />
    </div>

    <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

    <!-- ============================================================ PLANNER -->
    <template v-if="tab === 'PLANNER'">
      <AppCard>
        <div class="controls">
          <div class="field">
            <label for="pp-scope">Planning Scope <span class="label-bn">কোন সরবরাহকারীর</span></label>
            <Select
              v-model="scope"
              input-id="pp-scope"
              :options="scopeOptions"
              option-label="label"
              option-value="value"
              fluid
            />
          </div>
          <div class="field">
            <label for="pp-history">Sales History <span class="label-bn">কত দিনের বিক্রি</span></label>
            <Select
              v-model="lookBackDays"
              input-id="pp-history"
              :options="historyOptions"
              option-label="label"
              option-value="value"
              fluid
            />
          </div>
          <div class="field">
            <label for="pp-cover">Target Stock Cover <span class="label-bn">কত দিনের মাল রাখবেন</span></label>
            <AmountInput
              input-id="pp-cover"
              v-model="coverDays"
              :min="1"
              :max="365"
              :fraction-digits="0"
              align="left"
            />
          </div>
          <div class="field">
            <label for="pp-budget">Purchase Budget <span class="label-bn">বাজেট — ঐচ্ছিক</span></label>
            <AmountInput input-id="pp-budget" v-model="budgetTaka" :min="0" placeholder="0" />
          </div>
          <div class="field">
            <label for="pp-date">Plan Date <span class="label-bn">তারিখ</span></label>
            <DateOnlyPicker input-id="pp-date" v-model="planDate" />
          </div>
        </div>

        <div class="actions">
          <Button
            label="Analyze Stock"
            icon="pi pi-search"
            :loading="analysing"
            @click="analyze"
          />
          <Button
            label="Use All Suggested"
            icon="pi pi-check-square"
            severity="secondary"
            outlined
            :disabled="!analysed"
            @click="useAllSuggested"
          />
          <Button
            label="Auto Fit Budget"
            icon="pi pi-sliders-h"
            severity="secondary"
            outlined
            :disabled="!analysed"
            @click="autoFitBudget"
          />
          <Button
            label="Add New Product"
            icon="pi pi-plus"
            severity="secondary"
            outlined
            @click="addingNew = true"
          />
        </div>
      </AppCard>

      <div class="tiles">
        <div class="tile"><span>Critical</span><strong>{{ criticalCount }}</strong></div>
        <div class="tile"><span>High Priority</span><strong>{{ highCount }}</strong></div>
        <template v-if="showMoney">
          <div class="tile">
            <span>Planned Investment</span><strong>{{ taka(totals.investmentMinor) }}</strong>
          </div>
          <div class="tile">
            <span>Expected Sales</span><strong>{{ taka(totals.expectedSalesMinor) }}</strong>
          </div>
          <div class="tile">
            <span>Expected Gross Profit</span>
            <strong>{{ taka(totals.expectedProfitMinor) }}</strong>
          </div>
          <div class="tile">
            <span>Margin</span>
            <strong>{{ (totals.marginPercentHundredths / 100).toFixed(2) }}%</strong>
          </div>
        </template>
      </div>

      <AppCard>
        <div class="add-row">
          <div class="field grow">
            <label for="pp-add">Add Existing Product <span class="label-bn">তালিকায় পণ্য যোগ করুন</span></label>
            <Select
              v-model="addProductId"
              input-id="pp-add"
              :options="productOptions"
              option-label="label"
              option-value="value"
              filter
              fluid
              placeholder="Select any product, including zero stock…"
            />
          </div>
          <Button label="Add Product" icon="pi pi-plus" outlined @click="addExistingProduct" />
          <div class="field grow">
            <label for="pp-search">Search Plan <span class="label-bn">খুঁজুন</span></label>
            <input id="pp-search" v-model="search" placeholder="Product / supplier / priority…" />
          </div>
        </div>
      </AppCard>

      <AppCard>
        <EmptyState v-if="!analysed" icon="pi-search" title="Press Analyze Stock to begin">
          Choose how far back to look at sales and how many days of stock you want to hold, then
          press <strong>Analyze Stock</strong>. Tick the products you want and set a quantity.
        </EmptyState>
        <EmptyState
          v-else-if="visibleRows.length === 0"
          icon="pi-check-circle"
          title="Nothing to show"
        >
          No product matched. Clear the search, or add one with Add Existing Product.
        </EmptyState>

        <div v-else class="table-wrap">
          <table class="plan-table">
            <thead>
              <tr>
                <th>Use</th>
                <th>Priority</th>
                <th>Product</th>
                <th>Supplier</th>
                <th class="num">Stock</th>
                <th class="num">Reorder</th>
                <th class="num">Sales/Day</th>
                <th class="num">Cover Days</th>
                <th class="num">Pending PO</th>
                <th v-if="showMoney" class="num">Last Cost</th>
                <th v-if="showMoney" class="num">Sell Price</th>
                <th class="num">Suggested</th>
                <th class="num">Planned Qty</th>
                <th v-if="showMoney" class="num">Investment</th>
                <th v-if="showMoney" class="num">Expected Sales</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in visibleRows"
                :key="row.productId"
                :class="{ picked: used[row.productId] === true }"
              >
                <td>
                  <input
                    type="checkbox"
                    :checked="used[row.productId] === true"
                    @change="used = { ...used, [row.productId]: ($event.target as HTMLInputElement).checked }"
                  />
                </td>
                <td>
                  <span :class="['priority', row.priority.toLowerCase()]">
                    {{ priorityLabels[row.priority] }}
                  </span>
                </td>
                <td>
                  <strong>{{ row.displayName }}</strong>
                  <span class="sub">{{ row.unitName }}</span>
                </td>
                <td>
                  <Select
                    :model-value="supplierOf[row.productId] ?? NO_SUPPLIER"
                    :options="supplierOptions"
                    option-label="label"
                    option-value="value"
                    class="supplier-pick"
                    @update:model-value="supplierOf = { ...supplierOf, [row.productId]: $event }"
                  />
                </td>
                <td class="num">{{ qtyText(row.stockQty) }}</td>
                <td class="num">{{ qtyText(row.minStockQty) }}</td>
                <td class="num">{{ qtyText(row.dailySalesQty) }}</td>
                <td class="num">{{ row.coverDays === null ? '—' : row.coverDays }}</td>
                <td class="num">{{ qtyText(row.pendingQty) }}</td>
                <td v-if="showMoney" class="num">{{ taka(row.unitCostMinor ?? 0) }}</td>
                <td v-if="showMoney" class="num">{{ taka(row.sellingPriceMinor ?? 0) }}</td>
                <td class="num suggested">
                  {{ qtyText(row.suggestedQty) }}
                  <em v-if="!row.fromHistory" title="Too little sales history — using minimum stock">
                    min
                  </em>
                </td>
                <td class="num">
                  <AmountInput
                    :model-value="qtyOf(row.productId)"
                    :min="0"
                    :fraction-digits="3"
                    class="qty-input"
                    @update:model-value="setQty(row.productId, $event)"
                  />
                </td>
                <td v-if="showMoney" class="num">{{ taka(investmentOf(row)) }}</td>
                <td v-if="showMoney" class="num">{{ taka(expectedSalesOf(row)) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <AppCard v-if="analysed">
        <div class="field">
          <label for="pp-notes">Plan Notes <span class="label-bn">মন্তব্য — ঐচ্ছিক</span></label>
          <input id="pp-notes" v-model="planNotes" placeholder="Optional planning note" />
        </div>
        <div class="save-row">
          <p class="chosen-count">{{ chosen.length }} product(s) on this plan</p>
          <Button
            label="Save Plan"
            icon="pi pi-save"
            :loading="saving"
            :disabled="chosen.length === 0"
            @click="savePlan"
          />
        </div>
      </AppCard>
    </template>

    <!-- ======================================================== SAVED PLANS -->
    <AppCard v-else-if="tab === 'PLANS'">
      <h3>Saved Purchase Plans</h3>
      <EmptyState v-if="plans.length === 0" icon="pi-list" title="No plans yet">
        Work out what to buy on the Planner tab and save it. It arrives here as a draft for
        approval.
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="plan-table">
          <thead>
            <tr>
              <th>Plan No</th>
              <th>Date</th>
              <th>Status</th>
              <th class="num">Items</th>
              <th v-if="showMoney || plans.some((p) => p.investmentMinor !== undefined)" class="num">
                Investment
              </th>
              <th v-if="plans.some((p) => p.expectedProfitMinor !== undefined)" class="num">
                Expected Profit
              </th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="plan in plans" :key="plan.id">
              <td>
                <strong>{{ plan.planNumber }}</strong>
                <span v-if="plan.notes !== null" class="sub">{{ plan.notes }}</span>
              </td>
              <td>{{ plan.businessDate }}</td>
              <td>
                <span :class="['status', plan.status.toLowerCase()]">
                  {{ planStatusLabels[plan.status] }}
                </span>
              </td>
              <td class="num">{{ plan.lineCount }}</td>
              <td v-if="plans.some((p) => p.investmentMinor !== undefined)" class="num">
                {{ plan.investmentMinor === undefined ? '—' : taka(plan.investmentMinor) }}
              </td>
              <td v-if="plans.some((p) => p.expectedProfitMinor !== undefined)" class="num">
                {{ plan.expectedProfitMinor === undefined ? '—' : taka(plan.expectedProfitMinor) }}
              </td>
              <td>
                <div class="row-actions">
                  <Button
                    label="View"
                    size="small"
                    outlined
                    @click="router.push({ name: 'purchase-plan-detail', params: { id: plan.id } })"
                  />
                  <template v-if="plan.status === 'DRAFT'">
                    <Button
                      label="Approve"
                      size="small"
                      :disabled="busy"
                      @click="decide(plan, 'APPROVED')"
                    />
                    <Button
                      label="Reject"
                      size="small"
                      outlined
                      severity="secondary"
                      :disabled="busy"
                      @click="decide(plan, 'REJECTED')"
                    />
                    <Button
                      label="Delete"
                      size="small"
                      outlined
                      severity="danger"
                      :disabled="busy"
                      @click="deleting = plan"
                    />
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AppCard>

    <!-- ==================================================== SUPPLIER ORDERS -->
    <AppCard v-else>
      <h3>Supplier Purchase Orders</h3>
      <EmptyState v-if="orders.length === 0" icon="pi-send" title="No orders yet">
        Approve a plan on the Saved Plans tab. One order is made for each supplier, ready to print,
        save as a PDF or share.
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="plan-table">
          <thead>
            <tr>
              <th>Order No</th>
              <th>Date</th>
              <th>Supplier</th>
              <th class="num">Items</th>
              <th class="num">Qty</th>
              <th>Status</th>
              <th>Purchase</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="order in orders" :key="order.id">
              <td>
                <strong>{{ order.orderNumber }}</strong>
                <span class="sub">from {{ order.planNumber }}</span>
              </td>
              <td>{{ order.businessDate }}</td>
              <td>{{ order.supplierName }}</td>
              <td class="num">{{ order.itemCount }}</td>
              <td class="num">{{ qtyText(order.totalQty) }}</td>
              <td>
                <span :class="['status', order.status.toLowerCase()]">
                  {{ orderStatusLabels[order.status] }}
                </span>
              </td>
              <td>{{ order.purchaseNumber ?? '—' }}</td>
              <td>
                <Button
                  label="View"
                  size="small"
                  outlined
                  @click="router.push({ name: 'supplier-order', params: { id: order.id } })"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AppCard>

    <QuickAddProductDialog
      v-if="catalog !== null"
      :open="addingNew"
      :catalog="catalog"
      :suppliers="suppliers"
      @close="addingNew = false"
      @created="onProductCreated"
    />

    <ConfirmDialog
      v-if="deleting !== null"
      title="Delete this plan?"
      :message="`${deleting.planNumber} will be removed. Nothing was posted by it, so nothing is undone.`"
      confirm-label="Delete plan"
      danger
      :busy="busy"
      @confirm="removePlan"
      @cancel="deleting = null"
    />
  </AppShell>
</template>

<style scoped>
/*
 * The Bangla name under the English one, not trailing it (owner decision
 * 2026-08-26, pointing at the module tabs as the shape to copy).
 *
 * These labels are longer than a form's usual one or two words — "Target Stock
 * Cover কত দিনের মাল রাখবেন" on a single line wrapped mid-phrase and threw the
 * controls out of alignment. Stacked, each language reads as its own line.
 */
.field label {
  display: grid;
  gap: 1px;
  line-height: 1.3;
}

/* The 6px lead-in only makes sense when it trails the English on one line. */
.field label .label-bn {
  margin-left: 0;
}

.tabs {
  display: flex;
  gap: var(--sher-space-2);
  margin-bottom: var(--sher-space-3);
  flex-wrap: wrap;
}

.controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: var(--sher-space-3);
}

.actions {
  display: flex;
  gap: var(--sher-space-2);
  margin-top: var(--sher-space-3);
  flex-wrap: wrap;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: var(--sher-space-3);
  margin: var(--sher-space-3) 0;
}

.tile {
  background: var(--sher-surface);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  padding: var(--sher-space-3);
  display: grid;
  gap: 4px;
}

.tile span {
  color: var(--sher-text-muted);
  font-size: 0.8rem;
}

.tile strong {
  font-size: 1.35rem;
  font-variant-numeric: tabular-nums;
}

.add-row {
  display: flex;
  align-items: flex-end;
  gap: var(--sher-space-3);
  flex-wrap: wrap;
}

.grow {
  flex: 1;
  min-width: 14rem;
}

/* Wide tables scroll inside their own box; the page never scrolls sideways. */
.table-wrap {
  overflow-x: auto;
}

.plan-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.plan-table th,
.plan-table td {
  padding: var(--sher-space-2);
  border-bottom: 1px solid var(--sher-line);
  text-align: left;
  white-space: nowrap;
}

.plan-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.plan-table tr.picked {
  background: var(--sher-surface-2);
}

.sub {
  display: block;
  color: var(--sher-text-muted);
  font-size: 0.75rem;
}

.priority,
.status {
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 0.74rem;
  white-space: nowrap;
  background: var(--sher-surface-2);
  color: var(--sher-text-muted);
}

.priority.critical,
.status.rejected {
  background: color-mix(in srgb, var(--sher-danger) 14%, transparent);
  color: var(--sher-danger);
}

.priority.high,
.status.draft,
.status.open {
  background: color-mix(in srgb, var(--sher-warning) 18%, transparent);
  color: var(--sher-warning);
}

.status.approved,
.status.converted {
  background: color-mix(in srgb, var(--sher-success) 16%, transparent);
  color: var(--sher-success);
}

.suggested em {
  display: block;
  font-size: 0.7rem;
  color: var(--sher-text-muted);
  font-style: normal;
}

/*
 * Wide enough for a quantity and no wider. PrimeVue's number input stretches to
 * its container unless the inner control is sized, so the width goes on that.
 */
.qty-input {
  width: 6rem;
}

.qty-input :deep(input) {
  width: 6rem;
  text-align: right;
}

.supplier-pick {
  min-width: 10rem;
}

.row-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.save-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sher-space-3);
  margin-top: var(--sher-space-3);
}

.chosen-count {
  margin: 0;
  color: var(--sher-text-muted);
}

h3 {
  margin: 0 0 var(--sher-space-3);
  font-size: 1rem;
}
</style>
