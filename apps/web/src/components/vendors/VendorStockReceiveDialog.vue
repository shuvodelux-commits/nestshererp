<script setup lang="ts">
import type { PartyResponse } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import Textarea from 'primevue/textarea';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { receiveVendorStock } from '../../api/vendors';
import { useSession } from '../../auth/session';
import AmountInput from '../fields/AmountInput.vue';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * A vendor leaves goods to be sold on their behalf (§5.6 M07, DR13.10, owner
 * decision 2026-08-26).
 *
 * **Deliberately very small**: one vendor, one product, one quantity, one cost.
 * There is no consignment agreement here and no vendor price list — the owner
 * asked for a form, not a module.
 *
 * Saving moves stock and posts **no money at all**. The vendor is owed nothing
 * until one of these sells, at which point the till converts the goods at this
 * cost and creates the payable.
 */
const props = defineProps<{
  open: boolean;
  vendors: readonly PartyResponse[];
  products: readonly {
    id: string;
    displayName: string;
    baseUnitName: string;
    tracksSerial: boolean;
  }[];
  initialVendorId?: string | undefined;
  initialProductId?: string | undefined;
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'received'): void }>();

const session = useSession();
const clock = new SystemClock();

const vendorPartyId = ref<string | null>(null);
const productId = ref<string | null>(null);
const qty = ref(0);
const costTaka = ref(0);
const note = ref('');
const serialText = ref('');
const businessDate = ref('');
const expiryDate = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const visible = computed({
  get: () => props.open,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const vendorOptions = computed(() =>
  props.vendors.map((vendor) => ({ label: vendor.name, value: vendor.id })),
);
const productOptions = computed(() =>
  props.products.map((product) => ({ label: product.displayName, value: product.id })),
);
const unitName = computed(
  () => props.products.find((product) => product.id === productId.value)?.baseUnitName ?? '',
);
const selectedProduct = computed(() => props.products.find((product) => product.id === productId.value));
const serials = computed(() =>
  serialText.value
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter((value) => value !== ''),
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    vendorPartyId.value = props.initialVendorId ?? null;
    productId.value = props.initialProductId ?? null;
    qty.value = 0;
    costTaka.value = 0;
    note.value = '';
    serialText.value = '';
    businessDate.value = '';
    expiryDate.value = '';
    error.value = null;
    operationId.value = Ulid.generate(clock);
  },
);

async function save(): Promise<void> {
  if (vendorPartyId.value === null || productId.value === null) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Choose the vendor and the product' };
    return;
  }
  if (qty.value <= 0) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Enter how many they left' };
    return;
  }
  if (selectedProduct.value?.tracksSerial && serials.value.length !== Math.round(qty.value)) {
    error.value = {
      code: 'VALIDATION_FAILED',
      message: `Enter exactly ${Math.round(qty.value)} manufacturer serial numbers`,
    };
    return;
  }

  busy.value = true;
  error.value = null;
  try {
    await receiveVendorStock(
      session.accessToken.value ?? '',
      {
        vendorPartyId: vendorPartyId.value,
        productId: productId.value,
        qty: Math.round(qty.value * 1000),
        vendorUnitCostMinor: Math.round(costTaka.value * 100),
        expiryDate: expiryDate.value === '' ? null : expiryDate.value,
        serials: serials.value,
        note: note.value.trim() === '' ? null : note.value.trim(),
        ...(businessDate.value === '' ? {} : { businessDate: businessDate.value }),
      },
      operationId.value,
    );
    emit('received');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'SAVE_FAILED', message: 'The vendor stock could not be saved. Try again.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Receive vendor stock — ভেন্ডরের মাল নিন"
    :style="{ width: 'min(38rem, 94vw)' }"
  >
    <form class="vendor-form" @submit.prevent="save">
      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="grid">
        <div class="field">
          <label for="vs-vendor">Vendor <span class="label-bn">কার মাল</span></label>
          <Select
            v-model="vendorPartyId"
            input-id="vs-vendor"
            :options="vendorOptions"
            option-label="label"
            option-value="value"
            filter
            append-to="self"
            fluid
            placeholder="Choose a vendor"
          />
        </div>

        <div class="field">
          <label for="vs-product">Product <span class="label-bn">কী মাল</span></label>
          <Select
            v-model="productId"
            input-id="vs-product"
            :options="productOptions"
            option-label="label"
            option-value="value"
            filter
            append-to="self"
            fluid
            placeholder="Choose a product"
          />
        </div>

        <div class="field">
          <label for="vs-qty">Quantity <span class="label-bn">কতটা</span> {{ unitName }}</label>
          <AmountInput input-id="vs-qty" v-model="qty" :min="0" :fraction-digits="3" />
        </div>

        <div v-if="selectedProduct?.tracksSerial" class="field full">
          <label for="vs-serials">
            Manufacturer serials <span class="label-bn">প্রতি লাইনে একটি সিরিয়াল</span>
          </label>
          <Textarea
            id="vs-serials"
            v-model="serialText"
            rows="5"
            placeholder="One serial per line"
            fluid
          />
          <small>{{ serials.length }} selected · quantity {{ Math.round(qty) }}</small>
        </div>

        <div class="field">
          <label for="vs-cost">Their price each <span class="label-bn">প্রতিটির দাম</span></label>
          <AmountInput input-id="vs-cost" v-model="costTaka" :min="0" placeholder="450" />
        </div>

        <div class="field">
          <label for="vs-date">Date <span class="label-bn">তারিখ — ফাঁকা রাখলে আজ</span></label>
          <DateOnlyPicker input-id="vs-date" v-model="businessDate" />
        </div>

        <div class="field">
          <label for="vs-expiry">Expiry date <span class="label-bn">মেয়াদ — ঐচ্ছিক</span></label>
          <DateOnlyPicker input-id="vs-expiry" v-model="expiryDate" />
        </div>

        <div class="field">
          <label for="vs-note">Note <span class="label-bn">মন্তব্য — ঐচ্ছিক</span></label>
          <input id="vs-note" v-model="note" autocomplete="off" placeholder="Optional" />
        </div>
      </div>

      <p class="consequence">
        These goods go on the shelf but stay the vendor's. They add nothing to your stock value and
        you owe nothing yet — the vendor is owed only when one of them sells.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy">
          {{ busy ? 'Saving…' : 'Receive stock' }}
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

.vendor-form {
  display: grid;
  gap: var(--sher-space-3);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sher-space-3);
}

.full {
  grid-column: 1 / -1;
}

@media (max-width: 40rem) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.consequence {
  margin: 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}
</style>
