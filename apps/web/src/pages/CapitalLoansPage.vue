<script setup lang="ts">
import type { MoneyAccountResponse, MoneyMovementRow } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchAccounts, fetchMovements, voidMovement } from '../api/money';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import CancelDocumentDialog from '../components/CancelDocumentDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import CapitalLoanEntryDialog from '../components/money/CapitalLoanEntryDialog.vue';
import ManageLoanAccountsDialog from '../components/money/ManageLoanAccountsDialog.vue';
import type { CapitalEntryKind } from '../components/money/capital-entry-kinds';
import { LOAN_ENTRY_KINDS, OWNER_ENTRY_KINDS } from '../components/money/capital-entry-kinds';
import { MONEY_BN, MONEY_EN, taka } from '../components/money/money-text';

/**
 * The owner's money and the shop's loans (Finance module, owner decisions
 * 2026-08-31).
 *
 * **One page, two separate concepts.** Owner capital posts against
 * `OWNER_CURRENT_ACCOUNT` — §2.4's owner current account, signed both ways, so
 * a credit balance means the business owes the owner. Loans post against
 * `LOAN:{id}` and are what the shop owes a lender. They share a screen because
 * a shopkeeper thinks of both as "money that is not from trading"; they share
 * no figure, no section and no permission, because they are not the same thing
 * and one must never be added to the other.
 *
 * **Each action checks its own permission.** A person with only
 * `loan.movement.record` sees the loan section and the loan entry types and
 * nothing about the owner; a person with only `owner.capital.record` sees the
 * reverse. The server enforces the same split, from the kind stored on the row.
 *
 * **Manage Loan Accounts is here** because `loan.account.manage` does not admit
 * anyone to Money Accounts — without it, a bookkeeper trusted with the loans
 * could reach this page and have nowhere to create the account it needs.
 */
const session = useSession();

const ownerRows = ref<readonly MoneyMovementRow[]>([]);
const loanRows = ref<readonly MoneyMovementRow[]>([]);
const accounts = ref<readonly MoneyAccountResponse[]>([]);
const ownerBalanceMinor = ref(0);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const showEntry = ref(false);
const editing = ref<MoneyMovementRow | null>(null);
const cancelling = ref<MoneyMovementRow | null>(null);
const showLoanAccounts = ref(false);

const canOwner = computed(() => session.can('owner.capital.record'));
const canLoan = computed(() => session.can('loan.movement.record'));
const canManageLoans = computed(() => session.can('loan.account.manage'));
const canVoid = computed(() => session.can('cash.movement.void'));

/** Only the entry types this person may actually record (UI-09). */
const allowedKinds = computed<readonly CapitalEntryKind[]>(() => [
  ...(canOwner.value ? OWNER_ENTRY_KINDS : []),
  ...(canLoan.value ? LOAN_ENTRY_KINDS : []),
]);

const loans = computed(() => accounts.value.filter((account) => account.type === 'LOAN'));
const totalLoanMinor = computed(() =>
  loans.value.reduce((sum, loan) => sum + -loan.balanceMinor, 0),
);

/**
 * What the owner has in the business, from the entries themselves.
 *
 * Money put in less money taken out. It is the owner current account seen from
 * the owner's side, and it is deliberately not labelled Equity: this is a
 * current account with the owner, not a proven equity figure, so the card says
 * which way it points rather than asking a shopkeeper to read a sign
 * convention.
 */
function recomputeOwnerBalance(rows: readonly MoneyMovementRow[]): number {
  return rows.reduce((sum, row) => {
    if (row.status === 'CANCELLED') return sum;
    return row.kind === 'OWNER_INJECTION' ? sum + row.amountMinor : sum - row.amountMinor;
  }, 0);
}

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  loading.value = true;
  failure.value = null;

  try {
    const [owner, loan, list] = await Promise.all([
      canOwner.value
        ? fetchMovements(token, { group: 'OWNER', limit: 50 })
        : Promise.resolve({ rows: [], page: { nextCursor: null, hasMore: false } }),
      canLoan.value
        ? fetchMovements(token, { group: 'LOAN', limit: 50 })
        : Promise.resolve({ rows: [], page: { nextCursor: null, hasMore: false } }),
      fetchAccounts(token, false),
    ]);

    ownerRows.value = owner.rows;
    loanRows.value = loan.rows;
    accounts.value = list.accounts;
    ownerBalanceMinor.value = recomputeOwnerBalance(owner.rows);
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load capital and loans' };
  } finally {
    loading.value = false;
  }
}

/**
 * The dialog owns the reason, the spinner and the error; this only posts the
 * reversal, and lets a refusal reach the dialog so a person denied the
 * permission sees why rather than seeing nothing happen.
 */
async function cancel(reason: string): Promise<void> {
  const token = session.accessToken.value;
  const row = cancelling.value;
  if (token === null || row === null) return;

  await voidMovement(token, row.id, { version: row.version, reason });
}

async function saved(): Promise<void> {
  showEntry.value = false;
  editing.value = null;
  await load();
}

/** Cancelling needs the void code **and** the code that records that kind. */
function mayCancel(row: MoneyMovementRow): boolean {
  if (!canVoid.value || row.status === 'CANCELLED') return false;
  return row.kind === 'LOAN_RECEIVED' || row.kind === 'LOAN_REPAYMENT'
    ? canLoan.value
    : canOwner.value;
}

function mayEdit(row: MoneyMovementRow): boolean {
  if (row.status === 'CANCELLED') return false;
  return row.kind === 'LOAN_RECEIVED' || row.kind === 'LOAN_REPAYMENT'
    ? canLoan.value
    : canOwner.value;
}

const TYPE_LABELS: Record<string, string> = {
  OWNER_INJECTION: 'Owner added',
  OWNER_WITHDRAWAL: 'Owner took out',
  LOAN_RECEIVED: 'Loan received',
  LOAN_REPAYMENT: 'Loan repayment',
};

function typeLabel(row: MoneyMovementRow): string {
  return TYPE_LABELS[row.kind] ?? row.kind;
}

/** The money side of the entry — the other side is the owner or the loan. */
function moneyAccountName(row: MoneyMovementRow): string {
  const arriving = row.kind === 'OWNER_INJECTION' || row.kind === 'LOAN_RECEIVED';
  return arriving ? row.toAccountName : row.fromAccountName;
}

function loanAccountName(row: MoneyMovementRow): string {
  return row.kind === 'LOAN_RECEIVED' ? row.fromAccountName : row.toAccountName;
}

function statusSeverity(status: string): string {
  if (status === 'CANCELLED') return 'danger';
  return status === 'CORRECTED' ? 'warn' : 'success';
}

function statusLabel(status: string): string {
  if (status === 'CANCELLED') return 'Cancelled';
  return status === 'CORRECTED' ? 'Corrected' : 'Posted';
}

onMounted(load);
onDataChanged(load);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>{{ MONEY_EN.capitalAndLoans }}</h1>
        <p class="sher-bn">{{ MONEY_BN.capitalAndLoans }} — মালিকের টাকা আর ঋণের হিসাব</p>
      </div>

      <div class="head-actions">
        <Button
          v-if="canManageLoans"
          icon="pi pi-cog"
          :label="MONEY_EN.manageLoanAccounts"
          outlined
          @click="showLoanAccounts = true"
        />
        <Button
          v-if="allowedKinds.length > 0"
          icon="pi pi-plus"
          :label="MONEY_EN.newEntry"
          @click="((editing = null), (showEntry = true))"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="summary">
      <article v-if="canOwner" class="summary-card">
        <p class="summary-label">
          Owner capital in the business
          <span class="sher-bn">মালিকের টাকা ব্যবসায়</span>
        </p>
        <p class="summary-value">{{ taka(ownerBalanceMinor) }}</p>
        <p class="summary-detail">
          {{
            ownerBalanceMinor >= 0
              ? 'The business owes the owner this much'
              : 'The owner owes the business this much'
          }}
        </p>
      </article>

      <article v-if="canLoan || canManageLoans" class="summary-card owed">
        <p class="summary-label">
          {{ MONEY_EN.loansOwed }} <span class="sher-bn">{{ MONEY_BN.loansOwed }}</span>
        </p>
        <p class="summary-value">{{ taka(totalLoanMinor) }}</p>
        <p class="summary-detail">{{ loans.length }} loans</p>
      </article>
    </div>

    <AppCard
      v-if="canOwner"
      title="Owner Capital Movements"
      subtitle-bn="মালিক কবে কত দিলেন বা নিলেন"
    >
      <DataTable :value="[...ownerRows]" :loading="loading" data-key="id" size="small" striped-rows>
        <template #empty>
          <EmptyState icon="pi-user" title="Nothing recorded yet">
            Money the owner puts in or takes out is recorded here — never as an expense.
          </EmptyState>
        </template>

        <Column field="businessDate" header="Date" />
        <Column header="Type">
          <template #body="{ data }">{{ typeLabel(data) }}</template>
        </Column>
        <Column header="Money Account">
          <template #body="{ data }">{{ moneyAccountName(data) }}</template>
        </Column>
        <Column header="Amount" class="num">
          <template #body="{ data }">
            <strong>{{ taka(data.amountMinor) }}</strong>
          </template>
        </Column>
        <Column header="Reference">
          <template #body="{ data }">{{ data.reference ?? '—' }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag :severity="statusSeverity(data.status)" :value="statusLabel(data.status)" />
          </template>
        </Column>
        <Column header="Action">
          <template #body="{ data }">
            <div class="row-actions">
              <Button
                v-if="mayEdit(data)"
                v-tooltip.top="'Edit'"
                icon="pi pi-pencil"
                text
                rounded
                aria-label="Edit"
                @click="((editing = data), (showEntry = true))"
              />
              <Button
                v-if="mayCancel(data)"
                v-tooltip.top="'Cancel this entry'"
                icon="pi pi-ban"
                text
                rounded
                severity="danger"
                aria-label="Cancel"
                @click="cancelling = data"
              />
            </div>
          </template>
        </Column>
      </DataTable>
    </AppCard>

    <AppCard v-if="canLoan" title="Loan Movements" subtitle-bn="ঋণ নেওয়া ও শোধ দেওয়া">
      <DataTable :value="[...loanRows]" :loading="loading" data-key="id" size="small" striped-rows>
        <template #empty>
          <EmptyState icon="pi-briefcase" title="No loan entries yet">
            Loan money received and instalments paid appear here. Interest is an expense.
          </EmptyState>
        </template>

        <Column field="businessDate" header="Date" />
        <Column header="Type">
          <template #body="{ data }">{{ typeLabel(data) }}</template>
        </Column>
        <Column header="Loan Account">
          <template #body="{ data }">{{ loanAccountName(data) }}</template>
        </Column>
        <Column header="Money Account">
          <template #body="{ data }">{{ moneyAccountName(data) }}</template>
        </Column>
        <Column header="Amount" class="num">
          <template #body="{ data }">
            <strong>{{ taka(data.amountMinor) }}</strong>
          </template>
        </Column>
        <Column header="Reference">
          <template #body="{ data }">{{ data.reference ?? '—' }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag :severity="statusSeverity(data.status)" :value="statusLabel(data.status)" />
          </template>
        </Column>
        <Column header="Action">
          <template #body="{ data }">
            <div class="row-actions">
              <Button
                v-if="mayEdit(data)"
                v-tooltip.top="'Edit'"
                icon="pi pi-pencil"
                text
                rounded
                aria-label="Edit"
                @click="((editing = data), (showEntry = true))"
              />
              <Button
                v-if="mayCancel(data)"
                v-tooltip.top="'Cancel this entry'"
                icon="pi pi-ban"
                text
                rounded
                severity="danger"
                aria-label="Cancel"
                @click="cancelling = data"
              />
            </div>
          </template>
        </Column>
      </DataTable>
    </AppCard>

    <CapitalLoanEntryDialog
      v-if="showEntry"
      :allowed="allowedKinds"
      :editing="editing"
      @close="((showEntry = false), (editing = null))"
      @saved="saved"
    />

    <ManageLoanAccountsDialog
      v-if="showLoanAccounts"
      @close="showLoanAccounts = false"
      @changed="load"
    />

    <CancelDocumentDialog
      v-if="cancelling"
      :title="`${typeLabel(cancelling)} ${cancelling.number}`"
      :consequence="`${moneyAccountName(cancelling)} goes back to what it was before this entry.`"
      :amount-minor="cancelling.amountMinor"
      :submit="cancel"
      @close="cancelling = null"
      @cancelled="((cancelling = null), load())"
    />
  </section>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: var(--sher-space-1);
}

.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: var(--sher-space-2);
  margin-bottom: var(--sher-space-2);
}

.summary-card {
  padding: var(--sher-card-pad);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  background: var(--sher-raised);
  box-shadow: var(--sher-shadow-card);
}

.summary-label {
  display: flex;
  flex-direction: column;
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.summary-label .sher-bn {
  font-size: 11px;
}

.summary-value {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.summary-card.owed .summary-value {
  color: var(--sher-bad);
}

.summary-detail {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.row-actions {
  display: flex;
  gap: 2px;
}
</style>
