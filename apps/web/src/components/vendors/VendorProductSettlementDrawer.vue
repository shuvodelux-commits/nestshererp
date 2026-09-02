<script setup lang="ts">
import type { ProductResponse } from '@sher/core-contracts';
import { Money, Qty, SystemClock, Ulid } from '@sher/shared-utils';
import Drawer from 'primevue/drawer';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Textarea from 'primevue/textarea';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { settleVendorWithProducts } from '../../api/vendors';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import AmountInput from '../fields/AmountInput.vue';
import { taka } from '../money/money-text';

const props = defineProps<{
  open: boolean;
  vendorId: string;
  vendorName: string;
  receivableMinor: number;
  products: readonly ProductResponse[];
  accounts: readonly { readonly code: string; readonly label: string }[];
  canAddLandedCosts: boolean;
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'settled'): void }>();

interface ProductLine {
  productId: string;
  qty: number;
  price: number;
  expiryDate: string;
  serialText: string;
}
interface CostRow {
  category: 'TRANSPORT' | 'LABOUR' | 'LOADING' | 'DELIVERY' | 'CUSTOMS' | 'OTHER';
  amount: number;
  method: 'BY_VALUE' | 'BY_QTY' | 'MANUAL';
  description: string;
  paidAccountCode: string;
  manual: number[];
}

const session = useSession();
const clock = new SystemClock();
const lines = ref<ProductLine[]>([]);
const discount = ref(0);
const costs = ref<CostRow[]>([]);
const businessDate = ref('');
const supplierBillRef = ref('');
const notes = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const productOptions = computed(() =>
  props.products.map((product) => ({ label: product.displayName, value: product.id })),
);
const categories = [
  { label: 'Transport', value: 'TRANSPORT' },
  { label: 'Labour', value: 'LABOUR' },
  { label: 'Loading / Unloading', value: 'LOADING' },
  { label: 'Delivery', value: 'DELIVERY' },
  { label: 'Customs', value: 'CUSTOMS' },
  { label: 'Other', value: 'OTHER' },
];
const methods = [
  { label: 'Purchase Value', value: 'BY_VALUE' },
  { label: 'Quantity', value: 'BY_QTY' },
  { label: 'Manual', value: 'MANUAL' },
];

const grossMinor = computed(() =>
  lines.value.reduce(
    (sum, line) =>
      sum + Money(Math.round(line.price * 100)).multiply(Qty(Math.round(line.qty * 1000))).minor,
    0,
  ),
);
const netMinor = computed(() => grossMinor.value - Math.round(discount.value * 100));
const landedMinor = computed(() => costs.value.reduce((sum, cost) => sum + Math.round(cost.amount * 100), 0));
const inventoryValueMinor = computed(() => netMinor.value + landedMinor.value);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    lines.value = [{ productId: '', qty: 1, price: 0, expiryDate: '', serialText: '' }];
    discount.value = 0;
    costs.value = [];
    businessDate.value = '';
    supplierBillRef.value = '';
    notes.value = '';
    error.value = null;
    operationId.value = Ulid.generate(clock);
  },
);

function productOf(line: ProductLine): ProductResponse | undefined {
  return props.products.find((product) => product.id === line.productId);
}
function serialsOf(line: ProductLine): string[] {
  return line.serialText.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
}
function addLine(): void {
  lines.value.push({ productId: '', qty: 1, price: 0, expiryDate: '', serialText: '' });
  costs.value.forEach((cost) => cost.manual.push(0));
}
function removeLine(index: number): void {
  lines.value.splice(index, 1);
  costs.value.forEach((cost) => cost.manual.splice(index, 1));
}
function addCost(): void {
  costs.value.push({
    category: 'TRANSPORT',
    amount: 0,
    method: 'BY_QTY',
    description: '',
    paidAccountCode: props.accounts[0]?.code ?? '',
    manual: lines.value.map(() => 0),
  });
}
function manualRemainingMinor(cost: CostRow): number {
  return Math.round(cost.amount * 100) - cost.manual.reduce((sum, value) => sum + Math.round((value ?? 0) * 100), 0);
}

async function save(): Promise<void> {
  if (lines.value.some((line) => line.productId === '' || line.qty <= 0 || line.price < 0)) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Complete every product line' };
    return;
  }
  if (netMinor.value <= 0 || netMinor.value > props.receivableMinor) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Net product value must be positive and cannot exceed the vendor receivable' };
    return;
  }
  for (const line of lines.value) {
    const product = productOf(line);
    if (product?.tracksExpiry && line.expiryDate === '') {
      error.value = { code: 'VALIDATION_FAILED', message: `Enter an expiry date for ${product.displayName}` };
      return;
    }
    if (product?.tracksSerial && serialsOf(line).length !== Math.round(line.qty)) {
      error.value = { code: 'VALIDATION_FAILED', message: `Enter exactly ${Math.round(line.qty)} serials for ${product.displayName}` };
      return;
    }
  }
  if (costs.value.some((cost) =>
    cost.amount <= 0 || cost.paidAccountCode === '' ||
    (cost.category === 'OTHER' && cost.description.trim() === '') ||
    (cost.method === 'MANUAL' && manualRemainingMinor(cost) !== 0)
  )) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Complete every landed-cost row; manual Remaining must be zero' };
    return;
  }

  busy.value = true;
  error.value = null;
  try {
    await settleVendorWithProducts(
      session.accessToken.value ?? '',
      {
        vendorPartyId: props.vendorId,
        ...(businessDate.value === '' ? {} : { businessDate: businessDate.value }),
        supplierBillRef: supplierBillRef.value.trim() || null,
        discountMinor: Math.round(discount.value * 100),
        lines: lines.value.map((line) => ({
          productId: line.productId,
          qty: Math.round(line.qty * 1000),
          unitPriceMinor: Math.round(line.price * 100),
          expiryDate: line.expiryDate || null,
          serials: serialsOf(line),
        })),
        landedCosts: costs.value.map((cost) => ({
          category: cost.category,
          amountMinor: Math.round(cost.amount * 100),
          method: cost.method,
          description: cost.description.trim() || null,
          paidAccountCode: cost.paidAccountCode,
          manualAllocations: cost.method === 'MANUAL'
            ? cost.manual.map((amount, lineIndex) => ({ lineIndex, amountMinor: Math.round((amount ?? 0) * 100) }))
            : [],
        })),
        notes: notes.value.trim() || null,
      },
      operationId.value,
    );
    emit('settled');
  } catch (cause) {
    error.value = cause instanceof ApiError
      ? { code: cause.code, message: cause.message }
      : { code: 'SAVE_FAILED', message: 'The product settlement could not be posted' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Drawer :visible="open" position="right" header="Receive products as settlement — পণ্য নিয়ে সমন্বয়" class="settlement-drawer" @update:visible="(value) => { if (!value) emit('close') }">
    <form class="form" @submit.prevent="save">
      <p class="lede"><strong>{{ vendorName }}</strong> owes {{ taka(receivableMinor) }}. Only net product value reduces this balance; landed costs are paid separately.</p>
      <ErrorNotice v-if="error" :code="error.code" :message="error.message" />

      <div class="grid-2">
        <label class="field"><span>Date</span><DateOnlyPicker v-model="businessDate" input-id="settlement-date" /></label>
        <label class="field"><span>Vendor reference</span><InputText v-model="supplierBillRef" /></label>
      </div>

      <section class="section">
        <div class="section-head"><h3>Products</h3><button type="button" class="btn btn-ghost" @click="addLine">+ Add product</button></div>
        <div v-for="(line, index) in lines" :key="index" class="line-card">
          <Select v-model="line.productId" :options="productOptions" option-label="label" option-value="value" filter placeholder="Product" />
          <AmountInput v-model="line.qty" :min="0.001" :fraction-digits="3" placeholder="Quantity" />
          <AmountInput v-model="line.price" :min="0" placeholder="Price each" />
          <DateOnlyPicker v-if="productOf(line)?.tracksExpiry" v-model="line.expiryDate" :input-id="`settlement-expiry-${index}`" />
          <Textarea v-if="productOf(line)?.tracksSerial" v-model="line.serialText" rows="3" placeholder="One manufacturer serial per line" class="full" />
          <button v-if="lines.length > 1" type="button" class="icon-btn icon-btn--danger" title="Remove" @click="removeLine(index)"><i class="pi pi-trash" /></button>
        </div>
        <label class="field discount"><span>Purchase discount</span><AmountInput v-model="discount" :min="0" /></label>
      </section>

      <section class="section">
        <div class="section-head"><h3>Landed costs</h3><button v-if="canAddLandedCosts" type="button" class="btn btn-ghost" @click="addCost">+ Add cost</button></div>
        <div v-for="(cost, costIndex) in costs" :key="costIndex" class="cost-card">
          <Select v-model="cost.category" :options="categories" option-label="label" option-value="value" />
          <AmountInput v-model="cost.amount" :min="0" placeholder="Amount" />
          <Select v-model="cost.method" :options="methods" option-label="label" option-value="value" />
          <Select v-model="cost.paidAccountCode" :options="[...accounts]" option-label="label" option-value="code" placeholder="Cash / bank source" />
          <InputText v-if="cost.category === 'OTHER'" v-model="cost.description" placeholder="Required description" class="full" />
          <div v-if="cost.method === 'MANUAL'" class="manual full">
            <label v-for="(line, lineIndex) in lines" :key="lineIndex">
              <span>{{ productOf(line)?.displayName ?? `Line ${lineIndex + 1}` }}</span>
              <AmountInput
                :model-value="cost.manual[lineIndex] ?? 0"
                :min="0"
                @update:model-value="(value) => { cost.manual[lineIndex] = value }"
              />
            </label>
            <strong :class="{ bad: manualRemainingMinor(cost) !== 0 }">Remaining {{ taka(manualRemainingMinor(cost)) }}</strong>
          </div>
          <button type="button" class="icon-btn icon-btn--danger" title="Remove" @click="costs.splice(costIndex, 1)"><i class="pi pi-trash" /></button>
        </div>
      </section>

      <label class="field"><span>Note</span><Textarea v-model="notes" rows="2" /></label>
      <div class="totals">
        <span>Gross products <strong>{{ taka(grossMinor) }}</strong></span>
        <span>Discount <strong>{{ taka(Math.round(discount * 100)) }}</strong></span>
        <span>Net receivable settlement <strong>{{ taka(netMinor) }}</strong></span>
        <span>Landed costs (cash/bank) <strong>{{ taka(landedMinor) }}</strong></span>
        <span>Owned inventory increase <strong>{{ taka(inventoryValueMinor) }}</strong></span>
        <span>Receivable after <strong>{{ taka(receivableMinor - netMinor) }}</strong></span>
      </div>
      <div class="actions"><button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button><button type="submit" class="btn btn-primary" :disabled="busy">{{ busy ? 'Posting…' : 'Post settlement' }}</button></div>
    </form>
  </Drawer>
</template>

<style scoped>
.form,.section,.field,.manual { display: flex; flex-direction: column; gap: var(--sher-space-2); }
.lede { margin: 0; color: var(--sher-text-muted); }
.grid-2 { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--sher-space-2); }
.section { padding-top: var(--sher-space-3); border-top: 1px solid var(--sher-line); }
.section-head,.actions,.totals span { display: flex; align-items: center; justify-content: space-between; gap: var(--sher-space-2); }
.section-head h3 { margin: 0; }
.line-card,.cost-card { display: grid; grid-template-columns: minmax(10rem,2fr) repeat(3,minmax(7rem,1fr)) auto; gap: var(--sher-space-2); align-items: start; padding: var(--sher-space-2); border: 1px solid var(--sher-line); border-radius: var(--sher-radius-md); }
.full { grid-column: 1 / -1; }
.manual label { display: grid; grid-template-columns: 1fr 10rem; align-items: center; gap: var(--sher-space-2); }
.discount { max-width: 14rem; }
.totals { display: flex; flex-direction: column; gap: var(--sher-space-1); padding: var(--sher-space-3); background: var(--sher-sunken); border-radius: var(--sher-radius-md); }
.bad { color: var(--sher-danger); }
.actions { justify-content: flex-end; }
@media (max-width: 48rem) { .grid-2,.line-card,.cost-card { grid-template-columns: 1fr; } .full { grid-column: auto; } }
:global(.settlement-drawer) { width: min(56rem, 100vw); }
</style>
