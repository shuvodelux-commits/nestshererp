<script setup lang="ts">
import { qtyText } from './money/money-text';
import type { ProductResponse, StockAdjustmentReasonValue } from '@sher/core-contracts';
import { parseQty, Qty, SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import { adjustStock } from '../api/inventory';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import DateOnlyPicker from './DateOnlyPicker.vue';
import ErrorNotice from './ErrorNotice.vue';

/**
 * Correct one product's stock (§5.10) — the `Stock` action on the Products row
 * menu.
 *
 * One signed box, the way a shopkeeper says it: `10` found, `-3` broken.
 * Nothing here computes anything (B8) — the server resolves the cost, writes
 * the movement and posts `DR/CR STOCK_ADJUSTMENT`, and this screen only says
 * what happened afterwards.
 */
const props = defineProps<{ product: ProductResponse | null }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'adjusted'): void }>();

const clock = new SystemClock();
const session = useSession();

/**
 * The four §5.10 reasons. Closed, because the Damaged & Written-off report
 * groups by them and free text cannot be grouped.
 */
const reasonOptions: Array<{ label: string; value: StockAdjustmentReasonValue }> = [
  { label: 'Damaged — নষ্ট হয়েছে', value: 'DAMAGE' },
  { label: 'Recount — গুনে দেখলাম', value: 'RECOUNT' },
  { label: 'Lost or stolen — হারিয়েছে', value: 'THEFT_LOSS' },
  { label: 'Other — অন্য কারণ', value: 'OTHER' },
];

const visible = computed({
  get: () => props.product !== null,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const amount = ref('');
const reason = ref<StockAdjustmentReasonValue>('DAMAGE');
const note = ref('');
const businessDate = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

// A fresh intent gets a fresh idempotency key (UI-34): reusing the last one
// would make a second, genuinely different correction look like a retry.
watch(
  () => props.product?.id,
  () => {
    amount.value = '';
    reason.value = 'DAMAGE';
    note.value = '';
    businessDate.value = '';
    error.value = null;
    operationId.value = Ulid.generate(clock);
  },
);

const onHand = computed(() => qtyText(props.product?.stockQty ?? 0));
const unitName = computed(() => props.product?.baseUnitName ?? '');
const noteRequired = computed(() => reason.value === 'OTHER');

/** What the shopkeeper will be left with, so the number is not a surprise. */
const preview = computed(() => {
  const delta = parseQty(amount.value);
  if (delta === null || delta === 0 || props.product === null) return null;
  return Qty(props.product.stockQty).add(Qty(delta)).format();
});

async function save(): Promise<void> {
  const product = props.product;
  const delta = parseQty(amount.value);
  error.value = null;

  if (product === null) return;
  if (delta === null || delta === 0) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Enter how much to add or remove — use a minus sign to remove' };
    return;
  }
  if (noteRequired.value && note.value.trim() === '') {
    error.value = { code: 'VALIDATION_FAILED', message: 'Write what happened — "Other" needs a note' };
    return;
  }

  busy.value = true;
  try {
    await adjustStock(
      session.accessToken.value ?? '',
      {
        productId: product.id,
        qtyDelta: delta,
        reason: reason.value,
        note: note.value.trim() === '' ? null : note.value.trim(),
        ...(businessDate.value === '' ? {} : { businessDate: businessDate.value }),
      },
      operationId.value,
    );
    emit('adjusted');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'SAVE_FAILED', message: 'The stock change could not be saved. Try again.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="`Adjust stock — স্টক ঠিক করুন`"
    :style="{ width: 'min(34rem, 94vw)' }"
  >
    <form v-if="product !== null" class="stock-form" @submit.prevent="save">
      <p class="on-hand">
        <strong>{{ product.displayName }}</strong>
        <span>In stock now: {{ onHand }} {{ unitName }}</span>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="stock-amount">Add or remove <span>কত যোগ বা বাদ</span></label>
        <input
          id="stock-amount"
          v-model="amount"
          inputmode="decimal"
          autocomplete="off"
          placeholder="10 to add, -3 to remove"
        />
        <p v-if="preview !== null" class="preview">
          After saving: <strong>{{ preview }} {{ unitName }}</strong>
        </p>
      </div>

      <div class="field">
        <label for="stock-reason">Reason <span>কারণ</span></label>
        <Select
          v-model="reason"
          input-id="stock-reason"
          :options="reasonOptions"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
        />
      </div>

      <div class="field">
        <label for="stock-note">
          Note <span>{{ noteRequired ? 'কী হয়েছে লিখুন — আবশ্যক' : 'মন্তব্য — ঐচ্ছিক' }}</span>
        </label>
        <input id="stock-note" v-model="note" autocomplete="off" :placeholder="noteRequired ? 'What happened?' : 'Optional'" />
      </div>

      <div class="field">
        <label for="stock-date">Date <span>তারিখ — ফাঁকা রাখলে আজ</span></label>
        <DateOnlyPicker input-id="stock-date" v-model="businessDate" />
      </div>

      <p class="consequence">
        Saving records a real stock movement and its accounting entry. It cannot be edited
        afterwards — a mistake is corrected with another adjustment.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy">
          {{ busy ? 'Saving…' : 'Save adjustment' }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.stock-form {
  display: grid;
  gap: var(--sher-space-3);
}

.on-hand {
  margin: 0;
  display: grid;
  gap: 2px;
}

.on-hand span {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
  font-variant-numeric: tabular-nums;
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

.preview {
  margin: 6px 0 0;
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
  font-variant-numeric: tabular-nums;
}

.consequence {
  margin: 0;
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
  line-height: 1.45;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-3);
}
</style>
