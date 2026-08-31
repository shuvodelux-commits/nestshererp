<script setup lang="ts">
import type { CashSessionResponse } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { computed, ref } from 'vue';

import { ApiError } from '../../api/client';
import { reopenDay } from '../../api/money';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';
import CounterChoice from './CounterChoice.vue';
import type { CounterOption } from './CounterChoice.vue';
import { MONEY_BN, MONEY_EN, taka } from './money-text';

/**
 * `ভুল করে বন্ধ করেছি` — undoing today's close (§5.16.4, owner decision
 * 2026-08-24).
 *
 * The words on the button are the sentence the cashier would say out loud. They
 * are not "reopen session" and certainly not "reverse the shortage posting" —
 * UI-74 keeps that vocabulary in the ledger, where an accountant needs it.
 *
 * The dialog says plainly what the count was, so the person about to undo it
 * can see whether they are undoing the right thing, and offers the common
 * reasons as presets with free text for the rest. It also says, in one line,
 * that both closes stay in the day's history — a shopkeeper who believed this
 * erased the first count would be surprised later, and surprise is what makes
 * people stop trusting a ledger.
 */
const props = defineProps<{ day: CashSessionResponse }>();
const emit = defineEmits<{ (event: 'reopened'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();

const picked = ref<string | null>(null);
const other = ref('');
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const activeClose = computed(
  () => props.day.closes.find((close) => close.status === 'ACTIVE') ?? null,
);

const options: readonly CounterOption[] = [
  {
    value: 'ভুল অঙ্ক লিখেছি',
    labelBn: 'ভুল অঙ্ক লিখেছি',
    labelEn: 'Typed the wrong amount',
    icon: 'pi-pencil',
  },
  {
    value: 'আগেই বন্ধ করে ফেলেছি',
    labelBn: 'আগেই বন্ধ করে ফেলেছি',
    labelEn: 'Closed too early',
    icon: 'pi-clock',
  },
  { value: 'OTHER', labelBn: 'অন্য কারণ', labelEn: 'Another reason', icon: 'pi-comment' },
];

const reason = computed(() => (picked.value === 'OTHER' ? other.value.trim() : picked.value ?? ''));
const canSubmit = computed(() => reason.value !== '' && !busy.value);

async function submit(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || reason.value === '') return;

  busy.value = true;
  failure.value = null;

  try {
    await reopenDay(token, props.day.id, {
      reason: reason.value,
      operationId: operationId.value,
    });
    emit('reopened');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not reopen the day' };
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
        <span class="head-en">{{ MONEY_EN.reopenDay }}</span>
        <span class="head-bn sher-bn">{{ MONEY_BN.reopenDay }}</span>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <p v-if="activeClose" class="counted">
      <span>You counted<small class="sher-bn">আপনি লিখেছিলেন</small></span>
      <strong>{{ taka(activeClose.countedClosingMinor) }}</strong>
    </p>

    <p class="ask">
      {{ MONEY_EN.whyReopen }}
      <span class="ask-bn sher-bn">{{ MONEY_BN.whyReopen }}</span>
    </p>
    <CounterChoice v-model="picked" :options="options" />

    <label v-if="picked === 'OTHER'" class="note">
      <InputText v-model="other" maxlength="500" autocomplete="off" autofocus />
    </label>

    <p class="keeps">
      <i class="pi pi-info-circle" aria-hidden="true" />
      <span>
        The earlier count is not erased — both stay in the day's history.
        <small class="sher-bn">আগের হিসাব মুছে যাবে না — দিনের ইতিহাসে দুটোই থাকবে।</small>
      </span>
    </p>

    <template #footer>
      <Button text :label="MONEY_EN.cancel" :disabled="busy" @click="emit('close')" />
      <Button
        class="primary-action"
        icon="pi pi-replay"
        :label="MONEY_EN.confirm"
        :loading="busy"
        :disabled="!canSubmit"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
/* English first, Bangla under it (owner decision 2026-08-31). */
.counted span small,
.keeps span small {
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

.counted {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin: 0 0 14px;
  padding: 8px 12px;
  border-radius: var(--sher-radius-md, 8px);
  background: var(--sher-surface-muted, rgba(127, 127, 127, 0.08));
}

.counted strong {
  font-size: 18px;
}

.ask {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 600;
}

.note {
  display: block;
  margin-top: 10px;
}

.keeps {
  display: flex;
  gap: 8px;
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.primary-action {
  min-height: 48px;
  font-size: 16px;
  font-weight: 600;
}
</style>
