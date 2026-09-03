<script setup lang="ts">
import type { DayStatusResponse, MoneyAccountResponse, ReturnReason, ReturnableBillResponse } from '@sher/core-contracts';
import { purchaseReturnTotals } from '@sher/core-domain';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAccounts, fetchDayStatus } from '../../api/money';
import { createPurchaseReturn, fetchReturnableBill } from '../../api/purchase-returns';
import { useSession } from '../../auth/session';
import ConfirmDialog from '../ConfirmDialog.vue';
import ErrorNotice from '../ErrorNotice.vue';
import AmountInput from '../fields/AmountInput.vue';
import { taka } from '../money/money-text';
import StartDayDialog from '../money/StartDayDialog.vue';

/**
 * Goods going back to a supplier (§5.11, owner decisions 2026-08-26).
 *
 * **One task, one modal**, and the same shape as the customer return so the
 * counter learns it once: the lines of this bill, how many are going back, why,
 * and whether the money comes back now or stays as credit.
 *
 * Two caps per line, and the box takes the smaller: what the bill still has
 * un-returned, and **what is still on the shelf**. Goods already sold cannot go
 * back, and the line says so in those words rather than mentioning lots.
 *
 * Every figure moves as a quantity is typed, through `purchaseReturnTotals` —
 * the same function the posting service runs on the bill's own rows.
 */
const props = defineProps<{ purchaseId: string }>();
const emit = defineEmits<{ close: []; returned: [] }>();

const session = useSession();
const clock = new SystemClock();

const bill = ref<ReturnableBillResponse | null>(null);
const accounts = ref<readonly MoneyAccountResponse[]>([]);
const quantities = ref<Record<string, number>>({});
const reason = ref<ReturnReason>('DAMAGED');
const note = ref('');
const settlement = ref<'RECEIVE' | 'CREDIT'>('CREDIT');
const received = ref(0);
const accountId = ref('');
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
  { value: 'EXTRA_QUANTITY', label: 'Extra quantity — বেশি এসেছে' },
  { value: 'CHANGED_MIND', label: 'Not needed — লাগবে না' },
  { value: 'OTHER', label: 'Other — অন্য কারণ' },
];

/** What may go back: on the bill, and still on the shelf. */
const sendableLines = computed(() =>
  (bill.value?.lines ?? []).map((line) => ({
    ...line,
    sendable: Math.min(line.qtyReturnable, line.qtyRemainingInLot),
  })),
);

const billedLines = computed(() =>
  sendableLines.value.map((line) => ({
    purchaseLineId: line.purchaseLineId,
    productId: line.productId,
    lotId: line.lotId,
    qtyReceived: line.qtyReceived,
    qtyReturned: line.qtyReturned,
    qtyRemainingInLot: line.qtyRemainingInLot,
    billedNetMinor: line.billedNetMinor,
    actualUnitCost: line.actualUnitCost,
  })),
);

const draftLines = computed(() =>
  Object.entries(quantities.value)
    .filter(([, qty]) => qty > 0)
    .map(([purchaseLineId, qty]) => ({ purchaseLineId, qty: Math.round(qty * 1000) })),
);

const receivedMinor = computed(() =>
  settlement.value === 'CREDIT' ? 0 : Math.round(received.value * 100),
);

const totals = computed(() => {
  if (draftLines.value.length === 0) return null;
  try {
    return purchaseReturnTotals(
      { lines: draftLines.value, receivedMinor: receivedMinor.value },
      billedLines.value,
    );
  } catch {
    return null;
  }
});

const returnValueMinor = computed(() => totals.value?.returnValueMinor ?? 0);
const adjustmentMinor = computed(() => totals.value?.adjustmentMinor ?? 0);
const creditMinor = computed(() => Math.max(returnValueMinor.value - receivedMinor.value, 0));
const settlesMinor = computed(() =>
  Math.min(creditMinor.value, Math.max(bill.value?.outstandingMinor ?? 0, 0)),
);
const advanceMinor = computed(() => creditMinor.value - settlesMinor.value);

const accountOptions = computed(() =>
  accounts.value.map((account) => ({ value: account.id, label: account.name })),
);

const ready = computed(
  () =>
    returnValueMinor.value > 0 &&
    receivedMinor.value <= returnValueMinor.value &&
    (receivedMinor.value === 0 || accountId.value !== ''),
);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const [returnable, accountPage] = await Promise.all([
      fetchReturnableBill(token, props.purchaseId),
      fetchAccounts(token),
    ]);
    bill.value = returnable;
    accounts.value = accountPage.accounts.filter((account) => account.status === 'ACTIVE');
    accountId.value =
      accounts.value.find((account) => account.isDrawer)?.id ?? accounts.value[0]?.id ?? '';
    quantities.value = Object.fromEntries(
      returnable.lines.map((line) => [line.purchaseLineId, 0]),
    );
  } catch (cause) {
    failure.value = describe(cause, 'Could not open this bill');
  } finally {
    loading.value = false;
  }
}

function takeAll(purchaseLineId: string, sendable: number): void {
  quantities.value = { ...quantities.value, [purchaseLineId]: sendable / 1000 };
}

function chooseReceive(): void {
  settlement.value = 'RECEIVE';
  received.value = returnValueMinor.value / 100;
}

async function submit(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;
  const account = accounts.value.find((row) => row.id === accountId.value);

  saving.value = true;
  failure.value = null;
  try {
    await createPurchaseReturn(
      token,
      {
        purchaseId: props.purchaseId,
        lines: draftLines.value.map((line) => ({
          sourceLineId: line.purchaseLineId,
          qty: line.qty,
          // Serial selection belongs to sales returns (§5.14); goods going back to
          // a supplier leave by lot, so the shared return line carries none.
          serialUnitIds: [],
        })),
        reason: reason.value,
        note: note.value.trim() === '' ? null : note.value.trim(),
        receivedMinor: receivedMinor.value,
        receiptAccountCode:
          receivedMinor.value === 0 || account === undefined
            ? null
            : account.type === 'CASH'
              ? `CASH:${account.id}`
              : `BANK:${account.id}`,
        backdateReason: null,
      },
      operationId.value,
    );
    emit('returned');
  } catch (cause) {
    if (cause instanceof ApiError && cause.details['reason'] === 'CASH_DAY_NOT_STARTED') {
      const token_ = session.accessToken.value;
      if (token_ !== null) {
        dayStatus.value = await fetchDayStatus(token_);
        startingDay.value = true;
      }
      return;
    }
    failure.value = describe(cause, 'Could not send these goods back');
  } finally {
    saving.value = false;
  }
}

async function onConfirm(): Promise<void> {
  confirming.value = false;
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
    header="Return to supplier"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="dlg__head">
        <h2>Return to supplier <small>সাপ্লায়ারকে ফেরত</small></h2>
        <p v-if="bill">{{ bill.number }} · {{ bill.supplierName }}</p>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <p v-if="loading" class="pret__empty">Opening the bill…</p>
    <p v-else-if="sendableLines.length === 0" class="pret__empty">
      There is nothing on this bill to send back.
    </p>

    <template v-else>
      <table class="pret__lines">
        <thead>
          <tr>
            <th>Item <small>পণ্য</small></th>
            <th class="num">Can go back</th>
            <th class="num">Sending <small>ফেরত</small></th>
            <th class="num">Credit <small>টাকা</small></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="line in sendableLines" :key="line.purchaseLineId">
            <td>
              <strong>{{ line.productName }}</strong>
              <small>{{ line.unitName }}</small>
            </td>
            <td class="num">
              {{ qtyText(line.sendable) }}
              <small v-if="line.sendable < line.qtyReturnable">
                rest already sold — বিক্রি হয়ে গেছে
              </small>
            </td>
            <td class="num">
              <div class="pret__qty">
                <AmountInput
                  :model-value="quantities[line.purchaseLineId] ?? 0"
                  :min="0"
                  :max="line.sendable / 1000"
                  :fraction-digits="3"
                  :disabled="line.sendable <= 0"
                  :aria-label="`Quantity going back for ${line.productName}`"
                  @update:model-value="quantities[line.purchaseLineId] = $event"
                />
                <Button
                  label="All"
                  text
                  size="small"
                  :disabled="line.sendable <= 0"
                  @click="takeAll(line.purchaseLineId, line.sendable)"
                />
              </div>
            </td>
            <td class="num">
              {{
                taka(
                  totals?.lines.find((row) => row.purchaseLineId === line.purchaseLineId)
                    ?.valueMinor ?? 0,
                )
              }}
            </td>
          </tr>
        </tbody>
      </table>

      <div class="dlg__grid">
        <label class="field">
          <span>Why is it going back <small>কারণ</small></span>
          <Select v-model="reason" :options="REASONS" option-label="label" option-value="value" />
        </label>

        <label class="field">
          <span>Note <small>কিছু লিখতে চাইলে</small></span>
          <InputText v-model="note" placeholder="Optional" />
        </label>
      </div>

      <div class="pret__money">
        <div class="seg">
          <button
            type="button"
            :class="{ 'seg--on': settlement === 'CREDIT' }"
            @click="settlement = 'CREDIT'"
          >
            Keep as credit <small>বাকি থেকে বাদ</small>
          </button>
          <button
            type="button"
            :class="{ 'seg--on': settlement === 'RECEIVE' }"
            @click="chooseReceive"
          >
            Money back now <small>টাকা ফেরত নিন</small>
          </button>
        </div>

        <div v-if="settlement === 'RECEIVE'" class="dlg__grid">
          <label class="field">
            <span>Money received <small>কত টাকা পেলেন</small></span>
            <AmountInput v-model="received" :min="0" :max="returnValueMinor / 100" />
          </label>
          <label class="field">
            <span>Into which account <small>কোথায় জমা</small></span>
            <Select
              v-model="accountId"
              :options="accountOptions"
              option-label="label"
              option-value="value"
            />
          </label>
        </div>
      </div>

      <dl class="pret__totals">
        <div>
          <dt>Supplier credits</dt>
          <dd>{{ taka(returnValueMinor) }}</dd>
        </div>
        <div v-if="receivedMinor > 0">
          <dt>Money back now</dt>
          <dd>{{ taka(receivedMinor) }}</dd>
        </div>
        <div v-if="settlesMinor > 0">
          <dt>Comes off this bill</dt>
          <dd>{{ taka(settlesMinor) }}</dd>
        </div>
        <div v-if="advanceMinor > 0">
          <dt>Credit with supplier</dt>
          <dd>{{ taka(advanceMinor) }}</dd>
        </div>
        <div v-if="adjustmentMinor > 0" class="pret__adjust">
          <dt>Transport the shop keeps</dt>
          <dd>{{ taka(adjustmentMinor) }}</dd>
        </div>
      </dl>

      <p v-if="adjustmentMinor > 0" class="pret__why">
        The supplier refunds what they billed. The van fare and labour on these goods were the
        shop’s own cost and stay with the shop.
      </p>
    </template>

    <template #footer>
      <Button label="Cancel" text class="btn-ghost" @click="emit('close')" />
      <Button
        label="Send Back"
        class="btn-primary"
        :disabled="!ready || saving"
        @click="confirming = true"
      />
    </template>
  </Dialog>

  <ConfirmDialog
    v-if="confirming"
    title="Send these goods back?"
    :amount-minor="returnValueMinor"
    :message="
      receivedMinor > 0
        ? `${taka(receivedMinor)} comes back from the supplier`
        : 'The value comes off what the shop owes them'
    "
    confirm-label="Send Back"
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

.pret__empty {
  margin: 1rem 0;
  color: var(--sher-text-muted);
}

.pret__lines {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.pret__lines th,
.pret__lines td {
  padding: 0.45rem 0.35rem;
  border-bottom: 1px solid var(--sher-line);
  text-align: left;
  vertical-align: middle;
}

.pret__lines th small,
.pret__lines td small {
  display: block;
  font-size: 0.72rem;
  color: var(--sher-text-muted);
  font-weight: 400;
}

.pret__lines .num {
  text-align: right;
}

.pret__qty {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.25rem;
}

.pret__qty :deep(input) {
  width: 5.5rem;
  text-align: right;
}

.pret__money {
  margin-top: 0.9rem;
}

.pret__totals {
  margin: 0.9rem 0 0;
  display: grid;
  gap: 0.35rem;
}

.pret__totals div {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.pret__totals dt {
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.pret__totals dd {
  margin: 0;
  font-weight: 600;
}

.pret__adjust dd {
  color: var(--sher-text-muted);
  font-weight: 500;
}

.pret__why {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  color: var(--sher-text-muted);
}
</style>
