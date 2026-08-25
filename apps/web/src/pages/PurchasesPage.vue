<script setup lang="ts">
import type { PurchaseListRow } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchPurchases } from '../api/purchasing';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import SearchField from '../components/SearchField.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka } from '../components/money/money-text';

/**
 * Purchase Invoice · কেনার তালিকা (§5.9) — a List screen (UI-22): filter bar →
 * tiles → table → paging.
 *
 * The tiles come first because the question a shopkeeper opens this screen with
 * is "how much do I owe, and to whom is it late" — not "what did I buy". They
 * are counted by the same query as the rows (§2.7.I), so a tile can never
 * disagree with the table under it.
 *
 * Paging is keyset (§3.9, `OFFSET` banned).
 */
const session = useSession();
const router = useRouter();

const rows = ref<readonly PurchaseListRow[]>([]);
const summary = ref({
  purchaseCount: 0,
  periodTotalMinor: 0,
  unpaidTotalMinor: 0,
  overdueTotalMinor: 0,
});
const search = ref('');
const fromDate = ref('');
const toDate = ref('');
const settlement = ref<'ALL' | 'UNPAID' | 'PAID'>('ALL');
const cursor = ref<string | null>(null);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const canCreate = computed(() => session.can('purchase.bill.create'));
const showCost = computed(() => session.can('inventory.cost.view'));

const settlementOptions = [
  { value: 'ALL', label: 'All bills' },
  { value: 'UNPAID', label: 'Still owed' },
  { value: 'PAID', label: 'Fully paid' },
];

async function load(reset = true): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  if (reset) cursor.value = null;
  loading.value = true;
  failure.value = null;

  try {
    const page = await fetchPurchases(token, {
      ...(search.value === '' ? {} : { search: search.value }),
      ...(fromDate.value === '' ? {} : { fromDate: fromDate.value }),
      ...(toDate.value === '' ? {} : { toDate: toDate.value }),
      ...(settlement.value === 'ALL' ? {} : { settlement: settlement.value }),
      ...(cursor.value === null ? {} : { cursor: cursor.value }),
    });
    rows.value = reset ? page.data : [...rows.value, ...page.data];
    nextCursor.value = page.page.nextCursor;
    summary.value = {
      purchaseCount: page.summary.purchaseCount,
      periodTotalMinor: page.summary.periodTotalMinor ?? 0,
      unpaidTotalMinor: page.summary.unpaidTotalMinor ?? 0,
      overdueTotalMinor: page.summary.overdueTotalMinor ?? 0,
    };
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load the purchases' };
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  cursor.value = nextCursor.value;
  await load(false);
}

function open(row: PurchaseListRow): void {
  void router.push(`/purchases/${row.id}`);
}

onMounted(() => load());
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(() => load());
</script>

<template>
  <AppShell
    title="Purchases"
    :breadcrumb="['Dashboard', 'Purchases']"
    help-bn="কেনার তালিকা — কার কাছ থেকে কী কিনেছেন, কত বাকি আছে"
  >
    <template #actions>
      <button
        v-if="canCreate"
        type="button"
        class="btn btn-primary"
        @click="router.push('/purchases/new')"
      >
        <i class="pi pi-plus" aria-hidden="true" /> New purchase
      </button>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div v-if="showCost" class="tiles">
      <StatCard
        label="Purchases in this view"
        :value="taka(summary.periodTotalMinor)"
        :detail="`${summary.purchaseCount} bills`"
        icon="pi-shopping-cart"
        tone="slate"
      />
      <StatCard
        label="Still owed"
        :value="taka(summary.unpaidTotalMinor)"
        icon="pi-wallet"
        tone="rose"
      />
      <StatCard
        label="Overdue"
        :value="taka(summary.overdueTotalMinor)"
        detail="Past the date the supplier gave"
        icon="pi-exclamation-triangle"
        tone="amber"
      />
    </div>

    <AppCard>
      <div class="filters">
        <SearchField
          v-model="search"
          field-id="purchase-search"
          label="Search purchases"
          placeholder="Supplier or bill number"
          @search="load()"
        />
        <Select
          v-model="settlement"
          :options="settlementOptions"
          option-label="label"
          option-value="value"
          aria-label="Which bills"
          append-to="body"
          @change="load()"
        />
        <DateOnlyPicker
          v-model="fromDate"
          input-id="purchase-from"
          placeholder="From"
          @update:model-value="load()"
        />
        <DateOnlyPicker
          v-model="toDate"
          input-id="purchase-to"
          placeholder="To"
          @update:model-value="load()"
        />
      </div>

      <DataTable
        :value="[...rows]"
        :loading="loading"
        data-key="id"
        size="small"
        striped-rows
        row-hover
        :row-class="(row: PurchaseListRow) => (row.overdue ? 'is-overdue' : row.dueMinor !== undefined && row.dueMinor > 0 ? 'is-unpaid' : '')"
        @row-click="open($event.data as PurchaseListRow)"
      >
        <template #empty>
          <EmptyState icon="pi-shopping-cart" title="No purchases yet">
            Record what a supplier delivered and the stock, the cost and their bill are all
            written in one step.
          </EmptyState>
        </template>

        <Column field="businessDate" header="Date" />
        <Column field="supplierName" header="Supplier">
          <template #body="{ data }">
            <div class="supplier-cell">
              <strong>{{ data.supplierName }}</strong>
              <span class="muted">
                {{ data.number }}
                <template v-if="data.supplierBillRef">· {{ data.supplierBillRef }}</template>
              </span>
            </div>
          </template>
        </Column>
        <Column header="Items" class="num">
          <template #body="{ data }">{{ data.lineCount }}</template>
        </Column>
        <Column v-if="showCost" header="Total" class="num">
          <template #body="{ data }">{{ taka(data.grandTotalMinor ?? 0) }}</template>
        </Column>
        <Column v-if="showCost" header="Paid" class="num">
          <template #body="{ data }">{{ taka(data.paidMinor ?? 0) }}</template>
        </Column>
        <Column v-if="showCost" header="Due" class="num">
          <template #body="{ data }">
            <strong>{{ taka(data.dueMinor ?? 0) }}</strong>
          </template>
        </Column>
        <Column header="">
          <template #body="{ data }">
            <Tag v-if="data.overdue" severity="danger" value="Overdue" />
            <Tag
              v-else-if="(data.dueMinor ?? 0) > 0"
              severity="warn"
              :value="data.dueDate === null ? 'Unpaid' : `Due ${data.dueDate}`"
            />
            <Tag v-else severity="success" value="Paid" />
          </template>
        </Column>
      </DataTable>

      <div v-if="nextCursor !== null" class="more">
        <Button label="Show more" outlined :loading="loading" @click="loadMore" />
      </div>
    </AppCard>
  </AppShell>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sher-space-3, 12px);
  margin-bottom: var(--sher-space-4, 16px);
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: var(--sher-space-3, 12px);
}

.supplier-cell {
  display: flex;
  flex-direction: column;
}

.supplier-cell .muted {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.more {
  display: flex;
  justify-content: center;
  margin-top: var(--sher-space-3, 12px);
}

:deep(.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

:deep(tr.is-overdue td:first-child) {
  box-shadow: inset 3px 0 0 var(--sher-danger, #dc2626);
}

:deep(tr.is-unpaid td:first-child) {
  box-shadow: inset 3px 0 0 var(--sher-warn, #d97706);
}
</style>
