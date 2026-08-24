<script setup lang="ts">
import type { PartyLedgerResponse, PartyResponse, PartyRoleValue } from '@sher/core-contracts';
import { Money } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchParty, fetchPartyLedger, fetchPartyOpening } from '../api/parties';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import PartyOpeningDialog from '../components/parties/PartyOpeningDialog.vue';
import PartyFormPage from './PartyFormPage.vue';

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

/**
 * Red for outstanding, green for an advance — the same rule the list applies,
 * keyed on the role rather than the direction, so a supplier the shop owes is
 * as red as a customer who owes the shop.
 */
function balanceClass(direction: string): string {
  if (direction === 'SETTLED') return 'balance-settled';
  const outstanding =
    role.value === 'CUSTOMER' ? direction === 'RECEIVABLE' : direction === 'PAYABLE';
  return outstanding ? 'balance-due' : 'balance-advance';
}

/**
 * What produced a row, in a shopkeeper's words rather than the posting
 * kernel's. An unmapped type falls back to the raw code rather than to an empty
 * cell — a line nobody can explain is exactly the line worth showing plainly.
 */
const DOCUMENT_LABELS: Record<string, string> = {
  OPENING_BALANCE: 'Opening balance',
  // Named for what it is rather than left as the raw posting code, which was
  // both unreadable and wide enough to push the statement into a horizontal
  // scroll — on paper, off the edge of the page.
  OPENING_BALANCE_CORRECTION: 'Opening correction',
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

/* ------------------------------------------------------------- the hub bits */

/** The party themselves, for the header, the actions and the edit dialog. */
const party = ref<PartyResponse | null>(null);
const editing = ref(false);
const openingOpen = ref(false);
const hasOpening = ref(false);

const RIGHTS: Record<PartyRoleValue, string> = {
  CUSTOMER: 'party.customer.edit',
  SUPPLIER: 'party.supplier.edit',
  VENDOR: 'party.vendor.edit',
};

const canEdit = computed(() => session.can(RIGHTS[role.value]));

/** §5.6: the same figure, named for the role reading it. */
const closingLabel = computed(() => (role.value === 'CUSTOMER' ? 'Current Due' : 'Payable'));
const closingLabelBn = computed(() => (role.value === 'CUSTOMER' ? 'পাবো' : 'দিব'));

/** The closing balance split into its word and its amount, for the totals row. */
const closingWord = computed(() => {
  const direction = ledger.value?.closingBalance.direction;
  if (direction === undefined || direction === 'SETTLED') return 'Settled';
  return direction === 'RECEIVABLE' ? 'পাবো' : 'দিব';
});

const closingAmount = computed(() => {
  const balance = ledger.value?.closingBalance;
  if (balance === undefined || balance.direction === 'SETTLED') return money(0);
  return money(
    balance.direction === 'RECEIVABLE' ? balance.outstandingMinor : balance.advanceMinor,
  );
});

/**
 * §5.6's primary hub actions, none of which can post yet.
 *
 * Shown disabled rather than absent by owner decision (2026-08-22). UI-09 and
 * §5.6 both say an unimplemented action stays absent, so this is a recorded
 * deviation: the tooltip carries the reason so a disabled button is at least
 * explained rather than merely dead.
 */
const futureActions = computed(() => {
  if (role.value === 'SUPPLIER') {
    return [
      { label: 'Pay supplier', icon: 'pi-wallet', hint: 'Arrives with Purchases' },
      { label: 'New purchase', icon: 'pi-shopping-cart', hint: 'Arrives with Purchases' },
    ];
  }
  if (role.value === 'VENDOR') {
    return [{ label: 'Pay vendor', icon: 'pi-wallet', hint: 'Arrives with Consignment' }];
  }
  return [
    { label: 'Receive payment', icon: 'pi-wallet', hint: 'Arrives with Sales' },
    { label: 'New sale', icon: 'pi-shopping-cart', hint: 'Arrives with Sales' },
  ];
});

async function loadParty(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || partyId.value === '') return;
  try {
    party.value = await fetchParty(token, partyId.value);
    hasOpening.value =
      (await fetchPartyOpening(token, partyId.value, role.value)) !== null;
  } catch (cause) {
    failure.value = describe(cause);
  }
}

async function onEdited(): Promise<void> {
  editing.value = false;
  await Promise.all([loadParty(), load()]);
}

async function onOpeningSaved(): Promise<void> {
  openingOpen.value = false;
  await Promise.all([loadParty(), load()]);
}

/**
 * §5.6's "print/share a statement".
 *
 * The browser's own print dialog over a print stylesheet, rather than a PDF
 * dependency: what a shop actually does with a statement is hand it over or
 * photograph it, and the page already holds every figure it needs.
 */
function printStatement(): void {
  window.print();
}

onMounted(() => {
  void load();
  void loadParty();
});

// A new party id means a different ledger, not another page of this one.
watch(partyId, () => {
  ledger.value = null;
  party.value = null;
  void load();
  void loadParty();
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
            <button type="button" class="linkish no-print" @click="goBack">← Back to list</button>
            <h1>{{ ledger?.partyName ?? 'Ledger' }}</h1>
            <!--
              §5.6's hub: the party's own details sit above their statement, so
              the operator can act on this person without leaving and searching
              for them again.
            -->
            <p v-if="party !== null" class="party-contact">
              <span v-if="party.phone !== null" class="mono">{{ party.phone }}</span>
              <span v-if="party.address !== null">{{ party.address }}</span>
            </p>
          </div>
          <div v-if="ledger !== null" class="closing">
            <span class="closing-label">
              {{ closingLabel }} <span class="sher-bn">{{ closingLabelBn }}</span>
            </span>
            <strong :class="balanceClass(ledger.closingBalance.direction)">
              {{ balanceText(ledger.closingBalance) }}
            </strong>
          </div>
        </div>
      </template>

      <!--
        §5.6's hub actions. Receive Payment / New Sale (and the supplier and
        vendor equivalents) belong to modules that do not exist yet, so they are
        shown disabled with a tooltip saying when they arrive — the owner's
        decision of 2026-08-22, recorded in the change log because UI-09 and
        §5.6 would otherwise leave them out entirely until then.
      -->
      <div v-if="party !== null" class="hub-actions no-print">
        <button
          v-for="action in futureActions"
          :key="action.label"
          type="button"
          class="btn btn-primary"
          disabled
          :title="action.hint"
        >
          <i :class="`pi ${action.icon}`" aria-hidden="true" /> {{ action.label }}
        </button>

        <button
          v-if="canEdit && !party.isSystemReserved"
          type="button"
          class="btn btn-ghost"
          @click="editing = true"
        >
          <i class="pi pi-pencil" aria-hidden="true" /> Edit details
        </button>
        <button
          v-if="canEdit && !party.isSystemReserved"
          type="button"
          class="btn btn-ghost"
          @click="openingOpen = true"
        >
          <i class="pi pi-wallet" aria-hidden="true" />
          {{ hasOpening ? 'Correct opening balance' : 'Set opening balance' }}
        </button>
        <button type="button" class="btn btn-ghost" @click="printStatement">
          <i class="pi pi-print" aria-hidden="true" /> Print statement
        </button>
      </div>

      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <!--
        The shared picker, not a native `<input type="date">`: the native one
        renders as `mm/dd/yyyy` in the browser's own locale, which is the wrong
        order for a shop reading `2026-08-22` everywhere else on the screen.
      -->
      <div class="filters no-print">
        <label class="filter">
          <span>From <span class="sher-bn">শুরুর তারিখ</span></span>
          <DateOnlyPicker
            v-model="fromDate"
            input-id="ledger-from"
            placeholder="Any time"
            @update:model-value="load()"
          />
        </label>
        <label class="filter">
          <span>To <span class="sher-bn">শেষ তারিখ</span></span>
          <DateOnlyPicker
            v-model="toDate"
            input-id="ledger-to"
            placeholder="Today"
            @update:model-value="load()"
          />
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
            <!--
              The closing figure is the one thing anyone carries away from a
              statement, so it is set as a labelled amount rather than run
              together as "৳6,000.00 পাবো" in a bold colour — which read as a
              stray phrase rather than a total.
            -->
            <tfoot v-if="ledger !== null">
              <tr>
                <td colspan="3" class="totals-label">Total for this period</td>
                <td class="num">{{ money(ledger.totalDebitMinor) }}</td>
                <td class="num">{{ money(ledger.totalCreditMinor) }}</td>
                <td class="num closing-cell">
                  <span class="closing-word">{{ closingWord }}</span>
                  <strong :class="balanceClass(ledger.closingBalance.direction)">
                    {{ closingAmount }}
                  </strong>
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

    <!--
      §5.6: edit party master data "without leaving and re-searching the party".
      The same form the list and the route render, embedded over the hub, so the
      statement is still underneath when the dialog closes.
    -->
    <Dialog
      v-model:visible="editing"
      modal
      :header="party?.name ?? 'Edit'"
      :style="{ width: 'min(48rem, 96vw)' }"
      :draggable="false"
    >
      <PartyFormPage
        v-if="editing && party !== null"
        embedded
        :embedded-party-id="party.id"
        :embedded-role="role"
        @saved="onEdited"
        @close="editing = false"
      />
    </Dialog>

    <PartyOpeningDialog
      v-if="openingOpen && party !== null"
      :party="party"
      :role="role"
      @saved="onOpeningSaved"
      @close="openingOpen = false"
    />
  </AppShell>
</template>

<style scoped>
.party-contact {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-3);
  margin: 4px 0 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}

.hub-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-2);
  margin-bottom: var(--sher-space-4);
}

/*
 * §5.6's "print/share a statement", as the browser's own print.
 *
 * Everything that is a control disappears: a printed statement is handed to
 * someone or filed, and a paper button is noise. What survives is the party,
 * the period, the rows and the closing balance — which is what a statement is.
 */
@media print {
  .no-print,
  .hub-actions,
  .filters,
  .paging {
    display: none !important;
  }

  .table-wrap {
    overflow: visible;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  /* A statement runs over pages; a header that appears once is unreadable. */
  thead {
    display: table-header-group;
  }

  tr {
    break-inside: avoid;
  }
}

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

.balance-due {
  color: var(--sher-bad-fg, #b91c1c);
}

.balance-advance {
  color: var(--sher-ok-fg, #15803d);
}

.balance-settled {
  color: var(--sher-muted-fg, #64748b);
}

.totals-label {
  font-weight: 600;
}

/* Word above, amount below — a total, not a sentence. */
.closing-cell {
  white-space: nowrap;
}

.closing-word {
  display: block;
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--sher-muted-fg, #64748b);
}

/*
 * Document numbers are long and monospaced. Letting the column shrink and the
 * value wrap keeps the statement inside the page instead of pushing the
 * balance column off the right edge — on screen and on paper.
 */
td.mono {
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.paging {
  display: flex;
  justify-content: center;
  padding-top: 0.75rem;
}
</style>
