<script setup lang="ts">
import type {
  DayStatusResponse,
  ExpenseCategoryResponse,
  ExpenseResponse,
  MoneyAccountResponse,
  PartyResponse,
} from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { correctExpense, recordExpense } from '../../api/expenses';
import { fetchAccounts, fetchDayStatus } from '../../api/money';
import { fetchParties } from '../../api/parties';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import AmountInput from '../fields/AmountInput.vue';
import { taka } from './money-text';
import StartDayDialog from './StartDayDialog.vue';

/**
 * Recording what the shop spent (§5.12, owner decision 2026-08-26).
 *
 * **One task, one modal**: what it was for, how much, and where it came from.
 * Nothing else — the payee and the note are the only optional fields, and the
 * date only appears for somebody allowed to enter an earlier one.
 *
 * The category becomes half an account code (`EXPENSE:RENT`), which is why it
 * is chosen from the shop's list rather than typed: two spellings of Rent would
 * be two accounts, and no report would add them up.
 */
/**
 * Phase 9.2: the same modal corrects a posted expense. `existing` turns it from
 * a create into a correction — the server reverses what was posted and
 * re-posts these figures under the **same number**, so the shopkeeper sees one
 * expense that now says the right thing, not two that half-cancel.
 */
/**
 * Phase 11: `prefill` opens the same modal on figures the shop has not typed —
 * a bank charge read off a statement line (§5.17). It fills the boxes and
 * nothing else: the owner still chooses the category and still presses Save,
 * because reconciliation may not post, and a form that posts itself is posting.
 */
const props = defineProps<{
  categories: readonly ExpenseCategoryResponse[];
  existing?: ExpenseResponse | null;
  prefill?: {
    readonly amountMinor: number;
    readonly accountId: string;
    readonly businessDate: string;
    readonly note: string;
  } | null;
}>();

const emit = defineEmits<{ close: []; recorded: [] }>();

const session = useSession();
const clock = new SystemClock();
const today = clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone);

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const payees = ref<readonly PartyResponse[]>([]);
const categoryId = ref('');
const amount = ref(0);
const accountId = ref('');
const payeeId = ref('');
const note = ref('');
const businessDate = ref(today);
const backdateReason = ref('');
const saving = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const dayStatus = ref<DayStatusResponse | null>(null);
const startingDay = ref(false);

const operationId = ref(Ulid.generate(clock));

/** Only somebody with the permission is offered an earlier date (§5.19). */
const canBackdate = computed(() => session.can('period.backdate'));
const isBackdated = computed(() => businessDate.value !== today);

const activeCategories = computed(() =>
  props.categories
    .filter((category) => category.status === 'ACTIVE')
    .map((category) => ({ value: category.id, label: category.name })),
);

const accountOptions = computed(() =>
  accounts.value.map((account) => ({
    value: account.id,
    label: `${account.name} — ${taka(account.balanceMinor)}`,
  })),
);

const payeeOptions = computed(() => [
  { value: '', label: 'No one in particular' },
  ...payees.value.map((party) => ({ value: party.id, label: party.name })),
]);

const amountMinor = computed(() => Math.round(amount.value * 100));

const ready = computed(
  () =>
    categoryId.value !== '' &&
    amountMinor.value > 0 &&
    accountId.value !== '' &&
    (!isBackdated.value || backdateReason.value.trim() !== ''),
);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const [accountPage, partyPage] = await Promise.all([
      fetchAccounts(token),
      // Suppliers are the parties a shop pays that the app knows about today:
      // a landlord and an electrician are recorded as suppliers. D-04's EMPLOYEE
      // role is still unoffered, so salary is filed against the category with
      // the name in the note until that module defines what an employee is.
      fetchParties(token, { role: 'SUPPLIER', status: 'ACTIVE', limit: 200 }),
    ]);
    accounts.value = accountPage.accounts.filter((account) => account.status === 'ACTIVE');
    payees.value = partyPage.data;
    accountId.value =
      accounts.value.find((account) => account.isDrawer)?.id ?? accounts.value[0]?.id ?? '';
    categoryId.value = activeCategories.value[0]?.value ?? '';

    // A correction opens on the figures that are posted, so the shopkeeper
    // changes the one thing that is wrong rather than typing it all again.
    const suggested = props.prefill ?? null;
    if (suggested !== null) {
      amount.value = Math.abs(suggested.amountMinor) / 100;
      accountId.value = suggested.accountId;
      businessDate.value = suggested.businessDate;
      note.value = suggested.note;
    }

    const posted = props.existing ?? null;
    if (posted !== null) {
      categoryId.value = posted.categoryId;
      amount.value = posted.amountMinor / 100;
      accountId.value = posted.accountCode.slice(posted.accountCode.indexOf(':') + 1);
      payeeId.value = posted.payeePartyId ?? '';
      note.value = posted.note ?? '';
      businessDate.value = posted.businessDate;
    }

  } catch (cause) {
    failure.value = describe(cause, 'Could not open this form');
  }
}

async function save(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;
  const account = accounts.value.find((row) => row.id === accountId.value);
  if (account === undefined) return;

  saving.value = true;
  failure.value = null;
  try {
    const body = {
      categoryId: categoryId.value,
      amountMinor: amountMinor.value,
      accountCode: account.type === 'CASH' ? `CASH:${account.id}` : `BANK:${account.id}`,
      payeePartyId: payeeId.value === '' ? null : payeeId.value,
      note: note.value.trim() === '' ? null : note.value.trim(),
      ...(isBackdated.value ? { businessDate: businessDate.value } : {}),
      backdateReason: isBackdated.value ? backdateReason.value.trim() : null,
    };

    const posted = props.existing ?? null;
    if (posted === null) {
      await recordExpense(token, body, operationId.value);
    } else {
      /*
       * A correction carries the document's version (D-32) and the reason the
       * backdating rule may ask for — the server refuses without one when the
       * correction cannot post on its own date.
       */
      await correctExpense(token, posted.id, {
        ...body,
        businessDate: businessDate.value,
        version: posted.version,
        reason: backdateReason.value.trim() === '' ? null : backdateReason.value.trim(),
      });
    }
    emit('recorded');
  } catch (cause) {
    if (cause instanceof ApiError && cause.details['reason'] === 'CASH_DAY_NOT_STARTED') {
      // Nothing typed is lost: the day opens here and the same expense is saved.
      const token_ = session.accessToken.value;
      if (token_ !== null) {
        dayStatus.value = await fetchDayStatus(token_);
        startingDay.value = true;
      }
      return;
    }
    failure.value = describe(cause, 'Could not record this expense');
  } finally {
    saving.value = false;
  }
}

async function onDayStarted(): Promise<void> {
  startingDay.value = false;
  await save();
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}

onMounted(load);
</script>

<template>
  <Dialog
    visible
    modal
    :style="{ width: 'min(38rem, 96vw)' }"
    :header="existing ? 'Correct expense' : 'Record expense'"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="dlg__head">
        <h2 v-if="existing">
          Correct this expense <small>খরচ ঠিক করুন — {{ existing.number }}</small>
        </h2>
        <h2 v-else>Record expense <small>খরচ লিখুন</small></h2>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="dlg__grid">
      <label class="field">
        <span>What for <small>কীসের খরচ</small></span>
        <Select
          v-model="categoryId"
          :options="activeCategories"
          option-label="label"
          option-value="value"
          placeholder="Choose a category"
        />
      </label>

      <label class="field">
        <span>Amount <small>কত টাকা</small></span>
        <AmountInput v-model="amount" :min="0" placeholder="0.00" />
      </label>

      <label class="field">
        <span>Paid from <small>কোথা থেকে</small></span>
        <Select
          v-model="accountId"
          :options="accountOptions"
          option-label="label"
          option-value="value"
        />
      </label>

      <label class="field">
        <span>Paid to <small>কাকে দিলেন</small></span>
        <Select
          v-model="payeeId"
          :options="payeeOptions"
          option-label="label"
          option-value="value"
          filter
        />
      </label>

      <label v-if="canBackdate" class="field">
        <span>Date <small>তারিখ</small></span>
        <DateOnlyPicker v-model="businessDate" input-id="expense-date" />
      </label>

      <label v-if="canBackdate && isBackdated" class="field">
        <span>Why this date <small>কেন আগের তারিখ</small></span>
        <InputText v-model="backdateReason" placeholder="Found the receipt today" />
      </label>

      <label class="field field--wide">
        <span>Note <small>কিছু লিখতে চাইলে</small></span>
        <InputText v-model="note" placeholder="Optional" />
      </label>
    </div>

    <template #footer>
      <Button label="Cancel" text class="btn-ghost" @click="emit('close')" />
      <Button label="Save" class="btn-primary" :disabled="!ready || saving" @click="save" />
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

.dlg__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem;
}

.field--wide {
  grid-column: 1 / -1;
}
</style>
