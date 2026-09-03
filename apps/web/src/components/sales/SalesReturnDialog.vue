<script setup lang="ts">
import type {
  DayStatusResponse,
  MoneyAccountResponse,
  ReturnReason,
  ReturnableInvoiceResponse,
} from '@sher/core-contracts';
import { salesReturnTotals } from '@sher/core-domain';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAccounts, fetchDayStatus } from '../../api/money';
import { createSalesReturn, fetchReturnableInvoice } from '../../api/returns';
import { useSession } from '../../auth/session';
import ConfirmDialog from '../ConfirmDialog.vue';
import ErrorNotice from '../ErrorNotice.vue';
import AmountInput from '../fields/AmountInput.vue';
import { taka } from '../money/money-text';
import StartDayDialog from '../money/StartDayDialog.vue';

/**
 * Goods coming back from a customer (§5.11, owner decisions 2026-08-26).
 *
 * **One task, one modal** (owner rule, binding): the lines of this invoice, how
 * many of each are coming back, why, and what happens to the money. Nothing
 * else is on the screen.
 *
 * Every figure moves as a quantity is typed, because the modal runs
 * `salesReturnTotals` — **the same domain function the server runs** on the
 * invoice's own rows when it posts. Two implementations of one rounding rule is
 * how a poisha goes missing.
 *
 * Damage is deliberately absent: the shop accepts what it takes back, and goods
 * later found unsellable are written off through Stock Adjustment, which the
 * shopkeeper already knows.
 */
const props = defineProps<{ saleId: string }>();
const emit = defineEmits<{ close: []; returned: [] }>();

const session = useSession();
const clock = new SystemClock();

const invoice = ref<ReturnableInvoiceResponse | null>(null);
const accounts = ref<readonly MoneyAccountResponse[]>([]);
/** Quantity coming back per sale line, keyed by line id. Scale 3, as sold. */
const quantities = ref<Record<string, number>>({});
const selectedSerials = ref<Record<string, string[]>>({});
const reason = ref<ReturnReason>('CHANGED_MIND');
const note = ref('');
const settlement = ref<'REFUND' | 'CREDIT'>('CREDIT');
const refund = ref(0);
const accountId = ref('');
const approvalPin = ref('');
/*
 * A guest sale created nobody (§5.8). Credit left on account is a balance, so
 * it needs a customer — prefilled with what the counter was told when the sale
 * was made, which is usually already right.
 */
const customerName = ref('');
const customerPhone = ref('');
const askingPin = ref(false);
const saving = ref(false);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);
const dayStatus = ref<DayStatusResponse | null>(null);
const startingDay = ref(false);
const confirming = ref(false);

const operationId = ref(Ulid.generate(clock));

const REASONS: { value: ReturnReason; label: string }[] = [
  { value: 'DAMAGED', label: 'Damaged — নষ্ট' },
  { value: 'WRONG_ITEM', label: 'Wrong item — ভুল পণ্য' },
  { value: 'CHANGED_MIND', label: 'Changed mind — নেবে না' },
  { value: 'EXTRA_QUANTITY', label: 'Extra quantity — বেশি হয়েছে' },
  { value: 'OTHER', label: 'Other — অন্য কারণ' },
];

/** Only lines with an unrestored durable origin remain returnable. */
const returnableLines = computed(() =>
  (invoice.value?.lines ?? []).filter((line) => line.returnable && line.qtyReturnable > 0),
);

const soldLines = computed(() =>
  returnableLines.value.map((line) => ({
    saleLineId: line.saleLineId,
    productId: line.productId,
    qtySold: line.qtySold,
    qtyReturned: line.qtyReturned,
    netAmountMinor: line.netAmountMinor,
    // The modal never shows cost and never needs it: zero here changes no
    // figure on this screen, and the server reads the real cost from the lots.
    costMinor: 0,
  })),
);

const draftLines = computed(() =>
  returnableLines.value
    .map((line) => ({
      saleLineId: line.saleLineId,
      qty: line.tracksSerial
        ? (selectedSerials.value[line.saleLineId]?.length ?? 0) * 1000
        : Math.round((quantities.value[line.saleLineId] ?? 0) * 1000),
      serialUnitIds: selectedSerials.value[line.saleLineId] ?? [],
    }))
    .filter((line) => line.qty > 0),
);

/**
 * The return as it stands, run through the domain. `null` while nothing is
 * ticked — the function refuses an empty return, which is correct and is not an
 * error to show anybody.
 */
const totals = computed(() => {
  if (draftLines.value.length === 0) return null;
  try {
    return salesReturnTotals(
      { lines: draftLines.value, refundMinor: refundMinor.value },
      soldLines.value,
    );
  } catch {
    return null;
  }
});

const returnValueMinor = computed(() => totals.value?.returnValueMinor ?? 0);
const refundMinor = computed(() =>
  settlement.value === 'CREDIT' ? 0 : Math.round(refund.value * 100),
);
const creditMinor = computed(() => Math.max(returnValueMinor.value - refundMinor.value, 0));
const settlesMinor = computed(() =>
  Math.min(creditMinor.value, Math.max(invoice.value?.dueMinor ?? 0, 0)),
);
const advanceMinor = computed(() => creditMinor.value - settlesMinor.value);

/** What this person may still hand back today, before a PIN is needed. */
const overLimit = computed(() => {
  const limit = invoice.value?.refundLimit;
  if (limit === undefined || refundMinor.value === 0) return false;
  const overPerReturn =
    limit.perReturnMinor !== null && refundMinor.value > limit.perReturnMinor;
  const overPerDay =
    limit.perDayMinor !== null && limit.usedTodayMinor + refundMinor.value > limit.perDayMinor;
  return overPerReturn || overPerDay;
});

/** Only a guest sale keeping money on account has to name anybody. */
const needsCustomer = computed(
  () => invoice.value?.isWalkIn === true && creditMinor.value > 0,
);

const accountOptions = computed(() =>
  accounts.value.map((account) => ({ value: account.id, label: account.name })),
);

const ready = computed(
  () =>
    returnValueMinor.value > 0 &&
    refundMinor.value <= returnValueMinor.value &&
    (refundMinor.value === 0 || accountId.value !== '') &&
    (!needsCustomer.value ||
      (customerName.value.trim() !== '' && customerPhone.value.trim() !== '')),
);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const [returnable, accountPage] = await Promise.all([
      fetchReturnableInvoice(token, props.saleId),
      fetchAccounts(token),
    ]);
    invoice.value = returnable;
    customerName.value = returnable.isWalkIn ? returnable.customerName : '';
    customerPhone.value = returnable.customerPhone ?? '';
    accounts.value = accountPage.accounts.filter((account) => account.status === 'ACTIVE');
    accountId.value =
      accounts.value.find((account) => account.isDrawer)?.id ?? accounts.value[0]?.id ?? '';
    quantities.value = Object.fromEntries(
      returnable.lines.map((line) => [line.saleLineId, 0]),
    );
    selectedSerials.value = Object.fromEntries(
      returnable.lines.map((line) => [line.saleLineId, []]),
    );
  } catch (cause) {
    failure.value = describe(cause, 'Could not open this invoice');
  } finally {
    loading.value = false;
  }
}

/** The whole of a line, in one tap — the common case at a counter. */
function takeAll(saleLineId: string, qtyReturnable: number): void {
  const line = returnableLines.value.find((candidate) => candidate.saleLineId === saleLineId);
  if (line?.tracksSerial) {
    selectedSerials.value = {
      ...selectedSerials.value,
      [saleLineId]: line.serials.map((serial) => serial.id),
    };
    return;
  }
  quantities.value = { ...quantities.value, [saleLineId]: qtyReturnable / 1000 };
}

function chooseRefund(): void {
  settlement.value = 'REFUND';
  // Defaults to the whole value: a customer handing goods back expects all of
  // it, and typing less is the exception.
  refund.value = returnValueMinor.value / 100;
}

async function submit(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;
  const account = accounts.value.find((row) => row.id === accountId.value);

  saving.value = true;
  failure.value = null;
  try {
    await createSalesReturn(
      token,
      {
        saleId: props.saleId,
        lines: draftLines.value.map((line) => ({
          sourceLineId: line.saleLineId,
          qty: line.qty,
          serialUnitIds: line.serialUnitIds,
        })),
        reason: reason.value,
        note: note.value.trim() === '' ? null : note.value.trim(),
        refundMinor: refundMinor.value,
        refundAccountCode:
          refundMinor.value === 0 || account === undefined
            ? null
            : account.type === 'CASH'
              ? `CASH:${account.id}`
              : `BANK:${account.id}`,
        approvalPin: approvalPin.value === '' ? null : approvalPin.value,
        customerName: customerName.value.trim() === '' ? null : customerName.value.trim(),
        customerPhone: customerPhone.value.trim() === '' ? null : customerPhone.value.trim(),
        customerAddress: null,
        customerGuardianName: null,
        // Today, always: backdating a return has its own screen and its own
        // permission, and the counter modal deliberately does not carry one.
        backdateReason: null,
      },
      operationId.value,
    );
    emit('returned');
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'APPROVAL_REQUIRED') {
      // Nothing typed is lost: the PIN box opens over the same return, and the
      // same operation id posts it once the manager has approved.
      approvalPin.value = '';
      askingPin.value = true;
      failure.value = { code: cause.code, message: cause.message };
      return;
    }
    if (cause instanceof ApiError && cause.details['reason'] === 'CASH_DAY_NOT_STARTED') {
      const token_ = session.accessToken.value;
      if (token_ !== null) {
        dayStatus.value = await fetchDayStatus(token_);
        startingDay.value = true;
      }
      return;
    }
    failure.value = describe(cause, 'Could not take this return');
  } finally {
    saving.value = false;
  }
}

async function onConfirm(): Promise<void> {
  confirming.value = false;
  await submit();
}

async function onApprove(): Promise<void> {
  askingPin.value = false;
  await submit();
}

async function onDayStarted(): Promise<void> {
  startingDay.value = false;
  await submit();
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}

/** Scale-3 quantity → the plain number the shopkeeper reads. */
function qtyText(raw: number): string {
  return String(raw / 1000);
}

onMounted(load);
</script>

<template>
  <Dialog
    visible
    modal
    :style="{ width: 'min(42rem, 96vw)' }"
    header="Return"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="dlg__head">
        <h2>Return goods <small>পণ্য ফেরত</small></h2>
        <p v-if="invoice">{{ invoice.number }} · {{ invoice.customerName }}</p>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <p v-if="loading" class="ret__empty">Opening the invoice…</p>
    <p v-else-if="returnableLines.length === 0" class="ret__empty">
      Nothing on this invoice can come back — it has all been returned already.
    </p>

    <template v-else>
      <table class="ret__lines">
        <thead>
          <tr>
            <th>Item <small>পণ্য</small></th>
            <th class="num">Sold</th>
            <th class="num">Coming back <small>ফেরত</small></th>
            <th class="num">Value <small>টাকা</small></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="line in returnableLines" :key="line.saleLineId">
            <td>
              <strong>{{ line.productName }}</strong>
              <small>{{ line.unitName }}</small>
            </td>
            <td class="num">
              {{ qtyText(line.qtyReturnable) }}
              <small v-if="line.qtyReturned > 0">of {{ qtyText(line.qtySold) }}</small>
            </td>
            <td class="num">
              <div class="ret__qty">
                <AmountInput
                  v-if="!line.tracksSerial"
                  :model-value="quantities[line.saleLineId] ?? 0"
                  @update:model-value="quantities[line.saleLineId] = $event"
                  :min="0"
                  :max="line.qtyReturnable / 1000"
                  :fraction-digits="3"
                  :aria-label="`Quantity returning for ${line.productName}`"
                />
                <Button
                  label="All"
                  text
                  size="small"
                  @click="takeAll(line.saleLineId, line.qtyReturnable)"
                />
              </div>
              <div v-if="line.tracksSerial" class="serial-list">
                <label v-for="serial in line.serials" :key="serial.id">
                  <input
                    v-model="selectedSerials[line.saleLineId]"
                    type="checkbox"
                    :value="serial.id"
                  />
                  <span>
                    {{ serial.serialNo }}
                    <small>{{ serial.sourceType === 'VENDOR' ? 'Vendor stock' : 'Own stock' }}</small>
                  </span>
                </label>
                <small>{{ selectedSerials[line.saleLineId]?.length ?? 0 }} selected</small>
              </div>
            </td>
            <td class="num">
              {{
                taka(
                  totals?.lines.find((row) => row.saleLineId === line.saleLineId)?.valueMinor ?? 0,
                )
              }}
            </td>
          </tr>
        </tbody>
      </table>

      <div class="dlg__grid">
        <label class="field">
          <span>Why is it coming back <small>কারণ</small></span>
          <Select
            v-model="reason"
            :options="REASONS"
            option-label="label"
            option-value="value"
          />
        </label>

        <label class="field">
          <span>Note <small>কিছু লিখতে চাইলে</small></span>
          <InputText v-model="note" placeholder="Optional" />
        </label>
      </div>

      <div class="ret__money">
        <div class="seg">
          <button
            type="button"
            :class="{ 'seg--on': settlement === 'CREDIT' }"
            @click="settlement = 'CREDIT'"
          >
            Keep on account <small>জমা থাকবে</small>
          </button>
          <button
            type="button"
            :class="{ 'seg--on': settlement === 'REFUND' }"
            @click="chooseRefund"
          >
            Refund now <small>টাকা ফেরত</small>
          </button>
        </div>

        <div v-if="settlement === 'REFUND'" class="dlg__grid">
          <label class="field">
            <span>Refund amount <small>কত টাকা ফেরত</small></span>
            <AmountInput v-model="refund" :min="0" :max="returnValueMinor / 100" />
          </label>
          <label class="field">
            <span>Out of which account <small>কোথা থেকে</small></span>
            <Select
              v-model="accountId"
              :options="accountOptions"
              option-label="label"
              option-value="value"
            />
          </label>
        </div>
      </div>

      <div v-if="needsCustomer" class="dlg__grid ret__customer">
        <p class="ret__customer-why">
          This sale was paid in full, so no customer was saved. Money left on account belongs to
          somebody — check the name and number below.
        </p>
        <label class="field">
          <span>Customer name <small>কাস্টমারের নাম</small></span>
          <InputText v-model="customerName" placeholder="Full name" />
        </label>
        <label class="field">
          <span>Mobile <small>মোবাইল নম্বর</small></span>
          <InputText v-model="customerPhone" placeholder="01XXXXXXXXX" />
        </label>
      </div>

      <dl class="ret__totals">
        <div>
          <dt>Goods coming back</dt>
          <dd>{{ taka(returnValueMinor) }}</dd>
        </div>
        <div v-if="refundMinor > 0">
          <dt>Refunded now</dt>
          <dd>{{ taka(refundMinor) }}</dd>
        </div>
        <div v-if="settlesMinor > 0">
          <dt>Comes off this invoice</dt>
          <dd>{{ taka(settlesMinor) }}</dd>
        </div>
        <div v-if="advanceMinor > 0">
          <dt>Kept as advance</dt>
          <dd>{{ taka(advanceMinor) }}</dd>
        </div>
      </dl>

      <p v-if="overLimit" class="ret__limit">
        This is more than you may hand back — a manager will be asked to approve it.
      </p>
    </template>

    <template #footer>
      <Button label="Cancel" text class="btn-ghost" @click="emit('close')" />
      <Button
        label="Take Return"
        class="btn-primary"
        :disabled="!ready || saving"
        @click="confirming = true"
      />
    </template>
  </Dialog>

  <ConfirmDialog
    v-if="confirming"
    title="Take this return?"
    :amount-minor="returnValueMinor"
    :message="
      refundMinor > 0
        ? `${taka(refundMinor)} will be handed back`
        : 'The value stays on the customer’s account'
    "
    confirm-label="Take Return"
    @cancel="confirming = false"
    @confirm="onConfirm"
  />

  <Dialog
    v-if="askingPin"
    visible
    modal
    :style="{ width: 'min(24rem, 96vw)' }"
    header="Manager approval"
    @update:visible="askingPin = false"
  >
    <p class="ret__pin-why">
      This refund is over your limit. Ask the owner or a manager to type their PIN.
    </p>
    <label class="field">
      <span>PIN <small>ম্যানেজারের পিন</small></span>
      <Password v-model="approvalPin" :feedback="false" toggle-mask autofocus />
    </label>
    <template #footer>
      <Button label="Cancel" text class="btn-ghost" @click="askingPin = false" />
      <Button
        label="Approve"
        class="btn-primary"
        :disabled="approvalPin.length < 4 || saving"
        @click="onApprove"
      />
    </template>
  </Dialog>

  <StartDayDialog
    v-if="startingDay && dayStatus"
    :status="dayStatus"
    @close="startingDay = false"
    @started="onDayStarted"
  />
</template>

<style scoped>
.dlg__head h2 {
  margin: 0;
  font-size: 1.1rem;
}

.dlg__head h2 small {
  font-weight: 400;
  font-size: 0.8rem;
  color: var(--sher-text-muted);
  margin-left: 0.4rem;
}

.dlg__head p {
  margin: 0.15rem 0 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}

.dlg__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.ret__empty {
  margin: 1rem 0;
  color: var(--sher-text-muted);
}

.ret__lines {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.ret__lines th,
.ret__lines td {
  padding: 0.45rem 0.35rem;
  border-bottom: 1px solid var(--sher-line);
  text-align: left;
  vertical-align: middle;
}

.ret__lines th small,
.ret__lines td small {
  display: block;
  font-size: 0.72rem;
  color: var(--sher-text-muted);
  font-weight: 400;
}

.ret__lines .num {
  text-align: right;
}

.ret__qty {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.25rem;
}

.ret__qty :deep(input) {
  width: 5.5rem;
  text-align: right;
}

.ret__money {
  margin-top: 0.9rem;
}

.ret__totals {
  margin: 0.9rem 0 0;
  display: grid;
  gap: 0.35rem;
}

.ret__totals div {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.ret__totals dt {
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.ret__totals dd {
  margin: 0;
  font-weight: 600;
}

.ret__customer {
  margin-top: 0.75rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius-sm);
}

.ret__customer-why {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 0.82rem;
  color: var(--sher-text-muted);
}

.ret__limit {
  margin: 0.6rem 0 0;
  font-size: 0.85rem;
  color: var(--sher-warn-text, #92400e);
}

.ret__pin-why {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
  color: var(--sher-text-muted);
}
</style>
