<script setup lang="ts">
import type { PurchaseReturnResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchPurchaseReturns } from '../api/purchase-returns';
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
 * Purchase Return · কেনা ফেরত (§5.11) — a List screen (UI-22): filter bar →
 * tiles → table → paging.
 *
 * **Nothing is sent back here** (owner decision 2026-08-26). A return starts on
 * the bill the goods arrived on, because that is what caps the quantity, names
 * the lot and carries the cost; this page is where the shop reads what has gone
 * back and prints it.
 *
 * The tiles are counted by the same query as the rows (§2.7.I), so a tile can
 * never disagree with the table under it. Paging is keyset (§3.9).
 */
const session = useSession();

const rows = ref<readonly PurchaseReturnResponse[]>([]);
const totalValueMinor = ref(0);
const totalReceivedMinor = ref(0);
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

const creditedMinor = computed(() => totalValueMinor.value - totalReceivedMinor.value);

async function load(append = false): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  failure.value = null;
  try {
    const page = await fetchPurchaseReturns(token, {
      ...(search.value.trim() === '' ? {} : { search: search.value.trim() }),
      ...(fromDate.value === '' ? {} : { fromDate: fromDate.value }),
      ...(toDate.value === '' ? {} : { toDate: toDate.value }),
      ...(append && nextCursor.value !== null ? { cursor: nextCursor.value } : {}),
      limit: 20,
    });
    rows.value = append ? [...rows.value, ...page.returns] : page.returns;
    nextCursor.value = page.nextCursor;
    totalValueMinor.value = page.totalValueMinor;
    totalReceivedMinor.value = page.totalReceivedMinor;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load supplier returns' };
  } finally {
    loading.value = false;
  }
}

/** What each return took back, in one line — the column a shopkeeper scans. */
function itemsText(row: PurchaseReturnResponse): string {
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
    title="Purchase Returns"
    :breadcrumb="['Dashboard', 'Purchases', 'Purchase Returns']"
    help-bn="কেনা ফেরত — সাপ্লায়ারকে কী ফেরত গেছে, টাকা ফেরত না বাকি থেকে বাদ"
  >
    <div class="prets">
      <header class="prets__head no-print">
        <p>What went back to suppliers, what they credited, and where the money went.</p>
        <Button label="Print" icon="pi pi-print" text @click="print" />
      </header>

      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <div class="prets__filters no-print">
        <SearchField
          v-model="search"
          label="Search returns"
          placeholder="Return number or customer — নম্বর বা নাম"
          field-id="purchase-returns-search"
          @search="() => load()"
        />
        <DateOnlyPicker
          v-model="fromDate"
          input-id="purchase-returns-from"
          placeholder="From"
          @update:model-value="() => load()"
        />
        <DateOnlyPicker
          v-model="toDate"
          input-id="purchase-returns-to"
          placeholder="To"
          @update:model-value="() => load()"
        />
      </div>

      <div class="prets__tiles">
        <StatCard
          label="Goods sent back"
          :value="taka(totalValueMinor)"
          detail="ফেরত পাঠানো পণ্যের মূল্য"
          icon="pi-reply"
          tone="slate"
        />
        <StatCard
          label="Money taken back"
          :value="taka(totalReceivedMinor)"
          detail="টাকা ফেরত পেয়েছেন"
          icon="pi-wallet"
          tone="rose"
        />
        <StatCard
          label="Left as credit"
          :value="taka(creditedMinor)"
          detail="বাকি থেকে বাদ"
          icon="pi-briefcase"
          tone="blue"
        />
      </div>

      <AppCard>
        <EmptyState v-if="!loading && rows.length === 0" icon="pi-reply" title="No returns yet">
          A return starts from the bill the goods came in on — open Purchases, find the bill, and
          choose Return to supplier.
        </EmptyState>

        <DataTable v-else :value="[...rows]" :loading="loading" data-key="id" striped-rows>
          <Column field="number" header="Return">
            <template #body="{ data }">
              <strong>{{ data.number }}</strong>
              <small class="prets__sub">{{ data.businessDate }}</small>
            </template>
          </Column>
          <Column field="purchaseNumber" header="Bill" />
          <Column field="supplierName" header="Supplier">
            <template #body="{ data }">
              {{ data.supplierName }}
              <small v-if="data.note" class="prets__sub">{{ data.note }}</small>
            </template>
          </Column>
          <Column header="Items">
            <template #body="{ data }">
              <span class="prets__items">{{ itemsText(data) }}</span>
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
              <span v-if="data.receivedMinor > 0">
                {{ taka(data.receivedMinor) }}
                <small class="prets__sub">{{ data.receiptAccountName ?? '' }}</small>
              </span>
              <span v-else class="prets__muted">Off the bill</span>
            </template>
          </Column>
        </DataTable>

        <div v-if="nextCursor" class="prets__more no-print">
          <Button label="Show more" text :disabled="loading" @click="load(true)" />
        </div>
      </AppCard>
    </div>
  </AppShell>
</template>

<style scoped>
.prets {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.prets__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.prets__head h1 {
  margin: 0;
  font-size: 1.35rem;
}

.prets__head h1 small {
  font-size: 0.9rem;
  font-weight: 400;
  color: var(--sher-text-muted);
  margin-left: 0.4rem;
}

.prets__head p {
  margin: 0.2rem 0 0;
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.prets__filters {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.prets__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.75rem;
}

.prets__sub {
  display: block;
  font-size: 0.75rem;
  color: var(--sher-text-muted);
}

.prets__items {
  font-size: 0.85rem;
}

.prets__muted {
  color: var(--sher-text-muted);
}

.prets__more {
  display: flex;
  justify-content: center;
  padding-top: 0.5rem;
}
</style>
