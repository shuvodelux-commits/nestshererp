<script setup lang="ts">
import type {
  CashSessionResponse, DaybookRow, DayStatusResponse, ExpenseCategoryResponse, PartyResponse,
} from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchDaybook } from '../api/daybook';
import { fetchExpenses } from '../api/expenses';
import { fetchDayStatus } from '../api/money';
import { fetchParties } from '../api/parties';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import EndDayDialog from '../components/money/EndDayDialog.vue';
import TransferMoneyDialog from '../components/money/TransferMoneyDialog.vue';
import RecordExpenseDialog from '../components/money/RecordExpenseDialog.vue';
import StartDayDialog from '../components/money/StartDayDialog.vue';
import PaySupplierDialog from '../components/purchasing/PaySupplierDialog.vue';
import ReceivePaymentDialog from '../components/sales/ReceivePaymentDialog.vue';
import { taka } from '../components/money/money-text';
import { onDataChanged } from '../state/data-freshness';

/**
 * Counter · কাউন্টার (§5.16, D-42, UI-53, UI-67).
 *
 * **A launcher, not a module.** Every button here opens the dialog that already
 * owns that action, under that module's own permission, and Counter posts
 * nothing itself — the same relationship Daybook has to the modules it reviews
 * (UI-72). It exists because the manual money a shop handles between sales
 * lives in five different places, and the person doing it is standing at one
 * counter with a queue in front of them.
 *
 * **English-primary with Bangla helper** (owner decision 2026-08-31, amending
 * UI-74). The counter workflow reads the same way end to end: the launcher and
 * the dialogs it opens both put the English label first and the Bangla under
 * it, so nothing changes register halfway through a task.
 *
 * The list underneath is **read from Daybook**, not from a table of Counter's
 * own. It is there so a cashier who cannot remember whether they already
 * entered that ৳500 can see that they did, before entering it twice.
 */
const session = useSession();
const router = useRouter();

const status = ref<DayStatusResponse | null>(null);
const recent = ref<readonly DaybookRow[]>([]);
const categories = ref<readonly ExpenseCategoryResponse[]>([]);
const customers = ref<readonly PartyResponse[]>([]);
const suppliers = ref<readonly PartyResponse[]>([]);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const showStart = ref(false);
const showEnd = ref(false);
const showExpense = ref(false);
const showMove = ref(false);
/** Which party is being picked, and for which of the two money dialogs. */
const picking = ref<'RECEIVE' | 'PAY' | null>(null);
const pickedPartyId = ref('');
const receiveFrom = ref<PartyResponse | null>(null);
const payTo = ref<PartyResponse | null>(null);

const held = computed(() => session.permissions.value);
const may = (code: string): boolean => held.value.includes(code);

const today = computed(() => status.value?.businessDate ?? '');
const openToday = computed<CashSessionResponse | null>(() => {
  const day = status.value?.todaySession ?? null;
  return day?.status === 'OPEN' ? day : null;
});
const drawerMinor = computed(() => openToday.value?.expectedClosingMinor ?? null);

/**
 * The six actions, in the order a counter meets them. Each is hidden rather
 * than disabled when its permission is missing (UI-09) — and Counter itself is
 * only in the menu when at least one of them survives, so the screen can never
 * arrive empty.
 */
const actions = computed(() => {
  const items: Array<{
    key: string; label: string; bn: string; icon: string; run: () => void;
  }> = [];
  if (may('sale.payment.record')) {
    items.push({
      key: 'receive',
      label: 'Receive Money',
      bn: 'কাস্টমারের কাছ থেকে টাকা নিন',
      icon: 'pi pi-arrow-down-left',
      run: () => { pickedPartyId.value = ''; picking.value = 'RECEIVE'; },
    });
  }
  if (may('purchase.payment.record')) {
    items.push({
      key: 'pay',
      label: 'Pay Supplier',
      bn: 'সাপ্লায়ারকে টাকা দিন',
      icon: 'pi pi-arrow-up-right',
      run: () => { pickedPartyId.value = ''; picking.value = 'PAY'; },
    });
  }
  if (may('expense.record')) {
    items.push({
      key: 'expense',
      label: 'Expense',
      bn: 'খরচ লিখুন',
      icon: 'pi pi-receipt',
      run: () => { showExpense.value = true; },
    });
  }
  /*
   * Moving money is Counter's, and it opens **Finance's** transfer dialog with
   * the drawer already chosen as the source (owner decision 2026-08-31). One
   * form, one set of rules, one posting path, whether the deposit is entered
   * here or from Finance.
   *
   * Owner Money left this list on the same decision: it belongs to Capital &
   * Loans, behind `owner.capital.record`, because recording what the owner took
   * home is a different trust from banking the day's takings.
   */
  if (may('cash.movement.record')) {
    items.push({
      key: 'move',
      label: 'Move Money',
      bn: 'টাকা সরান — ব্যাংকে বা সিন্দুকে',
      icon: 'pi pi-arrows-h',
      run: () => { showMove.value = true; },
    });
  }
  if (openToday.value !== null && may('cash.session.close')) {
    items.push({
      key: 'end',
      label: 'End Day',
      bn: 'দিন শেষ করুন — ড্রয়ার গুনুন',
      icon: 'pi pi-lock',
      run: () => { showEnd.value = true; },
    });
  } else if (may('cash.session.start')) {
    items.push({
      key: 'start',
      label: 'Start Day',
      bn: 'দিন শুরু করুন',
      icon: 'pi pi-play',
      run: () => { showStart.value = true; },
    });
  }
  return items;
});

const partyOptions = computed(() =>
  (picking.value === 'PAY' ? suppliers.value : customers.value).map((party) => ({
    label: party.name,
    value: party.id,
  })),
);

async function load(): Promise<void> {
  const token = session.accessToken.value ?? '';
  loading.value = true;
  failure.value = null;
  try {
    status.value = await fetchDayStatus(token);
    const day = status.value.businessDate;

    /*
     * Today's rows, newest first, from Daybook's own read model. A cashier
     * without `daybook.view.all_users` sees only what they recorded
     * themselves, which is exactly the list that stops *them* double-entering.
     */
    if (may('daybook.view')) {
      const book = await fetchDaybook(token, { from: day, to: day, limit: 8 });
      recent.value = [...book.rows].reverse().slice(0, 8);
    }
    if (may('expense.record')) {
      categories.value = (await fetchExpenses(token, { limit: 1 })).categories;
    }
    if (may('sale.payment.record')) {
      customers.value = (await fetchParties(token, { role: 'CUSTOMER', limit: 200 })).data;
    }
    if (may('purchase.payment.record')) {
      suppliers.value = (await fetchParties(token, { role: 'SUPPLIER', limit: 200 })).data;
    }
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the counter' };
  } finally {
    loading.value = false;
  }
}

function confirmParty(): void {
  const list = picking.value === 'PAY' ? suppliers.value : customers.value;
  const party = list.find((one) => one.id === pickedPartyId.value) ?? null;
  if (party === null) return;
  if (picking.value === 'PAY') payTo.value = party;
  else receiveFrom.value = party;
  picking.value = null;
}

function done(): void {
  receiveFrom.value = null;
  payTo.value = null;
  showExpense.value = false;
  showMove.value = false;
  showStart.value = false;
  showEnd.value = false;
  void load();
}

onMounted(load);
onDataChanged(load);

/*
 * Phase 18.5, found by the E2E suite (2026-09-03).
 *
 * `load()` decides *what* to fetch from the permissions this session holds, and
 * on a cold open it can run before `/api/v1/me` has answered. When it does, the
 * customer list, the supplier list and the expense categories are all skipped —
 * and nothing ever asks for them again, because the only other trigger is a
 * write. The screen then looks completely normal: the six action tiles are
 * there, the drawer figure is there, and `Receive Money` opens a picker that
 * says "No available options", so a cashier with a customer standing in front
 * of them simply cannot take the money until they leave the page and come back.
 *
 * Re-running when the permissions arrive is the whole fix. It is not a retry
 * loop and it cannot run twice for the same set: `before.length === 0` is only
 * true for the one transition from "not yet known" to "known".
 */
watch(held, (codes, before) => {
  if (before.length === 0 && codes.length > 0) void load();
});
</script>

<template>
  <AppShell
    title="Counter"
    :breadcrumb="['Daily', 'Counter']"
    help-bn="কাউন্টার — হাতে হাতে টাকার কাজ"
  >
    <!--
      Phase 18.2: the title and the Bangla helper line were drawn twice — once
      by `AppShell`, once again by this page's own header underneath it. The
      page's copy is gone and the only thing that header actually carried, the
      day chip and the drawer figure, has moved into the actions slot every
      other screen puts its own furniture in.
    -->
    <template #actions>
      <div class="ctr__day">
        <template v-if="openToday !== null">
          <span class="ctr__chip is-open">Day open · {{ today }}</span>
          <strong v-if="drawerMinor !== null">In the drawer now: {{ taka(drawerMinor) }}</strong>
        </template>
        <span v-else class="ctr__chip is-shut">Day not started · {{ today }}</span>
      </div>
    </template>

    <div class="ctr">
      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <div class="ctr__grid">
        <button
          v-for="action in actions"
          :key="action.key"
          type="button"
          class="ctr__action"
          @click="action.run()"
        >
          <i :class="`pi ${action.icon}`" aria-hidden="true" />
          <span class="ctr__action-label">{{ action.label }}</span>
          <span class="ctr__action-bn">{{ action.bn }}</span>
        </button>
      </div>

      <AppCard
        title="Entered today"
        subtitle-bn="আজ যা যা তোলা হয়েছে"
        icon="pi-list"
      >
        <template #actions>
          <button type="button" class="btn btn-ghost" @click="router.push('/daybook')">
            View all today
          </button>
        </template>
        <p class="ctr__hint">
          Check here before you enter something again — আগে দেখে নিন, একই টাকা যেন দুইবার না ওঠে
        </p>
        <!--
          UI-29 and the Phase 18.2 pattern: an empty state gets one sentence and
          one button. It had neither — a bare heading, which tells a cashier
          nothing about whether that is normal at half past nine.
        -->
        <EmptyState
          v-if="!loading && recent.length === 0"
          icon="pi-inbox"
          title="Nothing entered yet today"
        >
          Money taken, money paid and what the shop spent will appear here as you record them.
          Sales rung up at the POS are not counter work and show in Daybook instead.
          <template #action>
            <button type="button" class="btn btn-ghost" @click="router.push('/daybook')">
              See the whole day
            </button>
          </template>
        </EmptyState>
        <ul v-else class="ctr__list">
          <li v-for="row in recent" :key="row.id">
            <span class="ctr__time">{{ row.createdAt.slice(11, 16) }}</span>
            <span class="ctr__what">{{ row.description }}</span>
            <span class="ctr__amount">{{ taka(row.amountMinor) }}</span>
          </li>
        </ul>
      </AppCard>
    </div>

    <!-- Choosing who the money is with, before the module's own dialog opens -->
    <Dialog
      :visible="picking !== null"
      modal
      :header="picking === 'PAY' ? 'Pay Supplier — কাকে টাকা দেবেন?' : 'Receive Money — কার কাছ থেকে?'"
      :style="{ width: 'min(30rem, 94vw)' }"
      @update:visible="picking = null"
    >
      <div class="field">
        <label for="ctr-party">
          {{ picking === 'PAY' ? 'Supplier' : 'Customer' }}
          <span>{{ picking === 'PAY' ? 'সাপ্লায়ার' : 'কাস্টমার' }}</span>
        </label>
        <!--
          Appended to the **body**, not to the dialog (owner-reported
          2026-08-31). Inside the dialog the panel is clipped by its own box, so
          a long party list cannot be scrolled, and the filter box collapses the
          panel when it takes focus. Every other picker that lives in a dialog
          already appends to the body — `PaySupplierDialog` and the rest.
        -->
        <Select
          v-model="pickedPartyId"
          input-id="ctr-party"
          :options="partyOptions"
          option-label="label"
          option-value="value"
          filter
          append-to="body"
          fluid
        />
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" @click="picking = null">Cancel</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="pickedPartyId === ''"
          @click="confirmParty"
        >
          Continue
        </button>
      </div>
    </Dialog>

    <ReceivePaymentDialog
      v-if="receiveFrom !== null"
      :party-id="receiveFrom.id"
      :party-name="receiveFrom.name"
      @close="receiveFrom = null"
      @received="done"
    />

    <PaySupplierDialog
      v-if="payTo !== null"
      :supplier-id="payTo.id"
      :supplier-name="payTo.name"
      @close="payTo = null"
      @paid="done"
    />

    <RecordExpenseDialog
      v-if="showExpense"
      :categories="categories"
      @close="showExpense = false"
      @recorded="done"
    />

    <TransferMoneyDialog
      v-if="showMove"
      :from-account-id="status?.drawerAccountId ?? null"
      @close="showMove = false"
      @saved="done"
    />

    <StartDayDialog
      v-if="showStart && status !== null"
      :status="status"
      @close="showStart = false"
      @started="done"
    />

    <EndDayDialog
      v-if="showEnd && openToday !== null"
      :day="openToday"
      @close="showEnd = false"
      @closed="done"
    />
  </AppShell>
</template>

<style scoped>
.ctr {
  display: grid;
  gap: var(--sher-space-4);
}

/* The page's second copy of the shell header is gone; only its chip remains. */

.ctr__day {
  display: grid;
  gap: 4px;
  justify-items: end;
  font-variant-numeric: tabular-nums;
}

.ctr__chip {
  font-size: 0.78rem;
  padding: 0.1rem 0.5rem;
  border-radius: var(--sher-radius-pill);
  background: var(--sher-sunken);
}

.ctr__chip.is-open { color: var(--sher-ok); }
.ctr__chip.is-shut { color: var(--sher-warn); }

.ctr__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: var(--sher-space-3);
}

.ctr__action {
  display: grid;
  gap: 4px;
  justify-items: start;
  min-height: 6rem;
  padding: var(--sher-space-3);
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius-lg);
  background: var(--sher-raised);
  color: var(--sher-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: var(--sher-transition);
}

.ctr__action:hover {
  border-color: var(--sher-primary);
  background: var(--sher-hover);
}

.ctr__action i {
  font-size: 1.25rem;
  color: var(--sher-primary);
}

.ctr__action-label {
  font-weight: 600;
}

.ctr__action-bn {
  color: var(--sher-text-muted);
  font-size: 11px;
}

.ctr__hint {
  margin: 0 0 var(--sher-space-2);
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
}

.ctr__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}

.ctr__list li {
  display: grid;
  grid-template-columns: 3.5rem 1fr auto;
  gap: var(--sher-space-2);
  padding: 6px 0;
  border-bottom: 1px solid var(--sher-line-soft);
  font-variant-numeric: tabular-nums;
}

.ctr__time,
.ctr__amount {
  color: var(--sher-text-muted);
}

.ctr__amount {
  color: var(--sher-text);
  font-weight: 600;
}

.field label span {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
  font-weight: 400;
}
</style>
