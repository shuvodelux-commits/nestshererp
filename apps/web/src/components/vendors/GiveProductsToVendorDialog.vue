<script setup lang="ts">
import type { ProductResponse, VendorIssueMode } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, ref } from 'vue';

import { ApiError } from '../../api/client';
import { giveProductsToVendor } from '../../api/vendors';
import { useSession } from '../../auth/session';
import AmountInput from '../fields/AmountInput.vue';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * The shop's own goods going out to a vendor (§5.6 M07, owner decision
 * 2026-08-31: the mode is chosen per transaction).
 *
 * The two modes are two different events, and the screen says so before
 * anything is saved. **Charged to vendor** is a sale: it raises an invoice,
 * puts the money on their account and takes the profit — the same posting the
 * counter makes, because it is the same service. **Temporary issue** is
 * custody: the goods are still the shop's, still in its stock value, and
 * nothing at all happens to the accounts.
 */
const props = defineProps<{
  vendorId: string;
  vendorName: string;
  products: readonly ProductResponse[];
}>();

const emit = defineEmits<{
  (event: 'given'): void;
  (event: 'sell'): void;
  (event: 'close'): void;
}>();

const session = useSession();
const clock = new SystemClock();

const mode = ref<VendorIssueMode>('CHARGED');
const productId = ref<string | null>(null);
const qty = ref(0);
const note = ref('');
const businessDate = ref(clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone));
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const modeOptions = [
  { value: 'CHARGED' as const, label: 'Charged to vendor — বিক্রি হিসেবে' },
  { value: 'TEMPORARY' as const, label: 'Temporary issue — সাময়িকভাবে' },
];

const productOptions = computed(() =>
  props.products.map((product) => ({ label: product.displayName, value: product.id })),
);
const selected = computed(() =>
  props.products.find((product) => product.id === productId.value) ?? null,
);
const unitName = computed(() => selected.value?.baseUnitName ?? '');

const charging = computed(() => mode.value === 'CHARGED');

const ready = computed(
  () =>
    charging.value || (productId.value !== null && qty.value > 0),
);

async function save(): Promise<void> {
  if (charging.value) {
    emit('sell');
    return;
  }
  const token = session.accessToken.value;
  if (token === null || productId.value === null || !ready.value) return;

  busy.value = true;
  failure.value = null;
  try {
    await giveProductsToVendor(
      token,
      {
        vendorPartyId: props.vendorId,
        mode: mode.value,
        productId: productId.value,
        qty: Math.round(qty.value * 1000),
        unitValueMinor: 0,
        note: note.value.trim() === '' ? null : note.value.trim(),
        businessDate: businessDate.value,
      },
      operationId.value,
    );
    emit('given');
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not record this' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    visible
    modal
    :header="`Give products to ${vendorName} — ভেন্ডরকে মাল দিন`"
    :style="{ width: 'min(36rem, 96vw)' }"
    @update:visible="emit('close')"
  >
    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="two-column">
      <div v-if="!charging" class="field">
        <label for="give-mode">This handover is <span class="label-bn">কী হিসেবে</span></label>
        <Select
          input-id="give-mode"
          v-model="mode"
          :options="modeOptions"
          option-label="label"
          option-value="value"
          append-to="body"
          fluid
        />
      </div>

      <div v-if="!charging" class="field">
        <label for="give-product">Product <span class="label-bn">পণ্য</span></label>
        <Select
          input-id="give-product"
          v-model="productId"
          :options="productOptions"
          option-label="label"
          option-value="value"
          placeholder="Choose a product"
          filter
          append-to="body"
          fluid
        />
      </div>

      <div class="field">
        <label for="give-qty">
          Quantity <span class="label-bn">পরিমাণ</span>
          <span v-if="unitName !== ''" class="unit">({{ unitName }})</span>
        </label>
        <AmountInput input-id="give-qty" v-model="qty" :decimals="2" />
      </div>

      <div v-if="!charging" class="field">
        <label for="give-date">Date <span class="label-bn">তারিখ</span></label>
        <DateOnlyPicker v-model="businessDate" input-id="give-date" />
      </div>

      <div v-if="!charging" class="field">
        <label for="give-note">Note <span class="label-bn">মন্তব্য</span></label>
        <InputText id="give-note" v-model="note" maxlength="300" fluid />
      </div>
    </div>

    <p v-if="charging" class="notice is-ok">
      Continue in POS with this vendor selected. The POS will handle products, exact serials,
      mixed stock sources, and shortages before putting the full invoice on their account.
      <span class="label-bn">POS-এ সম্পূর্ণ বিক্রি করুন</span>
    </p>
    <p v-else class="notice is-ok">
      The goods stay yours and stay in your stock value — only their location changes. No money
      moves. <span class="label-bn">হিসাবে কোনো টাকা যোগ হবে না</span>
    </p>

    <template #footer>
      <Button label="Cancel" text @click="emit('close')" />
      <Button
        icon="pi pi-check"
        :label="charging ? 'Continue in POS' : 'Issue temporarily'"
        :disabled="!ready"
        :loading="busy"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.two-column {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--sher-space-3, 12px);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field label {
  font-size: 13px;
  font-weight: 600;
}

.label-bn {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.unit {
  margin-left: 4px;
  font-weight: 400;
  color: var(--sher-text-muted);
}
</style>
