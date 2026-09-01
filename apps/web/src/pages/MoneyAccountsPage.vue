<script setup lang="ts">
import type { MoneyAccountResponse, MoneyAccountTypeValue } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { deactivateAccount, fetchAccounts } from '../api/money';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AccountFormDialog from '../components/money/AccountFormDialog.vue';
import { taka } from '../components/money/money-text';

/**
 * Cash, bank, MFS and loan accounts (§5.16, §5.17).
 *
 * Moved out of Settings into **Finance** on 2026-08-31. It sat with the setup
 * screens because a till is configured once and never touched again; with
 * loans, ledgers and transfers beside it, it is now a screen an owner opens on
 * an ordinary day to see where the money is.
 *
 * **Four families, one table, one tab each** (owner's design, 2026-08-31). A
 * shop with fifty accounts cannot read one undifferentiated list, and the tab
 * counts are how the owner sees at a glance that a bKash account is missing.
 *
 * The list never shows a stored balance — every figure is the INV-07 sum of the
 * account's journal lines, computed with the row. **Loans are never added into
 * any money total**: a loan balance is what the shop owes, and adding it to
 * what the shop holds would overstate both.
 *
 * English-primary (UI-14): this is the owner's screen, not the counter's.
 */
const session = useSession();
const router = useRouter();

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const includeInactive = ref(false);
const loading = ref(true);
const busyId = ref<string | null>(null);
const failure = ref<{ code: string; message: string } | null>(null);

const showForm = ref(false);
const editing = ref<MoneyAccountResponse | null>(null);
const formType = ref<MoneyAccountTypeValue>('CASH');

const canManageCash = computed(() => session.can('cash.account.manage'));
const canManageBank = computed(() => session.can('bank.account.manage'));
const canManageLoan = computed(() => session.can('loan.account.manage'));
const banksOn = computed(() => session.featureEnabled('bank_accounts_enabled'));

/**
 * The tabs, in the order a shopkeeper thinks about money: what is in the shop,
 * what is in the bank, what is on the phone, what is owed.
 *
 * A tab whose family this user may not see never appears — the server does not
 * return those accounts at all, so an empty tab would be a claim about the
 * shop's money that this person is not being shown.
 */
const TABS = [
  { type: 'CASH', label: 'Cash', labelBn: 'ক্যাশ' },
  { type: 'BANK', label: 'Bank', labelBn: 'ব্যাংক' },
  { type: 'MFS', label: 'MFS', labelBn: 'বিকাশ / নগদ' },
  { type: 'LOAN', label: 'Loans', labelBn: 'ঋণ' },
] as const;

const tabs = computed(() =>
  TABS.map((tab) => ({
    ...tab,
    rows: accounts.value.filter((account) => account.type === tab.type),
  })).filter((tab) => tab.rows.length > 0 || canAdd(tab.type)),
);

const active = ref<MoneyAccountTypeValue>('CASH');
const rows = computed(() => tabs.value.find((tab) => tab.type === active.value)?.rows ?? []);
const showingLoans = computed(() => active.value === 'LOAN');

function canAdd(type: MoneyAccountTypeValue): boolean {
  if (type === 'CASH') return canManageCash.value;
  if (type === 'LOAN') return canManageLoan.value;
  return canManageBank.value && banksOn.value;
}

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  loading.value = true;
  failure.value = null;

  try {
    const response = await fetchAccounts(token, includeInactive.value);
    accounts.value = response.accounts;
    // Land on a tab that actually has something in it.
    if (rows.value.length === 0) {
      active.value = tabs.value[0]?.type ?? 'CASH';
    }
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the accounts' };
  } finally {
    loading.value = false;
  }
}

/** Only ever offered at zero — the service refuses the rest (§3.6). */
async function retire(account: MoneyAccountResponse): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  busyId.value = account.id;
  failure.value = null;

  try {
    await deactivateAccount(token, account.id, account.version);
    await load();
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not take that account out of use' };
  } finally {
    busyId.value = null;
  }
}

function canManage(account: MoneyAccountResponse): boolean {
  return canAdd(account.type);
}

function typeLabel(account: MoneyAccountResponse): string {
  if (account.type === 'CASH') return account.isDrawer ? 'Drawer' : 'Cash';
  if (account.type === 'LOAN') return 'Loan';
  return account.type === 'MFS' ? 'MFS' : 'Bank';
}

/** A loan reads as what is owed; its journal balance is a credit. */
function balanceText(account: MoneyAccountResponse): string {
  return account.type === 'LOAN'
    ? `${taka(-account.balanceMinor)} (owed)`
    : taka(account.balanceMinor);
}

function add(): void {
  editing.value = null;
  formType.value = active.value;
  showForm.value = true;
}

function edit(account: MoneyAccountResponse): void {
  editing.value = account;
  formType.value = account.type;
  showForm.value = true;
}

async function saved(): Promise<void> {
  showForm.value = false;
  await load();
}

onMounted(load);
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>Money Accounts</h1>
        <p class="sher-bn">ক্যাশ, ব্যাংক ও বিকাশ — কোথায় কত টাকা আছে</p>
      </div>

      <div class="head-actions">
        <label class="inactive-toggle">
          <input v-model="includeInactive" type="checkbox" @change="load" />
          Show closed accounts
        </label>
        <Button
          v-if="canAdd(active)"
          icon="pi pi-plus"
          label="Add Account"
          @click="add"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <nav class="tabs" aria-label="Account type">
      <button
        v-for="tab in tabs"
        :key="tab.type"
        type="button"
        class="tab"
        :class="{ 'is-active': active === tab.type }"
        @click="active = tab.type"
      >
        {{ tab.label }} ({{ tab.rows.length }})
        <span class="sher-bn">{{ tab.labelBn }}</span>
      </button>
    </nav>

    <AppCard>
      <DataTable :value="[...rows]" :loading="loading" data-key="id" size="small" striped-rows>
        <template #empty>
          <EmptyState icon="pi-wallet" title="Nothing here yet">
            {{
              showingLoans
                ? 'Add a loan account to record money borrowed and repaid.'
                : 'Add the cash drawer first — the day cannot be started without it.'
            }}
          </EmptyState>
        </template>

        <Column field="name" header="Account Name">
          <template #body="{ data }">
            <div class="name-cell">
              <strong :class="{ owed: data.type === 'LOAN' }">{{ data.name }}</strong>
              <span v-if="data.reference" class="reference">{{ data.reference }}</span>
            </div>
          </template>
        </Column>

        <Column header="Type">
          <template #body="{ data }">
            <Tag :severity="data.isDrawer ? 'info' : 'secondary'" :value="typeLabel(data)" />
          </template>
        </Column>

        <Column header="Current Balance" class="num">
          <template #body="{ data }">
            <strong :class="{ owed: data.type === 'LOAN' }">{{ balanceText(data) }}</strong>
          </template>
        </Column>

        <Column header="Status">
          <template #body="{ data }">
            <Tag
              :severity="data.status === 'ACTIVE' ? 'success' : 'secondary'"
              :value="data.status === 'ACTIVE' ? 'Active' : 'Closed'"
            />
          </template>
        </Column>

        <Column header="Action">
          <template #body="{ data }">
            <div class="row-actions">
              <Button
                v-tooltip.top="'Ledger'"
                icon="pi pi-eye"
                text
                rounded
                aria-label="Ledger"
                @click="router.push(`/finance/accounts/${data.id}/ledger`)"
              />
              <Button
                v-if="canManage(data)"
                v-tooltip.top="'Edit'"
                icon="pi pi-pencil"
                text
                rounded
                aria-label="Edit"
                @click="edit(data)"
              />
              <Button
                v-if="canManage(data) && data.status === 'ACTIVE' && data.balanceMinor === 0"
                v-tooltip.top="'Take out of use — only possible while it is empty'"
                icon="pi pi-ban"
                text
                rounded
                severity="danger"
                :loading="busyId === data.id"
                aria-label="Take out of use"
                @click="retire(data)"
              />
            </div>
          </template>
        </Column>
      </DataTable>
    </AppCard>

    <p v-if="showingLoans" class="loan-note">
      <i class="pi pi-info-circle" aria-hidden="true" />
      Loan accounts are excluded from money totals.
      <span class="sher-bn">ঋণ কখনো নগদ বা ব্যাংকের টাকার সাথে যোগ হয় না</span>
    </p>

    <AccountFormDialog
      v-if="showForm"
      :account="editing"
      :start-type="formType"
      @close="showForm = false"
      @saved="saved"
    />
  </section>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
}

.inactive-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--sher-space-2);
}

.tab {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--sher-line);
  border-radius: 999px;
  background: var(--sher-raised);
  font: inherit;
  font-weight: 600;
  color: var(--sher-text-muted);
  cursor: pointer;
}

.tab .sher-bn {
  font-size: 11px;
  font-weight: 400;
}

.tab:hover {
  background: var(--sher-hover);
}

.tab.is-active {
  border-color: var(--sher-primary);
  background: var(--sher-primary-soft);
  color: var(--sher-primary-text);
}

.name-cell {
  display: flex;
  flex-direction: column;
}

.reference {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.owed {
  color: var(--sher-bad);
}

.row-actions {
  display: flex;
  gap: 2px;
}

.loan-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: var(--sher-space-2) 0 0;
  font-size: 12px;
  color: var(--sher-warn);
}
</style>
