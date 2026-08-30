<script setup lang="ts">
import type { MoneyReportResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchMoneyReport } from '../api/reports';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import WhyDialog from '../components/reports/WhyDialog.vue';
import { downloadCsv } from '../components/reports/report-csv';
import { RANGE_PRESETS, rangeFor } from '../components/reports/report-range';
import type { RangePreset } from '../components/reports/report-range';
import { taka } from '../components/money/money-text';
import { onDataChanged } from '../state/data-freshness';

/**
 * Money reports · টাকার হিসাব (§5.20).
 *
 * Six views behind one picker: who owes the shop, what the shop owes, cash,
 * bank, what was spent, and profit. Ageing has its own table because it has
 * four buckets and a reconciliation line; accounts have theirs because opening
 * and closing are the point of them.
 *
 * **The reconciliation line is shown, never hidden.** §5.20 requires the
 * ageing total to equal its journal control account as of the same date; when
 * it does not, the difference is a real finding about the ledger and the screen
 * says so rather than quietly showing the smaller number.
 */
const session = useSession();
const router = useRouter();

const today = new Date().toISOString().slice(0, 10);
const preset = ref<RangePreset>('THIS_MONTH');
const initial = rangeFor('THIS_MONTH', today);
const from = ref(initial.from);
const to = ref(initial.to);
const view = ref('DUE_AGEING');

const report = ref<MoneyReportResponse | null>(null);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const why = ref<{ subject: string; key: string; label: string } | null>(null);

const viewOptions = [
  { value: 'DUE_AGEING', label: 'Customer dues — কাস্টমারের বাকি' },
  { value: 'PAYABLE_AGEING', label: 'Supplier payables — সাপ্লায়ারকে দেনা' },
  { value: 'CASH', label: 'Cash — ক্যাশ' },
  { value: 'BANK', label: 'Bank & bKash — ব্যাংক ও বিকাশ' },
  { value: 'EXPENSE', label: 'Expenses — খরচ' },
  { value: 'PROFIT', label: 'Profit — লাভ' },
];

const ageing = computed(() => report.value?.ageing ?? null);
const accounts = computed(() => report.value?.accounts ?? null);
const expenses = computed(() => report.value?.expenses ?? null);
const profit = computed(() => report.value?.profit ?? null);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  error.value = null;
  try {
    report.value = await fetchMoneyReport(token, {
      from: from.value,
      to: to.value,
      view: view.value,
    });
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load the money report' };
    report.value = null;
  } finally {
    loading.value = false;
  }
}

function choosePreset(value: RangePreset): void {
  preset.value = value;
  if (value === 'CUSTOM') return;
  const range = rangeFor(value, today);
  from.value = range.from;
  to.value = range.to;
  void load();
}

function exportCsv(): void {
  const current = ageing.value;
  if (current !== null) {
    downloadCsv(`ageing-${view.value.toLowerCase()}-${to.value}`, [
      ['Name', 'Phone', '0–30 days', '31–60 days', '61–90 days', '90+ days', 'Total', 'Overdue'],
      ...current.rows.map((row) => [
        row.partyName,
        row.phone ?? '',
        taka(row.buckets.D0_30),
        taka(row.buckets.D31_60),
        taka(row.buckets.D61_90),
        taka(row.buckets.D90_PLUS),
        taka(row.totalMinor),
        taka(row.overdueMinor),
      ]),
    ]);
    return;
  }
  const money = accounts.value;
  if (money !== null) {
    downloadCsv(`accounts-${view.value.toLowerCase()}-${from.value}-to-${to.value}`, [
      ['Account', 'Opening', 'Money in', 'Money out', 'Closing'],
      ...money.rows.map((row) => [
        row.label,
        taka(row.openingMinor),
        taka(row.inMinor),
        taka(row.outMinor),
        taka(row.closingMinor),
      ]),
    ]);
    return;
  }
  const spent = expenses.value;
  if (spent !== null) {
    downloadCsv(`expenses-${from.value}-to-${to.value}`, [
      ['Category', 'Entries', 'Spent'],
      ...spent.rows.map((row) => [row.label, String(row.count), taka(row.amountMinor)]),
    ]);
  }
}

function print(): void {
  window.setTimeout(() => window.print(), 60);
}

function openDocument(sourceId: string, sourceType: string): void {
  if (sourceType === 'SALE') void router.push(`/sales/${sourceId}`);
  else if (sourceType === 'PURCHASE') void router.push(`/purchases/${sourceId}`);
}

onMounted(() => {
  void load();
  onDataChanged(() => void load());
});
</script>

<template>
  <AppShell
    title="Money reports"
    :breadcrumb="['Dashboard', 'Reports', 'Money']"
    help-bn="টাকার হিসাব — কে কত বাকি, কত দেনা, ক্যাশ, ব্যাংক, খরচ ও লাভ"
  >
    <div class="mrep">
      <div class="mrep__filters no-print">
        <div class="mrep__presets">
          <Button
            v-for="option in RANGE_PRESETS"
            :key="option.value"
            :label="option.label"
            size="small"
            :severity="option.value === preset ? 'primary' : 'secondary'"
            :outlined="option.value !== preset"
            @click="choosePreset(option.value)"
          />
        </div>
        <div class="mrep__range">
          <DateOnlyPicker
            v-model="from"
            input-id="money-from"
            placeholder="From"
            @update:model-value="() => { preset = 'CUSTOM'; load(); }"
          />
          <span class="mrep__dash">→</span>
          <DateOnlyPicker
            v-model="to"
            input-id="money-to"
            placeholder="To"
            @update:model-value="() => { preset = 'CUSTOM'; load(); }"
          />
        </div>
        <Select
          v-model="view"
          :options="viewOptions"
          option-label="label"
          option-value="value"
          class="mrep__view"
          @change="() => load()"
        />
        <div class="mrep__output">
          <Button label="Print" icon="pi pi-print" text size="small" @click="print" />
          <Button label="CSV" icon="pi pi-download" text size="small" @click="exportCsv" />
        </div>
      </div>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <!-- ------------------------------------------------------------ ageing -->
      <template v-if="ageing !== null">
        <div class="mrep__tiles">
          <StatCard
            :label="view === 'DUE_AGEING' ? 'Owed to the shop' : 'Owed by the shop'"
            :value="taka(ageing.totalMinor)"
            :detail="`as of ${ageing.asOf}`"
            icon="pi-wallet"
            :tone="view === 'DUE_AGEING' ? 'violet' : 'rose'"
            filled
          />
          <StatCard label="0–30 days" :value="taka(ageing.totals.D0_30)" icon="pi-clock" tone="blue" />
          <StatCard label="31–60 days" :value="taka(ageing.totals.D31_60)" icon="pi-clock" tone="amber" />
          <StatCard label="61–90 days" :value="taka(ageing.totals.D61_90)" icon="pi-clock" tone="amber" />
          <StatCard label="Over 90 days" :value="taka(ageing.totals.D90_PLUS)" icon="pi-exclamation-triangle" tone="rose" />
        </div>

        <p class="mrep__recon" :class="ageing.reconciled ? 'is-ok' : 'is-bad'">
          <span v-if="ageing.reconciled">
            ✓ This adds up to the ledger exactly ({{ taka(ageing.controlAccountMinor) }}).
          </span>
          <span v-else>
            ⚠ These rows come to {{ taka(ageing.totalMinor) }}, the ledger says
            {{ taka(ageing.controlAccountMinor) }} — a difference of
            {{ taka(ageing.differenceMinor) }}.
          </span>
        </p>

        <AppCard>
          <EmptyState v-if="ageing.rows.length === 0" icon="pi-check-circle" title="Nothing outstanding">
            Nobody owes anything on this side of the book as of {{ ageing.asOf }}.
          </EmptyState>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name<small>নাম</small></th>
                  <th class="num">0–30<small>দিন</small></th>
                  <th class="num">31–60<small>দিন</small></th>
                  <th class="num">61–90<small>দিন</small></th>
                  <th class="num">90+<small>দিন</small></th>
                  <th class="num">Total<small>মোট</small></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in ageing.rows" :key="row.partyId">
                  <td>
                    <strong>{{ row.partyName }}</strong>
                    <small v-if="row.phone">{{ row.phone }}</small>
                    <small v-if="row.overdueMinor > 0" class="mrep__overdue">
                      {{ taka(row.overdueMinor) }} past the agreed day
                    </small>
                  </td>
                  <td class="num">{{ taka(row.buckets.D0_30) }}</td>
                  <td class="num">{{ taka(row.buckets.D31_60) }}</td>
                  <td class="num">{{ taka(row.buckets.D61_90) }}</td>
                  <td class="num">{{ taka(row.buckets.D90_PLUS) }}</td>
                  <td class="num">
                    <button
                      type="button"
                      class="mrep__why"
                      @click="why = { subject: 'PARTY_BALANCE', key: row.partyId, label: row.partyName }"
                    >
                      {{ taka(row.totalMinor) }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AppCard>
      </template>

      <!-- ---------------------------------------------------------- accounts -->
      <template v-else-if="accounts !== null">
        <div class="mrep__tiles">
          <StatCard label="Closing balance" :value="taka(accounts.totals.closingMinor)" :detail="`${from} → ${to}`" icon="pi-wallet" tone="blue" filled />
          <StatCard label="Money in" :value="taka(accounts.totals.inMinor)" icon="pi-arrow-down-left" tone="green" />
          <StatCard label="Money out" :value="taka(accounts.totals.outMinor)" icon="pi-arrow-up-right" tone="rose" />
          <StatCard label="Opening" :value="taka(accounts.totals.openingMinor)" icon="pi-history" tone="slate" />
        </div>

        <AppCard>
          <EmptyState v-if="accounts.rows.length === 0" icon="pi-wallet" title="No accounts to show">
            Nothing has moved through this kind of account yet.
          </EmptyState>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account<small>হিসাব</small></th>
                  <th class="num">Opening<small>শুরুতে</small></th>
                  <th class="num">In<small>জমা</small></th>
                  <th class="num">Out<small>খরচ</small></th>
                  <th class="num">Closing<small>শেষে</small></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in accounts.rows" :key="row.accountCode">
                  <td><strong>{{ row.label }}</strong></td>
                  <td class="num">{{ taka(row.openingMinor) }}</td>
                  <td class="num">{{ taka(row.inMinor) }}</td>
                  <td class="num">{{ taka(row.outMinor) }}</td>
                  <td class="num">
                    <button
                      type="button"
                      class="mrep__why"
                      @click="why = { subject: 'ACCOUNT', key: row.accountCode, label: row.label }"
                    >
                      {{ taka(row.closingMinor) }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AppCard>
      </template>

      <!-- ---------------------------------------------------------- expenses -->
      <template v-else-if="expenses !== null">
        <div class="mrep__tiles">
          <StatCard label="Spent" :value="taka(expenses.totals.amountMinor)" :detail="`${from} → ${to}`" icon="pi-wallet" tone="rose" filled />
          <StatCard label="Entries" :value="String(expenses.totals.count)" icon="pi-list" tone="slate" />
        </div>
        <AppCard>
          <EmptyState v-if="expenses.rows.length === 0" icon="pi-wallet" title="Nothing spent in this period">
            Rent, salary, electricity and transport appear here once they are recorded.
          </EmptyState>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>What for<small>কোন খাতে</small></th>
                  <th class="num">Entries<small>কয়টি</small></th>
                  <th class="num">Spent<small>খরচ</small></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in expenses.rows" :key="row.key">
                  <td><strong>{{ row.label }}</strong></td>
                  <td class="num">{{ row.count }}</td>
                  <td class="num">
                    <button
                      type="button"
                      class="mrep__why"
                      @click="why = { subject: 'EXPENSE_CATEGORY', key: row.key, label: row.label }"
                    >
                      {{ taka(row.amountMinor) }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AppCard>
      </template>

      <!-- ------------------------------------------------------------ profit -->
      <template v-else-if="profit !== null">
        <p v-if="profit.provisional" class="mrep__provisional">
          Some sales in this period are still costed provisionally, so this profit is not final
          (D-06). হিসাব এখনো চূড়ান্ত নয়।
        </p>
        <div class="mrep__tiles">
          <StatCard label="Net profit" :value="taka(profit.netProfitMinor)" :detail="`${from} → ${to}`" icon="pi-chart-line" tone="green" filled />
          <StatCard label="Sold" :value="taka(profit.salesMinor - profit.returnsMinor)" icon="pi-shopping-cart" tone="blue" />
          <StatCard label="Cost of goods sold" :value="taka(profit.cogsMinor)" icon="pi-box" tone="slate" />
          <StatCard label="Expenses" :value="taka(profit.expenseMinor)" icon="pi-wallet" tone="rose" />
        </div>

        <AppCard title="How the profit is made up" subtitle="লাভ কীভাবে হলো">
          <div class="table-wrap">
            <table>
              <tbody>
                <tr><td>Sales<small>বিক্রি</small></td><td class="num">{{ taka(profit.salesMinor) }}</td></tr>
                <tr><td>Less returns<small>ফেরত বাদ</small></td><td class="num">−{{ taka(profit.returnsMinor) }}</td></tr>
                <tr><td>Less cost of goods sold<small>কেনা দাম বাদ</small></td><td class="num">−{{ taka(profit.cogsMinor) }}</td></tr>
                <tr class="mrep__strong"><td>Gross profit<small>মোট লাভ</small></td><td class="num">{{ taka(profit.grossProfitMinor) }}</td></tr>
                <tr><td>Less expenses<small>খরচ বাদ</small></td><td class="num">−{{ taka(profit.expenseMinor) }}</td></tr>
                <tr><td>Other adjustments<small>অন্যান্য</small></td><td class="num">−{{ taka(profit.otherMinor) }}</td></tr>
                <tr class="mrep__strong"><td>Net profit<small>শেষ লাভ</small></td><td class="num">{{ taka(profit.netProfitMinor) }}</td></tr>
              </tbody>
            </table>
          </div>
        </AppCard>

        <AppCard v-if="profit.expenseRows.length > 0" title="Where the expenses went" subtitle="খরচ কোন খাতে">
          <div class="table-wrap">
            <table>
              <tbody>
                <tr v-for="row in profit.expenseRows" :key="row.key">
                  <td>{{ row.label }}</td>
                  <td class="num">{{ taka(row.amountMinor) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </AppCard>
      </template>

      <div v-else-if="loading" class="mrep__loading">Loading…</div>
    </div>

    <WhyDialog
      :subject="why?.subject ?? null"
      :item-key="why?.key ?? ''"
      :label="why?.label ?? ''"
      :from="from"
      :to="to"
      @close="why = null"
      @open="openDocument"
    />
  </AppShell>
</template>

<style scoped>
.mrep { display: grid; gap: 1rem; }
.mrep__filters { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
.mrep__presets { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.mrep__range { display: flex; align-items: center; gap: 0.4rem; }
.mrep__dash { color: var(--sher-text-muted, #94a3b8); }
.mrep__view { min-width: 16rem; }
.mrep__output { margin-left: auto; display: flex; gap: 0.25rem; }
.mrep__tiles { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
.mrep__recon { margin: 0; font-size: 0.85rem; }
.mrep__recon.is-ok { color: var(--sher-ok, #15803d); }
.mrep__recon.is-bad { color: var(--sher-bad, #b91c1c); font-weight: 600; }
.mrep__provisional { margin: 0; padding: 0.5rem 0.75rem; border-radius: 0.5rem; background: color-mix(in srgb, var(--sher-warn, #f59e0b) 12%, transparent); color: var(--sher-warn, #b45309); font-size: 0.85rem; }
.mrep__overdue { display: block; color: var(--sher-warn, #b45309); }
.mrep__why { background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; text-decoration: underline dotted; }
.mrep__strong td { font-weight: 700; }
.mrep__loading { color: var(--sher-text-muted, #64748b); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.5rem 0.6rem; text-align: left; border-bottom: 1px solid var(--sher-border, #e2e8f0); }
th small, td small { display: block; font-weight: 400; color: var(--sher-text-muted, #64748b); font-size: 0.72rem; }
.num { text-align: right; }
</style>
