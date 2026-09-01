<script setup lang="ts">
import type { MoneyMovementRow } from '@sher/core-contracts';
import { SystemClock } from '@sher/shared-utils';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchMovements, voidMovement } from '../api/money';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import CancelDocumentDialog from '../components/CancelDocumentDialog.vue';
import TransferMoneyDialog from '../components/money/TransferMoneyDialog.vue';
import { MONEY_BN, MONEY_EN, taka } from '../components/money/money-text';

/**
 * Money moved between the shop's own accounts (Finance module, owner decisions
 * 2026-08-31).
 *
 * A list and one button. The list matters as much as the button: a shopkeeper
 * who banked ৳20,000 yesterday and cannot find it today has no way to know
 * whether it was recorded, and would enter it again.
 *
 * **Cancelled transfers stay on the list**, marked. A row that disappeared
 * because somebody undid it is precisely the row the next person comes looking
 * for.
 *
 * Editing and cancelling call the paths that already exist — `correct()`
 * reverses and re-posts under the same number, `void()` posts one reversing
 * entry with a required reason. Nothing here posts anything itself.
 */
const session = useSession();
const clock = new SystemClock();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const rows = ref<readonly MoneyMovementRow[]>([]);
const fromDate = ref('');
const toDate = ref('');
const search = ref('');
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const showTransfer = ref(false);
const editing = ref<MoneyMovementRow | null>(null);
const cancelling = ref<MoneyMovementRow | null>(null);
const viewing = ref<MoneyMovementRow | null>(null);

const canRecord = computed(() => session.can('cash.movement.record'));
/** Cancelling needs both codes — the record right and the void right (§5.26). */
const canCancel = computed(() => canRecord.value && session.can('cash.movement.void'));

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  loading.value = true;
  failure.value = null;

  try {
    const response = await fetchMovements(token, {
      group: 'TRANSFER',
      fromDate: fromDate.value === '' ? undefined : fromDate.value,
      toDate: toDate.value === '' ? undefined : toDate.value,
      search: search.value.trim() === '' ? undefined : search.value.trim(),
      limit: 50,
    });
    rows.value = response.rows;
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the transfers' };
  } finally {
    loading.value = false;
  }
}

/**
 * The dialog owns the reason, the spinner and the error; this only posts the
 * reversal. Throwing rather than swallowing is deliberate — the dialog shows
 * the refusal, so a person denied the permission sees why rather than seeing
 * nothing happen.
 */
async function cancel(reason: string): Promise<void> {
  const token = session.accessToken.value;
  const row = cancelling.value;
  if (token === null || row === null) return;

  await voidMovement(token, row.id, { version: row.version, reason });
}

async function saved(): Promise<void> {
  showTransfer.value = false;
  editing.value = null;
  await load();
}

function statusSeverity(status: string): string {
  if (status === 'CANCELLED') return 'danger';
  return status === 'CORRECTED' ? 'warn' : 'success';
}

function statusLabel(status: string): string {
  if (status === 'CANCELLED') return 'Cancelled';
  return status === 'CORRECTED' ? 'Corrected' : 'Posted';
}

onMounted(() => {
  // The last month, which is the window a shopkeeper is usually asking about.
  const today = clock.businessDate(timezone);
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 30);
  fromDate.value = start.toISOString().slice(0, 10);
  toDate.value = today;
  void load();
});

onDataChanged(load);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>{{ MONEY_EN.transferMoney }}</h1>
        <p class="sher-bn">{{ MONEY_BN.transferMoney }} — এক অ্যাকাউন্ট থেকে আরেকটায়</p>
      </div>

      <div class="head-actions">
        <Button
          v-if="canRecord"
          icon="pi pi-plus"
          :label="MONEY_EN.newTransfer"
          @click="((editing = null), (showTransfer = true))"
        />
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="filters">
      <div class="field">
        <label for="from-date">From <span class="label-bn">শুরুর তারিখ</span></label>
        <DateOnlyPicker input-id="from-date" v-model="fromDate" @update:model-value="load" />
      </div>
      <div class="field">
        <label for="to-date">To <span class="label-bn">শেষ তারিখ</span></label>
        <DateOnlyPicker input-id="to-date" v-model="toDate" @update:model-value="load" />
      </div>
      <div class="field grow">
        <label for="transfer-search">Search <span class="label-bn">খুঁজুন</span></label>
        <input
          id="transfer-search"
          v-model="search"
          type="search"
          placeholder="Search by reference or note"
          @keyup.enter="load"
          @search="load"
        />
      </div>
    </div>

    <AppCard>
      <DataTable :value="[...rows]" :loading="loading" data-key="id" size="small" striped-rows>
        <template #empty>
          <EmptyState icon="pi-arrow-right-arrow-left" title="No transfers in this period">
            Money moved between the shop's accounts will appear here.
          </EmptyState>
        </template>

        <Column field="businessDate" header="Date" />
        <Column field="fromAccountName" header="From Account" />
        <Column field="toAccountName" header="To Account" />
        <Column header="Amount" class="num">
          <template #body="{ data }">
            <strong>{{ taka(data.amountMinor) }}</strong>
          </template>
        </Column>
        <Column header="Reference">
          <template #body="{ data }">{{ data.reference ?? data.number }}</template>
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
                v-tooltip.top="'View'"
                icon="pi pi-eye"
                text
                rounded
                aria-label="View"
                @click="viewing = data"
              />
              <Button
                v-if="canRecord && data.status !== 'CANCELLED'"
                v-tooltip.top="'Edit'"
                icon="pi pi-pencil"
                text
                rounded
                aria-label="Edit"
                @click="((editing = data), (showTransfer = true))"
              />
              <Button
                v-if="canCancel && data.status !== 'CANCELLED'"
                v-tooltip.top="'Cancel this transfer'"
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

    <TransferMoneyDialog
      v-if="showTransfer"
      :editing="editing"
      @close="((showTransfer = false), (editing = null))"
      @saved="saved"
    />

    <CancelDocumentDialog
      v-if="cancelling"
      :title="`Transfer ${cancelling.number}`"
      :consequence="`${cancelling.fromAccountName} gets ${taka(cancelling.amountMinor)} back, and ${cancelling.toAccountName} loses it.`"
      :amount-minor="cancelling.amountMinor"
      :submit="cancel"
      @close="cancelling = null"
      @cancelled="((cancelling = null), load())"
    />

    <!-- One movement, in words. A view is a small panel, not a page. -->
    <div v-if="viewing" class="viewer" role="dialog" @click.self="viewing = null">
      <article class="viewer-card">
        <h2>{{ viewing.description }}</h2>
        <dl>
          <div><dt>Date</dt><dd>{{ viewing.businessDate }}</dd></div>
          <div><dt>From</dt><dd>{{ viewing.fromAccountName }}</dd></div>
          <div><dt>To</dt><dd>{{ viewing.toAccountName }}</dd></div>
          <div><dt>Amount</dt><dd>{{ taka(viewing.amountMinor) }}</dd></div>
          <div><dt>Reference</dt><dd>{{ viewing.reference ?? viewing.number }}</dd></div>
          <div v-if="viewing.note"><dt>Note</dt><dd>{{ viewing.note }}</dd></div>
          <div><dt>Status</dt><dd>{{ statusLabel(viewing.status) }}</dd></div>
          <div v-if="viewing.createdByName"><dt>Recorded by</dt><dd>{{ viewing.createdByName }}</dd></div>
        </dl>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" @click="viewing = null">Close</button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.row-actions {
  display: flex;
  gap: 2px;
}

.viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.45);
  padding: var(--sher-space-2);
}

.viewer-card {
  width: min(28rem, 94vw);
  padding: var(--sher-card-pad);
  border-radius: var(--sher-radius-lg);
  background: var(--sher-raised);
  box-shadow: var(--sher-shadow-card);
}

.viewer-card h2 {
  margin: 0 0 var(--sher-space-2);
  font-size: 16px;
}

.viewer-card dl {
  display: grid;
  gap: 6px;
  margin: 0 0 var(--sher-space-2);
}

.viewer-card dl > div {
  display: flex;
  justify-content: space-between;
  gap: var(--sher-space-2);
  border-bottom: 1px solid var(--sher-line);
  padding-bottom: 4px;
}

.viewer-card dt {
  color: var(--sher-text-muted);
}

.viewer-card dd {
  margin: 0;
  font-weight: 600;
  text-align: right;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
