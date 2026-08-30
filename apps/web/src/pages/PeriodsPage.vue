<script setup lang="ts">
import type { PeriodResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { closePeriod, fetchPeriods } from '../api/periods';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Months · হিসাবের মাস (§5.19, D-25, owner decision 2026-08-26).
 *
 * **Closing is final.** There is no reopen button, because there is no reopen:
 * a correction posts in the month that is open, the way a closed book is
 * handled everywhere else. The confirmation says so in those words, since it is
 * the one decision on this screen that cannot be taken back.
 *
 * Only months that exist are listed — every month with a journal entry, plus
 * any already closed. A shop that opened in June is never asked about May.
 */
const session = useSession();

const periods = ref<readonly PeriodResponse[]>([]);
const loading = ref(true);
const working = ref(false);
const closingPeriod = ref<PeriodResponse | null>(null);
const failure = ref<{ code: string; message: string } | null>(null);

const canClose = computed(() => session.can('period.close'));

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthName(period: PeriodResponse): string {
  return `${MONTH_NAMES[period.month - 1] ?? ''} ${String(period.year)}`;
}

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  try {
    periods.value = (await fetchPeriods(token)).periods;
  } catch (cause) {
    failure.value = describe(cause, 'Could not load the months');
  } finally {
    loading.value = false;
  }
}

async function onClose(): Promise<void> {
  const token = session.accessToken.value;
  const target = closingPeriod.value;
  if (token === null || target === null) return;
  working.value = true;
  failure.value = null;
  try {
    await closePeriod(token, { year: target.year, month: target.month, note: null });
    closingPeriod.value = null;
    await load();
  } catch (cause) {
    failure.value = describe(cause, 'Could not close that month');
  } finally {
    working.value = false;
  }
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}

onMounted(load);
</script>

<template>
  <AppShell
    title="Months"
    :breadcrumb="['Dashboard', 'Settings', 'Months']"
    help-bn="হিসাবের মাস — মাস বন্ধ করলে সেই মাসে আর কিছু বসানো যাবে না"
  >
    <div class="per">
      <p class="per__intro">
        Closing a month stops anything new being posted into it. It cannot be undone — a later
        correction posts in the month that is still open.
      </p>

      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <AppCard>
        <EmptyState v-if="!loading && periods.length === 0" icon="pi-calendar" title="Nothing to close yet">
          Months appear here once the shop has posted something in them.
        </EmptyState>

        <table v-else class="per__table">
          <thead>
            <tr>
              <th>Month <small>মাস</small></th>
              <th class="num">Entries <small>এন্ট্রি</small></th>
              <th>Status <small>অবস্থা</small></th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="period in periods" :key="period.period">
              <td>
                <strong>{{ monthName(period) }}</strong>
                <small v-if="period.isCurrent">this month — চলতি মাস</small>
              </td>
              <td class="num">{{ period.entryCount }}</td>
              <td>
                <Tag
                  :value="period.status === 'CLOSED' ? 'Closed · বন্ধ' : 'Open · খোলা'"
                  :severity="period.status === 'CLOSED' ? 'secondary' : 'success'"
                />
                <small v-if="period.closedByName" class="per__sub">
                  by {{ period.closedByName }}
                </small>
              </td>
              <td class="num">
                <Button
                  v-if="canClose && period.status === 'OPEN' && !period.isCurrent"
                  label="Close month"
                  size="small"
                  outlined
                  @click="closingPeriod = period"
                />
                <!--
                  The current month has no button by design — closing the month
                  you are standing in would refuse your own next sale. Saying so
                  is the fix for a screen that otherwise looks broken: the owner
                  read a row with no action and asked how to close a month
                  (2026-08-26).
                -->
                <small v-else-if="period.isCurrent" class="per__wait">
                  Closes once the month ends
                  <span>মাস শেষ হলে বন্ধ করা যাবে</span>
                </small>
              </td>
            </tr>
          </tbody>
        </table>
      </AppCard>
    </div>

    <ConfirmDialog
      v-if="closingPeriod"
      :title="`Close ${monthName(closingPeriod)}?`"
      message="Nothing can be posted into this month again — no sale, no purchase, no expense, no correction. This cannot be undone. Anything found later posts in the open month instead."
      :facts="[{ label: 'Entries frozen', value: String(closingPeriod.entryCount) }]"
      danger
      confirm-label="Close the month"
      confirm-label-bn="মাস বন্ধ করুন"
      :busy="working"
      :error="failure"
      @cancel="closingPeriod = null"
      @confirm="onClose"
    />
  </AppShell>
</template>

<style scoped>
.per__wait {
  display: block;
  text-align: right;
  color: var(--sher-text-muted);
  font-size: 0.78rem;
  line-height: 1.35;
}

.per__wait span {
  display: block;
}

.per {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.per__intro {
  margin: 0;
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.per__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.per__table th,
.per__table td {
  padding: 0.5rem 0.35rem;
  border-bottom: 1px solid var(--sher-line);
  text-align: left;
  vertical-align: middle;
}

.per__table th small,
.per__table td small {
  display: block;
  font-size: 0.72rem;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.per__table .num {
  text-align: right;
}

.per__sub {
  display: block;
  font-size: 0.72rem;
  color: var(--sher-text-muted);
}
</style>
