<script setup lang="ts">
import type { MoneyAccountResponse } from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { deactivateAccount, fetchAccounts } from '../../api/money';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';
import AccountFormDialog from './AccountFormDialog.vue';
import { MONEY_BN, MONEY_EN, taka } from './money-text';

/**
 * The shop's loans, set up from inside Capital & Loans (owner decision
 * 2026-08-31).
 *
 * **This exists to close a dead end.** `loan.account.manage` makes Capital &
 * Loans visible, but Money Accounts needs `cash.account.view` or
 * `bank.account.view` — so a bookkeeper trusted with the loans and nothing else
 * could reach the entry screen and had nowhere to create the loan account it
 * needs. This is that place.
 *
 * It is **not a second implementation**: the list is the same
 * `GET /money/accounts` filtered to loans, and adding or editing one opens the
 * existing `AccountFormDialog` with the type fixed to `LOAN`, which calls the
 * same endpoints and the same `ManageAccountsService` every other account uses.
 */
const emit = defineEmits<{ (event: 'close'): void; (event: 'changed'): void }>();

const session = useSession();

const loans = ref<readonly MoneyAccountResponse[]>([]);
const loading = ref(true);
const busyId = ref<string | null>(null);
const failure = ref<{ code: string; message: string } | null>(null);

const showForm = ref(false);
const editing = ref<MoneyAccountResponse | null>(null);

const canManage = computed(() => session.can('loan.account.manage'));

/** Positive: what is still owed. A loan's journal balance is a credit. */
function owed(account: MoneyAccountResponse): number {
  return -account.balanceMinor;
}

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  loading.value = true;
  failure.value = null;

  try {
    const response = await fetchAccounts(token, true);
    loans.value = response.accounts.filter((account) => account.type === 'LOAN');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the loan accounts' };
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
    emit('changed');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not take that loan out of use' };
  } finally {
    busyId.value = null;
  }
}

async function saved(): Promise<void> {
  showForm.value = false;
  editing.value = null;
  await load();
  emit('changed');
}

onMounted(load);
</script>

<template>
  <Dialog
    :visible="true"
    modal
    :draggable="false"
    :style="{ width: 'min(42rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="dialog-head">
        <span class="head-en">{{ MONEY_EN.manageLoanAccounts }}</span>
        <span class="head-bn sher-bn">{{ MONEY_BN.manageLoanAccounts }}</span>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="loan-list">
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="loans.length === 0" class="muted">
        No loan accounts yet. Add one to record money borrowed and repaid.
        <span class="sher-bn">এখনো কোনো ঋণের হিসাব নেই</span>
      </p>

      <div v-for="loan in loans" :key="loan.id" class="loan-row">
        <span class="loan-name">
          {{ loan.name }}
          <span v-if="loan.holderName" class="loan-holder">{{ loan.holderName }}</span>
        </span>
        <span class="loan-owed">{{ taka(owed(loan)) }} owed</span>
        <span class="loan-actions">
          <button
            v-if="canManage"
            type="button"
            class="icon-btn"
            title="Edit this loan"
            @click="((editing = loan), (showForm = true))"
          >
            <i class="pi pi-pencil" aria-hidden="true" />
          </button>
          <button
            v-if="canManage && loan.balanceMinor === 0 && loan.status === 'ACTIVE'"
            type="button"
            class="icon-btn"
            title="Take out of use — fully repaid"
            :disabled="busyId === loan.id"
            @click="retire(loan)"
          >
            <i class="pi pi-ban" aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>

    <template #footer>
      <button type="button" class="btn btn-ghost" @click="emit('close')">Close</button>
      <button
        v-if="canManage"
        type="button"
        class="btn btn-primary"
        @click="((editing = null), (showForm = true))"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        Add loan account
      </button>
    </template>

    <!-- The same form every other account uses, with the type fixed to LOAN. -->
    <AccountFormDialog
      v-if="showForm"
      :account="editing"
      start-type="LOAN"
      @close="((showForm = false), (editing = null))"
      @saved="saved"
    />
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

.loan-list {
  display: flex;
  flex-direction: column;
}

.muted {
  color: var(--sher-text-muted);
}

.loan-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sher-space-2);
  padding: 10px 4px;
  border-bottom: 1px solid var(--sher-line);
}

.loan-row:last-child {
  border-bottom: 0;
}

.loan-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-weight: 600;
}

.loan-holder {
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.loan-owed {
  font-variant-numeric: tabular-nums;
  color: var(--sher-bad);
  white-space: nowrap;
}

.loan-actions {
  display: flex;
  gap: 4px;
}
</style>
