<script setup lang="ts">
import type { DayStatusResponse, MoneyAccountResponse } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAccounts, startDay } from '../../api/money';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';
import CounterAmountField from './CounterAmountField.vue';
import CounterChoice from './CounterChoice.vue';
import type { CounterOption } from './CounterChoice.vue';
import { MONEY_BN, MONEY_EN, parseTaka, taka } from './money-text';

/**
 * `দিন শুরু করুন` — Start Day (§5.16.2).
 *
 * **One question at a time.** The cashier is asked how much is in the drawer,
 * and nothing else — unless the amount disagrees with last night's count, at
 * which point §5.16.5 requires a named source or destination and a second
 * question appears. A form that showed every field up front would ask most
 * shopkeepers, on most days, to read four boxes they do not need.
 *
 * The presets are the §5.16.5 table in the shop's own words: money the owner
 * put in, money brought from the safe, money taken from the bank. Each maps to
 * an account code, because a sentence cannot be one side of a journal entry.
 */
const props = defineProps<{ status: DayStatusResponse }>();
const emit = defineEmits<{ (event: 'started'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();

const amount = ref('');
const counterpart = ref<string | null>(null);
const note = ref('');
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));
const accounts = ref<readonly MoneyAccountResponse[]>([]);

const previousClosingMinor = computed(() => props.status.previousClosingMinor);
const enteredMinor = computed(() => parseTaka(amount.value));

/**
 * How far the count is from what the books already say is in the drawer.
 *
 * The same figure as "difference from last night" on every day after the first,
 * because the previous close leaves the account equal to what was counted
 * (INV-07b). On the first day it is the whole opening — the drawer holds money
 * the books have never seen, and asking where it came from is the point.
 */
const differenceMinor = computed(() => {
  const entered = enteredMinor.value;
  if (entered === null) return 0;
  return entered - props.status.drawerBalanceMinor;
});

const needsCounterpart = computed(() => differenceMinor.value !== 0);

/**
 * The presets, built from the shop's own accounts.
 *
 * The drawer itself is excluded — money cannot come from the box it is going
 * into — and an inactive account is not offered, because posting to one is the
 * thing deactivation exists to stop.
 */
const options = computed<readonly CounterOption[]>(() => {
  const more = differenceMinor.value > 0;
  const others = accounts.value.filter(
    (account) => !account.isDrawer && account.status === 'ACTIVE',
  );

  return [
    {
      value: 'OWNER_CURRENT_ACCOUNT',
      labelBn: more ? MONEY_BN.ownerGave : MONEY_BN.ownerTook,
      labelEn: more ? MONEY_EN.ownerGave : MONEY_EN.ownerTook,
      icon: 'pi-user',
    },
    ...others.map((account) => ({
      value: `${account.type === 'CASH' ? 'CASH' : 'BANK'}:${account.id}`,
      labelBn: labelFor(account, more),
      labelEn: `${more ? 'From' : 'To'} ${account.name}`,
      icon: account.type === 'CASH' ? 'pi-lock' : 'pi-building-columns',
    })),
  ];
});

function labelFor(account: MoneyAccountResponse, more: boolean): string {
  if (account.type === 'CASH') return more ? MONEY_BN.fromSafe : MONEY_BN.toSafe;
  return more ? MONEY_BN.fromBank : MONEY_BN.toBank;
}

const canSubmit = computed(
  () =>
    enteredMinor.value !== null &&
    !busy.value &&
    (!needsCounterpart.value || counterpart.value !== null),
);

onMounted(async () => {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    accounts.value = (await fetchAccounts(token)).accounts;
  } catch {
    // The presets degrade to "owner" alone, which is still a postable answer.
    accounts.value = [];
  }
});

async function submit(): Promise<void> {
  const token = session.accessToken.value;
  const openingAmountMinor = enteredMinor.value;
  if (token === null || openingAmountMinor === null) return;

  busy.value = true;
  failure.value = null;

  try {
    await startDay(token, {
      businessDate: props.status.businessDate,
      openingAmountMinor,
      counterpartAccountCode: needsCounterpart.value ? counterpart.value : null,
      note: note.value.trim() === '' ? null : note.value.trim(),
      operationId: operationId.value,
    });
    emit('started');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not start the day' };
    // A new intent needs a new id; the old one would replay the failed attempt.
    operationId.value = Ulid.generate(clock);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    :draggable="false"
    class="counter-dialog"
    :style="{ width: '30rem' }"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="counter-header">
        <span class="head-en">{{ MONEY_EN.startDay }}</span>
        <span class="head-bn sher-bn">{{ MONEY_BN.startDay }}</span>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <p v-if="previousClosingMinor !== null" class="last-night">
      <i class="pi pi-moon" aria-hidden="true" />
      <span>{{ MONEY_EN.lastNightCount }}<small class="sher-bn">{{ MONEY_BN.lastNightCount }}</small></span>
      <strong>{{ taka(previousClosingMinor) }}</strong>
    </p>

    <CounterAmountField
      v-model="amount"
      :label-bn="MONEY_BN.countAtStart"
      :label-en="MONEY_EN.countAtStart"
      autofocus
    />

    <template v-if="needsCounterpart">
      <p class="difference" :class="differenceMinor > 0 ? 'over' : 'short'">
        <strong>{{ taka(Math.abs(differenceMinor)) }}</strong>
        <span>{{ differenceMinor > 0 ? MONEY_EN.over : MONEY_EN.short }}<small class="sher-bn">{{ differenceMinor > 0 ? MONEY_BN.over : MONEY_BN.short }}</small></span>
      </p>

      <p class="ask">
        {{ differenceMinor > 0 ? MONEY_EN.whereFrom : MONEY_EN.whereGone }}
        <span class="ask-bn sher-bn">
          {{ differenceMinor > 0 ? MONEY_BN.whereFrom : MONEY_BN.whereGone }}
        </span>
      </p>
      <CounterChoice v-model="counterpart" :options="options" />

      <label class="note">
        <span>{{ MONEY_EN.note }}</span>
        <span class="ask-bn sher-bn">{{ MONEY_BN.note }}</span>
        <InputText v-model="note" maxlength="500" />
      </label>
    </template>

    <template #footer>
      <Button text :label="MONEY_EN.cancel" :disabled="busy" @click="emit('close')" />
      <Button
        class="primary-action"
        icon="pi pi-play"
        :label="MONEY_EN.startDay"
        :loading="busy"
        :disabled="!canSubmit"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
/* English first, Bangla under it (owner decision 2026-08-31). */
.last-night span small,
.difference span small {
  display: block;
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.ask-bn {
  display: block;
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.counter-header {
  display: flex;
  flex-direction: column;
}

.head-en {
  font-size: 20px;
  font-weight: 700;
}

.head-bn {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.last-night {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--sher-radius-md, 8px);
  background: var(--sher-surface-muted, rgba(127, 127, 127, 0.08));
  font-size: 14px;
}

.last-night strong {
  margin-left: auto;
  font-size: 16px;
}

.difference {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 16px 0 8px;
  font-size: 15px;
}

.difference strong {
  font-size: 22px;
}

.difference.short strong {
  color: var(--sher-danger, #c0392b);
}

.difference.over strong {
  color: var(--sher-success, #1e8449);
}

.ask {
  margin: 8px 0;
  font-size: 16px;
  font-weight: 600;
}

.note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
}

/* One primary action per counter screen, large enough to hit (UI-75). */
.primary-action {
  min-height: 48px;
  font-size: 16px;
  font-weight: 600;
}
</style>
