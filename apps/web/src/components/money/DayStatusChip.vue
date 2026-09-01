<script setup lang="ts">
import type { DayStatusResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import { computed, onMounted, ref } from 'vue';

import { fetchDayStatus } from '../../api/money';
import { useSession } from '../../auth/session';
import { onDataChanged } from '../../state/data-freshness';
import EndDayDialog from './EndDayDialog.vue';
import TransferMoneyDialog from './TransferMoneyDialog.vue';
import ReopenDayDialog from './ReopenDayDialog.vue';
import StartDayDialog from './StartDayDialog.vue';
import { MONEY_BN, taka } from './money-text';

/**
 * The day chip in the top bar (owner decision 2026-08-24: both surfaces).
 *
 * It is on every screen for one reason: whether the day is open is the thing a
 * cashier most often needs to know and most easily forgets, and a shop that
 * discovers it at 9pm has a day of cash movements with no session to hold them.
 * So the state is always visible, and the action to fix it is the chip itself
 * — the cashier never leaves the sales screen to open or close the day.
 *
 * It draws only what this user can act on (UI-09), and disappears entirely for
 * a shop that does not track a drawer.
 */
const session = useSession();

const status = ref<DayStatusResponse | null>(null);
const showStart = ref(false);
const showEnd = ref(false);
const showReopen = ref(false);
const showMove = ref(false);

const today = computed(() => status.value?.todaySession ?? null);
const open = computed(() => (today.value?.status === 'OPEN' ? today.value : null));
const closedToday = computed(() => (today.value?.status === 'CLOSED' ? today.value : null));
const blocked = computed(() => status.value?.blockedByDate ?? null);
/*
 * The day the chip is asking for. Pressing "আগের দিন আগে শেষ করুন" used to do
 * nothing, because the press handler only knew how to open Start Day — so the
 * one screen telling the shopkeeper what to do was the one place they could not
 * do it (owner-reported, 2026-08-25).
 */
const blockedSession = computed(() => status.value?.blockedSession ?? null);

/** Hidden outright when the shop has no drawer, or the feature is off. */
const visible = computed(
  () =>
    status.value !== null &&
    status.value.enabled &&
    status.value.drawerAccountId !== null &&
    session.can('cash.daily.view'),
);

const label = computed(() => {
  if (blocked.value !== null) return MONEY_BN.closePreviousFirst;
  if (open.value !== null) return MONEY_BN.dayOpen;
  return status.value?.canReopenToday === true ? MONEY_BN.dayClosed : MONEY_BN.dayNotStarted;
});

const tone = computed(() => {
  if (blocked.value !== null) return 'blocked';
  return open.value !== null ? 'open' : 'shut';
});

/** The one thing this chip's press should do right now. */
const action = computed<'START' | 'END' | 'REOPEN' | 'BLOCKED' | null>(() => {
  if (blocked.value !== null) {
    return blockedSession.value !== null && session.can('cash.session.close') ? 'END' : null;
  }
  if (open.value !== null) return session.can('cash.session.close') ? 'END' : null;
  if (status.value?.canReopenToday === true) return 'REOPEN';
  return session.can('cash.session.start') ? 'START' : null;
});

async function refresh(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    status.value = await fetchDayStatus(token);
  } catch {
    // Quiet, like the access load: a chip that cannot read its own state draws
    // nothing rather than putting an alarm on every screen in the app.
    status.value = null;
  }
}

function press(): void {
  const next = action.value;
  if (next === 'START') showStart.value = true;
  if (next === 'END') showEnd.value = true;
  if (next === 'REOPEN') showReopen.value = true;
}

/** Today's open day, or the earlier one still waiting to be counted. */
const dayToClose = computed(() => blockedSession.value ?? open.value);

async function done(): Promise<void> {
  showStart.value = false;
  showEnd.value = false;
  showReopen.value = false;
  showMove.value = false;
  await refresh();
}

// A sale, a purchase or a payment anywhere moves the drawer, so the chip
// re-reads the day rather than waiting for the next navigation.
onMounted(refresh);
onDataChanged(refresh);
defineExpose({ refresh });
</script>

<template>
  <div v-if="visible && status" class="day-chip-wrap">
    <button
      type="button"
      class="day-chip"
      :class="tone"
      :disabled="action === null"
      @click="press"
    >
      <span class="dot" aria-hidden="true" />
      <span class="chip-text">
        <span class="chip-label">{{ label }}</span>
        <span v-if="blocked" class="chip-sub">{{ blocked }}</span>
        <span v-else-if="open" class="chip-sub">{{ taka(open.expectedClosingMinor) }}</span>
      </span>
    </button>

    <Button
      v-if="open && session.can('cash.movement.record')"
      v-tooltip.bottom="MONEY_BN.moveMoney"
      icon="pi pi-arrow-right-arrow-left"
      text
      rounded
      :aria-label="MONEY_BN.moveMoney"
      @click="showMove = true"
    />

    <StartDayDialog v-if="showStart" :status="status" @started="done" @close="showStart = false" />
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
    <!--
      Repointed when Phase 12.2 replaced MoveMoneyDialog with TransferMoneyDialog:
      the new dialog takes the source account as `from-account-id`, owns its own
      date field, and emits `saved`.
    -->
    <TransferMoneyDialog
      v-if="showMove && status.drawerAccountId"
      :from-account-id="status.drawerAccountId"
      @saved="done"
      @close="showMove = false"
    />
  </div>
</template>

<style scoped>
.day-chip-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
}

.day-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  /* The 40px touch target UI-59 protects, in a top bar that is otherwise dense. */
  min-height: 40px;
  padding: 4px 12px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: 999px;
  background: var(--sher-surface);
  color: inherit;
  cursor: pointer;
}

.day-chip:disabled {
  cursor: default;
  opacity: 0.75;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--sher-text-muted);
}

.day-chip.open .dot {
  background: var(--sher-success, #1e8449);
}

.day-chip.blocked .dot {
  background: var(--sher-danger, #c0392b);
}

.chip-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.2;
}

.chip-label {
  font-size: 14px;
  font-weight: 600;
}

.chip-sub {
  font-size: 11px;
  color: var(--sher-text-muted);
}
</style>
