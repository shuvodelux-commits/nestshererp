<script setup lang="ts">
import type { AccountStatementResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchAccountStatement } from '../api/money';
import { fetchReconciliations } from '../api/reconciliation';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatCard from '../components/StatCard.vue';
import StartReconciliationDialog from '../components/money/StartReconciliationDialog.vue';
import { taka } from '../components/money/money-text';

/**
 * An account's statement (§5.17, owner decision 2026-08-24: balance and
 * statement this phase; reconciling against the bank's own statement comes with
 * its own module).
 *
 * A projection of journal lines, recomputed on every read — the same shape the
 * party ledger has, and for the same reason (INV-07, INV-10). There is no
 * stored running total here that could drift from the postings under it.
 *
 * The closing figure in the header is the **account's**, not the page's: with a
 * date filter applied, the running balance of the visible rows is not what the
 * account holds, and somebody would bank on the wrong number.
 */
const session = useSession();
const route = useRoute();
const router = useRouter();

const statement = ref<AccountStatementResponse | null>(null);
/**
 * Phase 11 (§5.17, UI-70): reconciling starts here, from the account whose
 * statement the owner is already reading. Cash is not offered — a drawer is
 * reconciled by counting it, in Daily Cash (UI-71).
 */
const reconciling = ref(false);
const openReconciliationId = ref<string | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const accountId = computed(() => String(route.params.id ?? ''));

/** What the ledger calls a source, in words a shopkeeper reads. */
const SOURCE_LABELS: Record<string, string> = {
  ACCOUNT_OPENING: 'Opening balance',
  ACCOUNT_OPENING_CORRECTION: 'Opening balance corrected',
  CASH_MOVEMENT: 'Money moved',
  CASH_SESSION_CLOSE: 'Day’s cash difference',
  CASH_SESSION_REOPEN: 'Day reopened',
  OPENING_BALANCE: 'Opening balance',
};

function sourceLabel(sourceType: string): string {
  return SOURCE_LABELS[sourceType] ?? sourceType;
}

const canReconcile = computed(
  () => statement.value !== null && statement.value.type !== 'CASH' && session.can('bank.reconciliation.view'),
);

function openReconciliation(id: string): void {
  void router.push(`/settings/accounts/${accountId.value}/reconcile/${id}`);
}

onMounted(async () => {
  const token = session.accessToken.value;
  if (token === null) return;

  try {
    statement.value = await fetchAccountStatement(token, accountId.value);
    if (canReconcile.value) {
      const open = await fetchReconciliations(token, accountId.value);
      openReconciliationId.value = open.rows.find((row) => row.status === 'DRAFT')?.id ?? null;
    }
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the statement' };
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>{{ statement?.accountName ?? 'Statement' }}</h1>
        <p class="sher-bn">এই অ্যাকাউন্টে কবে কত ঢুকেছে আর বেরিয়েছে</p>
      </div>
      <div class="head-actions">
        <button
          v-if="canReconcile && openReconciliationId !== null"
          type="button"
          class="btn btn-primary"
          @click="openReconciliation(openReconciliationId)"
        >
          Continue reconciling
        </button>
        <button
          v-else-if="canReconcile && session.can('bank.reconciliation.perform')"
          type="button"
          class="btn btn-primary"
          @click="reconciling = true"
        >
          Reconcile
        </button>
        <Button
          text
          icon="pi pi-arrow-left"
          label="Back to accounts"
          @click="router.push('/settings/accounts')"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div v-if="statement" class="totals">
      <StatCard label="Balance now" :value="taka(statement.closingBalanceMinor)" icon="pi-wallet" tone="blue" />
      <StatCard label="Money in" :value="taka(statement.totalInMinor)" icon="pi-arrow-down" tone="green" />
      <StatCard label="Money out" :value="taka(statement.totalOutMinor)" icon="pi-arrow-up" tone="rose" />
    </div>

    <AppCard>
      <DataTable
        :value="statement ? [...statement.rows] : []"
        :loading="loading"
        data-key="journalLineId"
        size="small"
        striped-rows
      >
        <template #empty>
          <EmptyState icon="pi-list" title="Nothing has moved yet">
            Every sale, payment and transfer touching this account will appear here.
          </EmptyState>
        </template>

        <Column field="businessDate" header="Date" />

        <Column header="What happened">
          <template #body="{ data }">
            <div class="what">
              <span>{{ sourceLabel(data.sourceType) }}</span>
              <span v-if="data.sourceNumber" class="doc">{{ data.sourceNumber }}</span>
            </div>
          </template>
        </Column>

        <Column header="In" class="num">
          <template #body="{ data }">
            {{ data.amountMinor > 0 ? taka(data.amountMinor) : '' }}
          </template>
        </Column>

        <Column header="Out" class="num">
          <template #body="{ data }">
            {{ data.amountMinor < 0 ? taka(-data.amountMinor) : '' }}
          </template>
        </Column>

        <Column header="Balance" class="num">
          <template #body="{ data }">
            <strong>{{ taka(data.runningBalanceMinor) }}</strong>
          </template>
        </Column>
      </DataTable>
    </AppCard>
    <StartReconciliationDialog
      v-if="reconciling && statement !== null"
      :account="{
        id: statement.accountId,
        name: statement.accountName,
        type: statement.type,
        holderName: null,
        reference: null,
        isDrawer: false,
        status: 'ACTIVE',
        balanceMinor: statement.closingBalanceMinor,
        openingAmountMinor: null,
        openingDate: null,
        version: 1,
      }"
      @close="reconciling = false"
      @started="openReconciliation"
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

.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.page-head p {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--sher-space-3, 12px);
}

.what {
  display: flex;
  flex-direction: column;
}

.doc {
  font-size: 11px;
  color: var(--sher-text-muted);
}

:deep(.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
