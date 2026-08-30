<script setup lang="ts">
import type { ExpenseCategoryResponse, ExpenseResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import {
  addExpenseCategory,
  voidExpense,
  archiveExpenseCategory,
  fetchExpenses,
  renameExpenseCategory,
} from '../api/expenses';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import ManageListDialog from '../components/ManageListDialog.vue';
import SearchField from '../components/SearchField.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import CancelDocumentDialog from '../components/CancelDocumentDialog.vue';
import RecordExpenseDialog from '../components/money/RecordExpenseDialog.vue';
import { taka } from '../components/money/money-text';
import { onDataChanged } from '../state/data-freshness';

/**
 * Expenses · খরচ (§5.12) — a List screen (UI-22): filter bar → tiles → table.
 *
 * The tiles are the three categories the shop spent most on in whatever range
 * is showing, counted by the same query as the rows (§2.7.I). Recording one is
 * a compact modal, and the category list is managed in the dialog every other
 * piece of vocabulary uses — a shop that files things its own way should not
 * have to learn a second screen to do it.
 */
const session = useSession();

const rows = ref<readonly ExpenseResponse[]>([]);
const categories = ref<readonly ExpenseCategoryResponse[]>([]);
const totalMinor = ref(0);
const nextCursor = ref<string | null>(null);
const search = ref('');
const categoryId = ref('');
const fromDate = ref('');
const toDate = ref('');
const loading = ref(true);
const recording = ref(false);
/*
 * Phase 9.2. A posted expense is corrected in the dialog that recorded it and
 * cancelled in the one every module cancels with — the same two acts the
 * daybook offers, on the screen where the expense lives (§5.27 concentrates
 * visibility, it does not own the action).
 */
const correcting = ref<ExpenseResponse | null>(null);
const cancelling = ref<ExpenseResponse | null>(null);

const managing = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const canRecord = computed(() => session.can('expense.record'));

/** The three biggest in this view — what a shopkeeper actually asks. */
const topCategories = computed(() =>
  [...categories.value]
    .filter((category) => category.spentMinor > 0)
    .sort((left, right) => right.spentMinor - left.spentMinor)
    .slice(0, 3),
);

const categoryFilterOptions = computed(() => [
  { value: '', label: 'All categories' },
  ...categories.value.map((category) => ({ value: category.id, label: category.name })),
]);

async function load(append = false): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  failure.value = null;
  try {
    const page = await fetchExpenses(token, {
      ...(search.value.trim() === '' ? {} : { search: search.value.trim() }),
      ...(categoryId.value === '' ? {} : { categoryId: categoryId.value }),
      ...(fromDate.value === '' ? {} : { fromDate: fromDate.value }),
      ...(toDate.value === '' ? {} : { toDate: toDate.value }),
      ...(append && nextCursor.value !== null ? { cursor: nextCursor.value } : {}),
      limit: 20,
    });
    rows.value = append ? [...rows.value, ...page.expenses] : page.expenses;
    categories.value = page.categories;
    nextCursor.value = page.nextCursor;
    totalMinor.value = page.totalMinor;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load expenses' };
  } finally {
    loading.value = false;
  }
}

/*
 * The manager takes the same three functions every other vocabulary list gives
 * it (`create` returns the new id, `remove` returns the name it removed), so a
 * shopkeeper who has renamed a brand already knows how to rename a category.
 * Archiving rather than deleting is the difference, and it is the server's
 * rule: a posted expense keeps pointing at its category for ever.
 */
async function onAddCategory(name: string): Promise<string> {
  const token = session.accessToken.value;
  if (token === null) return '';
  const created = await addExpenseCategory(token, name);
  await load();
  return created.id;
}

async function onRenameCategory(id: string, name: string): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  await renameExpenseCategory(token, id, name);
  await load();
}

async function onArchiveCategory(id: string): Promise<string> {
  const token = session.accessToken.value;
  if (token === null) return '';
  const name = categories.value.find((category) => category.id === id)?.name ?? '';
  await archiveExpenseCategory(token, id);
  await load();
  return name;
}

async function onCancelExpense(reason: string): Promise<void> {
  const token = session.accessToken.value;
  const expense = cancelling.value;
  if (token === null || expense === null) return;
  await voidExpense(token, expense.id, { version: expense.version, reason });
}

onMounted(() => {

  void load();
  onDataChanged(() => void load());
});
</script>

<template>
  <AppShell
    title="Expenses"
    :breadcrumb="['Dashboard', 'Money', 'Expenses']"
    help-bn="খরচ — দোকানের সব খরচ, কোন খাতে কত গেল"
  >
    <div class="exp">
      <header class="exp__head no-print">
        <p>Rent, salary, electricity, transport — everything that leaves without buying stock.</p>
        <div class="exp__head-actions">
          <Button label="Categories" icon="pi pi-tags" text @click="managing = true" />
          <Button
            v-if="canRecord"
            label="Record expense"
            icon="pi pi-plus"
            @click="recording = true"
          />
        </div>
      </header>

      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <div class="exp__filters no-print">
        <SearchField
          v-model="search"
          label="Search expenses"
          placeholder="Number, category, payee or note"
          field-id="expenses-search"
          @search="() => load()"
        />
        <Select
          v-model="categoryId"
          :options="categoryFilterOptions"
          option-label="label"
          option-value="value"
          @change="() => load()"
        />
        <DateOnlyPicker
          v-model="fromDate"
          input-id="expenses-from"
          placeholder="From"
          @update:model-value="() => load()"
        />
        <DateOnlyPicker
          v-model="toDate"
          input-id="expenses-to"
          placeholder="To"
          @update:model-value="() => load()"
        />
      </div>

      <div class="exp__tiles">
        <StatCard
          label="Spent in this view"
          :value="taka(totalMinor)"
          detail="মোট খরচ"
          icon="pi-wallet"
          tone="rose"
          filled
        />
        <StatCard
          v-for="category in topCategories"
          :key="category.id"
          :label="category.name"
          :value="taka(category.spentMinor)"
          icon="pi-tag"
          tone="slate"
        />
      </div>

      <AppCard>
        <EmptyState
          v-if="!loading && rows.length === 0"
          icon="pi-wallet"
          title="No expenses yet"
        >
          Everything the shop pays out that is not stock belongs here — rent, salary, the
          electricity bill, a rickshaw fare.
        </EmptyState>

        <DataTable v-else :value="[...rows]" :loading="loading" data-key="id" striped-rows>
          <Column field="businessDate" header="Date">
            <template #body="{ data }">
              {{ data.businessDate }}
              <small class="exp__sub">{{ data.number }}</small>
            </template>
          </Column>
          <Column field="categoryName" header="What for" />
          <Column field="payeeName" header="Paid to">
            <template #body="{ data }">
              <span v-if="data.payeeName">{{ data.payeeName }}</span>
              <span v-else class="exp__muted">—</span>
              <small v-if="data.note" class="exp__sub">{{ data.note }}</small>
            </template>
          </Column>
          <Column field="accountName" header="Paid from">
            <template #body="{ data }">{{ data.accountName ?? data.accountCode }}</template>
          </Column>
          <Column header="Amount" class="num">
            <template #body="{ data }">
              <strong :class="data.status === 'VOIDED' ? 'exp__void' : ''">
                {{ taka(data.amountMinor) }}
              </strong>
              <small v-if="data.status === 'VOIDED'" class="exp__sub">
                cancelled — {{ data.voidReason }}
              </small>
              <small v-else-if="data.entryMode === 'PRIOR_PERIOD'" class="exp__sub">
                corrected into this month — for {{ data.originalBusinessDate }}
              </small>
              <small v-else-if="data.entryMode === 'CORRECTED'" class="exp__sub">corrected</small>
            </template>
          </Column>
          <Column header="" class="no-print" style="width: 8rem">
            <template #body="{ data }">
              <div v-if="canRecord && data.status === 'POSTED'" class="exp__row-actions">
                <Button
                  label="Edit"
                  icon="pi pi-pencil"
                  text
                  size="small"
                  @click="correcting = data"
                />
                <Button
                  label="Cancel"
                  icon="pi pi-times-circle"
                  text
                  size="small"
                  severity="danger"
                  @click="cancelling = data"
                />
              </div>
            </template>
          </Column>
        </DataTable>

        <div v-if="nextCursor" class="exp__more no-print">
          <Button label="Show more" text :disabled="loading" @click="load(true)" />
        </div>
      </AppCard>
    </div>

    <RecordExpenseDialog
      v-if="recording"
      :categories="categories"
      @close="recording = false"
      @recorded="() => { recording = false; void load(); }"
    />

    <RecordExpenseDialog
      v-if="correcting !== null"
      :categories="categories"
      :existing="correcting"
      @close="correcting = null"
      @recorded="() => { correcting = null; void load(); }"
    />

    <CancelDocumentDialog
      v-if="cancelling !== null"
      :title="`Expense ${cancelling.number} — ${cancelling.categoryName}`"
      consequence="The money goes back into the account it was paid from."
      :amount-minor="cancelling.amountMinor"
      :submit="onCancelExpense"
      @close="cancelling = null"
      @cancelled="() => { cancelling = null; void load(); }"
    />

    <ManageListDialog
      v-if="managing"
      title="Expense categories"
      title-bn="খরচের খাত"
      :entries="categories.filter((category) => category.status === 'ACTIVE')"
      :can-edit="canRecord"
      :can-add="canRecord"
      add-placeholder="New category — নতুন খাত"
      :create="onAddCategory"
      :rename="onRenameCategory"
      :remove="onArchiveCategory"
      @close="managing = false"
    />
  </AppShell>
</template>

<style scoped>
.exp {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.exp__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.exp__head p {
  margin: 0;
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.exp__row-actions { display: flex; gap: 0.25rem; justify-content: flex-end; }
.exp__void { text-decoration: line-through; color: var(--sher-text-muted, #94a3b8); }

.exp__head-actions {
  display: flex;
  gap: 0.5rem;
}

.exp__filters {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.exp__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.75rem;
}

.exp__sub {
  display: block;
  font-size: 0.75rem;
  color: var(--sher-text-muted);
}

.exp__muted {
  color: var(--sher-text-muted);
}

.exp__more {
  display: flex;
  justify-content: center;
  padding-top: 0.5rem;
}
</style>
