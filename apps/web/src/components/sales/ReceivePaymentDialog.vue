<script setup lang="ts">
import type { CustomerStandingResponse, DayStatusResponse, MoneyAccountResponse } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAccounts, fetchDayStatus } from '../../api/money';
import { fetchCustomerStanding, receiveCustomerPayment } from '../../api/sales';
import { useSession } from '../../auth/session';
import ConfirmDialog from '../ConfirmDialog.vue';
import ErrorNotice from '../ErrorNotice.vue';
import { taka } from '../money/money-text';
import StartDayDialog from '../money/StartDayDialog.vue';

/**
 * Receiving money from a customer (§5.8, owner decision 2026-08-25).
 *
 * The same dialog from both entry points: opened from the customer's hub it
 * settles their oldest invoices first, opened from one invoice it settles that
 * one. Both call one service, so both allocate and post identically — the shape
 * that already governs paying a supplier.
 *
 * Every figure moves as the amount is typed: what this settles, what is left
 * owing, and what would be held as an advance.
 */
/** Phase 11: `prefill` opens this on a statement line's figures (§5.17). */
const props = defineProps<{
  partyId: string;
  partyName: string;
  saleId?: string | undefined;
  prefill?: { readonly amountMinor: number; readonly accountId: string } | null;
}>();
const emit = defineEmits<{ close: []; received: [] }>();

const session = useSession();
const clock = new SystemClock();

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const standing = ref<CustomerStandingResponse | null>(null);
const accountId = ref('');
const amount = ref(0);
const note = ref('');
const saving = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const dayStatus = ref<DayStatusResponse | null>(null);
const startingDay = ref(false);

const operationId = ref(Ulid.generate(clock));
const confirming = ref(false);

const invoices = computed(() =>
  props.saleId === undefined
    ? (standing.value?.openInvoices ?? [])
    : (standing.value?.openInvoices ?? []).filter((invoice) => invoice.id === props.saleId),
);

const outstandingMinor = computed(() =>
  invoices.value.reduce((sum, invoice) => sum + invoice.outstandingMinor, 0),
);
const amountMinor = computed(() => Math.round(amount.value * 100));
const settledMinor = computed(() => Math.min(amountMinor.value, outstandingMinor.value));
const advanceMinor = computed(() => Math.max(amountMinor.value - outstandingMinor.value, 0));
const leftMinor = computed(() => Math.max(outstandingMinor.value - amountMinor.value, 0));

/** Oldest first, exactly as the server will allocate it (§5.8). */
const allocation = computed(() => {
  let left = settledMinor.value;
  return invoices.value.map((invoice) => {
    const applied = Math.min(left, invoice.outstandingMinor);
    left -= applied;
    return { ...invoice, applied };
  });
});

const accountOptions = computed(() =>
  accounts.value.map((account) => ({ value: account.id, label: account.name })),
);

const ready = computed(() => amountMinor.value > 0 && accountId.value !== '');

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const [accountPage, standingResponse] = await Promise.all([
      fetchAccounts(token),
      fetchCustomerStanding(token, props.partyId),
    ]);
    accounts.value = accountPage.accounts.filter((account) => account.status === 'ACTIVE');
    standing.value = standingResponse;
    accountId.value = accounts.value.find((account) => account.isDrawer)?.id ?? accounts.value[0]?.id ?? '';
    amount.value = outstandingMinor.value / 100;

    // A statement line says what actually arrived and where; the due is only a
    // guess at it, so the real figure wins when there is one.
    const suggested = props.prefill ?? null;
    if (suggested !== null) {
      amount.value = Math.abs(suggested.amountMinor) / 100;
      accountId.value = suggested.accountId;
    }
  } catch (cause) {
    failure.value = describe(cause, 'Could not open this customer');
  }
}

async function receive(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;
  const account = accounts.value.find((row) => row.id === accountId.value);
  if (account === undefined) return;

  saving.value = true;
  failure.value = null;
  try {
    await receiveCustomerPayment(
      token,
      {
        customerPartyId: props.partyId,
        accountCode: account.type === 'CASH' ? `CASH:${account.id}` : `BANK:${account.id}`,
        amountMinor: amountMinor.value,
        saleIds: props.saleId === undefined ? [] : [props.saleId],
        note: note.value.trim() === '' ? null : note.value.trim(),
      },
      operationId.value,
    );
    emit('received');
  } catch (cause) {
    if (cause instanceof ApiError && cause.details['reason'] === 'CASH_DAY_NOT_STARTED') {
      // The typed amount is untouched; the day is started here and the same
      // receipt is tried again.
      const token_ = session.accessToken.value;
      if (token_ !== null) {
        dayStatus.value = await fetchDayStatus(token_);
        startingDay.value = true;
      }
      return;
    }
    failure.value = describe(cause, 'Could not record this payment');
  } finally {
    saving.value = false;
  }
}

async function onConfirm(): Promise<void> {
  confirming.value = false;
  await receive();
}

async function onDayStarted(): Promise<void> {
  startingDay.value = false;
  await receive();
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}

onMounted(load);
</script>

<template>
  <Dialog visible modal :style="{ width: 'min(34rem, 96vw)' }" header="Receive Payment" @update:visible="emit('close')">
    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <p class="receive__who">
      <strong>{{ partyName }}</strong>
      <span>Outstanding — বাকি {{ taka(outstandingMinor) }}</span>
    </p>

    <label class="field">
      <span>Amount received <small>কত টাকা পেলেন</small></span>
      <InputNumber v-model="amount" :min="0" :max-fraction-digits="2" autofocus />
    </label>

    <label class="field">
      <span>Into which account <small>কোথায় জমা হলো</small></span>
      <Select
        v-model="accountId"
        :options="accountOptions"
        option-label="label"
        option-value="value"
      />
    </label>

    <label class="field">
      <span>Note <small>কিছু লিখতে চাইলে</small></span>
      <InputText v-model="note" />
    </label>

    <ul v-if="allocation.length > 0" class="receive__allocation">
      <li v-for="invoice in allocation" :key="invoice.id">
        <span>{{ invoice.number }} · {{ invoice.businessDate }}</span>
        <span>{{ taka(invoice.outstandingMinor) }}</span>
        <strong>{{ invoice.applied > 0 ? taka(invoice.applied) : '—' }}</strong>
      </li>
    </ul>

    <dl class="receive__totals">
      <div>
        <dt>Settles</dt>
        <dd>{{ taka(settledMinor) }}</dd>
      </div>
      <div>
        <dt>Still owing</dt>
        <dd>{{ taka(leftMinor) }}</dd>
      </div>
      <div v-if="advanceMinor > 0">
        <dt>Held as advance</dt>
        <dd>{{ taka(advanceMinor) }}</dd>
      </div>
    </dl>

    <template #footer>
      <Button label="Cancel" text @click="emit('close')" />
      <Button
        label="Receive"
        :disabled="!ready || saving"
        :loading="saving"
        @click="confirming = true"
      />
    </template>
  </Dialog>

  <ConfirmDialog
    v-if="confirming"
    title="Receive this money?"
    :message="`From ${partyName}. Check the amount below before it is posted.`"
    :amount-minor="amountMinor"
    :facts="[
      { label: 'Settles — মেটাবে', value: taka(settledMinor) },
      { label: 'Still owing — বাকি', value: taka(leftMinor) },
      ...(advanceMinor > 0 ? [{ label: 'Advance — জমা', value: taka(advanceMinor) }] : []),
    ]"
    confirm-label="Receive"
    confirm-label-bn="টাকা জমা নিন"
    :busy="saving"
    @cancel="confirming = false"
    @confirm="onConfirm"
  />

  <StartDayDialog
    v-if="startingDay && dayStatus"
    :status="dayStatus"
    @close="startingDay = false"
    @started="onDayStarted"
  />
</template>

<style scoped>
.receive__who {
  display: flex;
  justify-content: space-between;
  margin: 0 0 0.5rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}

.field small {
  opacity: 0.7;
}

.receive__allocation {
  list-style: none;
  margin: 0.5rem 0;
  padding: 0;
  font-size: 0.8rem;
}

.receive__allocation li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.5rem;
  padding: 0.15rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}

.receive__totals {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.receive__totals > div {
  display: flex;
  justify-content: space-between;
}

.receive__totals dd {
  margin: 0;
  font-weight: 600;
}
</style>
