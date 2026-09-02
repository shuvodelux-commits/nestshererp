<script setup lang="ts">
import type { LandedCostCategoryValue, LandedCostMethodValue } from '@sher/core-contracts';
import { DEFAULT_LANDED_COST_METHOD } from '@sher/core-domain';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { addLandedCost } from '../../api/purchase-plans';
import { useSession } from '../../auth/session';
import AmountInput from '../fields/AmountInput.vue';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * A cost that turned up after the goods (§5.12, owner decision 2026-08-26).
 *
 * One task, one modal, the same shape as every other one-task action.
 *
 * The method defaults from the category — transport by quantity, customs by
 * value — through the same domain table the server uses, so the shopkeeper
 * gets the right answer without choosing and the two sides cannot disagree
 * about what "default" meant.
 */
const props = defineProps<{
  purchaseId: string | null;
  purchaseNumber: string;
  /** Where money may leave from. Empty leaves the cost owed to the supplier. */
  accounts: readonly { readonly code: string; readonly name: string }[];
  purchaseLines: readonly { readonly id: string; readonly productName: string }[];
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'added'): void }>();

const session = useSession();
const clock = new SystemClock();

const categories: Array<{ label: string; value: LandedCostCategoryValue }> = [
  { label: 'Transport — গাড়ি ভাড়া', value: 'TRANSPORT' },
  { label: 'Labour — মজুরি', value: 'LABOUR' },
  { label: 'Loading / Unloading — ওঠানো-নামানো', value: 'LOADING' },
  { label: 'Delivery — পৌঁছে দেওয়া', value: 'DELIVERY' },
  { label: 'Customs — শুল্ক', value: 'CUSTOMS' },
  { label: 'Other — অন্যান্য', value: 'OTHER' },
];

const methods: Array<{ label: string; value: LandedCostMethodValue }> = [
  { label: 'By quantity — মালের পরিমাণ অনুযায়ী', value: 'BY_QTY' },
  { label: 'By value — দামের অনুপাতে', value: 'BY_VALUE' },
  { label: 'Manual — নিজে ভাগ করুন', value: 'MANUAL' },
];

const category = ref<LandedCostCategoryValue>('TRANSPORT');
const method = ref<LandedCostMethodValue>(DEFAULT_LANDED_COST_METHOD.TRANSPORT);
const amountTaka = ref(0);
const description = ref('');
const manual = ref<number[]>([]);
/** See the planner: a `null` option value cannot be matched, so it draws blank. */
const ON_ACCOUNT = 'ON_ACCOUNT';
const paidAccountCode = ref<string>(ON_ACCOUNT);
const businessDate = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const visible = computed({
  get: () => props.purchaseId !== null,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const accountOptions = computed(() => [
  { label: 'Leave owed to the supplier — বাকি থাকবে', value: ON_ACCOUNT },
  ...props.accounts.map((account) => ({ label: account.name, value: account.code })),
]);

// Choosing a category answers the method question in the usual case; the
// shopkeeper can still override it for this one delivery.
watch(category, (next) => {
  method.value = DEFAULT_LANDED_COST_METHOD[next];
});

watch(
  () => props.purchaseId,
  () => {
    category.value = 'TRANSPORT';
    method.value = DEFAULT_LANDED_COST_METHOD.TRANSPORT;
    amountTaka.value = 0;
    description.value = '';
    manual.value = props.purchaseLines.map(() => 0);
    paidAccountCode.value = ON_ACCOUNT;
    businessDate.value = '';
    error.value = null;
    operationId.value = Ulid.generate(clock);
  },
);

async function save(): Promise<void> {
  const purchaseId = props.purchaseId;
  if (purchaseId === null) return;

  const amountMinor = Math.round(amountTaka.value * 100);
  if (amountMinor <= 0) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Enter how much the extra cost was' };
    return;
  }
  if (category.value === 'OTHER' && description.value.trim() === '') {
    error.value = { code: 'VALIDATION_FAILED', message: 'Describe what this Other cost was for' };
    return;
  }
  const allocatedMinor = manual.value.reduce((sum, amount) => sum + Math.round((amount ?? 0) * 100), 0);
  if (method.value === 'MANUAL' && allocatedMinor !== amountMinor) {
    error.value = {
      code: 'VALIDATION_FAILED',
      message: `Manual allocations must equal the cost. Remaining: ${((amountMinor - allocatedMinor) / 100).toFixed(2)}`,
    };
    return;
  }

  busy.value = true;
  error.value = null;
  try {
    await addLandedCost(
      session.accessToken.value ?? '',
      purchaseId,
      {
        category: category.value,
        method: method.value,
        amountMinor,
        paidAccountCode: paidAccountCode.value === ON_ACCOUNT ? null : paidAccountCode.value,
        note: null,
        description: category.value === 'OTHER' ? description.value.trim() : null,
        manualAllocations:
          method.value === 'MANUAL'
            ? props.purchaseLines.map((line, index) => ({
                purchaseLineId: line.id,
                amountMinor: Math.round((manual.value[index] ?? 0) * 100),
              }))
            : [],
        ...(businessDate.value === '' ? {} : { businessDate: businessDate.value }),
      },
      operationId.value,
    );
    emit('added');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'SAVE_FAILED', message: 'The cost could not be saved. Try again.' };
  } finally {
    busy.value = false;
  }
}

const manualRemainingMinor = computed(
  () =>
    Math.round(amountTaka.value * 100) -
    manual.value.reduce((sum, amount) => sum + Math.round((amount ?? 0) * 100), 0),
);
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Add extra cost — বাড়তি খরচ যোগ করুন"
    :style="{ width: 'min(38rem, 94vw)' }"
  >
    <form class="cost-form" @submit.prevent="save">
      <p class="on-bill">
        Bill <strong>{{ props.purchaseNumber }}</strong>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="grid">
        <div class="field">
          <label for="cost-category">What for <span class="label-bn">কীসের খরচ</span></label>
          <Select
            v-model="category"
            input-id="cost-category"
            :options="categories"
            option-label="label"
            option-value="value"
            append-to="self"
            fluid
          />
        </div>

        <div v-if="category === 'OTHER'" class="field full">
          <label for="cost-description">Description <span class="label-bn">কীসের খরচ</span></label>
          <InputText
            id="cost-description"
            v-model="description"
            maxlength="300"
            placeholder="Required for Other"
            fluid
          />
        </div>

        <div v-if="method === 'MANUAL'" class="manual full">
          <div v-for="(line, index) in purchaseLines" :key="line.id" class="manual-line">
            <label :for="`cost-manual-${line.id}`">{{ line.productName }}</label>
            <InputNumber
              v-model="manual[index]"
              :input-id="`cost-manual-${line.id}`"
              :min="0"
              :min-fraction-digits="2"
              :max-fraction-digits="2"
              fluid
            />
          </div>
          <div class="remaining" :class="{ done: manualRemainingMinor === 0 }">
            Remaining <strong>৳{{ (manualRemainingMinor / 100).toFixed(2) }}</strong>
          </div>
        </div>

        <div class="field">
          <label for="cost-amount">Amount <span class="label-bn">কত টাকা</span></label>
          <AmountInput input-id="cost-amount" v-model="amountTaka" :min="0" placeholder="800" />
        </div>

        <div class="field">
          <label for="cost-method">Spread it <span class="label-bn">কীভাবে ভাগ হবে</span></label>
          <Select
            v-model="method"
            input-id="cost-method"
            :options="methods"
            option-label="label"
            option-value="value"
            append-to="self"
            fluid
          />
        </div>

        <div class="field">
          <label for="cost-account">Paid from <span class="label-bn">কোথা থেকে দিলেন</span></label>
          <Select
            v-model="paidAccountCode"
            input-id="cost-account"
            :options="accountOptions"
            option-label="label"
            option-value="value"
            append-to="self"
            fluid
          />
        </div>

        <div class="field">
          <label for="cost-date">Date <span class="label-bn">তারিখ — ফাঁকা রাখলে আজ</span></label>
          <DateOnlyPicker input-id="cost-date" v-model="businessDate" />
        </div>
      </div>

      <p class="consequence">
        This raises what those goods cost. Anything from this bill that has already been sold has
        its cost corrected today, so the month you are in carries it — an earlier month is never
        rewritten.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy">
          {{ busy ? 'Saving…' : 'Add cost' }}
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

.cost-form {
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

.manual {
  display: grid;
  gap: var(--sher-space-2);
  padding: var(--sher-space-2);
  border: 1px solid var(--sher-border);
  border-radius: var(--sher-radius);
}

.manual-line,
.remaining {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(8rem, 0.6fr);
  align-items: center;
  gap: var(--sher-space-2);
}

.remaining {
  color: var(--sher-danger);
  font-weight: 600;
}

.remaining.done {
  color: var(--sher-success);
}

@media (max-width: 40rem) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.on-bill {
  margin: 0;
  color: var(--sher-text-muted);
}

.consequence {
  margin: 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}
</style>
