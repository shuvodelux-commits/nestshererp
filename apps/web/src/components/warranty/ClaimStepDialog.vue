<script setup lang="ts">
import type {
  ClaimSettlementValue,
  ClaimStatusValue,
  SerialUnitResponse,
  WarrantyClaimResponse,
} from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAvailableSerials, moveWarrantyClaim } from '../../api/warranty';
import { useSession } from '../../auth/session';
import AmountInput from '../fields/AmountInput.vue';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * One step along a claim (§5.19, owner simplification 2026-08-26).
 *
 * **One dialog, not six.** Every step is the same shape — a decision and at most
 * two fields — so the shopkeeper learns it once. Which fields appear follows
 * from the step: only `Settled` asks how, only a replacement asks which unit,
 * and only a cash settlement asks for an amount. Fields that cannot apply are
 * hidden rather than shown empty.
 */
const props = defineProps<{
  claim: WarrantyClaimResponse | null;
  status: ClaimStatusValue | null;
  /** Where a supplier's cash settlement lands, when it is cash at all. */
  accounts: readonly { readonly code: string; readonly name: string }[];
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'moved'): void }>();

const session = useSession();
const clock = new SystemClock();

const settlements: Array<{ label: string; value: ClaimSettlementValue }> = [
  { label: 'Replaced — বদলে দেওয়া হয়েছে', value: 'REPLACED' },
  { label: 'Repaired — সারিয়ে দেওয়া হয়েছে', value: 'REPAIRED' },
  { label: 'Money or account adjusted — টাকা ফেরত', value: 'ADJUSTED' },
  { label: 'Refused — সাপ্লায়ার মানেনি', value: 'REJECTED' },
];

const titles: Record<string, string> = {
  CHECKING: 'Start checking — দেখা শুরু করুন',
  SENT_TO_SUPPLIER: 'Send to supplier — সাপ্লায়ারের কাছে পাঠান',
  SETTLED: 'Settle this claim — মীমাংসা করুন',
  RETURNED_TO_CUSTOMER: 'Give it back — কাস্টমারকে ফেরত দিন',
  CLOSED: 'Close this claim — শেষ করুন',
};

const settlement = ref<ClaimSettlementValue>('REPLACED');
const replacementUnitId = ref<string | null>(null);
const recoveryTaka = ref(0);
/** See the planner: a `null` option value cannot be matched, so it draws blank. */
const ON_ACCOUNT = 'ON_ACCOUNT';
const recoveryAccountCode = ref<string>(ON_ACCOUNT);
const note = ref('');
const businessDate = ref('');
const units = ref<readonly SerialUnitResponse[]>([]);
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const visible = computed({
  get: () => props.claim !== null && props.status !== null,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const asksSettlement = computed(() => props.status === 'SETTLED');
const asksReplacement = computed(
  () => asksSettlement.value && settlement.value === 'REPLACED',
);
const asksMoney = computed(() => asksSettlement.value && settlement.value === 'ADJUSTED');

const unitOptions = computed(() =>
  units.value.map((unit) => ({ label: unit.serialNo, value: unit.id })),
);
const accountOptions = computed(() => [
  { label: "Against the supplier's account — সাপ্লায়ারের খাতায়", value: ON_ACCOUNT },
  ...props.accounts.map((account) => ({ label: account.name, value: account.code })),
]);

watch(
  () => [props.claim?.id, props.status],
  async () => {
    settlement.value = 'REPLACED';
    replacementUnitId.value = null;
    recoveryTaka.value = 0;
    recoveryAccountCode.value = ON_ACCOUNT;
    note.value = '';
    businessDate.value = '';
    error.value = null;
    operationId.value = Ulid.generate(clock);

    // Only fetched when a replacement is a possible answer; a claim being
    // closed has no use for a list of what is on the shelf.
    if (props.claim === null || props.status !== 'SETTLED') return;
    try {
      const response = await fetchAvailableSerials(
        session.accessToken.value ?? '',
        props.claim.productId,
      );
      units.value = response.data;
    } catch {
      units.value = [];
    }
  },
);

async function save(): Promise<void> {
  const claim = props.claim;
  const status = props.status;
  if (claim === null || status === null) return;

  if (asksMoney.value && recoveryTaka.value <= 0) {
    error.value = { code: 'VALIDATION_FAILED', message: 'Say how much the supplier credited' };
    return;
  }

  busy.value = true;
  error.value = null;
  try {
    await moveWarrantyClaim(
      session.accessToken.value ?? '',
      claim.id,
      {
        status,
        settlement: asksSettlement.value ? settlement.value : null,
        note: note.value.trim() === '' ? null : note.value.trim(),
        replacementUnitId: asksReplacement.value ? replacementUnitId.value : null,
        recoveryMinor: asksMoney.value ? Math.round(recoveryTaka.value * 100) : null,
        recoveryAccountCode:
          asksMoney.value && recoveryAccountCode.value !== ON_ACCOUNT
            ? recoveryAccountCode.value
            : null,
        ...(businessDate.value === '' ? {} : { businessDate: businessDate.value }),
        version: claim.version,
      },
      operationId.value,
    );
    emit('moved');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'SAVE_FAILED', message: 'The claim could not be updated. Try again.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="titles[props.status ?? ''] ?? 'Update claim'"
    :style="{ width: 'min(38rem, 94vw)' }"
  >
    <form v-if="props.claim !== null" class="step-form" @submit.prevent="save">
      <p class="on-claim">
        <strong>{{ props.claim.displayName }}</strong>
        <span>
          {{ props.claim.claimNumber }} · {{ props.claim.customerName }}
          {{ props.claim.serialNo === null ? '' : `· ${props.claim.serialNo}` }}
        </span>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div v-if="asksSettlement" class="field">
        <label for="cs-settlement">How was it settled <span class="label-bn">কীভাবে মীমাংসা হলো</span></label>
        <Select
          v-model="settlement"
          input-id="cs-settlement"
          :options="settlements"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
        />
      </div>

      <div v-if="asksReplacement" class="field">
        <label for="cs-unit">
          Give this unit from stock <span class="label-bn">দোকানের কোন মালটি দিচ্ছেন</span>
        </label>
        <Select
          v-model="replacementUnitId"
          input-id="cs-unit"
          :options="unitOptions"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
          placeholder="Leave empty if the supplier sent the replacement"
        />
        <p class="hint">
          Choosing one takes it off your shelf and charges its cost to warranty expense.
        </p>
      </div>

      <div v-if="asksMoney" class="grid">
        <div class="field">
          <label for="cs-amount">Supplier credited <span class="label-bn">কত টাকা</span></label>
          <AmountInput input-id="cs-amount" v-model="recoveryTaka" :min="0" placeholder="1200" />
        </div>
        <div class="field">
          <label for="cs-account">Into <span class="label-bn">কোথায় এলো</span></label>
          <Select
            v-model="recoveryAccountCode"
            input-id="cs-account"
            :options="accountOptions"
            option-label="label"
            option-value="value"
            append-to="self"
            fluid
          />
        </div>
      </div>

      <div class="field">
        <label for="cs-note">Note <span class="label-bn">মন্তব্য — ঐচ্ছিক</span></label>
        <input id="cs-note" v-model="note" autocomplete="off" placeholder="Optional" />
      </div>

      <div class="field">
        <label for="cs-date">Date <span class="label-bn">তারিখ — ফাঁকা রাখলে আজ</span></label>
        <DateOnlyPicker input-id="cs-date" v-model="businessDate" />
      </div>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy">
          {{ busy ? 'Saving…' : 'Save' }}
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

.step-form {
  display: grid;
  gap: var(--sher-space-3);
}

.on-claim {
  margin: 0;
  display: grid;
  gap: 2px;
}

.on-claim span {
  color: var(--sher-text-muted);
  font-size: 0.85rem;
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

.hint {
  margin: 4px 0 0;
  font-size: 0.8rem;
  color: var(--sher-text-muted);
}
</style>
