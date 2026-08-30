<script setup lang="ts">
import type { ReportRow, ReportTotals } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Select from 'primevue/select';
import { computed, ref } from 'vue';

import AppCard from '../AppCard.vue';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import EmptyState from '../EmptyState.vue';
import ErrorNotice from '../ErrorNotice.vue';
import StatCard from '../StatCard.vue';
import { qtyText, taka } from '../money/money-text';
import { downloadCsv } from './report-csv';
import { RANGE_PRESETS, rangeFor } from './report-range';
import type { RangePreset } from './report-range';

/**
 * One report screen, shared by all four (owner decision 2026-08-30 — few
 * screens, many filters).
 *
 * The shape is the List screen the rest of the app already uses (UI-22):
 * **filter bar → summary tiles → table**. Sales, Purchase, Stock and Money
 * differ only in what they group by and what they call their figures, so they
 * are the same component with different words — one table, one CSV writer, one
 * print block, and nothing new to learn on the second screen.
 *
 * Nothing here computes a business figure. Totals come from the server with
 * the rows (B8): a screen that added its own column up could disagree with the
 * ledger, which is the one thing a report may never do.
 */
const props = defineProps<{
  rows: readonly ReportRow[];
  totals: ReportTotals | null;
  loading: boolean;
  error: { code: string; message: string } | null;
  /** What the grouped column is called: "Product", "Supplier", "Day". */
  keyHeader: string;
  amountHeader: string;
  groupOptions: readonly { value: string; label: string }[];
  groupBy: string;
  today: string;
  from: string;
  to: string;
  preset: RangePreset;
  csvName: string;
  /** Set when a row can be asked "Why?" — the drill-down subject. */
  whySubject?: string | null;
}>();

const emit = defineEmits<{
  (event: 'update:groupBy', value: string): void;
  (event: 'update:preset', value: RangePreset): void;
  (event: 'update:from', value: string): void;
  (event: 'update:to', value: string): void;
  (event: 'reload'): void;
  (event: 'why', row: ReportRow): void;
}>();

const printing = ref(false);

const showQty = computed(() => (props.totals?.qty ?? 0) !== 0);
const showCost = computed(() => props.totals?.costMinor !== undefined);
const showProfit = computed(() => props.totals?.profitMinor !== undefined);
const showDue = computed(() => props.totals?.dueMinor !== undefined);

/** A typed date is a custom range, whichever preset was lit before. */
function chooseDate(field: 'from' | 'to', value: string): void {
  emit('update:preset', 'CUSTOM');
  if (field === 'from') emit('update:from', value);
  else emit('update:to', value);
  emit('reload');
}

function chooseGroup(value: string): void {
  emit('update:groupBy', value);
  emit('reload');
}

function choosePreset(value: RangePreset): void {

  emit('update:preset', value);
  if (value === 'CUSTOM') return;
  const range = rangeFor(value, props.today);
  emit('update:from', range.from);
  emit('update:to', range.to);
  emit('reload');
}

/** `12.34%` from integer basis points — no floating point anywhere near money. */
function percent(bp: number | undefined): string {
  if (bp === undefined) return '—';
  const sign = bp < 0 ? '−' : '';
  const abs = Math.abs(bp);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

function exportCsv(): void {
  const header = [
    props.keyHeader,
    ...(showQty.value ? ['Quantity'] : []),
    'Count',
    props.amountHeader,
    ...(showCost.value ? ['Cost'] : []),
    ...(showProfit.value ? ['Profit', 'Margin'] : []),
    ...(showDue.value ? ['Paid', 'Due'] : []),
  ];
  const body = props.rows.map((row) => [
    row.secondary === null ? row.label : `${row.label} (${row.secondary})`,
    ...(showQty.value ? [qtyText(row.qty)] : []),
    String(row.count),
    taka(row.amountMinor),
    ...(showCost.value ? [taka(row.costMinor ?? 0)] : []),
    ...(showProfit.value ? [taka(row.profitMinor ?? 0), percent(row.marginBp)] : []),
    ...(showDue.value ? [taka(row.paidMinor ?? 0), taka(row.dueMinor ?? 0)] : []),
  ]);
  downloadCsv(`${props.csvName}-${props.from}-to-${props.to}`, [header, ...body]);
}

/**
 * Printing is the browser's own dialog over the global print stylesheet, the
 * same way an invoice prints — the figures are already on the page, so there
 * is nothing to render a second time and nothing that can differ.
 */
function print(): void {
  printing.value = true;
  window.setTimeout(() => {
    window.print();
    printing.value = false;
  }, 60);
}
</script>

<template>
  <div class="rep">
    <div class="rep__filters no-print">
      <div class="rep__presets">
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

      <div class="rep__range">
        <DateOnlyPicker
          :model-value="from"
          input-id="report-from"
          placeholder="From"
          @update:model-value="(value) => chooseDate('from', value)"
        />
        <span class="rep__dash">→</span>
        <DateOnlyPicker
          :model-value="to"
          input-id="report-to"
          placeholder="To"
          @update:model-value="(value) => chooseDate('to', value)"
        />
      </div>

      <Select
        v-if="groupOptions.length > 1"
        :model-value="groupBy"
        :options="[...groupOptions]"
        option-label="label"
        option-value="value"
        class="rep__group"
        @change="(event) => chooseGroup(event.value)"
      />

      <div class="rep__output">
        <Button label="Print" icon="pi pi-print" text size="small" @click="print" />
        <Button label="CSV" icon="pi pi-download" text size="small" @click="exportCsv" />
      </div>
    </div>

    <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

    <div v-if="totals !== null" class="rep__tiles">
      <StatCard :label="amountHeader" :value="taka(totals.amountMinor)" :detail="`${from} → ${to}`" icon="pi-chart-line" tone="blue" filled />
      <StatCard v-if="showCost" label="Cost" :value="taka(totals.costMinor ?? 0)" icon="pi-box" tone="slate" />
      <StatCard v-if="showProfit" label="Profit" :value="taka(totals.profitMinor ?? 0)" :detail="percent(totals.marginBp)" icon="pi-arrow-up-right" tone="green" />
      <StatCard v-if="showDue" label="Still owed" :value="taka(totals.dueMinor ?? 0)" icon="pi-clock" tone="amber" />
      <StatCard v-if="!showDue && !showCost" label="Entries" :value="String(totals.count)" icon="pi-list" tone="slate" />
    </div>

    <AppCard>
      <EmptyState v-if="!loading && rows.length === 0" icon="pi-chart-bar" title="Nothing in this period">
        Change the dates above, or pick a different grouping. Nothing was posted in this range.
      </EmptyState>

      <DataTable v-else :value="[...rows]" :loading="loading" data-key="key" striped-rows>
        <Column field="label" :header="keyHeader">
          <template #body="{ data }">
            {{ data.label }}
            <small v-if="data.secondary" class="rep__sub">{{ data.secondary }}</small>
          </template>
        </Column>
        <Column v-if="showQty" header="Quantity" class="rep__num">
          <template #body="{ data }">{{ qtyText(data.qty) }}</template>
        </Column>
        <Column header="Entries" class="rep__num">
          <template #body="{ data }">{{ data.count }}</template>
        </Column>
        <Column :header="amountHeader" class="rep__num">
          <template #body="{ data }">
            <button
              v-if="whySubject"
              type="button"
              class="rep__why"
              :title="'Why?'"
              @click="emit('why', data)"
            >
              {{ taka(data.amountMinor) }}
            </button>
            <span v-else>{{ taka(data.amountMinor) }}</span>
          </template>
        </Column>
        <Column v-if="showCost" header="Cost" class="rep__num">
          <template #body="{ data }">{{ taka(data.costMinor ?? 0) }}</template>
        </Column>
        <Column v-if="showProfit" header="Profit" class="rep__num">
          <template #body="{ data }">
            <span :class="(data.profitMinor ?? 0) < 0 ? 'rep__bad' : 'rep__ok'">
              {{ taka(data.profitMinor ?? 0) }}
            </span>
            <small class="rep__sub">{{ percent(data.marginBp) }}</small>
          </template>
        </Column>
        <Column v-if="showDue" header="Paid" class="rep__num">
          <template #body="{ data }">{{ taka(data.paidMinor ?? 0) }}</template>
        </Column>
        <Column v-if="showDue" header="Due" class="rep__num">
          <template #body="{ data }">
            <span :class="(data.dueMinor ?? 0) > 0 ? 'rep__warn' : ''">{{ taka(data.dueMinor ?? 0) }}</span>
          </template>
        </Column>

        <template #footer>
          <div v-if="totals !== null" class="rep__footer">
            <span>Total</span>
            <strong>{{ taka(totals.amountMinor) }}</strong>
            <span v-if="showProfit">Profit <strong>{{ taka(totals.profitMinor ?? 0) }}</strong></span>
            <span v-if="showDue">Due <strong>{{ taka(totals.dueMinor ?? 0) }}</strong></span>
          </div>
        </template>
      </DataTable>
    </AppCard>

    <slot name="after" />
  </div>
</template>

<style scoped>
.rep { display: grid; gap: 1rem; }
.rep__filters { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
.rep__presets { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.rep__range { display: flex; align-items: center; gap: 0.4rem; }
.rep__dash { color: var(--sher-text-muted, #94a3b8); }
.rep__group { min-width: 12rem; }
.rep__output { margin-left: auto; display: flex; gap: 0.25rem; }
.rep__tiles { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
.rep__num { text-align: right; }
.rep__sub { display: block; color: var(--sher-text-muted, #64748b); font-size: 0.75rem; }
.rep__ok { color: var(--sher-ok, #15803d); }
.rep__bad { color: var(--sher-bad, #b91c1c); }
.rep__warn { color: var(--sher-warn, #b45309); }
.rep__why { background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; text-decoration: underline dotted; }
.rep__footer { display: flex; gap: 1.5rem; justify-content: flex-end; }
</style>
