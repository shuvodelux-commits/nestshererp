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
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import EndDayDialog from '../components/money/EndDayDialog.vue';
import ReopenDayDialog from '../components/money/ReopenDayDialog.vue';
import StartDayDialog from '../components/money/StartDayDialog.vue';
import AppShell from '../components/shell/AppShell.vue';
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

/*
 * The day still waiting to be counted, whichever day that is.
 *
 * End Day was offered only for **today's** open session, so a shop that forgot
 * to close last night was told "2026-08-24 is still open" by a banner with
 * nothing on it to press, and the button that would have fixed it was hidden
 * precisely because the day was not today (owner-reported, 2026-08-25).
 */
const blockedSession = computed(() => status.value?.blockedSession ?? null);
const dayToClose = computed(() => blockedSession.value ?? openToday.value);

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
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);
</script>

<template>
  <!--
    Phase 18.2. This screen drew its own `page` / `page-head` and was the one
    daily list that did — so its title sat at a different height from every
    other, its Bangla helper line was styled differently, and it had no
    breadcrumb and no module strip. `AppShell` owns all of that for everybody
    (and owns page spacing, which is why nothing here sets a margin).
  -->
  <AppShell
    title="Daily Cash"
    :breadcrumb="['Daily', 'Daily Cash']"
    help-bn="দিনের নগদ হিসাব — কত থাকার কথা, কত পাওয়া গেল"
  >
    <template #actions>
      <Button
        v-if="canStart"
        icon="pi pi-play"
        :label="MONEY_BN.startDay"
        @click="showStart = true"
      />
      <Button
        v-if="dayToClose && session.can('cash.session.close')"
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
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <p v-if="status && status.blockedByDate" class="blocked">
      <i class="pi pi-exclamation-triangle" aria-hidden="true" />
      <span>
        {{ status.blockedByDate }} is still open. Close it before starting a new day.
        <span class="sher-bn">{{ MONEY_BN.closePreviousFirst }}</span>
      </span>
      <Button
        v-if="blockedSession && session.can('cash.session.close')"
        icon="pi pi-check"
        size="small"
        :label="`${MONEY_BN.endDay} — ${status.blockedByDate}`"
        @click="showEnd = true"
      />
    </p>

    <!--
      Phase 18.4 — the same days as cards below 640px (owner decision
      2026-09-03). Nine money columns cannot be read on a phone at all; what an
      owner checking last week actually wants from each row is the date, what
      was counted, and whether it matched. The rest stays on the desktop table.
    -->
    <ul v-if="rows.length > 0" class="list-cards">
      <li v-for="row in rows" :key="`card-${row.sessionId}`" class="list-card">
        <span class="list-card-title">
          {{ row.businessDate }}
          <Tag v-if="row.wasReopened" class="reopened" severity="secondary" value="Reopened" />
        </span>

        <span class="list-card-amount">
          {{ row.countedClosingMinor === null ? '—' : taka(row.countedClosingMinor) }}
        </span>

        <p class="list-card-sub">
          Opened on {{ taka(row.openingAmountMinor) }} · in {{ taka(row.cashInMinor) }} · out
          {{ taka(row.cashOutMinor) }} · expected
          {{ row.expectedClosingMinor === null ? '—' : taka(row.expectedClosingMinor) }}
        </p>

        <div class="list-card-foot">
          <span
            v-if="row.differenceMinor !== null && row.differenceMinor !== 0"
            :class="row.differenceMinor < 0 ? 'short' : 'over'"
          >
            {{ taka(row.differenceMinor) }}
          </span>
          <Tag :severity="severity(row)" :value="statusLabel(row)" />
          <span v-if="row.differenceReason" class="reason">{{ row.differenceReason }}</span>
        </div>
      </li>
    </ul>

    <AppCard :class="rows.length > 0 ? 'phone-hidden' : ''">
      <DataTable
        :value="[...rows]"
        :loading="loading"
        data-key="sessionId"
        size="small"
        striped-rows
      >
        <template #empty>
          <!-- UI-29 and the Phase 18.2 pattern: one sentence, one button. -->
          <EmptyState icon="pi-wallet" title="No days recorded yet">
            Start the day and this list fills itself: what the drawer opened on, what came in and
            went out, and what was counted at close.
            <template #action>
              <button v-if="canStart" type="button" class="btn btn-primary" @click="showStart = true">
                {{ MONEY_BN.startDay }}
              </button>
            </template>
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
      v-if="showEnd && dayToClose"
      :day="dayToClose"
      @closed="done"
      @close="showEnd = false"
    />
    <ReopenDayDialog
      v-if="showReopen && closedToday"
      :day="closedToday"
      @reopened="done"
      @close="showReopen = false"
    />
  </AppShell>
</template>

<style scoped>
/*
 * The page frame, the header and the action row used to be redrawn here — a
 * second copy of `AppShell`'s, one font size out on the title and one margin
 * out under it. They are gone; `AppShell` draws them, for this screen and for
 * every other.
 */

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
