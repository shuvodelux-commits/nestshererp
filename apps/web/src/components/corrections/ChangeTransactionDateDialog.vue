<script setup lang="ts">
import type { RedatableDocument, RedateReasonCode, TransactionDateContext } from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { changeTransactionDate, fetchTransactionDateContext } from '../../api/corrections';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import { taka } from '../money/money-text';

/**
 * Change Transaction Date (Phase 11.2, D-43, UI-70, UI-72).
 *
 * **One dialog for every screen that offers the action.** Daybook, the party
 * and account ledgers and the reconciliation compare screen all open this
 * component with a document type and an id, and it does the rest — which is
 * what keeps six screens from growing six ideas of what re-dating means.
 *
 * The screen asks nothing it can work out and decides nothing it should not.
 * Which days are reachable, whether a month is closed and which bill this money
 * settles all come from the server when the dialog opens; the refusals are
 * shown here **before** Save so the shopkeeper is not told no after typing.
 *
 * A reason is never blank (owner decision 2026-08-31), and three of the four
 * cost a tap rather than a sentence (UI-75).
 */
const props = defineProps<{
  documentType: RedatableDocument | null;
  documentId: string | null;
  /** What the row calls itself, for the header — an expense, a receipt. */
  label?: string;
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'changed'): void }>();

const session = useSession();

const context = ref<TransactionDateContext | null>(null);
const businessDate = ref('');
const reasonCode = ref<RedateReasonCode>('WRONG_DATE');
const reasonText = ref('');
const confirmPassword = ref('');
const acknowledged = ref(false);
/** Set once the server has told us a closed month is involved (or we knew). */
const closedPeriod = ref(false);
const loading = ref(false);
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

const visible = computed({
  get: () => props.documentId !== null,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const REASONS: Array<{ code: RedateReasonCode; label: string; bn: string }> = [
  { code: 'WRONG_DATE', label: 'Wrong date typed', bn: 'ভুল তারিখ' },
  { code: 'ENTERED_LATE', label: 'Entered late', bn: 'দেরিতে তুলেছি' },
  { code: 'BANK_DATE', label: "Bank's date", bn: 'ব্যাংকের তারিখ' },
  { code: 'OTHER', label: 'Other reason', bn: 'অন্য কারণ' },
];

watch(
  () => props.documentId,
  async (id) => {
    context.value = null;
    businessDate.value = '';
    reasonCode.value = 'WRONG_DATE';
    reasonText.value = '';
    confirmPassword.value = '';
    acknowledged.value = false;
    closedPeriod.value = false;
    error.value = null;
    if (id === null || props.documentType === null) return;

    loading.value = true;
    try {
      const found = await fetchTransactionDateContext(
        session.accessToken.value ?? '',
        props.documentType,
        id,
      );
      context.value = found;
      businessDate.value = found.businessDate;
      // The month it sits in is already closed, so the warning is owed before
      // the person types anything — not after they press Save.
      closedPeriod.value = !found.currentPeriodOpen;
    } catch (failure) {
      error.value =
        failure instanceof ApiError
          ? { code: failure.code, message: failure.message }
          : { code: 'UNKNOWN', message: 'Could not open this transaction' };
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/**
 * Every refusal the browser can already make, re-checked on each keystroke
 * so the button explains itself instead of failing (instant recalculation).
 * The server checks all of them again — this is help, never authority.
 */
const refusal = computed<string | null>(() => {
  const found = context.value;
  if (found === null || businessDate.value === '') return null;
  if (businessDate.value === found.businessDate) return 'That is the day it is already on';
  if (businessDate.value > found.today) return 'A transaction cannot be dated in the future';
  if (
    found.earliestAllocatedDate !== null &&
    businessDate.value < found.earliestAllocatedDate
  ) {
    return (
      `This settles ${found.earliestAllocatedNumber ?? 'a bill'} dated ` +
      `${found.earliestAllocatedDate} — it cannot be dated earlier`
    );
  }
  if (found.drawerSessionDate !== null && businessDate.value !== found.drawerSessionDate) {
    return (
      'This money went through the cash drawer, and that day has already been counted' +
      ` — it can only stay on ${found.drawerSessionDate}`
    );
  }
  if (closedPeriod.value && !found.mayChangeLocked) {
    return 'That month is closed — ask the owner to move this';
  }
  return null;
});

/** The Owner's extra steps, shown only when a closed month is actually in play. */
const needsStepUp = computed(
  () => closedPeriod.value && (context.value?.mayChangeLocked ?? false),
);

const canSave = computed(() => {
  if (busy.value || context.value === null || businessDate.value === '') return false;
  if (refusal.value !== null) return false;
  if (reasonCode.value === 'OTHER' && reasonText.value.trim() === '') return false;
  if (needsStepUp.value && (!acknowledged.value || confirmPassword.value === '')) return false;
  return true;
});

async function save(): Promise<void> {
  const found = context.value;
  if (found === null || !canSave.value) return;

  busy.value = true;
  error.value = null;
  try {
    await changeTransactionDate(session.accessToken.value ?? '', {
      documentType: found.documentType,
      documentId: found.documentId,
      version: found.version,
      businessDate: businessDate.value,
      reasonCode: reasonCode.value,
      reasonText: reasonText.value.trim() === '' ? null : reasonText.value.trim(),
      confirmPassword: needsStepUp.value ? confirmPassword.value : null,
      acknowledgeClosedPeriod: needsStepUp.value ? acknowledged.value : false,
    });
    emit('changed');
    emit('close');
  } catch (failure) {
    if (failure instanceof ApiError) {
      error.value = { code: failure.code, message: failure.message };
      /*
       * The month the transaction is *moving to* is one only the server knows
       * the state of. When it says so, the warning and the password appear and
       * the person tries again — with what they typed still on the screen.
       */
      if (
        failure.details?.reason === 'CLOSED_PERIOD_UNACKNOWLEDGED' ||
        failure.code === 'PERIOD_LOCKED'
      ) {
        closedPeriod.value = true;
      }
    } else {
      error.value = { code: 'UNKNOWN', message: 'Could not change the date' };
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Change transaction date — লেনদেনের তারিখ বদলান"
    :style="{ width: 'min(38rem, 94vw)' }"
  >
    <p v-if="loading" class="loading">Loading…</p>

    <form v-else-if="context !== null" class="date-form" @submit.prevent="save">
      <p class="subject">
        <strong>{{ label ?? context.number }}</strong>
        <span>
          {{ taka(context.amountMinor) }} · now dated {{ context.businessDate }}
        </span>
        <span v-if="context.originalBusinessDate !== null" class="moved">
          Moved once before, from {{ context.originalBusinessDate }}
        </span>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="redate-date">New date <span>নতুন তারিখ</span></label>
        <DateOnlyPicker input-id="redate-date" v-model="businessDate" required />
        <p v-if="refusal !== null" class="refusal">{{ refusal }}</p>
      </div>

      <div class="field">
        <label>Why is it moving? <span>কেন সরানো হচ্ছে — আবশ্যক</span></label>
        <div class="reasons">
          <button
            v-for="option in REASONS"
            :key="option.code"
            type="button"
            class="reason"
            :class="{ chosen: reasonCode === option.code }"
            @click="reasonCode = option.code"
          >
            {{ option.label }}
            <span>{{ option.bn }}</span>
          </button>
        </div>
      </div>

      <div v-if="reasonCode === 'OTHER'" class="field">
        <label for="redate-reason">In your own words <span>কারণ লিখুন — আবশ্যক</span></label>
        <input
          id="redate-reason"
          v-model="reasonText"
          autocomplete="off"
          placeholder="The bill was dated the day it was delivered"
        />
      </div>

      <div v-if="needsStepUp" class="closed">
        <p class="closed-warning">
          <strong>That month is closed.</strong>
          Its totals may already have been printed, filed or shown to a lender, and moving
          this transaction changes them. Any completed reconciliation covering these days
          goes back under review.
        </p>
        <label class="ack">
          <input v-model="acknowledged" type="checkbox" />
          I understand, and I still want to move it
        </label>
        <div class="field">
          <label for="redate-password">Your password <span>নিজের পাসওয়ার্ড</span></label>
          <input
            id="redate-password"
            v-model="confirmPassword"
            type="password"
            autocomplete="current-password"
            placeholder="Asked again because this reaches a closed month"
          />
        </div>
      </div>

      <p class="consequence">
        The old posting is reversed on {{ context.businessDate }} and the same figures are
        posted again on the new day. The amount, the account and what it settles do not
        change, and the date it was entered never changes.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="!canSave">
          {{ busy ? 'Moving…' : 'Change date' }}
        </button>
      </div>
    </form>

    <ErrorNotice v-else-if="error !== null" :code="error.code" :message="error.message" />
  </Dialog>
</template>

<style scoped>
.date-form {
  display: grid;
  gap: var(--sher-space-3);
}

.loading {
  margin: 0;
  color: var(--sher-text-muted);
}

.subject {
  margin: 0;
  display: grid;
  gap: 2px;
}

.subject span {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
  font-variant-numeric: tabular-nums;
}

.subject .moved {
  font-size: 11px;
}

.field {
  margin: 0;
}

.field label span {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.field input {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius);
  padding: 0 10px;
  background: var(--sher-raised);
  color: var(--sher-text);
  font: inherit;
}

.reasons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: var(--sher-space-2);
}

.reason {
  min-height: 48px;
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius);
  background: var(--sher-raised);
  color: var(--sher-text);
  font: inherit;
  cursor: pointer;
  padding: 6px 10px;
  text-align: left;
}

.reason span {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
}

.reason.chosen {
  border-color: var(--sher-primary);
  box-shadow: inset 0 0 0 1px var(--sher-primary);
}

.refusal {
  margin: 6px 0 0;
  color: var(--sher-bad);
  font-size: var(--sher-text-sm);
}

.closed {
  display: grid;
  gap: var(--sher-space-2);
  border: 1px solid var(--sher-bad);
  border-radius: var(--sher-radius);
  padding: var(--sher-space-3);
}

.closed-warning {
  margin: 0;
  font-size: var(--sher-text-sm);
}

.ack {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--sher-text-sm);
}

.consequence {
  margin: 0;
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
}
</style>
