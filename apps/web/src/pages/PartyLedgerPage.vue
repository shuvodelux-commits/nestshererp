<script setup lang="ts">
import type { PartyLedgerResponse, PartyRoleValue } from '@sher/core-contracts';
import { Money } from '@sher/shared-utils';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchPartyLedger } from '../api/parties';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * A party's ledger (§2.4, INV-06) — a Detail screen (UI-22).
 *
 * The statement behind the balance on the parties list: every journal line that
 * moved this party's money, in business-date order, with the running total
 * beside it. Someone opens this when the figure on the list is not enough and
 * they need to know *why* it is that number.
 *
 * Everything here is read-only. A ledger is a projection, never a document —
 * there is nothing on this screen to edit, because correcting a posted entry
 * means reversing and reposting the document that produced it (§2.5), which
 * happens on that document's own screen.
 */
const route = useRoute();
const router = useRouter();
const session = useSession();

const partyId = computed(() => String(route.params.id ?? ''));

/** Which list to go back to. A party may hold several roles (D-04). */
const role = computed<PartyRoleValue>(() => {
  const value = route.query.role;
  return value === 'SUPPLIER' || value === 'VENDOR' ? value : 'CUSTOMER';
});

const roleLabel = computed(() =>
  role.value === 'SUPPLIER' ? 'Suppliers' : role.value === 'VENDOR' ? 'Vendors' : 'Customers',
);

const ledger = ref<PartyLedgerResponse | null>(null);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

/*
 * The date window. Both ends are inclusive, and both are optional — the default
 * is the whole history, because "what does this person owe me and how did it
 * get there" is the question this screen exists for, and a default window would
 * silently answer a narrower one.
 */
const fromDate = ref('');
const toDate = ref('');

const rows = computed(() => ledger.value?.rows ?? []);

async function load(cursor: string | null = null): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || partyId.value === '') return;

  busy.value = true;
  failure.value = null;

  try {
    const page = await fetchPartyLedger(token, partyId.value, {
      ...(fromDate.value === '' ? {} : { fromDate: fromDate.value }),
      ...(toDate.value === '' ? {} : { toDate: toDate.value }),
      ...(cursor === null ? {} : { cursor }),
    });

    /*
     * Paging appends. The running balances already account for everything
     * before the page (the server sums it), so the rows join on without
     * recomputing — which is what keeps page two's first running total equal
     * to page one's last plus its own amount.
     */
    ledger.value =
      cursor === null || ledger.value === null
        ? page
        : { ...page, rows: [...ledger.value.rows, ...page.rows] };
  } catch (cause) {
    failure.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

function money(minor: number): string {
  return `৳${Money(minor).format()}`;
}

/** §2.4's display mapping, the same one the parties list applies. */
function balanceText(balance: PartyLedgerResponse['openingBalance']): string {
  if (balance.direction === 'SETTLED') return 'Settled';
  return balance.direction === 'RECEIVABLE'
    ? `${money(balance.outstandingMinor)} পাবো`
    : `${money(balance.advanceMinor)} দিব`;
}

function balanceClass(direction: string): string {
  return `balance-${direction.toLowerCase()}`;
}

/**
 * What produced a row, in a shopkeeper's words rather than the posting
 * kernel's. An unmapped type falls back to the raw code rather than to an empty
 * cell — a line nobody can explain is exactly the line worth showing plainly.
 */
const DOCUMENT_LABELS: Record<string, string> = {
  OPENING_BALANCE: 'Opening balance',
  SALE: 'Sale',
  SALE_RETURN: 'Sale return',
  PURCHASE: 'Purchase',
  PURCHASE_RETURN: 'Purchase return',
  PAYMENT: 'Payment',
  RECEIPT: 'Receipt',
};

function documentLabel(type: string): string {
  return DOCUMENT_LABELS[type] ?? type;
}

function goBack(): void {
  void router.push(`/parties?role=${role.value}`);
}

onMounted(() => void load());

// A new party id means a different ledger, not another page of this one.
watch(partyId, () => {
  ledger.value = null;
  void load();
});
</script>

<template>
  <AppShell
    title="Ledger"
    :breadcrumb="['Dashboard', roleLabel, ledger?.partyName ?? 'Ledger']"
    help-bn="এই পক্ষের সব লেনদেন আর বকেয়ার হিসাব"
  >
    <AppCard>
      <template #header>
        <div class="ledger-head">
          <div>
            <button type="button" class="linkish" @click="goBack">← Back to list</button>
            <h1>{{ ledger?.partyName ?? 'Ledger' }}</h1>
          </div>
          <div v-if="ledger !== null" class="closing">
            <span class="closing-label">Balance <span class="sher-bn">পাবো / দিব</span></span>
            <strong :class="balanceClass(ledger.closingBalance.direction)">
              {{ balanceText(ledger.closingBalance) }}
            </strong>
          </div>
        </div>
      </template>

      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <div class="filters">
        <label>
          From
          <input v-model="fromDate" type="date" @change="load()" />
        </label>
        <label>
          To
          <input v-model="toDate" type="date" @change="load()" />
        </label>
      </div>

      <EmptyState
        v-if="!busy && rows.length === 0"
        icon="pi-book"
        title="Nothing posted in this period"
      />

      <template v-else>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date <span class="sher-bn header-bn">তারিখ</span></th>
                <th>Document</th>
                <th>Number</th>
                <th class="num">Debit</th>
                <th class="num">Credit</th>
                <th class="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              <!--
                The opening row. Present even when zero, because a statement
                that starts mid-history without saying what it started from is
                a statement nobody can check against their own records.
              -->
              <tr v-if="ledger !== null" class="opening-row">
                <td>{{ fromDate === '' ? '—' : fromDate }}</td>
                <td colspan="4">Opening balance</td>
                <td class="num" :class="balanceClass(ledger.openingBalance.direction)">
                  {{ balanceText(ledger.openingBalance) }}
                </td>
              </tr>

              <tr v-for="row in rows" :key="row.journalLineId">
                <td>{{ row.businessDate }}</td>
                <td>{{ documentLabel(row.sourceDocumentType) }}</td>
                <td class="mono">{{ row.sourceNumber }}</td>
                <td class="num">{{ row.debitMinor === 0 ? '—' : money(row.debitMinor) }}</td>
                <td class="num">{{ row.creditMinor === 0 ? '—' : money(row.creditMinor) }}</td>
                <td class="num">{{ money(Math.abs(row.runningBalanceMinor)) }}</td>
              </tr>
            </tbody>
            <tfoot v-if="ledger !== null">
              <tr>
                <td colspan="3">Totals for this period</td>
                <td class="num">{{ money(ledger.totalDebitMinor) }}</td>
                <td class="num">{{ money(ledger.totalCreditMinor) }}</td>
                <td class="num" :class="balanceClass(ledger.closingBalance.direction)">
                  {{ balanceText(ledger.closingBalance) }}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div v-if="ledger?.page.hasMore" class="paging">
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="busy"
            @click="load(ledger?.page.nextCursor ?? null)"
          >
            Show more
          </button>
        </div>
      </template>
    </AppCard>
  </AppShell>
</template>

<style scoped>
.ledger-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.ledger-head h1 {
  margin: 0.25rem 0 0;
  font-size: 1.25rem;
}

.closing {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.125rem;
  font-variant-numeric: tabular-nums;
}

.closing-label {
  font-size: 0.8125rem;
  color: var(--sher-muted-fg, #64748b);
}

.filters {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.75rem 0;
}

.filters label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}

/* Wide content scrolls in its own box; the page never scrolls sideways. */
.table-wrap {
  overflow-x: auto;
}

/* UI-32: money right-aligned, with tabular figures. */
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.mono {
  font-variant-numeric: tabular-nums;
}

.opening-row,
tfoot tr {
  font-weight: 600;
  background: var(--sher-subtle-bg, rgb(0 0 0 / 3%));
}

.balance-receivable {
  color: var(--sher-ok-fg, #15803d);
}

.balance-payable {
  color: var(--sher-bad-fg, #b91c1c);
}

.balance-settled {
  color: var(--sher-muted-fg, #64748b);
}

.paging {
  display: flex;
  justify-content: center;
  padding-top: 0.75rem;
}
</style>
