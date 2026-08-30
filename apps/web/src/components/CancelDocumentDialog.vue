<script setup lang="ts">
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { ref } from 'vue';

import { ApiError } from '../api/client';
import ErrorNotice from './ErrorNotice.vue';
import { taka } from './money/money-text';

/**
 * Cancelling something already posted (Phase 9.2, §2.5).
 *
 * The same compact modal every one-task action uses: what is being cancelled,
 * one box for **why**, one primary button. The reason is not optional — the
 * owner's rule — because the before-and-after figures explain a correction and
 * nothing but the person explains a cancellation.
 *
 * The dialog says plainly what cancelling does, in the shopkeeper's terms
 * rather than the ledger's: nothing is deleted, the document stays visible with
 * a line through it, and the money or the goods go back where they came from.
 */
const props = defineProps<{
  /** What is being cancelled, e.g. "Expense EXP-2026-000012". */
  title: string;
  /** The one-line consequence: "Petty Cash gets ৳1,500 back." */
  consequence: string;
  amountMinor?: number;
  /** Runs the cancellation; the dialog owns the reason, the spinner and the error. */
  submit: (reason: string) => Promise<void>;
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'cancelled'): void }>();

const reason = ref('');
const saving = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

async function confirm(): Promise<void> {
  const text = reason.value.trim();
  if (text.length < 3) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Say why this is being cancelled' };
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    await props.submit(text);
    emit('cancelled');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not cancel this' };
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog
    visible
    modal
    header="Cancel this — বাতিল করুন"
    :style="{ width: 'min(34rem, 94vw)' }"
    @update:visible="(open: boolean) => { if (!open) emit('close'); }"
  >
    <div class="cancel">
      <p class="cancel__what">
        <strong>{{ title }}</strong>
        <span v-if="amountMinor !== undefined">{{ taka(amountMinor) }}</span>
      </p>
      <p class="cancel__consequence">{{ consequence }}</p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="cancel-reason">Why is it being cancelled? <span>কেন বাতিল করছেন</span></label>
        <textarea
          id="cancel-reason"
          v-model="reason"
          rows="3"
          placeholder="Recorded twice by mistake"
        />
      </div>

      <p class="cancel__note">
        Nothing is deleted. The document stays with its number, struck through, and one reversing
        entry puts everything back — কিছুই মুছে যায় না, শুধু উল্টো এন্ট্রি হয়।
      </p>
    </div>

    <template #footer>
      <Button label="Keep it" text :disabled="saving" @click="emit('close')" />
      <Button
        label="Cancel it"
        icon="pi pi-times-circle"
        severity="danger"
        :loading="saving"
        @click="confirm"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.cancel { display: grid; gap: 0.75rem; }
.cancel__what { display: flex; justify-content: space-between; gap: 1rem; margin: 0; }
.cancel__consequence { margin: 0; color: var(--sher-text-muted, #64748b); }
.cancel__note { margin: 0; font-size: 0.8rem; color: var(--sher-text-muted, #64748b); }
</style>
