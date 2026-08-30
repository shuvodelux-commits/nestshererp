<script setup lang="ts">
import type { ReportRow, ReportTotals } from '@sher/core-contracts';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchSalesReport } from '../api/reports';
import { useSession } from '../auth/session';
import AppShell from '../components/shell/AppShell.vue';
import ReportScreen from '../components/reports/ReportScreen.vue';
import WhyDialog from '../components/reports/WhyDialog.vue';
import { rangeFor } from '../components/reports/report-range';
import type { RangePreset } from '../components/reports/report-range';
import { onDataChanged } from '../state/data-freshness';

/**
 * Sales reports · বিক্রির হিসাব (§5.20).
 *
 * One screen with a Group By, not seven screens (owner decision 2026-08-30):
 * by day, product, customer, staff member, brand, category or how the money
 * came in. Every figure is the journal's, and tapping one asks Why?.
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
  { value: 'PRODUCT', label: 'By product — পণ্য অনুযায়ী' },
  { value: 'CUSTOMER', label: 'By customer — কাস্টমার অনুযায়ী' },
  { value: 'CASHIER', label: 'By staff — কে বিক্রি করেছে' },
  { value: 'BRAND', label: 'By brand — ব্র্যান্ড অনুযায়ী' },
  { value: 'CATEGORY', label: 'By category — ধরন অনুযায়ী' },
  { value: 'PAYMENT_METHOD', label: 'By payment — কীভাবে টাকা এলো' },
];

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  error.value = null;
  try {
    const report = await fetchSalesReport(token, {
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
        : { code: 'UNKNOWN', message: 'Could not load the sales report' };
  } finally {
    loading.value = false;
  }
}

/** Only a product row can name the sales behind it; a day's total is the account. */
function askWhy(row: ReportRow): void {
  why.value = { key: groupBy.value === 'PRODUCT' ? row.key : 'SALES', label: row.label };
}

function openDocument(sourceId: string, sourceType: string): void {
  if (sourceType === 'SALE') void router.push(`/sales/${sourceId}`);
}

onMounted(() => {
  void load();
  onDataChanged(() => void load());
});
</script>

<template>
  <AppShell
    title="Sales reports"
    :breadcrumb="['Dashboard', 'Reports', 'Sales']"
    help-bn="বিক্রির হিসাব — কবে, কী, কার কাছে বিক্রি হয়েছে"
  >
    <ReportScreen
      :rows="rows"
      :totals="totals"
      :loading="loading"
      :error="error"
      key-header="Sales"
      amount-header="Sold"
      :group-options="groupOptions"
      :group-by="groupBy"
      :today="today"
      :from="from"
      :to="to"
      :preset="preset"
      csv-name="sales-report"
      why-subject="PRODUCT_SALES"
      @update:group-by="(value) => (groupBy = value)"
      @update:preset="(value) => (preset = value)"
      @update:from="(value) => (from = value)"
      @update:to="(value) => (to = value)"
      @reload="load"
      @why="askWhy"
    />

    <WhyDialog
      :subject="why === null ? null : (groupBy === 'PRODUCT' ? 'PRODUCT_SALES' : 'SALES_TOTAL')"
      :item-key="why?.key ?? ''"
      :label="why?.label ?? ''"
      :from="from"
      :to="to"
      @close="why = null"
      @open="openDocument"
    />
  </AppShell>
</template>
