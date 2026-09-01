<script setup lang="ts">
import type { MoneyAccountResponse, ReconciliationListRow } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchAccounts } from '../api/money';
import { fetchReconciliations } from '../api/reconciliation';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import MoneyAccountPicker from '../components/money/MoneyAccountPicker.vue';
import StartReconciliationDialog from '../components/money/StartReconciliationDialog.vue';
import { MONEY_BN, MONEY_EN, taka } from '../components/money/money-text';

/**
 * Checking an account against the bank's own statement (§5.17, Finance module).
 *
 * A landing page, not a second engine. Choose a bank or MFS account, see what
 * is open and what has been signed off, and start a new one — every comparison,
 * match and sign-off still happens in the reconciliation workspace that already
 * exists, and this page adds no matching logic of its own.
 *
 * Cash is not here: a till is **counted**, at Daily Cash, and a loan has no
 * bank statement to compare against. Offering either would be offering a
 * workflow that ends in a refusal.
 */
const session = useSession();
const router = useRouter();

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const accountId = ref<string | null>(null);
const rows = ref<readonly ReconciliationListRow[]>([]);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);
const starting = ref(false);

const chosen = computed(
  () => accounts.value.find((account) => account.id === accountId.value) ?? null,
);

/** Only what a bank produces a statement for. */
const reconcilable = computed(() =>
  accounts.value.filter((account) => account.type === 'BANK' || account.type === 'MFS'),
);

const open = computed(() => rows.value.filter((row) => row.status === 'DRAFT'));
const previous = computed(() => rows.value.filter((row) => row.status !== 'DRAFT'));

const canPerform = computed(() => session.can('bank.reconciliation.perform'));

async function loadAccounts(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  try {
    const response = await fetchAccounts(token, false);
    accounts.value = response.accounts;
    accountId.value = reconcilable.value[0]?.id ?? null;
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the accounts' };
  }
}

async function loadReconciliations(): Promise<void> {
  const token = session.accessToken.value;
  const id = accountId.value;
  if (token === null || id === null) {
    rows.value = [];
    loading.value = false;
    return;
  }

  loading.value = true;
  failure.value = null;

  try {
    const response = await fetchReconciliations(token, id);
    rows.value = response.rows;
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the reconciliations' };
  } finally {
    loading.value = false;
  }
}

watch(accountId, loadReconciliations);

function openSession(id: string): void {
  void router.push(`/finance/accounts/${String(accountId.value)}/reconcile/${id}`);
}

function statusLabel(status: string): string {
  if (status === 'DRAFT') return 'In Progress';
  return status === 'COMPLETED' ? 'Completed' : status;
}

onMounted(async () => {
  await loadAccounts();
  await loadReconciliations();
});
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>{{ MONEY_EN.reconciliation }}</h1>
        <p class="sher-bn">{{ MONEY_BN.reconciliation }}</p>
      </div>

      <div class="head-actions">
        <Button
          v-if="canPerform && chosen"
          icon="pi pi-plus"
          label="Start New"
          @click="starting = true"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="filters">
      <div class="field">
        <label for="reconcile-account">Account <span class="label-bn">কোন অ্যাকাউন্ট</span></label>
        <MoneyAccountPicker
          v-model="accountId"
          input-id="reconcile-account"
          :accounts="reconcilable"
          placeholder="Choose a bank or bKash account"
        />
      </div>
    </div>

    <AppCard title="Open Reconciliations" subtitle-bn="যেগুলো এখনো চলছে">
      <DataTable :value="[...open]" :loading="loading" data-key="id" size="small">
        <template #empty>
          <EmptyState icon="pi-check-square" title="Nothing in progress">
            Start one when the bank's statement for a period arrives.
          </EmptyState>
        </template>

        <Column header="Statement Date">
          <template #body="{ data }">{{ data.fromDate }} → {{ data.toDate }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag severity="warn" :value="statusLabel(data.status)" />
          </template>
        </Column>
        <Column header="Action">
          <template #body="{ data }">
            <Button
              v-tooltip.top="'Continue'"
              icon="pi pi-eye"
              text
              rounded
              aria-label="Continue"
              @click="openSession(data.id)"
            />
          </template>
        </Column>
      </DataTable>
    </AppCard>

    <AppCard title="Previous Reconciliations" subtitle-bn="আগে যেগুলো মিলিয়ে দেখা হয়েছে">
      <DataTable :value="[...previous]" :loading="loading" data-key="id" size="small" striped-rows>
        <template #empty>
          <EmptyState icon="pi-history" title="None completed yet">
            A finished reconciliation is the shop's record that the account agreed with the bank.
          </EmptyState>
        </template>

        <Column header="Statement Date">
          <template #body="{ data }">{{ data.fromDate }} → {{ data.toDate }}</template>
        </Column>
        <Column header="Difference" class="num">
          <template #body="{ data }">
            {{ data.differenceMinor === null ? '—' : taka(data.differenceMinor) }}
          </template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag severity="success" :value="statusLabel(data.status)" />
          </template>
        </Column>
        <Column header="Action">
          <template #body="{ data }">
            <Button
              v-tooltip.top="'Open'"
              icon="pi pi-eye"
              text
              rounded
              aria-label="Open"
              @click="openSession(data.id)"
            />
          </template>
        </Column>
      </DataTable>
    </AppCard>

    <StartReconciliationDialog
      v-if="starting && chosen"
      :account="chosen"
      @close="starting = false"
      @started="((starting = false), openSession($event))"
    />
  </section>
</template>

<style scoped>
.filters {
  max-width: 22rem;
}
</style>
