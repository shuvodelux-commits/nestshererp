<script setup lang="ts">
import { qtyText } from '../money/money-text';
import type { SerialUnitResponse, VendorStockReceiptResponse } from '@sher/core-contracts';
import { Qty, SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { returnVendorStock } from '../../api/vendors';
import { fetchAvailableSerials } from '../../api/warranty';
import { useSession } from '../../auth/session';
import AmountInput from '../fields/AmountInput.vue';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Handing back what did not sell (§5.6 M07, owner decision 2026-08-26).
 *
 * **Stock only — no money moves.** The shop never bought these goods, so there
 * is nothing to unpay and nothing to reverse. Capped at what is still on the
 * shelf from this receipt, because returning something already sold would drive
 * the lot negative and hand the vendor stock the shop no longer has.
 */
const props = defineProps<{ receipt: VendorStockReceiptResponse | null }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'returned'): void }>();

const session = useSession();
const clock = new SystemClock();

const qty = ref(0);
const note = ref('');
const businessDate = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));
const receiptSerials = ref<readonly SerialUnitResponse[]>([]);
const selectedSerialIds = ref<string[]>([]);

const visible = computed({
  get: () => props.receipt !== null,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const onHand = computed(() => (props.receipt?.onHandQty ?? 0) / 1000);

watch(
  () => props.receipt?.id,
  async () => {
    qty.value = onHand.value;
    note.value = '';
    businessDate.value = '';
    error.value = null;
    operationId.value = Ulid.generate(clock);
    receiptSerials.value = [];
    selectedSerialIds.value = [];
    const receipt = props.receipt;
    const token = session.accessToken.value;
    if (receipt !== null && token !== null && receipt.onHandQty > 0) {
      /*
       * The whole page, because the units wanted are picked out of it here: a
       * product with more in-stock serials than one default page could answer
       * without a single one of this receipt's, and the dialog would then ask
       * for a serial that was not on offer. 500 is the endpoint's ceiling.
       */
      const available = await fetchAvailableSerials(token, receipt.productId, 500);
      receiptSerials.value = available.data.filter(
        (unit) => unit.vendorStockReceiptId === receipt.id && unit.vendorLotId !== null,
      );
      selectedSerialIds.value = receiptSerials.value.map((unit) => unit.id);
    }
  },
);

async function save(): Promise<void> {
  const receipt = props.receipt;
  if (receipt === null) return;

  if (qty.value <= 0 || qty.value > onHand.value) {
    error.value = {
      code: 'VALIDATION_FAILED',
      message: `Enter between 0 and ${qtyText(receipt.onHandQty)}`,
    };
    return;
  }
  if (
    receiptSerials.value.length > 0 &&
    (qty.value !== Math.round(qty.value) || selectedSerialIds.value.length !== Math.round(qty.value))
  ) {
    error.value = {
      code: 'VALIDATION_FAILED',
      message: 'Select exactly one serial for every unit going back',
    };
    return;
  }

  busy.value = true;
  error.value = null;
  try {
    await returnVendorStock(
      session.accessToken.value ?? '',
      {
        receiptId: receipt.id,
        qty: Math.round(qty.value * 1000),
        serialUnitIds: selectedSerialIds.value,
        note: note.value.trim() === '' ? null : note.value.trim(),
        ...(businessDate.value === '' ? {} : { businessDate: businessDate.value }),
      },
      operationId.value,
    );
    emit('returned');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'SAVE_FAILED', message: 'The return could not be saved. Try again.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Return vendor stock — ভেন্ডরের মাল ফেরত"
    :style="{ width: 'min(34rem, 94vw)' }"
  >
    <form v-if="props.receipt !== null" class="return-form" @submit.prevent="save">
      <p class="on-receipt">
        <strong>{{ props.receipt.displayName }}</strong>
        <span>
          {{ props.receipt.vendorName }} · {{ qtyText(props.receipt.onHandQty) }}
          {{ props.receipt.unitName }} still on the shelf
        </span>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="vr-qty">How many going back <span class="label-bn">কতটা ফেরত যাচ্ছে</span></label>
        <AmountInput input-id="vr-qty" v-model="qty" :min="0" :max="onHand" :fraction-digits="3" />
      </div>

      <div v-if="receiptSerials.length > 0" class="field serial-list">
        <label>Manufacturer serials <span class="label-bn">ফেরত যাওয়া সিরিয়াল</span></label>
        <label v-for="unit in receiptSerials" :key="unit.id">
          <input v-model="selectedSerialIds" type="checkbox" :value="unit.id" />
          <span>{{ unit.serialNo }}</span>
        </label>
        <small>{{ selectedSerialIds.length }} selected · quantity {{ Math.round(qty) }}</small>
      </div>

      <div class="field">
        <label for="vr-date">Date <span class="label-bn">তারিখ — ফাঁকা রাখলে আজ</span></label>
        <DateOnlyPicker input-id="vr-date" v-model="businessDate" />
      </div>

      <div class="field">
        <label for="vr-note">Note <span class="label-bn">মন্তব্য — ঐচ্ছিক</span></label>
        <input id="vr-note" v-model="note" autocomplete="off" placeholder="Optional" />
      </div>

      <p class="consequence">
        The goods come off the shelf and no money moves — you never bought them, so there is nothing
        to pay back.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy">
          {{ busy ? 'Saving…' : 'Return stock' }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
/*
 * The Bangla name under the English one, not trailing it (owner decision
 * 2026-08-26, pointing at the module tabs as the shape to copy).
 *
 * These labels are longer than a form's usual one or two words — "Target Stock
 * Cover কত দিনের মাল রাখবেন" on a single line wrapped mid-phrase and threw the
 * controls out of alignment. Stacked, each language reads as its own line.
 */
.field label {
  display: grid;
  gap: 1px;
  line-height: 1.3;
}

/* The 6px lead-in only makes sense when it trails the English on one line. */
.field label .label-bn {
  margin-left: 0;
}

.return-form {
  display: grid;
  gap: var(--sher-space-3);
}

.on-receipt {
  margin: 0;
  display: grid;
  gap: 2px;
}

.on-receipt span {
  color: var(--sher-text-muted);
  font-size: 0.85rem;
}

.consequence {
  margin: 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}
</style>
