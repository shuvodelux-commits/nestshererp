<script setup lang="ts">
import type { CatalogResponse, ProductResponse } from '@sher/core-contracts';
import { parseQty, SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { createProduct } from '../../api/products';
import { useSession } from '../../auth/session';
import AmountInput from '../fields/AmountInput.vue';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Add a product without leaving what you are doing (D-39).
 *
 * **Only §5.5's mandatory fields**: name, base unit, both prices and the
 * reorder level. Everything else — brand, category, barcode, expiry, serial,
 * conversion — is filled in later on the product's own form, because a
 * shopkeeper mid-plan is thinking about what to buy, not about how to file it.
 *
 * **The same use case the full form calls.** Same endpoint, same permission,
 * same validation, same audit, same idempotency key. D-39 is explicit that the
 * inline path is not a relaxed second way to create anything, and this is what
 * that means in practice: there is no create path of its own here.
 *
 * The usual supplier is offered because this dialog opens from the planner,
 * where a product with no supplier lands on nobody's order.
 */
const props = defineProps<{
  open: boolean;
  catalog: CatalogResponse;
  suppliers: readonly { readonly id: string; readonly name: string }[];
}>();
const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'created', product: ProductResponse): void;
}>();

const session = useSession();
const clock = new SystemClock();

const name = ref('');
const baseUnitId = ref('');
const purchaseTaka = ref(0);
const sellingTaka = ref(0);
const minStock = ref('');
const usualSupplierId = ref<string | null>(null);
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const visible = computed({
  get: () => props.open,
  set: (value: boolean) => {
    if (!value) emit('close');
  },
});

const unitOptions = computed(() =>
  props.catalog.units.map((unit) => ({ label: unit.name, value: unit.id })),
);
const supplierOptions = computed(() => [
  { label: 'Decide later', value: null },
  ...props.suppliers.map((supplier) => ({ label: supplier.name, value: supplier.id })),
]);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    name.value = '';
    baseUnitId.value = props.catalog.units[0]?.id ?? '';
    purchaseTaka.value = 0;
    sellingTaka.value = 0;
    minStock.value = '';
    usualSupplierId.value = null;
    error.value = null;
    // A fresh intent gets a fresh key (UI-34): reusing the last one would make
    // a genuinely different product look like a retry of the previous save.
    operationId.value = Ulid.generate(clock);
  },
);

async function save(): Promise<void> {
  if (name.value.trim() === '') {
    error.value = { code: 'VALIDATION_FAILED', message: 'Give the product a name' };
    return;
  }
  if (baseUnitId.value === '') {
    error.value = { code: 'VALIDATION_FAILED', message: 'Choose the unit it is counted in' };
    return;
  }
  const reorder = parseQty(minStock.value === '' ? '0' : minStock.value);
  if (reorder === null || reorder < 0) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Enter a valid minimum stock' };
    return;
  }

  busy.value = true;
  error.value = null;
  try {
    const product = await createProduct(
      session.accessToken.value ?? '',
      {
        name: name.value.trim(),
        baseUnitId: baseUnitId.value,
        purchasePriceMinor: Math.round(purchaseTaka.value * 100),
        sellingPriceMinor: Math.round(sellingTaka.value * 100),
        minStockQty: reorder,
        brandId: null,
        categoryId: null,
        sku: null,
        barcode: null,
        description: null,
        defaultDiscountType: null,
        defaultDiscountValue: null,
        offerEnabled: false,
        offerPriceMinor: null,
        offerStartDate: null,
        offerEndDate: null,
        tracksExpiry: false,
        tracksSerial: false,
        conversionUnitId: null,
        conversionFactorQty: null,
        usualSupplierId: usualSupplierId.value,
        minOrderQty: null,
        warrantyMonths: null,
        supplierWarrantyMonths: null,
      },
      operationId.value,
    );
    emit('created', product);
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'SAVE_FAILED', message: 'The product could not be saved. Try again.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Add a product — নতুন পণ্য"
    :style="{ width: 'min(38rem, 94vw)' }"
  >
    <form class="quick-form" @submit.prevent="save">
      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="qp-name">Product name <span class="label-bn">পণ্যের নাম</span></label>
        <input id="qp-name" v-model="name" autocomplete="off" placeholder="Walton Fridge 200L" />
      </div>

      <div class="grid">
        <div class="field">
          <label for="qp-unit">Counted in <span class="label-bn">কীসে গোনা হয়</span></label>
          <Select
            v-model="baseUnitId"
            input-id="qp-unit"
            :options="unitOptions"
            option-label="label"
            option-value="value"
            append-to="self"
            fluid
          />
        </div>

        <div class="field">
          <label for="qp-min">
            Minimum stock <span class="label-bn">সবচেয়ে কম কতটা রাখবেন</span>
          </label>
          <input id="qp-min" v-model="minStock" inputmode="decimal" placeholder="5" />
        </div>

        <div class="field">
          <label for="qp-buy">Purchase price <span class="label-bn">কেনার দাম</span></label>
          <AmountInput input-id="qp-buy" v-model="purchaseTaka" :min="0" placeholder="18500" />
        </div>

        <div class="field">
          <label for="qp-sell">Selling price <span class="label-bn">বিক্রির দাম</span></label>
          <AmountInput input-id="qp-sell" v-model="sellingTaka" :min="0" placeholder="24500" />
        </div>

        <div class="field">
          <label for="qp-supplier">
            Usual supplier <span class="label-bn">সাধারণত কার কাছে কেনেন</span>
          </label>
          <Select
            v-model="usualSupplierId"
            input-id="qp-supplier"
            :options="supplierOptions"
            option-label="label"
            option-value="value"
            append-to="self"
            fluid
          />
        </div>
      </div>

      <p class="consequence">
        This saves a real product straight away. Brand, category, barcode and the rest can be
        filled in later on the product's own page.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy">
          {{ busy ? 'Saving…' : 'Add product' }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.field label {
  display: grid;
  gap: 1px;
  line-height: 1.3;
}

.field label .label-bn {
  margin-left: 0;
}

.quick-form {
  display: grid;
  gap: var(--sher-space-3);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sher-space-3);
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
