<script setup lang="ts">
import type {
  ExpenseCategoryResponse,
  PartyResponse,
  ReconciliationStatementRow,
} from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { fetchExpenses } from '../../api/expenses';
import { fetchParties } from '../../api/parties';
import { useSession } from '../../auth/session';
import PaySupplierDialog from '../purchasing/PaySupplierDialog.vue';
import ReceivePaymentDialog from '../sales/ReceivePaymentDialog.vue';
import ErrorNotice from '../ErrorNotice.vue';
import TransferMoneyDialog from './TransferMoneyDialog.vue';
import RecordExpenseDialog from './RecordExpenseDialog.vue';
import { taka } from './money-text';

/**
 * A row on the statement the shop never recorded (§5.17, Phase 11).
 *
 * **This dialog posts nothing.** It works out which existing workflow the line
 * belongs to, and then opens *that* dialog with the bank's figures filled in —
 * the owner reviews it and presses that dialog's own Save. Reconciliation is
 * allowed to notice a missing entry and to hand the owner the right form; it is
 * not allowed to write the entry, and this is where that line is drawn on the
 * screen (UI-72: one action, one authoritative use case).
 */
const props = defineProps<{
  row: ReconciliationStatementRow;
  /** The account being reconciled — the money moved through it, by definition. */
  accountId: string;
  drawerAccountId: string | null;
}>();

const emit = defineEmits<{ close: []; posted: [] }>();

const session = useSession();

type Kind = 'EXPENSE' | 'RECEIPT' | 'SUPPLIER_PAYMENT' | 'TRANSFER';

const moneyIn = computed(() => props.row.amountMinor > 0);

/**
 * The opening guess, from what the bank wrote and which way the money went.
 * A guess only: the owner changes it in one tap, and nothing is posted until
 * they do press Save in the workflow this opens.
 */
const suggested = computed<Kind>(() => {
  const text = props.row.description.toLowerCase();
  if (/charge|fee|vat|excise|duty|commission/.test(text)) return 'EXPENSE';
  if (/transfer|trf|sweep|own account/.test(text)) return 'TRANSFER';
  return moneyIn.value ? 'RECEIPT' : 'SUPPLIER_PAYMENT';
});

const kind = ref<Kind>('EXPENSE');
const partyId = ref('');
const parties = ref<readonly PartyResponse[]>([]);
const categories = ref<readonly ExpenseCategoryResponse[]>([]);
const opened = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const kinds = computed(() =>
  [
    { label: 'Bank charge or other cost — খরচ', value: 'EXPENSE' as Kind, allowed: !moneyIn.value },
    { label: 'Money a customer paid in — কাস্টমারের টাকা', value: 'RECEIPT' as Kind, allowed: moneyIn.value },
    { label: 'Payment to a supplier — সরবরাহকারীকে দেওয়া', value: 'SUPPLIER_PAYMENT' as Kind, allowed: !moneyIn.value },
    { label: 'Moved between our own accounts — নিজেদের অ্যাকাউন্টে সরানো', value: 'TRANSFER' as Kind, allowed: true },
  ].filter((option) => option.allowed),
);

const needsParty = computed(() => kind.value === 'RECEIPT' || kind.value === 'SUPPLIER_PAYMENT');
const chosenParty = computed(() => parties.value.find((party) => party.id === partyId.value) ?? null);
const ready = computed(() => !needsParty.value || chosenParty.value !== null);

async function loadParties(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !needsParty.value) return;

  try {
    const page = await fetchParties(token, {
      role: kind.value === 'RECEIPT' ? 'CUSTOMER' : 'SUPPLIER',
      status: 'ACTIVE',
      limit: 200,
    });
    parties.value = page.data;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load the list' };
  }
}

async function chooseKind(next: Kind): Promise<void> {
  kind.value = next;
  partyId.value = '';
  await loadParties();
}

onMounted(async () => {
  kind.value = suggested.value;

  const token = session.accessToken.value;
  if (token !== null) {
    try {
      // The expense list carries the shop's categories with it, which is where
      // every other caller reads them from — one endpoint, not two.
      categories.value = (await fetchExpenses(token, { limit: 1 })).categories;
    } catch {
      categories.value = [];
    }
  }

  await loadParties();
});
</script>

<template>
  <Dialog
    v-if="!opened"
    :visible="true"
    modal
    header="Record this entry — এই লেনদেনটি লিখুন"
    :style="{ width: 'min(38rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <div class="missing">
      <p class="line">
        <strong>{{ taka(Math.abs(row.amountMinor)) }}</strong>
        <span>{{ moneyIn ? 'came in' : 'went out' }} on {{ row.businessDate }}</span>
        <span class="what">{{ row.description }}</span>
      </p>

      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <div class="field">
        <label for="missing-kind">What was it? <span>এটা কী ছিল</span></label>
        <Select
          :model-value="kind"
          input-id="missing-kind"
          :options="kinds"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
          @update:model-value="chooseKind"
        />
      </div>

      <div v-if="needsParty" class="field">
        <label for="missing-party">
          {{ kind === 'RECEIPT' ? 'Which customer?' : 'Which supplier?' }}
          <span>{{ kind === 'RECEIPT' ? 'কোন কাস্টমার' : 'কোন সরবরাহকারী' }}</span>
        </label>
        <Select
          v-model="partyId"
          input-id="missing-party"
          :options="[...parties]"
          option-label="name"
          option-value="id"
          filter
          append-to="self"
          fluid
        />
      </div>

      <p class="consequence">
        The next screen is the shop's normal form for this, already filled in. Nothing is recorded
        until you save it there.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button type="button" class="btn btn-primary" :disabled="!ready" @click="opened = true">
          Continue
        </button>
      </div>
    </div>
  </Dialog>

  <!--
    From here the owning module takes over completely: its own dialog, its own
    permission, its own period rules, its own audit event. Reconciliation only
    hears back that something was posted, and re-reads.
  -->
  <RecordExpenseDialog
    v-else-if="kind === 'EXPENSE'"
    :categories="categories"
    :prefill="{
      amountMinor: row.amountMinor,
      accountId,
      businessDate: row.businessDate,
      note: row.description,
    }"
    @close="emit('close')"
    @recorded="emit('posted')"
  />

  <ReceivePaymentDialog
    v-else-if="kind === 'RECEIPT' && chosenParty !== null"
    :party-id="chosenParty.id"
    :party-name="chosenParty.name"
    :prefill="{ amountMinor: row.amountMinor, accountId }"
    @close="emit('close')"
    @received="emit('posted')"
  />

  <PaySupplierDialog
    v-else-if="kind === 'SUPPLIER_PAYMENT' && chosenParty !== null"
    :supplier-id="chosenParty.id"
    :supplier-name="chosenParty.name"
    :prefill="{ amountMinor: row.amountMinor, accountId, businessDate: row.businessDate }"
    @close="emit('close')"
    @paid="emit('posted')"
  />

  <!--
    Repointed when Phase 12.2 replaced MoveMoneyDialog with TransferMoneyDialog.
    NOTE for the owner: the new dialog has no `prefillAmountMinor` prop, so the
    statement line's amount and date are no longer carried into the form — the
    shopkeeper retypes them. Left as a repoint rather than a redesign, because
    adding a prefill back is a Finance-module decision, not this one's.
  -->
  <TransferMoneyDialog
    v-else-if="kind === 'TRANSFER' && drawerAccountId !== null"
    :from-account-id="drawerAccountId"
    @close="emit('close')"
    @saved="emit('posted')"
  />
</template>

<style scoped>
.missing {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3, 12px);
}

.line {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: 14px;
}

.line .what {
  color: var(--sher-text-muted);
  font-size: 12px;
}

.consequence {
  margin: 0;
  font-size: 12px;
  color: var(--sher-text-muted);
}
</style>
