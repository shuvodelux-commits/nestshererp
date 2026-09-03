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

/*
 * Phase 18.2 — the shared list pattern.
 *
 * Products and Parties have always drawn a `Clear` beside their filters and
 * told an empty result apart from an empty shop. This screen did neither, so a
 * shopkeeper who had set a date range and found nothing was shown "No purchases
 * yet" — which is a lie about his business, and the reason he would go looking
 * for the bill in a drawer.
 */
const filtersActive = computed(
  () => search.value !== '' || fromDate.value !== '' || toDate.value !== '' || settlement.value !== 'ALL',
);

function clearFilters(): void {
  search.value = '';
  fromDate.value = '';
  toDate.value = '';
  settlement.value = 'ALL';
  void load();
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

    <!--
      UI-25, and the Phase 18.2 shared list pattern: the filter row sits at page
      level above the card, labelled, with the search box growing into whatever
      width is left — the same furniture at the same height as Products and
      Parties, because a shopkeeper should not have to relearn a screen he has
      already learnt twice.
    -->
    <form class="filters" @submit.prevent="load()">
      <div class="field grow">
        <SearchField
          v-model="search"
          field-id="purchase-search"
          label="Search purchases"
          placeholder="Supplier name, bill number or the supplier's own reference"
          @search="load()"
        />
      </div>

      <div class="field">
        <label for="purchase-settlement">Which bills</label>
        <Select
          v-model="settlement"
          input-id="purchase-settlement"
          :options="settlementOptions"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
          @change="load()"
        />
      </div>

      <div class="field">
        <label for="purchase-from">From</label>
        <DateOnlyPicker
          v-model="fromDate"
          input-id="purchase-from"
          placeholder="From"
          @update:model-value="load()"
        />
      </div>

      <div class="field">
        <label for="purchase-to">To</label>
        <DateOnlyPicker
          v-model="toDate"
          input-id="purchase-to"
          placeholder="To"
          @update:model-value="load()"
        />
      </div>

      <button v-if="filtersActive" type="button" class="btn btn-ghost" @click="clearFilters">
        Clear
      </button>
    </form>

    <!--
      Phase 18.4 — the same bills as cards below 640px (owner decision
      2026-09-03). On a phone the table slid sideways and took Total, Paid and
      Due off the right-hand edge; on a screen whose whole purpose is "how much
      do I owe, and is it late", that is the screen failing. Desktop is
      untouched — the table below is the same one it always drew.
    -->
    <ul v-if="rows.length > 0" class="list-cards">
      <li
        v-for="row in rows"
        :key="`card-${row.id}`"
        class="list-card"
        :class="row.overdue ? 'is-overdue' : (row.dueMinor ?? 0) > 0 ? 'is-unpaid' : ''"
      >
        <span class="list-card-title">
          <button type="button" class="linkish" @click="open(row)">{{ row.supplierName }}</button>
        </span>

        <span v-if="showCost" class="list-card-amount">{{ taka(row.grandTotalMinor ?? 0) }}</span>

        <p class="list-card-sub">
          {{ row.businessDate }} · {{ row.number }}
          <template v-if="row.supplierBillRef"> · {{ row.supplierBillRef }}</template>
        </p>

        <div class="list-card-foot">
          <span v-if="showCost && (row.dueMinor ?? 0) > 0" class="due-line">
            Due <strong>{{ taka(row.dueMinor ?? 0) }}</strong>
          </span>
          <Tag v-if="row.overdue" severity="danger" value="Overdue" />
          <Tag
            v-else-if="(row.dueMinor ?? 0) > 0"
            severity="warn"
            :value="row.dueDate === null ? 'Unpaid' : `Due ${row.dueDate}`"
          />
          <Tag v-else severity="success" value="Paid" />
        </div>
      </li>
    </ul>

    <AppCard :class="rows.length > 0 ? 'phone-hidden' : ''">
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
          <EmptyState v-if="filtersActive" icon="pi-search" title="Nothing matched">
            No bill matches these filters.
            <template #action>
              <button type="button" class="btn btn-ghost" @click="clearFilters">
                Clear the filters
              </button>
            </template>
          </EmptyState>

          <EmptyState v-else icon="pi-shopping-cart" title="No purchases yet">
            Record what a supplier delivered and the stock, the cost and their bill are all
            written in one step.
            <template #action>
              <button
                v-if="canCreate"
                type="button"
                class="btn btn-primary"
                @click="router.push('/purchases/new')"
              >
                Record the first purchase
              </button>
            </template>
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
        <!--
          Phase 18.3 — column trimming. `Items` held a line count. Nothing is
          decided by it: a bill with four lines and one with forty are chased,
          paid and returned the same way, and the moment anybody cares how many
          there are they are opening the bill to look at them. It narrowed the
          three money columns beside it, which are what this screen is for.
        -->
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

/*
 * `.filters` used to be redefined here with its own gap and its own bottom
 * margin, so this screen's filter row sat at a different height from every
 * other list in the application. It is `design/components.css`'s, once, for
 * everybody — that file says so, and this page was the counter-example.
 */

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

/*
 * Phase 18.4 — the phone card list. The same left edge marks the same two
 * states as on the table rows, so "late" looks identical on both shapes.
 */
.list-card.is-overdue {
  border-left: 3px solid var(--sher-danger, #dc2626);
}

.list-card.is-unpaid {
  border-left: 3px solid var(--sher-warn, #d97706);
}

.due-line {
  margin-right: auto;
  font-size: var(--sher-text-sm);
  font-variant-numeric: tabular-nums;
}
</style>
