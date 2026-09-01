<script setup lang="ts">
import type { MoneyAccountResponse, MoneyMovementRow } from '@sher/core-contracts';
import { SystemClock } from '@sher/shared-utils';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchAccounts, fetchMovements } from '../api/money';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatCard from '../components/StatCard.vue';
import { MONEY_BN, MONEY_EN, taka } from '../components/money/money-text';

/**
 * Finance Overview — where the shop's money is, on one screen (owner decisions
 * 2026-08-31).
 *
 * Four figures, the accounts behind them, and what has moved lately. The date
 * selector means **balances as at this date**, defaulting to today: an owner
 * closing off last month wants what the accounts held on the 31st, not what
 * they hold while they are looking.
 *
 * **Loans are shown and never added in.** Outstanding Loans is its own tile in
 * its own tone, because a shop with ৳186,000 in the bank and a ৳75,000 loan
 * does not have ৳261,000 and must never be shown a figure that says so.
 *
 * Quick actions are Finance's own — Transfer, Capital & Loans, Reconciliation.
 * Customer receipts, supplier payments and expenses belong to their modules and
 * are reached from Counter; putting them here would be a second door into a
 * workflow that has one (owner decision 2026-08-31).
 */
const session = useSession();
const router = useRouter();
const clock = new SystemClock();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const asOf = ref(clock.businessDate(timezone));
const accounts = ref<readonly MoneyAccountResponse[]>([]);
const totals = ref({ cash: 0, bank: 0, mfs: 0, loan: 0 });
const recent = ref<readonly MoneyMovementRow[]>([]);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const canSeeCash = computed(() => session.can('cash.account.view'));
const canSeeBank = computed(() => session.can('bank.account.view'));
const banksOn = computed(() => session.featureEnabled('bank_accounts_enabled'));
const canSeeLoans = computed(
  () => session.can('loan.account.manage') || session.can('loan.movement.record'),
);

const canTransfer = computed(() => session.can('cash.movement.record'));
const canCapital = computed(
  () =>
    session.can('owner.capital.record') ||
    session.can('loan.movement.record') ||
    session.can('loan.account.manage'),
);
const canReconcile = computed(() => banksOn.value && session.can('bank.reconciliation.view'));

/** The four families, each drawn only for someone who may see it. */
const GROUPS = [
  { type: 'CASH', label: 'Cash', labelBn: 'ক্যাশ' },
  { type: 'BANK', label: 'Bank', labelBn: 'ব্যাংক' },
  { type: 'MFS', label: 'MFS', labelBn: 'বিকাশ / নগদ' },
  { type: 'LOAN', label: 'Loans / What we owe', labelBn: 'ঋণ' },
] as const;

const groups = computed(() =>
  GROUPS.map((group) => ({
    ...group,
    rows: accounts.value.filter((account) => account.type === group.type),
  })).filter((group) => group.rows.length > 0),
);

const countOf = (type: string): number =>
  accounts.value.filter((account) => account.type === type).length;

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  loading.value = true;
  failure.value = null;

  try {
    const [list, movements] = await Promise.all([
      fetchAccounts(token, false, asOf.value),
      // The list is permission-filtered by the server; a person who may see
      // none of these groups simply gets nothing to read here.
      fetchMovements(token, { group: 'ALL', limit: 10 }).catch(() => ({
        rows: [],
        page: { nextCursor: null, hasMore: false },
      })),
    ]);

    accounts.value = list.accounts;
    totals.value = {
      cash: list.totalCashMinor,
      bank: list.totalBankMinor,
      mfs: list.totalMfsMinor,
      loan: list.totalLoanMinor,
    };
    recent.value = movements.rows;
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the money position' };
  } finally {
    loading.value = false;
  }
}

function balanceText(account: MoneyAccountResponse): string {
  return account.type === 'LOAN' ? taka(-account.balanceMinor) : taka(account.balanceMinor);
}

function openLedger(account: MoneyAccountResponse): void {
  void router.push(`/finance/accounts/${account.id}/ledger`);
}

const statusTone = (status: string): string =>
  status === 'CANCELLED' ? 'danger' : status === 'CORRECTED' ? 'warn' : 'success';

const statusLabel = (status: string): string =>
  status === 'CANCELLED' ? 'Cancelled' : status === 'CORRECTED' ? 'Corrected' : 'Posted';

onMounted(load);
onDataChanged(load);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>{{ MONEY_EN.finance }}</h1>
        <p class="sher-bn">{{ MONEY_BN.finance }}</p>
      </div>

      <div class="head-actions">
        <DateOnlyPicker v-model="asOf" input-id="finance-as-of" @update:model-value="load" />
        <Button
          icon="pi pi-refresh"
          text
          rounded
          aria-label="Refresh"
          :loading="loading"
          @click="load"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="totals">
      <StatCard
        v-if="canSeeCash"
        :label="MONEY_EN.totalCash"
        :value="taka(totals.cash)"
        :detail="`${countOf('CASH')} accounts`"
        icon="pi-wallet"
        tone="green"
      />
      <StatCard
        v-if="canSeeBank && banksOn"
        :label="MONEY_EN.totalBank"
        :value="taka(totals.bank)"
        :detail="`${countOf('BANK')} accounts`"
        icon="pi-building-columns"
        tone="blue"
      />
      <StatCard
        v-if="canSeeBank && banksOn"
        :label="MONEY_EN.totalMfs"
        :value="taka(totals.mfs)"
        :detail="`${countOf('MFS')} accounts`"
        icon="pi-mobile"
        tone="violet"
      />
      <StatCard
        v-if="canSeeLoans"
        :label="MONEY_EN.loansOwed"
        :value="taka(totals.loan)"
        :detail="`${countOf('LOAN')} loans`"
        icon="pi-briefcase"
        tone="rose"
      />
    </div>

    <AppCard title="Quick Actions" subtitle-bn="যা প্রায়ই করা হয়">
      <div class="quick">
        <button v-if="canTransfer" type="button" class="quick-btn transfer" @click="router.push('/finance/transfers')">
          <i class="pi pi-arrow-right-arrow-left" aria-hidden="true" />
          <span class="quick-en">{{ MONEY_EN.transferMoney }}</span>
          <span class="quick-bn sher-bn">{{ MONEY_BN.transferMoney }}</span>
        </button>
        <button v-if="canCapital" type="button" class="quick-btn capital" @click="router.push('/finance/capital-loans')">
          <i class="pi pi-briefcase" aria-hidden="true" />
          <span class="quick-en">{{ MONEY_EN.capitalAndLoans }}</span>
          <span class="quick-bn sher-bn">{{ MONEY_BN.capitalAndLoans }}</span>
        </button>
        <button v-if="canReconcile" type="button" class="quick-btn reconcile" @click="router.push('/finance/reconciliation')">
          <i class="pi pi-check-square" aria-hidden="true" />
          <span class="quick-en">{{ MONEY_EN.reconciliation }}</span>
          <span class="quick-bn sher-bn">{{ MONEY_BN.reconciliation }}</span>
        </button>
      </div>
    </AppCard>

    <AppCard :title="MONEY_EN.moneyAccounts" :subtitle-bn="MONEY_BN.moneyAccounts">
      <template #actions>
        <Button
          text
          icon="pi pi-arrow-right"
          icon-pos="right"
          label="View all"
          @click="router.push('/finance/accounts')"
        />
      </template>

      <div class="groups">
        <div v-for="group in groups" :key="group.type" class="group">
          <p class="group-head">
            {{ group.label }} <span class="sher-bn">{{ group.labelBn }}</span>
          </p>
          <button
            v-for="account in group.rows"
            :key="account.id"
            type="button"
            class="account-row"
            @click="openLedger(account)"
          >
            <span class="account-name">{{ account.name }}</span>
            <span class="account-balance" :class="{ owed: account.type === 'LOAN' }">
              {{ balanceText(account) }}
            </span>
          </button>
        </div>
      </div>
    </AppCard>

    <AppCard title="Recent Money Movements" subtitle-bn="সম্প্রতি যা সরানো হয়েছে">
      <template #actions>
        <Button
          v-if="canTransfer"
          text
          icon="pi pi-arrow-right"
          icon-pos="right"
          label="View all"
          @click="router.push('/finance/transfers')"
        />
      </template>

      <DataTable :value="[...recent]" :loading="loading" data-key="id" size="small">
        <template #empty>
          <EmptyState icon="pi-arrow-right-arrow-left" title="Nothing moved yet">
            Transfers, owner money and loan entries appear here.
          </EmptyState>
        </template>

        <Column field="businessDate" header="Date" />
        <Column field="description" header="Description" />
        <Column field="fromAccountName" header="From" />
        <Column field="toAccountName" header="To" />
        <Column header="Amount" class="num">
          <template #body="{ data }">{{ taka(data.amountMinor) }}</template>
        </Column>
        <Column header="Reference">
          <template #body="{ data }">{{ data.reference ?? '—' }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag
              :severity="statusTone(data.status) === 'danger' ? 'danger' : statusTone(data.status) === 'warn' ? 'warn' : 'success'"
              :value="statusLabel(data.status)"
            />
          </template>
        </Column>
      </DataTable>
    </AppCard>
  </section>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--sher-space-1);
}

.totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: var(--sher-space-2);
  margin-bottom: var(--sher-space-2);
}

.quick {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: var(--sher-space-2);
}

.quick-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 14px 12px;
  border: 0;
  border-radius: var(--sher-radius-md);
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.quick-btn i {
  font-size: 18px;
  margin-bottom: 2px;
}

.quick-en {
  font-weight: 700;
}

.quick-bn {
  font-size: 11px;
  opacity: 0.85;
}

/* One tone per action, so the button is recognised before it is read. */
.transfer {
  background: #10614a;
}

.capital {
  background: #a8770f;
}

.reconcile {
  background: #5b3fa8;
}

.groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--sher-space-2);
}

.group-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sher-text-muted);
}

.group-head .sher-bn {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
}

.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sher-space-1);
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-bottom: 1px solid var(--sher-line);
  background: transparent;
  font: inherit;
  color: var(--sher-text);
  text-align: left;
  cursor: pointer;
}

.account-row:hover {
  background: var(--sher-hover);
}

.account-balance {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}

.account-balance.owed {
  color: var(--sher-bad);
}
</style>
