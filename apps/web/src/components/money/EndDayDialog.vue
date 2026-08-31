<script setup lang="ts">
import type { CashSessionResponse } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { computed, ref } from 'vue';

import { ApiError } from '../../api/client';
import { closeDay } from '../../api/money';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';
import CounterAmountField from './CounterAmountField.vue';
import { MONEY_BN, MONEY_EN, parseTaka, taka } from './money-text';

/**
 * `দিন শেষ করুন` — End Day (§5.16.4).
 *
 * **The expected figure is not shown until after the count is entered.**
 * §5.16.4 lists "show expected" first, but the owner's own reason for counting
 * is to find out whether the drawer agrees — and a cashier who can see the
 * number they are supposed to reach will, on a bad day, reach it. So the
 * sequence here is: count, enter, *then* compare. The expected amount is on the
 * screen the moment it can no longer influence the count, which is what
 * §5.16.7's six-quantities rule is protecting.
 *
 * One counted total, no denomination breakdown (owner decision 2026-08-24).
 */
const props = defineProps<{ day: CashSessionResponse }>();
const emit = defineEmits<{ (event: 'closed'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();

const amount = ref('');
const reason = ref('');
const revealed = ref(false);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const countedMinor = computed(() => parseTaka(amount.value));
const expectedMinor = computed(() => props.day.expectedClosingMinor);

const differenceMinor = computed(() =>
  countedMinor.value === null ? null : countedMinor.value - expectedMinor.value,
);

const needsReason = computed(() => revealed.value && (differenceMinor.value ?? 0) !== 0);

const canReveal = computed(() => countedMinor.value !== null && !revealed.value);
const canSubmit = computed(
  () =>
    revealed.value &&
    countedMinor.value !== null &&
    !busy.value &&
    (!needsReason.value || reason.value.trim() !== ''),
);

async function submit(): Promise<void> {
  const token = session.accessToken.value;
  const countedClosingMinor = countedMinor.value;
  if (token === null || countedClosingMinor === null) return;

  busy.value = true;
  failure.value = null;

  try {
    await closeDay(token, props.day.id, {
      countedClosingMinor,
      reason: reason.value.trim() === '' ? null : reason.value.trim(),
      operationId: operationId.value,
    });
    emit('closed');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not close the day' };
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
        <span class="head-en">{{ MONEY_EN.endDay }}</span>
        <span class="head-bn sher-bn">{{ MONEY_BN.endDay }}</span>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <CounterAmountField
      v-model="amount"
      :label-bn="MONEY_BN.countNow"
      :label-en="MONEY_EN.countNow"
      autofocus
    />

    <!-- Before the count is in, the screen deliberately shows no target. -->
    <div v-if="revealed" class="compare">
      <p class="line">
        <span>{{ MONEY_EN.systemExpects }}<small class="sher-bn">{{ MONEY_BN.systemExpects }}</small></span>
        <strong>{{ taka(expectedMinor) }}</strong>
      </p>
      <p class="line muted">
        <span>{{ MONEY_EN.cashIn }}<small class="sher-bn">{{ MONEY_BN.cashIn }}</small></span>
        <strong>{{ taka(day.cashInMinor) }}</strong>
      </p>
      <p class="line muted">
        <span>{{ MONEY_EN.cashOut }}<small class="sher-bn">{{ MONEY_BN.cashOut }}</small></span>
        <strong>{{ taka(day.cashOutMinor) }}</strong>
      </p>

      <p
        v-if="differenceMinor !== null"
        class="verdict"
        :class="differenceMinor === 0 ? 'matched' : differenceMinor < 0 ? 'short' : 'over'"
      >
        <i
          :class="`pi ${differenceMinor === 0 ? 'pi-check-circle' : 'pi-exclamation-triangle'}`"
          aria-hidden="true"
        />
        <span v-if="differenceMinor === 0">{{ MONEY_EN.matched }}<small class="sher-bn">{{ MONEY_BN.matched }}</small></span>
        <template v-else>
          <strong>{{ taka(Math.abs(differenceMinor)) }}</strong>
          <span>{{ differenceMinor < 0 ? MONEY_EN.short : MONEY_EN.over }}<small class="sher-bn">{{ differenceMinor < 0 ? MONEY_BN.short : MONEY_BN.over }}</small></span>
        </template>
      </p>

      <label v-if="needsReason" class="note">
        <span class="ask">{{
          (differenceMinor ?? 0) < 0 ? MONEY_EN.whyShort : MONEY_EN.whyOver
        }}</span>
        <span class="ask-bn sher-bn">{{
          (differenceMinor ?? 0) < 0 ? MONEY_BN.whyShort : MONEY_BN.whyOver
        }}</span>
        <InputText v-model="reason" maxlength="500" autocomplete="off" />
      </label>
    </div>

    <template #footer>
      <Button text :label="MONEY_EN.cancel" :disabled="busy" @click="emit('close')" />
      <Button
        v-if="!revealed"
        class="primary-action"
        icon="pi pi-arrow-right"
        :label="MONEY_EN.confirm"
        :disabled="!canReveal"
        @click="revealed = true"
      />
      <Button
        v-else
        class="primary-action"
        icon="pi pi-check"
        :label="MONEY_EN.endDay"
        :loading="busy"
        :disabled="!canSubmit"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
/*
 * English first, Bangla under it (owner decision 2026-08-31). The figure rows
 * carry both because a cashier reading either one should land on the same line.
 */
.line span small,
.verdict span small {
  display: block;
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.ask-bn {
  font-size: 11px;
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

.compare {
  margin-top: 16px;
  padding-top: 12px;
  border-top: var(--sher-border-w) solid var(--sher-line);
}

.line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin: 6px 0;
  font-size: 15px;
}

.line.muted {
  font-size: 13px;
  color: var(--sher-text-muted);
}

.verdict {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: var(--sher-radius-md, 8px);
  font-size: 16px;
  font-weight: 600;
}

.verdict strong {
  font-size: 20px;
}

.verdict.matched {
  background: color-mix(in srgb, var(--sher-success, #1e8449) 12%, transparent);
  color: var(--sher-success, #1e8449);
}

.verdict.short {
  background: color-mix(in srgb, var(--sher-danger, #c0392b) 12%, transparent);
  color: var(--sher-danger, #c0392b);
}

.verdict.over {
  background: color-mix(in srgb, var(--sher-warning, #b9770e) 14%, transparent);
  color: var(--sher-warning, #b9770e);
}

.note {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
}

.ask {
  font-size: 16px;
  font-weight: 600;
}

.primary-action {
  min-height: 48px;
  font-size: 16px;
  font-weight: 600;
}
</style>
