<script setup lang="ts">
import type { DaybookPrint, DaybookResponse, DaybookRow } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import Menu from 'primevue/menu';
import Select from 'primevue/select';
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import {
  cancelDocument, canCancelKind, fetchDaybook, markDayReviewed, recordDaybookPrint,
} from '../api/daybook';
import { isRedatableKind } from '../api/corrections';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import CancelDocumentDialog from '../components/CancelDocumentDialog.vue';
import ChangeTransactionDateDialog from '../components/corrections/ChangeTransactionDateDialog.vue';
import DaybookSheet from '../components/daybook/DaybookSheet.vue';
import { printNode } from '../components/sales/invoice-output';
import { taka } from '../components/money/money-text';
import { onDataChanged } from '../state/data-freshness';

/**
 * Daybook · দিনের হিসাব (§5.27, D-27).
 *
 * The layout the owner chose: **the day's money summary on top, then one
 * time-ordered list of everything that happened** — it reads like the notebook,
 * one line per thing, in the order it happened.
 *
 * **Nothing on this screen posts anything.** A row's ⋯ menu opens the owning
 * module's own screen or dialog, carrying that module's own permission, and
 * comes back to the same day. Which actions a row offers is decided by the
 * server (`row.actions`), because whether a bill can still be corrected depends
 * on the period lock, the document's status, what has been drawn from its lots
 * and the user's permissions — four things the browser does not know.
 */
const session = useSession();
const router = useRouter();

const today = new Date().toISOString().slice(0, 10);
const from = ref(today);
const to = ref(today);
const dateBasis = ref<'BUSINESS_DATE' | 'CREATED_AT'>('BUSINESS_DATE');
const kind = ref('');

const daybook = ref<DaybookResponse | null>(null);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);

const reviewing = ref<string | null>(null);
const reviewNote = ref('');
const printFormat = ref<'A4' | 'THERMAL_80'>('A4');
const lastPrint = ref<DaybookPrint | null>(null);
const sheet = ref<HTMLElement | null>(null);
const showSheet = ref(false);

const cancelling = ref<DaybookRow | null>(null);

/*
 * Phase 11.2 — the row whose date is being moved. Daybook opens the one
 * authoritative dialog and posts nothing itself (DR1, DR8, UI-72).
 */
const redating = ref<DaybookRow | null>(null);
const rowMenu = ref<InstanceType<typeof Menu> | null>(null);
const menuRow = ref<DaybookRow | null>(null);

const canReview = computed(() => session.can('daybook.review.mark'));
const canPrint = computed(() => session.can('daybook.print'));
const canEntryDate = computed(() => session.can('daybook.view.entry_date'));

const kindOptions = [
  { value: '', label: 'Everything — সব' },
  { value: 'SALE', label: 'Sales — বিক্রি' },
  { value: 'PURCHASE', label: 'Purchases — কেনা' },
  { value: 'CUSTOMER_RECEIPT', label: 'Money received — টাকা এসেছে' },
  { value: 'SUPPLIER_PAYMENT', label: 'Money paid — টাকা দেওয়া' },
  { value: 'EXPENSE', label: 'Expenses — খরচ' },
  { value: 'SALES_RETURN', label: 'Customer returns — বিক্রি ফেরত' },
  { value: 'PURCHASE_RETURN', label: 'Supplier returns — কেনা ফেরত' },
  { value: 'CASH_MOVEMENT', label: 'Cash moved — টাকা সরানো' },
  { value: 'STOCK_ADJUSTMENT', label: 'Stock changes — স্টক ঠিক করা' },
  { value: 'DAY_CLOSE', label: 'Day open/close — দিন শুরু-শেষ' },
];

const days = computed(() => daybook.value?.days ?? []);
const rows = computed(() => daybook.value?.rows ?? []);
const firstDay = computed(() => days.value[0] ?? null);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  error.value = null;
  try {
    daybook.value = await fetchDaybook(token, {
      from: from.value,
      to: to.value,
      dateBasis: dateBasis.value,
      ...(kind.value === '' ? {} : { kind: kind.value as never }),
      limit: 300,
    });
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load the daybook' };
  } finally {
    loading.value = false;
  }
}

function shiftDay(days: number): void {
  const at = new Date(`${from.value}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  const moved = at.toISOString().slice(0, 10);
  from.value = moved;
  to.value = moved;
  void load();
}

/*
 * Every action here **leaves** Daybook for the module that owns the document,
 * with the day it came from in the query string so the module's own dialog can
 * return to exactly this view (DR1, DR9). Daybook never posts.
 */
function openRow(row: DaybookRow): void {
  const back = `?back=daybook&from=${from.value}&to=${to.value}`;
  switch (row.kind) {
    case 'SALE':
      void router.push(`/sales/${row.sourceId}${back}`);
      break;
    case 'PURCHASE':
      void router.push(`/purchases/${row.sourceId}${back}`);
      break;
    case 'SALES_RETURN':
      void router.push(`/sales-returns${back}`);
      break;
    case 'PURCHASE_RETURN':
      void router.push(`/purchase-returns${back}`);
      break;
    case 'EXPENSE':
      void router.push(`/expenses${back}`);
      break;
    case 'CUSTOMER_RECEIPT':
    case 'SUPPLIER_PAYMENT':
      void router.push(row.partyId === null ? `/parties${back}` : `/parties/${row.partyId}/ledger${back}`);
      break;
    case 'CASH_MOVEMENT':
    case 'DAY_CLOSE':
      void router.push(`/daily-cash${back}`);
      break;
    case 'STOCK_ADJUSTMENT':
    case 'STOCK_COUNT':
      void router.push(`/inventory-report${back}`);
      break;
    default:
      break;
  }
}

/** The ⋯ menu, built from what the server said this row allows. */
const menuItems = computed(() => {
  const row = menuRow.value;
  if (row === null) return [];
  const actions = row.actions;
  const items = [];
  if (actions.open) items.push({ label: 'Open — খুলুন', icon: 'pi pi-external-link', command: () => openRow(row) });
  if (actions.edit) {
    items.push({
      label: 'Edit — ঠিক করুন',
      icon: 'pi pi-pencil',
      command: () => openRow(row),
    });
  }
  if (actions.receivePayment) items.push({ label: 'Receive payment — টাকা নিন', icon: 'pi pi-wallet', command: () => openRow(row) });
  if (actions.payBill) items.push({ label: 'Pay this bill — টাকা দিন', icon: 'pi pi-wallet', command: () => openRow(row) });
  if (actions.returnGoods) items.push({ label: 'Return goods — ফেরত', icon: 'pi pi-replay', command: () => openRow(row) });
  if (actions.changeDate && isRedatableKind(row.kind)) {
    items.push({
      label: 'Change date — তারিখ বদলান',
      icon: 'pi pi-calendar',
      command: () => {
        redating.value = row;
      },
    });
  }
  if (actions.remove) {
    items.push({
      label: 'Delete — বাতিল করুন',
      icon: 'pi pi-times-circle',
      // Phase 9.2: cancelling posts a reversal through the owning module's own
      // endpoint. Daybook opens the dialog and posts nothing itself (DR1).
      command: () => {
        cancelling.value = row;
      },
    });
  }
  /*
   * **A menu never opens empty** (owner-reported 2026-08-31: the ⋯ showed a
   * blank white box). A row with no actions and no reason from the server is a
   * gap in the capability table, not something to render as an empty popup —
   * so the row says the honest general thing and the shopkeeper is not left
   * clicking at nothing.
   */
  if (items.length === 0) {
    items.push({
      label: actions.blockedReason ?? 'Nothing can be done on this row from here',
      disabled: true,
    });
  }
  return items;
});

async function openMenu(event: Event, row: DaybookRow): Promise<void> {
  menuRow.value = row;
  /*
   * The menu is opened only **after** the model has been rebuilt for this row
   * (owner-reported 2026-08-31: the ⋯ showed an empty white box). `menuItems`
   * is computed from `menuRow`, and toggling in the same tick handed PrimeVue
   * the previous value — on the first click that is the initial `[]`, which
   * renders as an empty popup, and on every click after it, the row before.
   */
  await nextTick();
  rowMenu.value?.toggle(event);
}

/**
 * What cancelling this row will do, in the shopkeeper's words — shown in the
 * dialog before anything posts, because "reversing entry" is not a sentence
 * anybody at a counter should have to interpret.
 */
function consequenceOf(row: DaybookRow): string {
  switch (row.kind) {
    case 'SALE':
      return 'The goods go back on the shelf and the customer no longer owes this invoice.';
    case 'PURCHASE':
      return 'The goods come off the shelf and the supplier is no longer owed for this bill.';
    case 'CUSTOMER_RECEIPT':
      return 'The money leaves the account it went into, and the customer owes it again.';
    case 'SUPPLIER_PAYMENT':
      return 'The money goes back into the account it left, and the bills are owed again.';
    case 'EXPENSE':
      return 'The money goes back into the account it was paid from.';
    case 'CASH_MOVEMENT':
      return 'The money goes back where it was before this movement.';
    case 'STOCK_ADJUSTMENT':
      return 'The stock goes back to what it was before this change.';
    case 'SALES_RETURN':
      return 'The returned goods leave the shelf again and the refund or credit is undone.';
    case 'PURCHASE_RETURN':
      return 'The goods come back on the shelf and the supplier credit is undone.';
    default:
      return 'One reversing entry puts everything back where it was.';
  }
}

async function onCancelDocument(reason: string): Promise<void> {
  const token = session.accessToken.value;
  const row = cancelling.value;
  if (token === null || row === null) return;
  await cancelDocument(token, row.kind, row.sourceId, row.documentVersion ?? 0, reason);
}

async function saveReview(): Promise<void> {

  const token = session.accessToken.value;
  const day = reviewing.value;
  if (token === null || day === null) return;
  try {
    await markDayReviewed(token, {
      businessDate: day,
      note: reviewNote.value.trim() === '' ? null : reviewNote.value.trim(),
    });
    reviewing.value = null;
    reviewNote.value = '';
    await load();
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not mark the day checked' };
  }
}

/**
 * Printing records the print first, then prints what is on the screen — so the
 * paper and the `daybook_prints` row describe the same figures, and a reprint
 * can be proved identical to the copy somebody is holding.
 */
async function print(format: 'A4' | 'THERMAL_80'): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  printFormat.value = format;
  try {
    const result = await recordDaybookPrint(token, { from: from.value, to: to.value, format });
    lastPrint.value = result.print;
    daybook.value = result.daybook;
    showSheet.value = true;
    window.setTimeout(() => {
      const node = sheet.value;
      if (node !== null) printNode(node, format);
    }, 80);
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not print the day-end report' };
  }
}

onMounted(() => {
  void load();
  onDataChanged(() => void load());
});
</script>

<template>
  <AppShell
    title="Daybook"
    :breadcrumb="['Dashboard', 'Daily', 'Daybook']"
    help-bn="দিনের হিসাব — আজ দোকানে যা যা হয়েছে, এক জায়গায়"
  >
    <div class="dbk">
      <!--
        Phase 18.2: the shared `.filters` row, so Daybook's furniture sits at
        the same height and carries the same labels as every other list. The two
        day-step arrows stay — a shopkeeper reviewing yesterday steps a day at a
        time far more often than he picks a date — but they are now beside a
        labelled field instead of standing in for one.
      -->
      <div class="filters no-print">
        <div class="field">
          <label for="daybook-from">From</label>
          <div class="dbk__day">
            <Button icon="pi pi-chevron-left" text size="small" aria-label="Previous day" @click="shiftDay(-1)" />
            <DateOnlyPicker v-model="from" input-id="daybook-from" placeholder="From" @update:model-value="() => load()" />
          </div>
        </div>

        <div class="field">
          <label for="daybook-to">To</label>
          <div class="dbk__day">
            <DateOnlyPicker v-model="to" input-id="daybook-to" placeholder="To" @update:model-value="() => load()" />
            <Button icon="pi pi-chevron-right" text size="small" aria-label="Next day" @click="shiftDay(1)" />
          </div>
        </div>

        <div class="field dbk__kind">
          <label for="daybook-kind">What kind</label>
          <Select
            v-model="kind"
            input-id="daybook-kind"
            :options="kindOptions"
            option-label="label"
            option-value="value"
            append-to="self"
            fluid
            @change="() => load()"
          />
        </div>

        <Button
          v-if="canEntryDate"
          :label="dateBasis === 'BUSINESS_DATE' ? 'By day it belongs to' : 'By time it was typed'"
          icon="pi pi-clock"
          text
          size="small"
          @click="() => { dateBasis = dateBasis === 'BUSINESS_DATE' ? 'CREATED_AT' : 'BUSINESS_DATE'; load(); }"
        />

        <div class="dbk__output">
          <Button v-if="canPrint" label="Print A4" icon="pi pi-print" text size="small" @click="print('A4')" />
          <Button v-if="canPrint" label="Print roll" icon="pi pi-receipt" text size="small" @click="print('THERMAL_80')" />
        </div>
      </div>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <!-- ------------------------------------------------ the day's money -->
      <template v-for="day in days" :key="day.businessDate">
        <div class="dbk__daybar">
          <h2>{{ day.businessDate }}</h2>
          <span class="dbk__status" :class="`is-${day.dayStatus.toLowerCase()}`">
            {{ day.dayStatus === 'OPEN' ? 'দিন চলছে' : day.dayStatus === 'CLOSED' ? 'দিন শেষ' : 'দিন শুরু হয়নি' }}
          </span>
          <span v-if="day.reviewedAt !== null" class="dbk__checked">
            ✓ Checked by {{ day.reviewedByName }}
          </span>
          <Button
            v-if="canReview"
            :label="day.reviewedAt === null ? 'Mark as checked' : 'Check again'"
            icon="pi pi-check-square"
            text
            size="small"
            class="no-print"
            @click="() => { reviewing = day.businessDate; reviewNote = day.reviewNote ?? ''; }"
          />
        </div>

        <div class="dbk__tiles">
          <StatCard label="Opening cash" :value="taka(day.openingCashMinor)" detail="শুরুর ক্যাশ" icon="pi-wallet" tone="slate" />
          <StatCard label="Cash in" :value="taka(day.cashInMinor)" detail="জমা" icon="pi-arrow-down-left" tone="green" />
          <StatCard label="Cash out" :value="taka(day.cashOutMinor)" detail="খরচ" icon="pi-arrow-up-right" tone="rose" />
          <StatCard label="Expected" :value="taka(day.expectedClosingMinor)" detail="থাকার কথা" icon="pi-calculator" tone="blue" />
          <StatCard
            v-if="day.countedMinor !== null"
            label="Counted"
            :value="taka(day.countedMinor)"
            :detail="day.differenceMinor === 0 ? 'হিসাব মিলেছে' : day.differenceMinor !== null && day.differenceMinor < 0 ? 'টাকা কম' : 'টাকা বেশি'"
            icon="pi-check-circle"
            :tone="day.differenceMinor === 0 ? 'green' : 'amber'"
          />
        </div>

        <p v-if="day.openingMismatchMinor !== 0" class="dbk__mismatch">
          ⚠ This day opened on {{ taka(day.openingCashMinor) }}, but the previous day closed on a
          different figure — a difference of {{ taka(day.openingMismatchMinor) }}. Shown, not
          adjusted away.
        </p>

        <div v-if="day.movements.length > 0" class="dbk__movements">
          <span v-for="movement in day.movements" :key="movement.id" class="dbk__movement">
            {{ movement.label }} · {{ taka(movement.amountMinor) }}
            <small v-if="movement.reason">{{ movement.reason }}</small>
          </span>
        </div>
      </template>

      <!-- --------------------------------------------- everything that happened -->
      <AppCard>
        <!--
          UI-29 and the Phase 18.2 pattern: one sentence and one button. The
          button goes back to today rather than offering to create something —
          an empty day is almost always the wrong day, not an idle shop.
        -->
        <EmptyState v-if="!loading && rows.length === 0" icon="pi-book" title="Nothing happened on this day">
          No sale, purchase, payment or stock change was recorded on
          {{ from === to ? from : `${from} – ${to}` }}.
          <template #action>
            <button
              v-if="from !== today || to !== today"
              type="button"
              class="btn btn-ghost"
              @click="from = today; to = today; load()"
            >
              Go to today
            </button>
          </template>
        </EmptyState>

        <template v-else>
        <!--
          Phase 18.4 — the day as cards below 640px (owner decision 2026-09-03).
          Six columns will not fit a phone, and the one that fell off the right
          was Amount, which is the column somebody reviewing a day is reading.
          The ⋯ menu carries the same actions the table row does, because a
          correction is exactly what an owner reaches for on this screen.
        -->
        <ul class="list-cards">
          <li v-for="row in rows" :key="`card-${row.id}`" class="list-card">
            <span class="list-card-title" :class="row.status === 'VOIDED' ? 'dbk__void' : ''">
              {{ row.description }}
            </span>

            <span
              class="list-card-amount"
              :class="row.cashEffectMinor < 0 ? 'dbk__out' : row.cashEffectMinor > 0 ? 'dbk__in' : ''"
            >
              {{ taka(row.amountMinor) }}
            </span>

            <p class="list-card-sub">
              {{ row.createdAt.slice(11, 16) }} · {{ row.sourceNumber }}
              <template v-if="row.partyName"> · {{ row.partyName }}</template>
              <template v-if="row.accountLabel"> · {{ row.accountLabel }}</template>
              <template v-if="row.backdated"> · late entry</template>
              <template v-if="row.locked"> · month closed 🔒</template>
            </p>

            <div class="list-card-foot">
              <span class="dbk__sub">{{ row.createdByName }}</span>
              <Button
                class="dbk__card-menu no-print"
                icon="pi pi-ellipsis-v"
                text
                rounded
                size="small"
                aria-label="Actions"
                @click="(event) => openMenu(event, row)"
              />
            </div>
          </li>
        </ul>

        <DataTable
          :value="[...rows]"
          :loading="loading"
          data-key="id"
          striped-rows
          :class="rows.length > 0 ? 'phone-hidden' : ''"
        >
          <Column header="Time" style="width: 6rem">
            <template #body="{ data }">
              {{ data.createdAt.slice(11, 16) }}
              <small v-if="data.backdated" class="dbk__flag">late entry</small>
            </template>
          </Column>
          <Column header="What happened">
            <template #body="{ data }">
              <span :class="data.status === 'VOIDED' ? 'dbk__void' : ''">{{ data.description }}</span>
              <small class="dbk__sub">
                {{ data.sourceNumber }}
                <template v-if="data.reversedByNumber"> · cancelled by {{ data.reversedByNumber }}</template>
                <template v-if="data.locked"> · month closed 🔒</template>
                <template v-if="data.originalBusinessDate">
                  · moved from {{ data.originalBusinessDate }}
                  <template v-if="data.correctionReason"> — {{ data.correctionReason }}</template>
                </template>
              </small>
            </template>
          </Column>
          <Column header="Who" style="width: 12rem">
            <template #body="{ data }">
              {{ data.partyName ?? '—' }}
              <small class="dbk__sub">{{ data.createdByName }}</small>
            </template>
          </Column>
          <Column header="Account" style="width: 11rem">
            <template #body="{ data }">{{ data.accountLabel ?? '—' }}</template>
          </Column>
          <Column header="Amount" class="dbk__num" style="width: 9rem">
            <template #body="{ data }">
              <span :class="data.cashEffectMinor < 0 ? 'dbk__out' : data.cashEffectMinor > 0 ? 'dbk__in' : ''">
                {{ taka(data.amountMinor) }}
              </span>
            </template>
          </Column>
          <Column header="" style="width: 3rem" class="no-print">
            <template #body="{ data }">
              <Button icon="pi pi-ellipsis-v" text rounded size="small" aria-label="Actions" @click="(event) => openMenu(event, data)" />
            </template>
          </Column>
        </DataTable>
        </template>
      </AppCard>

      <Menu ref="rowMenu" :model="menuItems" popup />

      <!-- DR7 — what was typed late, or belongs to another day -->
      <AppCard
        v-if="daybook !== null && daybook.backdatedRows.length > 0"
        title="Entered late, or dated elsewhere"
        subtitle="পরে বসানো এন্ট্রি — DR7"
      >
        <DataTable :value="[...daybook.backdatedRows]" data-key="id">
          <Column field="businessDate" header="Belongs to" />
          <Column header="Typed on">
            <template #body="{ data }">{{ data.createdAt.slice(0, 10) }}</template>
          </Column>
          <Column field="description" header="What happened" />
          <Column header="Amount" class="dbk__num">
            <template #body="{ data }">{{ taka(data.amountMinor) }}</template>
          </Column>
        </DataTable>
      </AppCard>
    </div>

    <!-- Mark a day checked — the same compact modal every one-task action uses -->
    <Dialog
      :visible="reviewing !== null"
      modal
      header="Mark this day checked — দিন মিলিয়ে দেখলাম"
      :style="{ width: 'min(30rem, 94vw)' }"
      @update:visible="(open: boolean) => { if (!open) reviewing = null; }"
    >
      <div class="field">
        <label for="daybook-note">Note <span>কিছু লিখতে চাইলে</span></label>
        <textarea id="daybook-note" v-model="reviewNote" rows="3" placeholder="Anything that looked odd" />
      </div>
      <template #footer>
        <Button label="Cancel" text @click="reviewing = null" />
        <Button label="Mark as checked" icon="pi pi-check" @click="saveReview" />
      </template>
    </Dialog>

    <!-- Cancelling a row: the owning module's endpoint, one reason, one button -->
    <CancelDocumentDialog
      v-if="cancelling !== null && canCancelKind(cancelling.kind)"
      :title="cancelling.description"
      :consequence="consequenceOf(cancelling)"
      :amount-minor="cancelling.amountMinor"
      :submit="onCancelDocument"
      @close="cancelling = null"
      @cancelled="() => { cancelling = null; load(); }"
    />

    <!-- Moving a row to another day: one dialog, one endpoint, every screen -->
    <ChangeTransactionDateDialog
      :document-type="redating !== null && isRedatableKind(redating.kind) ? redating.kind : null"
      :document-id="redating?.sourceId ?? null"
      :label="redating?.description ?? ''"
      @close="redating = null"
      @changed="() => { redating = null; load(); }"
    />

    <!-- The printable sheet: off-screen until a print is asked for -->

    <div v-if="showSheet && daybook !== null" ref="sheet" class="dbk__sheet">
      <DaybookSheet
        :daybook="daybook"
        :print="lastPrint"
        :business-name="session.businessName.value ?? ''"
        :format="printFormat"
      />
    </div>
  </AppShell>
</template>

<style scoped>
.dbk { display: grid; gap: 1rem; }
.dbk__day { display: flex; align-items: center; gap: 0.25rem; }

.dbk__kind { min-width: 15rem; }
.dbk__output { margin-left: auto; display: flex; gap: 0.25rem; }
.dbk__daybar { display: flex; align-items: center; gap: 0.75rem; }
.dbk__daybar h2 { margin: 0; font-size: 1rem; }
.dbk__status { font-size: 0.78rem; padding: 0.1rem 0.5rem; border-radius: 999px; background: var(--sher-surface-2, #f1f5f9); }
.dbk__status.is-open { color: var(--sher-ok, #15803d); }
.dbk__status.is-closed { color: var(--sher-text-muted, #64748b); }
.dbk__status.is-not_started { color: var(--sher-warn, #b45309); }
.dbk__checked { font-size: 0.78rem; color: var(--sher-ok, #15803d); }
.dbk__tiles { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
.dbk__mismatch { margin: 0; font-size: 0.82rem; color: var(--sher-warn, #b45309); }
.dbk__movements { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.dbk__movement { font-size: 0.78rem; background: var(--sher-surface-2, #f1f5f9); padding: 0.2rem 0.55rem; border-radius: 999px; }
.dbk__movement small { display: block; color: var(--sher-text-muted, #64748b); }
.dbk__sub { display: block; color: var(--sher-text-muted, #64748b); font-size: 0.74rem; }
.dbk__flag { display: block; color: var(--sher-warn, #b45309); font-size: 0.7rem; }
.dbk__void { text-decoration: line-through; color: var(--sher-text-muted, #94a3b8); }
.dbk__num { text-align: right; }
.dbk__in { color: var(--sher-ok, #15803d); }
.dbk__out { color: var(--sher-bad, #b91c1c); }
.dbk__sheet { position: absolute; left: -10000px; top: 0; }

/* Phase 18.4 — the phone card list. Its shape is `design/components.css`'s. */
.list-card-foot .dbk__sub { display: inline; margin-right: auto; }
.dbk__card-menu { min-width: 44px; min-height: 44px; }
</style>
