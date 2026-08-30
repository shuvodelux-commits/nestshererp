<script setup lang="ts">
import type { ReportRow, ReportTotals } from '@sher/core-contracts';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchPurchaseReport } from '../api/reports';
import { useSession } from '../auth/session';
import AppShell from '../components/shell/AppShell.vue';
import ReportScreen from '../components/reports/ReportScreen.vue';
import WhyDialog from '../components/reports/WhyDialog.vue';
import { rangeFor } from '../components/reports/report-range';
import type { RangePreset } from '../components/reports/report-range';
import { onDataChanged } from '../state/data-freshness';

/**
 * Purchase reports · কেনাকাটার হিসাব (§5.20).
 *
 * What the shop bought, by day, by supplier or by product — and how much of it
 * is still owed. There is no cost or profit column here on purpose: a bill's
 * amount *is* what it cost, and a profit figure computed against a zero cost
 * would be the whole bill dressed up as earnings.
 */
const session = useSession();
const router = useRouter();

const today = new Date().toISOString().slice(0, 10);
const preset = ref<RangePreset>('THIS_MONTH');
const initial = rangeFor('THIS_MONTH', today);
const from = ref(initial.from);
const to = ref(initial.to);
const groupBy = ref('DATE');

const rows = ref<readonly ReportRow[]>([]);
const totals = ref<ReportTotals | null>(null);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const why = ref<{ key: string; label: string } | null>(null);

const groupOptions = [
  { value: 'DATE', label: 'By day — দিন অনুযায়ী' },
  { value: 'SUPPLIER', label: 'By supplier — সাপ্লায়ার অনুযায়ী' },
  { value: 'PRODUCT', label: 'By product — পণ্য অনুযায়ী' },
];

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  error.value = null;
  try {
    const report = await fetchPurchaseReport(token, {
      from: from.value,
      to: to.value,
      groupBy: groupBy.value,
    });
    rows.value = report.rows;
    totals.value = report.totals;
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load the purchase report' };
  } finally {
    loading.value = false;
  }
}

function askWhy(row: ReportRow): void {
  if (groupBy.value === 'PRODUCT') why.value = { key: row.key, label: row.label };
  else if (groupBy.value === 'SUPPLIER') why.value = { key: row.key, label: row.label };
}

function openDocument(sourceId: string, sourceType: string): void {
  if (sourceType === 'PURCHASE') void router.push(`/purchases/${sourceId}`);
}

onMounted(() => {
  void load();
  onDataChanged(() => void load());
});
</script>

<template>
  <AppShell
    title="Purchase reports"
    :breadcrumb="['Dashboard', 'Reports', 'Purchases']"
    help-bn="কেনাকাটার হিসাব — কার কাছ থেকে কত কেনা হয়েছে, কত বাকি"
  >
    <ReportScreen
      :rows="rows"
      :totals="totals"
      :loading="loading"
      :error="error"
      key-header="Purchases"
      amount-header="Bought"
      :group-options="groupOptions"
      :group-by="groupBy"
      :today="today"
      :from="from"
      :to="to"
      :preset="preset"
      csv-name="purchase-report"
      :why-subject="groupBy === 'DATE' ? null : 'PRODUCT_PURCHASES'"
      @update:group-by="(value) => (groupBy = value)"
      @update:preset="(value) => (preset = value)"
      @update:from="(value) => (from = value)"
      @update:to="(value) => (to = value)"
      @reload="load"
      @why="askWhy"
    />

    <WhyDialog
      :subject="why === null ? null : (groupBy === 'SUPPLIER' ? 'PARTY_BALANCE' : 'PRODUCT_PURCHASES')"
      :item-key="why?.key ?? ''"
      :label="why?.label ?? ''"
      :from="from"
      :to="to"
      @close="why = null"
      @open="openDocument"
    />
  </AppShell>
</template>
