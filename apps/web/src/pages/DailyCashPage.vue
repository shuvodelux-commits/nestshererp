<script setup lang="ts">
import type { CashSessionResponse, DailyCashRow, DayStatusResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchDailyCash, fetchDayStatus } from '../api/money';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import EndDayDialog from '../components/money/EndDayDialog.vue';
import ReopenDayDialog from '../components/money/ReopenDayDialog.vue';
import StartDayDialog from '../components/money/StartDayDialog.vue';
import { MONEY_BN, taka } from '../components/money/money-text';

/**
 * Daily Cash — expected against counted, day by day (§5.16.8, UI-71).
 *
 * **This screen is the Owner's, not the counter's**, so it stays
 * English-primary under UI-14 while the dialogs it opens are Bangla-first
 * (UI-74). The owner reconciling a week of trading and the cashier counting a
 * drawer are not the same reader, and the same screen serving both serves
 * neither.
 *
 * Every figure here is what the close **stored** (§5.16.4). Nothing is
 * recomputed on read: a sale corrected next month must not quietly change what
 * the system expected at last Tuesday's close, or the difference on that row
 * stops being evidence of anything.
 *
 * `Investigate` is absent rather than disabled — Daybook does not exist yet, and
 * UI-09 hides what cannot be done instead of showing a dead control.
 */
const session = useSession();

const rows = ref<readonly DailyCashRow[]>([]);
const status = ref<DayStatusResponse | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const showStart = ref(false);
const showEnd = ref(false);
const showReopen = ref(false);

const today = computed<CashSessionResponse | null>(() => status.value?.todaySession ?? null);
const openToday = computed(() => (today.value?.status === 'OPEN' ? today.value : null));
const closedToday = computed(() => (today.value?.status === 'CLOSED' ? today.value : null));

const canStart = computed(
  () =>
    status.value !== null &&
    status.value.enabled &&
    today.value === null &&
    status.value.blockedByDate === null &&
    session.can('cash.session.start'),
);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  loading.value = true;
  failure.value = null;

  try {
    const [history, day] = await Promise.all([fetchDailyCash(token), fetchDayStatus(token)]);
    rows.value = history.rows;
    status.value = day;
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load Daily Cash' };
  } finally {
    loading.value = false;
  }
}

async function done(): Promise<void> {
  showStart.value = false;
  showEnd.value = false;
  showReopen.value = false;
  await load();
}

function severity(row: DailyCashRow): 'success' | 'danger' | 'warn' | 'secondary' {
  if (row.differenceKind === null) return 'secondary';
  if (row.differenceKind === 'MATCHED') return 'success';
  return row.differenceKind === 'SHORT' ? 'danger' : 'warn';
}

/** The status word, in the shop's terms rather than the ledger's. */
function statusLabel(row: DailyCashRow): string {
  if (row.differenceKind === null) return 'Open';
  if (row.differenceKind === 'MATCHED') return 'Matched';
  return row.differenceKind === 'SHORT' ? 'Short' : 'Over';
}

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>Daily Cash</h1>
        <p class="sher-bn">দিনের নগদ হিসাব — কত থাকার কথা, কত পাওয়া গেল</p>
      </div>

      <div class="head-actions">
        <Button
          v-if="canStart"
          icon="pi pi-play"
          :label="MONEY_BN.startDay"
          @click="showStart = true"
        />
        <Button
          v-if="openToday && session.can('cash.session.close')"
          icon="pi pi-check"
          :label="MONEY_BN.endDay"
          @click="showEnd = true"
        />
        <Button
          v-if="closedToday && status?.canReopenToday"
          icon="pi pi-replay"
          severity="secondary"
          outlined
          :label="MONEY_BN.reopenDay"
          @click="showReopen = true"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <p v-if="status && status.blockedByDate" class="blocked">
      <i class="pi pi-exclamation-triangle" aria-hidden="true" />
      <span>
        {{ status.blockedByDate }} is still open. Close it before starting a new day.
        <span class="sher-bn">{{ MONEY_BN.closePreviousFirst }}</span>
      </span>
    </p>

    <AppCard>
      <DataTable
        :value="[...rows]"
        :loading="loading"
        data-key="sessionId"
        size="small"
        striped-rows
      >
        <template #empty>
          <EmptyState icon="pi-wallet" title="No days recorded yet">
            Start the day to begin tracking the drawer.
          </EmptyState>
        </template>

        <Column field="businessDate" header="Business date">
          <template #body="{ data }">
            <span class="date">{{ data.businessDate }}</span>
            <Tag
              v-if="data.wasReopened"
              class="reopened"
              severity="secondary"
              value="Reopened"
              v-tooltip.top="'Closed by mistake and reopened — both counts are kept'"
            />
          </template>
        </Column>

        <Column header="Opening" class="num">
          <template #body="{ data }">{{ taka(data.openingAmountMinor) }}</template>
        </Column>

        <Column header="Cash in" class="num">
          <template #body="{ data }">{{ taka(data.cashInMinor) }}</template>
        </Column>

        <Column header="Cash out" class="num">
          <template #body="{ data }">{{ taka(data.cashOutMinor) }}</template>
        </Column>

        <Column header="Expected" class="num">
          <template #body="{ data }">
            {{ data.expectedClosingMinor === null ? '—' : taka(data.expectedClosingMinor) }}
          </template>
        </Column>

        <Column header="Counted" class="num">
          <template #body="{ data }">
            {{ data.countedClosingMinor === null ? '—' : taka(data.countedClosingMinor) }}
          </template>
        </Column>

        <Column header="Difference" class="num">
          <template #body="{ data }">
            <span
              v-if="data.differenceMinor !== null && data.differenceMinor !== 0"
              :class="data.differenceMinor < 0 ? 'short' : 'over'"
            >
              {{ taka(data.differenceMinor) }}
            </span>
            <span v-else>—</span>
          </template>
        </Column>

        <Column header="Status">
          <template #body="{ data }">
            <Tag :severity="severity(data)" :value="statusLabel(data)" />
          </template>
        </Column>

        <Column header="Reason">
          <template #body="{ data }">
            <span class="reason">{{ data.differenceReason ?? '' }}</span>
          </template>
        </Column>
      </DataTable>
    </AppCard>

    <StartDayDialog
      v-if="showStart && status"
      :status="status"
      @started="done"
      @close="showStart = false"
    />
    <EndDayDialog
      v-if="showEnd && openToday"
      :day="openToday"
      @closed="done"
      @close="showEnd = false"
    />
    <ReopenDayDialog
      v-if="showReopen && closedToday"
      :day="closedToday"
      @reopened="done"
      @close="showReopen = false"
    />
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sher-space-4);
}

.page-head h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
}

.page-head p {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.head-actions {
  display: flex;
  gap: 8px;
}

.blocked {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  border-radius: var(--sher-radius-md, 8px);
  background: color-mix(in srgb, var(--sher-danger, #c0392b) 10%, transparent);
  font-size: 14px;
}

.date {
  font-variant-numeric: tabular-nums;
}

.reopened {
  margin-left: 8px;
}

.short {
  color: var(--sher-danger, #c0392b);
  font-weight: 600;
}

.over {
  color: var(--sher-warning, #b9770e);
  font-weight: 600;
}

.reason {
  font-size: 12px;
  color: var(--sher-text-muted);
}

:deep(.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
