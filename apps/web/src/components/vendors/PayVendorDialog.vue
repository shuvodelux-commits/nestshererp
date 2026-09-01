<script setup lang="ts">
import type {
  DayStatusResponse,
  MoneyAccountResponse,
  VendorPaymentIntent,
} from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAccounts, fetchDayStatus } from '../../api/money';
import { payVendor } from '../../api/vendors';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import { MONEY_BN, parseTaka, taka } from '../money/money-text';
import StartDayDialog from '../money/StartDayDialog.vue';

/**
 * Money out to a vendor (§5.6 M07, owner decision 2026-08-31).
 *
 * **The intent is a choice, not a guess.** Settling the payable clears what
 * selling their consignment goods made the shop owe; an advance is money paid
 * before any of it sold. The ledger cannot tell the two apart afterwards, so
 * the shopkeeper says which it is — and the cap moves with the answer: a
 * settlement can never exceed what is owed, while an advance has nothing to
 * exceed.
 */
const props = defineProps<{
  vendorId: string;
  vendorName: string;
  payableMinor: number;
}>();

const emit = defineEmits<{ (event: 'paid'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();

const intent = ref<VendorPaymentIntent>(props.payableMinor > 0 ? 'SETTLE_PAYABLE' : 'ADVANCE');
const accounts = ref<readonly MoneyAccountResponse[]>([]);
const amount = ref('');
const accountId = ref('');
const businessDate = ref(clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone));
const note = ref('');
const loading = ref(true);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const dayStatus = ref<DayStatusResponse | null>(null);
const startingDay = ref(false);
const dayBlocked = ref(false);

/** One key per payment, reused on retry, so two taps pay once (UI-34). */
const operationId = ref(Ulid.generate(clock));

const intentOptions = [
  { value: 'SETTLE_PAYABLE' as const, label: 'Settle payable — বকেয়া পরিশোধ' },
  { value: 'ADVANCE' as const, label: 'Advance payment — অগ্রিম' },
];

const accountOptions = computed(() =>
  accounts.value.map((account) => ({
    id: account.id,
    code: account.type === 'CASH' ? `CASH:${account.id}` : `BANK:${account.id}`,
    label: account.isDrawer ? `${account.name} (drawer)` : account.name,
  })),
);

const amountMinor = computed(() => parseTaka(amount.value) ?? 0);
const settling = computed(() => intent.value === 'SETTLE_PAYABLE');
const overPayable = computed(() => settling.value && amountMinor.value > props.payableMinor);
const ready = computed(
  () => amountMinor.value > 0 && accountId.value !== '' && !overPayable.value,
);

/* Instant recalculation: switching to a settlement proposes the whole debt,
 * which is the commonest payment, and an advance starts from nothing. */
watch(intent, (next) => {
  amount.value =
    next === 'SETTLE_PAYABLE' && props.payableMinor > 0 ? String(props.payableMinor / 100) : '';
});

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  try {
    const accountPage = await fetchAccounts(token);
    accounts.value = accountPage.accounts.filter((account) => account.status === 'ACTIVE');
    const drawer = accounts.value.find((account) => account.isDrawer);
    if (drawer !== undefined) accountId.value = drawer.id;
    if (settling.value && props.payableMinor > 0) {
      amount.value = String(props.payableMinor / 100);
    }
  } catch (cause) {
    failure.value = describe(cause, 'Could not open the accounts');
  } finally {
    loading.value = false;
  }
}

async function offerStartDay(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    dayStatus.value = await fetchDayStatus(token);
    startingDay.value = true;
  } catch (cause) {
    failure.value = describe(cause, 'Could not open the day');
  }
}

async function onDayStarted(): Promise<void> {
  startingDay.value = false;
  dayBlocked.value = false;
  await pay();
}

async function pay(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;

  busy.value = true;
  failure.value = null;
  try {
    await payVendor(
      token,
      {
        vendorPartyId: props.vendorId,
        intent: intent.value,
        amountMinor: amountMinor.value,
        accountCode:
          accountOptions.value.find((option) => option.id === accountId.value)?.code ?? '',
        businessDate: businessDate.value,
        note: note.value.trim() === '' ? null : note.value.trim(),
      },
      operationId.value,
    );
    emit('paid');
  } catch (cause) {
    dayBlocked.value =
      cause instanceof ApiError && cause.details['reason'] === 'CASH_DAY_NOT_STARTED';
    failure.value = describe(cause, 'Could not record this payment');
  } finally {
    busy.value = false;
  }
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNKNOWN', message: fallback };
}

onMounted(load);
</script>

<template>
  <Dialog
    visible
    modal
    :header="`Pay ${vendorName} — ভেন্ডরকে টাকা দিন`"
    :style="{ width: 'min(34rem, 96vw)' }"
    @update:visible="emit('close')"
  >
    <div v-if="loading" class="skeleton skeleton-form" aria-busy="true" aria-label="Loading" />

    <template v-else>
      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <div v-if="dayBlocked" class="callout is-warn">
        <i class="pi pi-exclamation-triangle callout-icon" aria-hidden="true" />
        <div class="callout-body">
          <span class="callout-title">{{ MONEY_BN.dayNotStarted }}</span>
          <p>Cash cannot leave the drawer until the day is started.</p>
          <div class="day-action">
            <Button icon="pi pi-play" :label="MONEY_BN.startDay" @click="offerStartDay" />
          </div>
        </div>
      </div>

      <p class="owed">
        <span>Owed to this vendor <span class="label-bn">দিতে হবে</span></span>
        <strong>{{ taka(payableMinor) }}</strong>
      </p>

      <div class="two-column">
        <div class="field">
          <label for="vendor-pay-intent">
            This payment is <span class="label-bn">কী বাবদ</span>
          </label>
          <Select
            input-id="vendor-pay-intent"
            v-model="intent"
            :options="intentOptions"
            option-label="label"
            option-value="value"
            append-to="body"
            fluid
          />
        </div>

        <div class="field">
          <label for="vendor-pay-amount">
            Amount <span class="label-bn">{{ MONEY_BN.amount }}</span>
          </label>
          <InputText id="vendor-pay-amount" v-model="amount" inputmode="decimal" fluid />
        </div>

        <div class="field">
          <label for="vendor-pay-account">
            Paid from <span class="label-bn">কোথা থেকে দিলেন</span>
          </label>
          <Select
            input-id="vendor-pay-account"
            v-model="accountId"
            :options="accountOptions"
            option-label="label"
            option-value="id"
            placeholder="Choose an account"
            append-to="body"
            fluid
          />
        </div>

        <div class="field">
          <label for="vendor-pay-date">Date <span class="label-bn">তারিখ</span></label>
          <DateOnlyPicker v-model="businessDate" input-id="vendor-pay-date" />
        </div>

        <div class="field">
          <label for="vendor-pay-note">
            Note <span class="label-bn">{{ MONEY_BN.note }}</span>
          </label>
          <InputText id="vendor-pay-note" v-model="note" maxlength="300" fluid />
        </div>
      </div>

      <p v-if="overPayable" class="notice is-warn">
        That is more than the {{ taka(payableMinor) }} this vendor is owed — record the extra as
        an advance instead.
      </p>
      <p v-else-if="!settling" class="notice is-ok">
        This money will sit as an advance with the vendor until their goods sell.
        <span class="label-bn">অগ্রিম হিসেবে জমা থাকবে</span>
      </p>
    </template>

    <template #footer>
      <Button :label="MONEY_BN.cancel" text @click="emit('close')" />
      <Button
        icon="pi pi-check"
        :label="`Pay ${taka(amountMinor)}`"
        :disabled="!ready"
        :loading="busy"
        @click="pay"
      />
    </template>

    <StartDayDialog
      v-if="startingDay && dayStatus !== null"
      :status="dayStatus"
      @started="onDayStarted"
      @close="startingDay = false"
    />
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

.owed {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 var(--sher-space-3, 12px);
  font-size: 16px;
}

.day-action {
  margin-top: 8px;
}
</style>
