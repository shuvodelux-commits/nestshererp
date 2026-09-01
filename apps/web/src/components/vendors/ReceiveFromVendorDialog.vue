<script setup lang="ts">
import type { MoneyAccountResponse, VendorReceiptIntent } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAccounts } from '../../api/money';
import { receiveFromVendor } from '../../api/vendors';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import { MONEY_BN, parseTaka, taka } from '../money/money-text';

/**
 * Money in from a vendor (§5.6 M07, owner decision 2026-08-31).
 *
 * Two different things wear the same words at a counter. **Settling a
 * receivable** is the vendor paying for goods the shop charged to them — an
 * ordinary credit sale, so the money goes through the ordinary customer receipt
 * and settles their oldest invoices first. **Refunding an advance** is the shop
 * getting back money it had paid ahead. Each is capped by its own balance,
 * because paying past either one would be a different transaction entirely.
 */
const props = defineProps<{
  vendorId: string;
  vendorName: string;
  receivableMinor: number;
  advancePaidMinor: number;
}>();

const emit = defineEmits<{ (event: 'received'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();

const intent = ref<VendorReceiptIntent>(
  props.receivableMinor > 0 ? 'SETTLE_RECEIVABLE' : 'REFUND_ADVANCE',
);
const accounts = ref<readonly MoneyAccountResponse[]>([]);
const amount = ref('');
const accountId = ref('');
const businessDate = ref(clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone));
const note = ref('');
const loading = ref(true);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const operationId = ref(Ulid.generate(clock));

const intentOptions = [
  { value: 'SETTLE_RECEIVABLE' as const, label: 'Settle receivable — পাওনা আদায়' },
  { value: 'REFUND_ADVANCE' as const, label: 'Refund of advance — অগ্রিম ফেরত' },
];

const accountOptions = computed(() =>
  accounts.value.map((account) => ({
    id: account.id,
    code: account.type === 'CASH' ? `CASH:${account.id}` : `BANK:${account.id}`,
    label: account.isDrawer ? `${account.name} (drawer)` : account.name,
  })),
);

/** What this intent may take at most — the two balances never mix. */
const ceilingMinor = computed(() =>
  intent.value === 'SETTLE_RECEIVABLE' ? props.receivableMinor : props.advancePaidMinor,
);
const amountMinor = computed(() => parseTaka(amount.value) ?? 0);
const overCeiling = computed(() => amountMinor.value > ceilingMinor.value);
const ready = computed(
  () => amountMinor.value > 0 && accountId.value !== '' && !overCeiling.value,
);

watch(intent, () => {
  amount.value = ceilingMinor.value > 0 ? String(ceilingMinor.value / 100) : '';
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
    if (ceilingMinor.value > 0) amount.value = String(ceilingMinor.value / 100);
  } catch (cause) {
    failure.value = describe(cause, 'Could not open the accounts');
  } finally {
    loading.value = false;
  }
}

async function receive(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;

  busy.value = true;
  failure.value = null;
  try {
    await receiveFromVendor(
      token,
      {
        vendorPartyId: props.vendorId,
        intent: intent.value,
        amountMinor: amountMinor.value,
        accountCode:
          accountOptions.value.find((option) => option.id === accountId.value)?.code ?? '',
        /* Empty settles their oldest invoices first, exactly as the customer
         * receipt dialog does — this screen picks no invoices of its own. */
        saleIds: [],
        businessDate: businessDate.value,
        note: note.value.trim() === '' ? null : note.value.trim(),
      },
      operationId.value,
    );
    emit('received');
  } catch (cause) {
    failure.value = describe(cause, 'Could not record this receipt');
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
    :header="`Receive from ${vendorName} — ভেন্ডরের কাছ থেকে টাকা নিন`"
    :style="{ width: 'min(34rem, 96vw)' }"
    @update:visible="emit('close')"
  >
    <div v-if="loading" class="skeleton skeleton-form" aria-busy="true" aria-label="Loading" />

    <template v-else>
      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <div class="balances">
        <p>
          <span>They owe you <span class="label-bn">পাবো</span></span>
          <strong>{{ taka(receivableMinor) }}</strong>
        </p>
        <p>
          <span>Advance with them <span class="label-bn">অগ্রিম দেওয়া</span></span>
          <strong>{{ taka(advancePaidMinor) }}</strong>
        </p>
      </div>

      <div class="two-column">
        <div class="field">
          <label for="vendor-receive-intent">
            This money is <span class="label-bn">কী বাবদ</span>
          </label>
          <Select
            input-id="vendor-receive-intent"
            v-model="intent"
            :options="intentOptions"
            option-label="label"
            option-value="value"
            append-to="body"
            fluid
          />
        </div>

        <div class="field">
          <label for="vendor-receive-amount">
            Amount <span class="label-bn">{{ MONEY_BN.amount }}</span>
          </label>
          <InputText id="vendor-receive-amount" v-model="amount" inputmode="decimal" fluid />
        </div>

        <div class="field">
          <label for="vendor-receive-account">
            Received into <span class="label-bn">কোথায় জমা</span>
          </label>
          <Select
            input-id="vendor-receive-account"
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
          <label for="vendor-receive-date">Date <span class="label-bn">তারিখ</span></label>
          <DateOnlyPicker v-model="businessDate" input-id="vendor-receive-date" />
        </div>

        <div class="field">
          <label for="vendor-receive-note">
            Note <span class="label-bn">{{ MONEY_BN.note }}</span>
          </label>
          <InputText id="vendor-receive-note" v-model="note" maxlength="300" fluid />
        </div>
      </div>

      <p v-if="ceilingMinor === 0" class="notice is-warn">
        {{
          intent === 'SETTLE_RECEIVABLE'
            ? 'This vendor owes nothing right now.'
            : 'This vendor is holding no advance to give back.'
        }}
      </p>
      <p v-else-if="overCeiling" class="notice is-warn">
        That is more than the {{ taka(ceilingMinor) }} this covers.
      </p>
      <p v-else-if="intent === 'SETTLE_RECEIVABLE'" class="notice is-ok">
        Recorded as a customer receipt against their oldest invoices first.
        <span class="label-bn">পুরনো বিল আগে</span>
      </p>
    </template>

    <template #footer>
      <Button :label="MONEY_BN.cancel" text @click="emit('close')" />
      <Button
        icon="pi pi-check"
        :label="`Receive ${taka(amountMinor)}`"
        :disabled="!ready"
        :loading="busy"
        @click="receive"
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

.balances {
  margin: 0 0 var(--sher-space-3, 12px);
}

.balances p {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 4px;
  font-size: 15px;
}
</style>
