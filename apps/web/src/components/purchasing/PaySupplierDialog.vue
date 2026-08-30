<script setup lang="ts">
import type { DayStatusResponse, MoneyAccountResponse, SupplierDueResponse } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAccounts, fetchDayStatus } from '../../api/money';
import { fetchSupplierDue, paySupplier } from '../../api/purchasing';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import { MONEY_BN, parseTaka, taka } from '../money/money-text';
import StartDayDialog from '../money/StartDayDialog.vue';

/**
 * Paying a supplier (§5.9) — a short form, so a dialog (UI-50).
 *
 * **One dialog, two entry points** (owner decision 2026-08-24). `Pay Supplier`
 * on the supplier's page opens it with no bill named and settles their oldest
 * bills first; `Pay this bill` on a purchase opens the same dialog with
 * `purchaseId` set. Both post through the one payment use case, so the ledger
 * cannot tell them apart — which is the point.
 */
const props = defineProps<{
  supplierId: string;
  supplierName: string;
  /** Set by "Pay this bill"; absent settles the oldest bills first. */
  purchaseId?: string | null;
  purchaseNumber?: string | null;
  /** Phase 11: figures read off a bank statement line (§5.17). */
  prefill?: { readonly amountMinor: number; readonly accountId: string; readonly businessDate: string } | null;
}>();

const emit = defineEmits<{ (event: 'paid'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();

const due = ref<SupplierDueResponse | null>(null);
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

const bills = computed(() =>
  props.purchaseId == null
    ? (due.value?.bills ?? [])
    : (due.value?.bills ?? []).filter((bill) => bill.id === props.purchaseId),
);

/** What this payment may be at most: the whole debt, or one bill's own share. */
const payableMinor = computed(() =>
  bills.value.reduce((sum, bill) => sum + bill.dueMinor, 0),
);

const accountOptions = computed(() =>
  accounts.value.map((account) => ({
    id: account.id,
    code: account.type === 'CASH' ? `CASH:${account.id}` : `BANK:${account.id}`,
    label: account.isDrawer ? `${account.name} (drawer)` : account.name,
  })),
);

const amountMinor = computed(() => parseTaka(amount.value) ?? 0);
const ready = computed(
  () =>
    amountMinor.value > 0 && amountMinor.value <= payableMinor.value && accountId.value !== '',
);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  try {
    const [dueResponse, accountPage] = await Promise.all([
      fetchSupplierDue(token, props.supplierId),
      fetchAccounts(token),
    ]);
    due.value = dueResponse;
    accounts.value = accountPage.accounts.filter((account) => account.status === 'ACTIVE');
    const drawer = accounts.value.find((account) => account.isDrawer);
    if (drawer !== undefined) accountId.value = drawer.id;
    // Pre-filled with what is actually owed: the commonest payment is the
    // whole of it, and the shopkeeper types over it when it is not.
    amount.value = payableMinor.value === 0 ? '' : String(payableMinor.value / 100);

    // Opened from a bank statement line, the amount and the account are known
    // exactly — the bank has already told us what left and from where.
    const suggested = props.prefill ?? null;
    if (suggested !== null) {
      amount.value = String(Math.abs(suggested.amountMinor) / 100);
      accountId.value = suggested.accountId;
      businessDate.value = suggested.businessDate;
    }
  } catch (cause) {
    failure.value = describe(cause, 'Could not open this supplier');
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
    await paySupplier(
      token,
      {
        supplierPartyId: props.supplierId,
        amountMinor: amountMinor.value,
        accountCode:
          accountOptions.value.find((option) => option.id === accountId.value)?.code ?? '',
        businessDate: businessDate.value,
        note: note.value.trim() === '' ? null : note.value.trim(),
        purchaseId: props.purchaseId ?? null,
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
    :header="`Pay ${supplierName} — টাকা পরিশোধ`"
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
        <span>
          {{ purchaseNumber == null ? 'Owed to this supplier' : `Owed on ${purchaseNumber}` }}
          <span class="label-bn">দিতে হবে</span>
        </span>
        <strong>{{ taka(payableMinor) }}</strong>
      </p>

      <p v-if="payableMinor === 0" class="notice is-ok">
        Nothing is owed right now — there is no payment to record.
      </p>

      <template v-else>
        <div class="two-column">
          <div class="field">
            <label for="pay-amount">
              Amount <span class="label-bn">{{ MONEY_BN.amount }}</span>
            </label>
            <InputText id="pay-amount" v-model="amount" inputmode="decimal" fluid />
          </div>

          <div class="field">
            <label for="pay-account">
              Paid from <span class="label-bn">কোথা থেকে দিলেন</span>
            </label>
            <Select
              input-id="pay-account"
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
            <label for="pay-date">Date <span class="label-bn">তারিখ</span></label>
            <DateOnlyPicker v-model="businessDate" input-id="pay-date" />
          </div>

          <div class="field">
            <label for="pay-note">
              Note <span class="label-bn">{{ MONEY_BN.note }}</span>
            </label>
            <InputText id="pay-note" v-model="note" maxlength="500" fluid />
          </div>
        </div>

        <!--
          Which bills this settles, shown before it is paid. Oldest first is the
          rule, and a shopkeeper handing over money should be able to see which
          of the supplier's bills it clears.
        -->
        <ul v-if="bills.length > 0" class="bills">
          <li v-for="bill in bills" :key="bill.id">
            <span>
              {{ bill.number }}
              <span class="muted">{{ bill.businessDate }}</span>
            </span>
            <span :class="{ overdue: bill.overdue }">{{ taka(bill.dueMinor) }}</span>
          </li>
        </ul>
      </template>
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

.bills {
  margin: var(--sher-space-3, 12px) 0 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.bills li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--sher-border, #e3e8ee);
}

.bills .muted {
  margin-left: 6px;
  color: var(--sher-text-muted);
}

.overdue {
  color: var(--sher-danger, #dc2626);
  font-weight: 600;
}

.day-action {
  margin-top: 8px;
}
</style>
