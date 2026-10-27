<script setup lang="ts">
import type { InventoryStockRow } from '@sher/core-contracts';
import { countTotals } from '@sher/core-domain';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchInventory } from '../api/inventory';
import { postStockCount } from '../api/stock-counts';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import SearchField from '../components/SearchField.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import AmountInput from '../components/fields/AmountInput.vue';
import { taka } from '../components/money/money-text';

/**
 * Stock Count · মাল গণনা (§5.13, owner decisions 2026-08-26).
 *
 * **The one screen in Phase 7 that is a page, not a modal.** Everything else
 * here is one task with a handful of fields; this is the whole shop's products
 * with a box beside each, and no dialog can hold that.
 *
 * The difference moves as each quantity is typed, through `countTotals` — the
 * same domain function the service runs again at posting time. What the sheet
 * shows and what the server writes cannot disagree about arithmetic; they can
 * disagree about *stock*, and that is the point of the recount warning: a
 * product sold while the sheet was open is named rather than silently
 * corrected.
 *
 * Only products that were actually counted post anything. An empty box means
 * "not counted", which is not the same as "counted zero" — and a shop counting
 * one shelf at a time depends on that distinction.
 */
const session = useSession();
const clock = new SystemClock();
const today = clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone);

const products = ref<readonly InventoryStockRow[]>([]);
/** Counted quantity per product, as typed. Absent means not counted. */
const counted = ref<Record<string, number | null>>({});
const search = ref('');
const note = ref('');
const businessDate = ref(today);
const backdateReason = ref('');
const loading = ref(true);
const saving = ref(false);
const confirming = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const movedProductIds = ref<readonly string[]>([]);
const posted = ref<{ number: string; differenceCount: number } | null>(null);

const operationId = ref(Ulid.generate(clock));

const canBackdate = computed(() => session.can('period.backdate'));
const isBackdated = computed(() => businessDate.value !== today);

const visible = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (term === '') return products.value;
  return products.value.filter((row) => row.productName.toLowerCase().includes(term));
});

/**
 * The sheet, totalled. Cost is not shown per line — a count is about
 * quantities — but the value of what is missing and what was found is exactly
 * the figure that decides whether to post, so it sits in the tiles.
 */
const totals = computed(() =>
  countTotals(
    products.value.map((row) => ({
      productId: row.productId,
      systemQty: row.qtyOnHand,
      countedQty: counted.value[row.productId] ?? null,
      // The report gives value only to callers who may see cost (UI-40); with
      // no cost visible the tiles show quantities and the value stays zero.
      avgUnitCost:
        row.valueMinor === undefined || row.qtyOnHand === 0
          ? 0
          : Math.round((row.valueMinor * 100_000) / row.qtyOnHand),
    })),
  ),
);

const deltaFor = computed(() => {
  const byProduct = new Map(totals.value.lines.map((line) => [line.productId, line.qtyDelta]));
  return (productId: string): number | null => byProduct.get(productId) ?? null;
});

const ready = computed(
  () => totals.value.countedLines > 0 && (!isBackdated.value || backdateReason.value.trim() !== ''),
);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  try {
    const overview = await fetchInventory(token, { limit: 500 });
    products.value = overview.stock;
    counted.value = Object.fromEntries(overview.stock.map((row) => [row.productId, null]));
  } catch (cause) {
    failure.value = describe(cause, 'Could not load the product list');
  } finally {
    loading.value = false;
  }
}

/** Everything on screen agrees with the system — the fast path for a spot check. */
function markAllCorrect(): void {
  const next = { ...counted.value };
  for (const row of visible.value) next[row.productId] = row.qtyOnHand / 1000;
  counted.value = next;
}

function clearSheet(): void {
  counted.value = Object.fromEntries(products.value.map((row) => [row.productId, null]));
  movedProductIds.value = [];
}

async function post(acceptMoved = false): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;
  saving.value = true;
  failure.value = null;
  try {
    const result = await postStockCount(
      token,
      {
        scopeLabel: search.value.trim() === '' ? 'All products' : `Search: ${search.value.trim()}`,
        note: note.value.trim() === '' ? null : note.value.trim(),
        lines: totals.value.lines.map((line) => ({
          productId: line.productId,
          countedQty: line.countedQty,
          systemQty: line.systemQty,
        })),
        ...(isBackdated.value ? { businessDate: businessDate.value } : {}),
        backdateReason: isBackdated.value ? backdateReason.value.trim() : null,
        acceptMoved,
      },
      operationId.value,
    );
    posted.value = { number: result.number, differenceCount: result.differenceCount };
    movedProductIds.value = [];
    operationId.value = Ulid.generate(clock);
    clearSheet();
    await load();
  } catch (cause) {
    if (cause instanceof ApiError && typeof cause.details['movedProductIds'] === 'string') {
      // Named rather than silently corrected: the shopkeeper recounts those
      // rows, or posts against what the system says now.
      movedProductIds.value = cause.details['movedProductIds'].split(',').filter((id) => id !== '');
    }
    failure.value = describe(cause, 'Could not post this count');
  } finally {
    saving.value = false;
  }
}

async function onConfirm(): Promise<void> {
  confirming.value = false;
  await post(false);
}

function movedName(productId: string): string {
  return products.value.find((row) => row.productId === productId)?.productName ?? productId;
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}

function qtyText(raw: number): string {
  return String(raw / 1000);
}

onMounted(load);
</script>

<template>
  <AppShell
    title="Stock Count"
    :breadcrumb="['Dashboard', 'Products', 'Stock Count']"
    help-bn="মাল গণনা — তাকে যা আছে আর সিস্টেমে যা আছে মিলিয়ে দেখুন"
  >
    <div class="cnt">
      <header class="cnt__head no-print">
        <p>
          Type what is actually on the shelf. Leave a box empty for anything you have not counted —
          only counted products post anything.
        </p>
      </header>

      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <div v-if="posted" class="cnt__done">
        <strong>{{ posted.number }}</strong> posted — {{ posted.differenceCount }} difference(s)
        corrected.
      </div>

      <div v-if="movedProductIds.length > 0" class="cnt__moved">
        <strong>These moved while you were counting:</strong>
        <span>{{ movedProductIds.map(movedName).join(', ') }}</span>
        <Button
          label="Post against what the system says now"
          size="small"
          severity="warn"
          :disabled="saving"
          @click="post(true)"
        />
      </div>

      <div class="cnt__filters no-print">
        <SearchField
          v-model="search"
          label="Find a product"
          placeholder="Product name — পণ্যের নাম"
          field-id="count-search"
        />
        <Button label="All correct here" text :disabled="loading" @click="markAllCorrect" />
        <Button label="Clear sheet" text :disabled="loading" @click="clearSheet" />
      </div>

      <div class="cnt__tiles">
        <StatCard
          label="Counted"
          :value="String(totals.countedLines)"
          detail="গোনা হয়েছে"
          icon="pi-check-circle"
          tone="slate"
        />
        <StatCard
          label="Differences"
          :value="String(totals.differenceCount)"
          detail="গরমিল"
          icon="pi-exclamation-triangle"
          tone="amber"
        />
        <StatCard
          label="Missing"
          :value="taka(totals.shortageValueMinor)"
          detail="কম পাওয়া গেছে"
          icon="pi-arrow-down"
          tone="rose"
        />
        <StatCard
          label="Found"
          :value="taka(totals.surplusValueMinor)"
          detail="বেশি পাওয়া গেছে"
          icon="pi-arrow-up"
          tone="green"
        />
      </div>

      <AppCard>
        <EmptyState v-if="!loading && products.length === 0" icon="pi-box" title="No products yet">
          Add products before counting them.
        </EmptyState>

        <table v-else class="cnt__sheet">
          <thead>
            <tr>
              <th>Product <small>পণ্য</small></th>
              <th class="num">System <small>সিস্টেমে</small></th>
              <th class="num">Counted <small>গুনে পেলাম</small></th>
              <th class="num">Difference <small>পার্থক্য</small></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in visible"
              :key="row.productId"
              :class="{ 'cnt__row--moved': movedProductIds.includes(row.productId) }"
            >
              <td>
                <strong>{{ row.productName }}</strong>
                <small>{{ row.baseUnitName }}</small>
              </td>
              <td class="num">{{ qtyText(row.qtyOnHand) }}</td>
              <td class="num">
                <AmountInput
                  :model-value="counted[row.productId] ?? 0"
                  :min="0"
                  :fraction-digits="3"
                  :aria-label="`Counted quantity for ${row.productName}`"
                  @update:model-value="counted[row.productId] = $event"
                />
              </td>
              <td class="num">
                <span
                  v-if="deltaFor(row.productId) !== null && deltaFor(row.productId) !== 0"
                  :class="deltaFor(row.productId)! > 0 ? 'cnt__up' : 'cnt__down'"
                >
                  {{ deltaFor(row.productId)! > 0 ? '+' : '' }}{{ qtyText(deltaFor(row.productId)!) }}
                </span>
                <span v-else-if="deltaFor(row.productId) === 0" class="cnt__ok">✓</span>
                <span v-else class="cnt__muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </AppCard>

      <div class="cnt__foot no-print">
        <label v-if="canBackdate" class="field">
          <span>Date <small>তারিখ</small></span>
          <DateOnlyPicker v-model="businessDate" input-id="count-date" />
        </label>
        <label v-if="canBackdate && isBackdated" class="field">
          <span>Why this date <small>কেন আগের তারিখ</small></span>
          <InputText v-model="backdateReason" placeholder="Counted on Friday, entered today" />
        </label>
        <label class="field">
          <span>Note <small>মন্তব্য</small></span>
          <InputText v-model="note" placeholder="Optional" />
        </label>
        <Button
          label="Post count"
          class="btn-primary"
          :disabled="!ready || saving"
          @click="confirming = true"
        />
      </div>
    </div>

    <ConfirmDialog
      v-if="confirming"
      title="Post this count?"
      :message="`${String(totals.differenceCount)} product(s) will be corrected. Stock found is added, stock missing is written off — both against Stock Adjustment.`"
      :facts="[
        { label: 'Counted', value: String(totals.countedLines) },
        { label: 'Missing', value: taka(totals.shortageValueMinor) },
        { label: 'Found', value: taka(totals.surplusValueMinor) },
      ]"
      confirm-label="Post count"
      confirm-label-bn="গণনা পোস্ট করুন"
      :busy="saving"
      @cancel="confirming = false"
      @confirm="onConfirm"
    />
  </AppShell>
</template>

<style scoped>
.cnt {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.cnt__head p {
  margin: 0;
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.cnt__done {
  padding: 0.6rem 0.8rem;
  border-radius: var(--sher-radius-sm);
  background: var(--sher-ok-soft, #ecfdf5);
  font-size: 0.9rem;
}

.cnt__moved {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.6rem 0.8rem;
  border-radius: var(--sher-radius-sm);
  border: 1px solid var(--sher-warn-line);
  font-size: 0.9rem;
}

.cnt__filters {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.cnt__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem;
}

.cnt__sheet {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.cnt__sheet th,
.cnt__sheet td {
  padding: 0.4rem 0.35rem;
  border-bottom: 1px solid var(--sher-line);
  text-align: left;
}

.cnt__sheet th small,
.cnt__sheet td small {
  display: block;
  font-size: 0.72rem;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.cnt__sheet .num {
  text-align: right;
}

.cnt__sheet .num :deep(input) {
  width: 6rem;
  text-align: right;
}

.cnt__row--moved {
  background: var(--sher-warn-soft, #fffbeb);
}

.cnt__up {
  color: var(--sher-ok-text, #047857);
  font-weight: 600;
}

.cnt__down {
  color: var(--sher-danger-text, #b91c1c);
  font-weight: 600;
}

.cnt__ok {
  color: var(--sher-text-muted);
}

.cnt__muted {
  color: var(--sher-line-strong);
}

.cnt__foot {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  flex-wrap: wrap;
  position: sticky;
  /* Above the fixed bottom navigation on a phone; zero on a desktop. */
  bottom: var(--sher-bottom-nav-h);
  padding: 0.75rem;
  background: var(--sher-raised, #fff);
  border-top: 1px solid var(--sher-line);
}
</style>
