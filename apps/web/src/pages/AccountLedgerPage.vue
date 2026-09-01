<script setup lang="ts">
import type {
  AccountStatementResponse,
  MoneyAccountResponse,
} from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchAccountStatement, fetchAccounts } from '../api/money';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import MoneyAccountPicker from '../components/money/MoneyAccountPicker.vue';
import { MONEY_BN, MONEY_EN, taka } from '../components/money/money-text';

/**
 * One account's ledger — every line in and out, with a running balance
 * (§5.17, Finance module owner decisions 2026-08-31).
 *
 * **Two ways in, one page.** `/finance/ledger` opens with a picker, because the
 * menu entry cannot know which account is meant; `/finance/accounts/:id/ledger`
 * opens on the account a row was clicked on. The picker stays either way, so
 * comparing the till with the bank is a change of selection rather than two
 * trips through the menu.
 *
 * **Nothing here is computed in the browser.** Debit, credit, the running
 * balance, the window totals and the description are all the server's, from the
 * journal — INV-07 makes an account's balance the sum of its lines, and a
 * screen that re-added them would eventually disagree with the account it is
 * describing.
 *
 * **Searching and filtering happen on the server** (owner decision
 * 2026-08-31): an account with three thousand lines would otherwise search only
 * the page already downloaded, and the totals under the table would stop
 * describing what is above it.
 */
const session = useSession();
const route = useRoute();
const router = useRouter();

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const accountId = ref<string | null>(null);
const statement = ref<AccountStatementResponse | null>(null);

const fromDate = ref('');
const toDate = ref('');
const search = ref('');
const kind = ref<'ALL' | 'SALE' | 'PURCHASE' | 'EXPENSE' | 'MOVEMENT' | 'OTHER'>('ALL');

const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

/** The families a shopkeeper knows, not the source-document types beneath. */
const kindOptions = [
  { value: 'ALL', label: 'All entries — সব' },
  { value: 'SALE', label: 'Sales & receipts — বিক্রি ও জমা' },
  { value: 'PURCHASE', label: 'Purchases & payments — কেনা ও পরিশোধ' },
  { value: 'EXPENSE', label: 'Expenses — খরচ' },
  { value: 'MOVEMENT', label: 'Money moved — টাকা সরানো' },
  { value: 'OTHER', label: 'Everything else — অন্যান্য' },
];

const chosen = computed(
  () => accounts.value.find((account) => account.id === accountId.value) ?? null,
);

const canReconcile = computed(
  () =>
    chosen.value !== null &&
    chosen.value.type !== 'CASH' &&
    chosen.value.type !== 'LOAN' &&
    session.can('bank.reconciliation.view'),
);

async function loadAccounts(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  try {
    const response = await fetchAccounts(token, false);
    accounts.value = response.accounts;

    // The route wins; otherwise the drawer, which is the account most people
    // came to read. Falling back to the first one this user may see keeps a
    // bank-only bookkeeper from landing on an empty screen.
    const fromRoute = typeof route.params.id === 'string' ? route.params.id : null;
    accountId.value =
      fromRoute ??
      accounts.value.find((account) => account.isDrawer)?.id ??
      accounts.value[0]?.id ??
      null;
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the accounts' };
  }
}

async function loadStatement(): Promise<void> {
  const token = session.accessToken.value;
  const id = accountId.value;
  if (token === null || id === null) {
    loading.value = false;
    return;
  }

  loading.value = true;
  failure.value = null;

  try {
    statement.value = await fetchAccountStatement(token, id, {
      fromDate: fromDate.value === '' ? undefined : fromDate.value,
      toDate: toDate.value === '' ? undefined : toDate.value,
      search: search.value.trim() === '' ? undefined : search.value.trim(),
      kind: kind.value,
      limit: 100,
    });
  } catch (error) {
    statement.value = null;
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the ledger' };
  } finally {
    loading.value = false;
  }
}

// Changing the account changes the address too, so the page can be shared and
// the back button means what it looks like it means.
watch(accountId, (id) => {
  if (id === null) return;
  if (route.params.id !== undefined && route.params.id !== id) {
    void router.replace(`/finance/accounts/${id}/ledger`);
  }
  void loadStatement();
});

/** The document a row came from, in the module that owns it. */
function openSource(row: { sourceType: string; sourceId: string | null }): void {
  if (row.sourceId === null) return;
  if (row.sourceType.startsWith('SALE')) void router.push(`/sales/${row.sourceId}`);
  else if (row.sourceType.startsWith('PURCHASE')) void router.push(`/purchases/${row.sourceId}`);
  else if (row.sourceType.startsWith('EXPENSE')) void router.push('/expenses');
  else if (row.sourceType.startsWith('CASH_MOVEMENT')) void router.push('/finance/transfers');
}

function hasSource(row: { sourceType: string; sourceId: string | null }): boolean {
  if (row.sourceId === null) return false;
  return (
    row.sourceType.startsWith('SALE') ||
    row.sourceType.startsWith('PURCHASE') ||
    row.sourceType.startsWith('EXPENSE') ||
    row.sourceType.startsWith('CASH_MOVEMENT')
  );
}

onMounted(async () => {
  await loadAccounts();
  await loadStatement();
});

onDataChanged(loadStatement);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>{{ MONEY_EN.accountLedger }}</h1>
        <p class="sher-bn">{{ MONEY_BN.accountLedger }} — কবে কত ঢুকেছে আর বেরিয়েছে</p>
      </div>

      <div class="head-actions">
        <Button
          v-if="canReconcile"
          icon="pi pi-check-square"
          :label="MONEY_EN.reconciliation"
          outlined
          @click="router.push('/finance/reconciliation')"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="filters">
      <div class="field">
        <label for="ledger-account">Account <span class="label-bn">কোন অ্যাকাউন্ট</span></label>
        <MoneyAccountPicker
          v-model="accountId"
          input-id="ledger-account"
          :accounts="accounts"
          placeholder="Choose an account"
        />
      </div>
      <div class="field">
        <label for="ledger-from">From <span class="label-bn">শুরুর তারিখ</span></label>
        <DateOnlyPicker input-id="ledger-from" v-model="fromDate" @update:model-value="loadStatement" />
      </div>
      <div class="field">
        <label for="ledger-to">To <span class="label-bn">শেষ তারিখ</span></label>
        <DateOnlyPicker input-id="ledger-to" v-model="toDate" @update:model-value="loadStatement" />
      </div>
      <div class="field">
        <label for="ledger-kind">Type <span class="label-bn">ধরন</span></label>
        <Select
          v-model="kind"
          input-id="ledger-kind"
          :options="kindOptions"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
          @change="loadStatement"
        />
      </div>
      <div class="field grow">
        <label for="ledger-search">Search <span class="label-bn">খুঁজুন</span></label>
        <input
          id="ledger-search"
          v-model="search"
          type="search"
          placeholder="Reference, description or number"
          @keyup.enter="loadStatement"
          @search="loadStatement"
        />
      </div>
    </div>

    <AppCard>
      <DataTable
        :value="statement === null ? [] : [...statement.rows]"
        :loading="loading"
        data-key="journalLineId"
        size="small"
        striped-rows
      >
        <template #empty>
          <EmptyState icon="pi-list" title="Nothing in this period">
            Choose a wider date range, or clear the search.
          </EmptyState>
        </template>

        <Column field="businessDate" header="Date" />
        <Column field="reference" header="Reference" />
        <Column header="Description">
          <template #body="{ data }">
            <button
              v-if="hasSource(data)"
              type="button"
              class="linkish"
              @click="openSource(data)"
            >
              {{ data.description }}
            </button>
            <span v-else>{{ data.description }}</span>
          </template>
        </Column>
        <Column header="Debit (৳)" class="num">
          <template #body="{ data }">
            {{ data.debitMinor === 0 ? '—' : taka(data.debitMinor) }}
          </template>
        </Column>
        <Column header="Credit (৳)" class="num">
          <template #body="{ data }">
            {{ data.creditMinor === 0 ? '—' : taka(data.creditMinor) }}
          </template>
        </Column>
        <Column header="Balance (৳)" class="num">
          <template #body="{ data }">
            <strong :class="{ negative: data.runningBalanceMinor < 0 }">
              {{ taka(data.runningBalanceMinor) }}
            </strong>
          </template>
        </Column>
      </DataTable>
    </AppCard>

    <div v-if="statement" class="totals">
      <div class="total">
        <span>Opening Balance</span>
        <strong>{{ taka(statement.openingBalanceMinor) }}</strong>
      </div>
      <div class="total">
        <span>Total In</span>
        <strong class="in">{{ taka(statement.totalInMinor) }}</strong>
      </div>
      <div class="total">
        <span>Total Out</span>
        <strong class="out">{{ taka(statement.totalOutMinor) }}</strong>
      </div>
      <div class="total closing">
        <span>Closing Balance</span>
        <strong :class="{ negative: statement.closingBalanceMinor < 0 }">
          {{ taka(statement.closingBalanceMinor) }}
        </strong>
      </div>
    </div>

    <p class="note">
      <i class="pi pi-info-circle" aria-hidden="true" />
      A negative balance is shown in red — it usually means an entry is missing or dated wrongly.
      <span class="sher-bn">লাল মানে হিসাবে কিছু বাদ পড়েছে বা তারিখ ভুল</span>
    </p>
  </section>
</template>

<style scoped>
.totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--sher-space-2);
  margin-top: var(--sher-space-2);
  padding: var(--sher-card-pad);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  background: var(--sher-raised);
}

.total {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.total span {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.total strong {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.total .in {
  color: var(--sher-ok, var(--sher-primary));
}

.total .out {
  color: var(--sher-bad);
}

.closing strong {
  color: var(--sher-primary-text);
}

.negative {
  color: var(--sher-bad);
}

.note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: var(--sher-space-2) 0 0;
  font-size: 12px;
  color: var(--sher-text-muted);
}
</style>
