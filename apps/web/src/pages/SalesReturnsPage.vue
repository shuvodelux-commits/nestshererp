<script setup lang="ts">
import type { SalesReturnResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchSalesReturns } from '../api/returns';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import SearchField from '../components/SearchField.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka } from '../components/money/money-text';
import { onDataChanged } from '../state/data-freshness';

/**
 * Sales Return · বিক্রি ফেরত (§5.11) — a List screen (UI-22): filter bar →
 * tiles → table → paging.
 *
 * **Nothing is taken back here** (owner decision 2026-08-26). A return starts
 * on the invoice it comes off, because that is what caps the quantity and
 * carries the cost; this page is where the shop reads what has come back, finds
 * one again, and prints it. Making it a second place to *create* a return would
 * be a second path into the same posting rules.
 *
 * The tiles are counted by the same query as the rows (§2.7.I), so a tile can
 * never disagree with the table under it. Paging is keyset (§3.9).
 */
const session = useSession();

const rows = ref<readonly SalesReturnResponse[]>([]);
const totalValueMinor = ref(0);
const totalRefundMinor = ref(0);
const nextCursor = ref<string | null>(null);
const search = ref('');
const fromDate = ref('');
const toDate = ref('');
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const REASON_LABELS: Record<string, string> = {
  DAMAGED: 'Damaged · নষ্ট',
  WRONG_ITEM: 'Wrong item · ভুল পণ্য',
  CHANGED_MIND: 'Changed mind · নেবে না',
  EXTRA_QUANTITY: 'Extra · বেশি',
  OTHER: 'Other · অন্য',
};

const creditedMinor = computed(() => totalValueMinor.value - totalRefundMinor.value);

async function load(append = false): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  failure.value = null;
  try {
    const page = await fetchSalesReturns(token, {
      ...(search.value.trim() === '' ? {} : { search: search.value.trim() }),
      ...(fromDate.value === '' ? {} : { fromDate: fromDate.value }),
      ...(toDate.value === '' ? {} : { toDate: toDate.value }),
      ...(append && nextCursor.value !== null ? { cursor: nextCursor.value } : {}),
      limit: 20,
    });
    rows.value = append ? [...rows.value, ...page.returns] : page.returns;
    nextCursor.value = page.nextCursor;
    totalValueMinor.value = page.totalValueMinor;
    totalRefundMinor.value = page.totalRefundMinor;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load returns' };
  } finally {
    loading.value = false;
  }
}

/** What each return took back, in one line — the column a shopkeeper scans. */
function itemsText(row: SalesReturnResponse): string {
  return row.lines
    .map((line) => `${line.productName} × ${String(line.qty / 1000)}`)
    .join(', ');
}

function print(): void {
  window.print();
}

onMounted(() => {
  void load();
  // Any non-GET anywhere re-reads this page: a return taken from an invoice in
  // another tab must not leave this list a day behind.
  onDataChanged(() => void load());
});
</script>

<template>
  <AppShell
    title="Sales Returns"
    :breadcrumb="['Dashboard', 'Sales', 'Sales Returns']"
    help-bn="বিক্রি ফেরত — কাস্টমার কী ফেরত দিয়েছে, টাকা ফেরত না জমা"
  >
    <div class="rets">
      <header class="rets__head no-print">
        <p>What customers brought back, what it was worth, and where the money went.</p>
        <Button label="Print" icon="pi pi-print" text @click="print" />
      </header>

      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <div class="rets__filters no-print">
        <SearchField
          v-model="search"
          label="Search returns"
          placeholder="Return number or customer — নম্বর বা নাম"
          field-id="returns-search"
          @search="() => load()"
        />
        <DateOnlyPicker
          v-model="fromDate"
          input-id="returns-from"
          placeholder="From"
          @update:model-value="() => load()"
        />
        <DateOnlyPicker
          v-model="toDate"
          input-id="returns-to"
          placeholder="To"
          @update:model-value="() => load()"
        />
      </div>

      <div class="rets__tiles">
        <StatCard
          label="Goods returned"
          :value="taka(totalValueMinor)"
          detail="ফেরত পণ্যের মূল্য"
          icon="pi-reply"
          tone="slate"
        />
        <StatCard
          label="Refunded in cash"
          :value="taka(totalRefundMinor)"
          detail="টাকা ফেরত"
          icon="pi-wallet"
          tone="rose"
        />
        <StatCard
          label="Left on account"
          :value="taka(creditedMinor)"
          detail="জমা রাখা"
          icon="pi-user"
          tone="blue"
        />
      </div>

      <AppCard>
        <EmptyState v-if="!loading && rows.length === 0" icon="pi-reply" title="No returns yet">
          A return starts from the invoice it comes off — open Sales, find the invoice, and
          choose Return.
        </EmptyState>

        <DataTable v-else :value="[...rows]" :loading="loading" data-key="id" striped-rows>
          <Column field="number" header="Return">
            <template #body="{ data }">
              <strong>{{ data.number }}</strong>
              <small class="rets__sub">{{ data.businessDate }}</small>
            </template>
          </Column>
          <Column field="saleNumber" header="Invoice" />
          <Column field="customerName" header="Customer">
            <template #body="{ data }">
              {{ data.customerName }}
              <small v-if="data.note" class="rets__sub">{{ data.note }}</small>
            </template>
          </Column>
          <Column header="Items">
            <template #body="{ data }">
              <span class="rets__items">{{ itemsText(data) }}</span>
            </template>
          </Column>
          <Column header="Why">
            <template #body="{ data }">
              <Tag :value="REASON_LABELS[data.reason] ?? data.reason" severity="secondary" />
            </template>
          </Column>
          <Column header="Value" class="num">
            <template #body="{ data }">{{ taka(data.returnValueMinor) }}</template>
          </Column>
          <Column header="Money back" class="num">
            <template #body="{ data }">
              <span v-if="data.refundMinor > 0">
                {{ taka(data.refundMinor) }}
                <small class="rets__sub">{{ data.refundAccountName ?? '' }}</small>
              </span>
              <span v-else class="rets__muted">On account</span>
              <small v-if="data.approvedByName" class="rets__sub">
                Approved by {{ data.approvedByName }}
              </small>
            </template>
          </Column>
        </DataTable>

        <div v-if="nextCursor" class="rets__more no-print">
          <Button label="Show more" text :disabled="loading" @click="load(true)" />
        </div>
      </AppCard>
    </div>
  </AppShell>
</template>

<style scoped>
.rets {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.rets__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.rets__head h1 {
  margin: 0;
  font-size: 1.35rem;
}

.rets__head h1 small {
  font-size: 0.9rem;
  font-weight: 400;
  color: var(--sher-text-muted);
  margin-left: 0.4rem;
}

.rets__head p {
  margin: 0.2rem 0 0;
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.rets__filters {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.rets__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.75rem;
}

.rets__sub {
  display: block;
  font-size: 0.75rem;
  color: var(--sher-text-muted);
}

.rets__items {
  font-size: 0.85rem;
}

.rets__muted {
  color: var(--sher-text-muted);
}

.rets__more {
  display: flex;
  justify-content: center;
  padding-top: 0.5rem;
}
</style>
