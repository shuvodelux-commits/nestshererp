<script setup lang="ts">
import type { MoneyAccountResponse, MoneyMovementRow } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import { computed, onMounted, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { correctMovement, fetchAccounts, recordMovement } from '../../api/money';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import MoneyAccountPicker from './MoneyAccountPicker.vue';
import type { CapitalEntryKind } from './capital-entry-kinds';
import { MONEY_BN, MONEY_EN, parseTaka, taka } from './money-text';

/**
 * Owner capital and loan money, in one dialog whose fields follow the kind of
 * entry being made (Finance module, owner decision 2026-08-31).
 *
 * **Owner capital and loans are kept apart at every level** — different journal
 * accounts, different figures, different permissions — and they share a dialog
 * only because they share a shape: an amount moving between the shop's money
 * and something that is not the shop's money. Choosing the type changes the
 * second field and nothing else:
 *
 * - Owner added / Owner took → Owner, and the **Money Account** it lands in.
 * - Loan received / Loan repaid → the **Loan Account**, and the Money Account.
 *
 * The field is called Money Account, never "payment method": a shop does not
 * pay itself, it moves money between places it owns.
 *
 * `OWNER_CURRENT_ACCOUNT` is §2.4's owner current account and the shop's
 * existing owner-equity mechanism. It is signed both ways — a credit balance is
 * money the business owes the owner — so the screen says "Owner", never
 * "Equity", and never adds it to a loan.
 */
const props = defineProps<{
  /** Which types this user may enter; the list is already permission-filtered. */
  allowed: readonly CapitalEntryKind[];
  editing?: MoneyMovementRow | null;
}>();

const emit = defineEmits<{ (event: 'saved'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const TYPES: readonly { value: CapitalEntryKind; label: string; labelBn: string; icon: string }[] = [
  { value: 'OWNER_INJECTION', label: 'Owner put money in', labelBn: 'মালিক টাকা দিলেন', icon: 'pi-user-plus' },
  { value: 'OWNER_WITHDRAWAL', label: 'Owner took money out', labelBn: 'মালিক টাকা নিলেন', icon: 'pi-user-minus' },
  { value: 'LOAN_RECEIVED', label: 'Loan received', labelBn: 'ঋণ নিলাম', icon: 'pi-download' },
  { value: 'LOAN_REPAYMENT', label: 'Loan repaid', labelBn: 'ঋণ শোধ দিলাম', icon: 'pi-upload' },
];

const kind = ref<CapitalEntryKind>(props.allowed[0] ?? 'OWNER_INJECTION');
const moneyAccountId = ref<string | null>(null);
const loanAccountId = ref<string | null>(null);
const amount = ref('');
const businessDate = ref(clock.businessDate(timezone));
const reference = ref('');
const note = ref('');
const reason = ref('');

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const busy = ref(false);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const types = computed(() => TYPES.filter((type) => props.allowed.includes(type.value)));
const isLoan = computed(() => kind.value === 'LOAN_RECEIVED' || kind.value === 'LOAN_REPAYMENT');
const isEditing = computed(() => props.editing != null);

/** Money in and money out of the shop: never a loan account on this side. */
const moneyAccounts = computed(() =>
  accounts.value.filter((account) => account.type !== 'LOAN' && account.status === 'ACTIVE'),
);
const loanAccounts = computed(() =>
  accounts.value.filter((account) => account.type === 'LOAN' && account.status === 'ACTIVE'),
);

const moneySide = computed(() => accounts.value.find((a) => a.id === moneyAccountId.value) ?? null);
const amountMinor = computed(() => parseTaka(amount.value));

/**
 * Which way the money goes. Owner money in and loan money in **arrive** in a
 * money account; what the owner takes and what is repaid **leave** it.
 */
const moneyArrives = computed(
  () => kind.value === 'OWNER_INJECTION' || kind.value === 'LOAN_RECEIVED',
);

const afterMinor = computed(() => {
  if (moneySide.value === null || amountMinor.value === null) return null;
  return moneyArrives.value
    ? moneySide.value.balanceMinor + amountMinor.value
    : moneySide.value.balanceMinor - amountMinor.value;
});

const overdrawn = computed(() => !moneyArrives.value && afterMinor.value !== null && afterMinor.value < 0);

const canSave = computed(
  () =>
    moneyAccountId.value !== null &&
    (!isLoan.value || loanAccountId.value !== null) &&
    amountMinor.value !== null &&
    amountMinor.value > 0 &&
    businessDate.value !== '' &&
    !busy.value,
);

async function loadAccounts(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  try {
    const response = await fetchAccounts(token, false, businessDate.value);
    accounts.value = response.accounts;
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the accounts' };
  } finally {
    loading.value = false;
  }
}

watch(businessDate, () => {
  if (businessDate.value !== '') void loadAccounts();
});

onMounted(async () => {
  const editing = props.editing ?? null;
  if (editing !== null) {
    kind.value = editing.kind as CapitalEntryKind;
    const arriving = editing.kind === 'OWNER_INJECTION' || editing.kind === 'LOAN_RECEIVED';
    moneyAccountId.value = idOf(arriving ? editing.toAccountCode : editing.fromAccountCode);
    loanAccountId.value = idOf(arriving ? editing.fromAccountCode : editing.toAccountCode);
    amount.value = String(editing.amountMinor / 100);
    businessDate.value = editing.businessDate;
    reference.value = editing.reference ?? '';
    note.value = editing.note ?? '';
  }
  await loadAccounts();
});

function idOf(code: string): string | null {
  const at = code.indexOf(':');
  return at === -1 ? null : code.slice(at + 1);
}

/**
 * The two sides this entry posts between.
 *
 * The other side is `OWNER_CURRENT_ACCOUNT` for owner money and `LOAN:{id}` for
 * loan money; the service refuses any other pairing for these kinds, which is
 * why the screen never has to.
 */
function sides(): { from: string; to: string } | null {
  const money = moneySide.value;
  if (money === null) return null;
  const moneyCode = `${money.type === 'CASH' ? 'CASH' : 'BANK'}:${money.id}`;
  const other = isLoan.value ? `LOAN:${String(loanAccountId.value)}` : 'OWNER_CURRENT_ACCOUNT';

  return moneyArrives.value ? { from: other, to: moneyCode } : { from: moneyCode, to: other };
}

async function save(): Promise<void> {
  const token = session.accessToken.value;
  const posting = sides();
  const value = amountMinor.value;
  if (token === null || posting === null || value === null) return;

  busy.value = true;
  failure.value = null;

  const payload = {
    kind: kind.value,
    fromAccountCode: posting.from,
    toAccountCode: posting.to,
    amountMinor: value,
    businessDate: businessDate.value,
    reference: reference.value.trim() === '' ? null : reference.value.trim(),
    note: note.value.trim() === '' ? null : note.value.trim(),
  };

  try {
    const editing = props.editing ?? null;
    if (editing === null) {
      await recordMovement(token, { ...payload, operationId: operationId.value });
    } else {
      await correctMovement(token, editing.id, {
        ...payload,
        version: editing.version,
        reason: reason.value.trim() === '' ? null : reason.value.trim(),
      });
    }
    emit('saved');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not record that entry' };
    operationId.value = Ulid.generate(clock);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    :draggable="false"
    :style="{ width: 'min(38rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="dialog-head">
        <span class="head-en">{{ isEditing ? 'Edit entry' : MONEY_EN.newEntry }}</span>
        <span class="head-bn sher-bn">{{ MONEY_BN.capitalAndLoans }}</span>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <form class="entry-form" @submit.prevent="save">
      <div class="field">
        <label>What is this? <span class="label-bn">কী ধরনের এন্ট্রি</span></label>
        <div class="types">
          <button
            v-for="type in types"
            :key="type.value"
            type="button"
            class="type"
            :class="{ 'is-chosen': kind === type.value }"
            :disabled="isEditing"
            @click="kind = type.value"
          >
            <i class="pi" :class="type.icon" aria-hidden="true" />
            <span class="type-en">{{ type.label }}</span>
            <span class="type-bn sher-bn">{{ type.labelBn }}</span>
          </button>
        </div>
      </div>

      <div class="row-2">
        <div v-if="isLoan" class="field">
          <label for="entry-loan">
            Loan Account <span class="label-bn">কোন ঋণ</span>
          </label>
          <MoneyAccountPicker
            v-model="loanAccountId"
            input-id="entry-loan"
            :accounts="loanAccounts"
            :disabled="loading"
            placeholder="Which loan"
          />
        </div>
        <div v-else class="field">
          <label for="entry-owner">Owner <span class="label-bn">মালিক</span></label>
          <input id="entry-owner" value="Owner" disabled />
        </div>

        <div class="field">
          <label for="entry-money">
            Money Account <span class="label-bn">কোন অ্যাকাউন্টে</span>
          </label>
          <MoneyAccountPicker
            v-model="moneyAccountId"
            input-id="entry-money"
            :accounts="moneyAccounts"
            :disabled="loading"
            :placeholder="moneyArrives ? 'Where it arrives' : 'Where it leaves from'"
          />
          <p v-if="moneySide" class="balance">
            {{ MONEY_EN.availableBalance }} as of {{ businessDate }}
            <strong>{{ taka(moneySide.balanceMinor) }}</strong>
          </p>
        </div>
      </div>

      <div class="row-2">
        <div class="field">
          <label for="entry-amount">
            {{ MONEY_EN.amount }} <span class="label-bn">{{ MONEY_BN.amount }}</span>
          </label>
          <input
            id="entry-amount"
            v-model="amount"
            inputmode="decimal"
            autocomplete="off"
            placeholder="10,000"
          />
        </div>

        <div class="field">
          <label for="entry-date">
            {{ MONEY_EN.transactionDate }}
            <span class="label-bn">{{ MONEY_BN.transactionDate }}</span>
          </label>
          <DateOnlyPicker input-id="entry-date" v-model="businessDate" />
        </div>
      </div>

      <div class="field">
        <label for="entry-reference">
          {{ MONEY_EN.reference }} <span class="label-bn">{{ MONEY_BN.reference }}</span>
        </label>
        <input
          id="entry-reference"
          v-model="reference"
          maxlength="64"
          autocomplete="off"
          placeholder="EMI-0830"
        />
      </div>

      <div class="field">
        <label for="entry-note">
          {{ MONEY_EN.note }} <span class="label-bn">{{ MONEY_BN.note }}</span>
        </label>
        <input id="entry-note" v-model="note" maxlength="500" placeholder="মাসিক কিস্তি" />
      </div>

      <div v-if="isEditing" class="field">
        <label for="entry-reason">
          Why is it being changed? <span class="label-bn">কেন বদলাচ্ছেন</span>
        </label>
        <input id="entry-reason" v-model="reason" maxlength="300" placeholder="Wrong amount typed" />
      </div>

      <p v-if="isLoan" class="hint">
        Principal only. Interest is recorded in Expenses, under “Loan interest”.
        <span class="sher-bn">শুধু আসল — সুদ খরচে লিখুন</span>
      </p>

      <p v-if="overdrawn && moneySide" class="overdraw">
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        <span>
          Amount is greater than the available balance. Available
          <strong>{{ taka(moneySide.balanceMinor) }}</strong>
          → After this entry: <strong>{{ taka(afterMinor ?? 0) }}</strong>
        </span>
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          {{ MONEY_EN.cancel }}
        </button>
        <button type="submit" class="btn btn-primary" :disabled="!canSave">
          <i class="pi pi-check" aria-hidden="true" />
          {{ busy ? 'Saving…' : isEditing ? 'Save changes' : 'Save entry' }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.dialog-head {
  display: flex;
  flex-direction: column;
}

.head-en {
  font-size: 20px;
  font-weight: 700;
}

.head-bn {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.entry-form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-2);
}

.types {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 8px;
}

.type {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 8px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-md);
  background: var(--sher-surface);
  font: inherit;
  color: var(--sher-text);
  cursor: pointer;
  text-align: center;
}

.type:hover:not(:disabled) {
  background: var(--sher-hover);
}

.type.is-chosen {
  border-color: var(--sher-primary);
  background: var(--sher-raised);
  box-shadow: inset 0 0 0 1px var(--sher-primary);
}

.type:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.type i {
  color: var(--sher-primary);
}

.type-en {
  font-weight: 600;
  font-size: 12px;
}

.type-bn {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sher-space-2);
}

.balance {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.balance strong {
  margin-left: 4px;
  color: var(--sher-text);
  font-variant-numeric: tabular-nums;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.overdraw {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--sher-warn-line);
  border-radius: var(--sher-radius-sm);
  background: var(--sher-warn-bg);
  color: var(--sher-warn);
  font-size: 12px;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-1);
  margin-top: var(--sher-space-1);
}

@media (max-width: 640px) {
  .row-2 {
    grid-template-columns: 1fr;
  }
}
</style>
