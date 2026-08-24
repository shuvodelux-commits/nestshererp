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
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatCard from '../components/StatCard.vue';
import AccountFormDialog from '../components/money/AccountFormDialog.vue';
import { taka } from '../components/money/money-text';

/**
 * Cash, bank and MFS accounts (§5.16, §5.17).
 *
 * Under **Settings** by the owner's decision of 2026-08-24: setting up a till,
 * a safe or a bKash account is something a shop does once and rarely touches
 * again, so it sits with the other setup screens and keeps the daily menu short
 * for the cashier. Daily Cash stays under `Daily`, where UI-67 puts it.
 *
 * English-primary (UI-14): this is the owner's screen, not the counter's.
 *
 * The list never shows a stored balance — every figure is the INV-07 sum of the
 * account's journal lines, computed with the row.
 */
const session = useSession();
const router = useRouter();

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const totals = ref({ cash: 0, bank: 0 });
const includeInactive = ref(false);
const loading = ref(true);
const busyId = ref<string | null>(null);
const failure = ref<{ code: string; message: string } | null>(null);

/*
 * The form is a dialog rather than a page (owner feedback 2026-08-24): four
 * fields filled once at setup do not warrant leaving the list behind.
 * `editing` is the account being corrected, and null while adding.
 */
const showForm = ref(false);
const editing = ref<MoneyAccountResponse | null>(null);
const formType = ref<MoneyAccountTypeValue>('CASH');

const canManageCash = computed(() => session.can('cash.account.manage'));
const canManageBank = computed(() => session.can('bank.account.manage'));
const banksOn = computed(() => session.featureEnabled('bank_accounts_enabled'));

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  loading.value = true;
  failure.value = null;

  try {
    const response = await fetchAccounts(token, includeInactive.value);
    accounts.value = response.accounts;
    totals.value = { cash: response.totalCashMinor, bank: response.totalBankMinor };
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
  return account.type === 'CASH' ? canManageCash.value : canManageBank.value;
}

function typeLabel(account: MoneyAccountResponse): string {
  if (account.type === 'CASH') return account.isDrawer ? 'Drawer' : 'Cash';
  return account.type === 'MFS' ? 'Mobile money' : 'Bank';
}

function add(type: MoneyAccountTypeValue): void {
  editing.value = null;
  formType.value = type;
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
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>Money accounts</h1>
        <p class="sher-bn">টাকা কোথায় কোথায় আছে — ক্যাশ, সিন্দুক, ব্যাংক, বিকাশ</p>
      </div>

      <div class="head-actions">
        <Button
          v-if="canManageCash"
          icon="pi pi-plus"
          label="Add cash account"
          @click="add('CASH')"
        />
        <Button
          v-if="canManageBank && banksOn"
          icon="pi pi-building-columns"
          label="Add bank account"
          outlined
          @click="add('BANK')"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="totals">
      <StatCard label="Cash in hand" :value="taka(totals.cash)" icon="pi-wallet" tone="blue" />
      <StatCard
        v-if="banksOn"
        label="In bank and mobile money"
        :value="taka(totals.bank)"
        icon="pi-building-columns"
        tone="slate"
      />
    </div>

    <AppCard>
      <DataTable
        :value="[...accounts]"
        :loading="loading"
        data-key="id"
        size="small"
        striped-rows
      >
        <template #empty>
          <EmptyState icon="pi-wallet" title="No accounts yet">
            Add the cash drawer first — the day cannot be started without it.
          </EmptyState>
        </template>

        <Column field="name" header="Account">
          <template #body="{ data }">
            <div class="name-cell">
              <strong>{{ data.name }}</strong>
              <span v-if="data.reference" class="reference">{{ data.reference }}</span>
            </div>
          </template>
        </Column>

        <Column header="Type">
          <template #body="{ data }">
            <Tag :severity="data.isDrawer ? 'info' : 'secondary'" :value="typeLabel(data)" />
          </template>
        </Column>

        <Column field="holderName" header="In the name of">
          <template #body="{ data }">{{ data.holderName ?? '—' }}</template>
        </Column>

        <Column header="Balance" class="num">
          <template #body="{ data }">
            <strong>{{ taka(data.balanceMinor) }}</strong>
          </template>
        </Column>

        <Column header="">
          <template #body="{ data }">
            <div class="row-actions">
              <Button
                v-tooltip.top="'Statement'"
                icon="pi pi-list"
                text
                rounded
                aria-label="Statement"
                @click="router.push(`/settings/accounts/${data.id}/statement`)"
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
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sher-space-4);
}

.page-head h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
}

.page-head p {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.head-actions {
  display: flex;
  gap: 8px;
}

.totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sher-space-3, 12px);
}

.name-cell {
  display: flex;
  flex-direction: column;
}

.reference {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}

:deep(.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
