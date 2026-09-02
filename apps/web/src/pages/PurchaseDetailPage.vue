<script setup lang="ts">
import type { PurchaseResponse, SerialProgressResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchPurchase, voidPurchase } from '../api/purchasing';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import { fetchAccounts } from '../api/money';
import { fetchSerialProgress } from '../api/warranty';
import AddLandedCostDialog from '../components/purchasing/AddLandedCostDialog.vue';
import SerialEntryDialog from '../components/inventory/SerialEntryDialog.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka } from '../components/money/money-text';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PaySupplierDialog from '../components/purchasing/PaySupplierDialog.vue';
import PurchaseReturnDialog from '../components/purchasing/PurchaseReturnDialog.vue';

/**
 * One posted bill (§5.9) — a Detail screen (UI-22).
 *
 * Where the shopkeeper lands after saving (owner decision 2026-08-24): the
 * green line at the top says the stock is in and what is still owed, so the
 * entry can be checked against the paper bill before anything else is done.
 *
 * Everything here is read-only. A posted purchase is corrected by a further
 * document (§2.5), never by editing this screen — `Pay this bill` is the one
 * action, and it is deliberately the **small** one: the large primary way to
 * settle a supplier is on the supplier's own page.
 */
const route = useRoute();
const router = useRouter();
const session = useSession();

const purchase = ref<PurchaseResponse | null>(null);

/*
 * Phase 8. Both are optional extras on a bill that is already posted: a cost
 * that arrived after the goods, and the serial numbers somebody had no time to
 * read on the night. Neither changes what the bill says it bought.
 */
const addingCost = ref(false);
const accounts = ref<readonly { code: string; name: string }[]>([]);
const serialLines = ref<readonly SerialProgressResponse[]>([]);
const serialLine = ref<SerialProgressResponse | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);
const paying = ref(false);

const justSaved = computed(() => route.query['saved'] === '1');
const canPay = computed(() => session.can('purchase.payment.record'));
/* A return is sent from the bill the goods arrived on (owner decision). */
const canReturn = computed(() => session.can('purchase.return.create'));
const canEdit = computed(() => session.can('purchase.bill.edit'));
const canVoid = computed(() => session.can('purchase.bill.void'));
const returning = ref(false);
const cancelling = ref(false);
const working = ref(false);
const canCreate = computed(() => session.can('purchase.bill.create'));
const showCost = computed(() => purchase.value?.grandTotalMinor !== undefined);
const dueMinor = computed(() => purchase.value?.dueMinor ?? 0);

async function load(): Promise<void> {
  const token = session.accessToken.value;
  const id = String(route.params['id'] ?? '');
  if (token === null || id === '') return;

  loading.value = true;
  failure.value = null;
  try {
    purchase.value = await fetchPurchase(token, id);
    void loadExtras(token, id);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not open this purchase' };
  } finally {
    loading.value = false;
  }
}

/**
 * Cancelling the bill (§2.5). The version travels with it, so two people
 * cancelling the same bill means the second is told rather than silently
 * winning (D-32).
 */
function describeFailure(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNKNOWN', message: fallback };
}

async function onVoid(): Promise<void> {
  const token = session.accessToken.value;
  const current = purchase.value;
  if (token === null || current === null) return;
  working.value = true;
  failure.value = null;
  try {
    await voidPurchase(token, current.id, { version: current.version, reason: null });
    cancelling.value = false;
    await load();
  } catch (cause) {
    failure.value = describeFailure(cause, 'Could not cancel this bill');
  } finally {
    working.value = false;
  }
}

/** The bill is re-read after a return: what it owes and what it holds have moved. */
async function onReturned(): Promise<void> {
  returning.value = false;
  await load();
}

async function onPaid(): Promise<void> {
  paying.value = false;
  await load();
}

onMounted(load);
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);

/**
 * The two Phase 8 extras, fetched separately so a bill still opens when either
 * is switched off or the caller may not see it.
 */
async function loadExtras(token: string, id: string): Promise<void> {
  try {
    const progress = await fetchSerialProgress(token, id);
    serialLines.value = progress.data;
  } catch {
    serialLines.value = [];
  }
  try {
    const response = await fetchAccounts(token);
    accounts.value = response.accounts.map((account) => ({
      code: `CASH:${account.id}`,
      name: account.name,
    }));
  } catch {
    accounts.value = [];
  }
}

function afterExtra(): void {
  addingCost.value = false;
  serialLine.value = null;
  void load();
}
</script>

<template>
  <AppShell
    :title="purchase?.number ?? 'Purchase'"
    :breadcrumb="['Dashboard', 'Purchases', purchase?.number ?? '']"
    help-bn="এই চালানে কী এলো, কত দিলেন, কত বাকি"
  >
    <template #actions>
      <button
        v-if="canCreate"
        type="button"
        class="btn btn-primary"
        @click="router.push('/purchases/new')"
      >
        <i class="pi pi-plus" aria-hidden="true" /> New purchase
      </button>
    </template>

    <div v-if="loading" class="skeleton skeleton-form" aria-busy="true" aria-label="Loading" />

    <template v-else-if="failure !== null">
      <AppCard title="Could not open this purchase">
        <ErrorNotice :code="failure.code" :message="failure.message" />
        <button type="button" class="btn btn-ghost" @click="router.push('/purchases')">
          Back to the list
        </button>
      </AppCard>
    </template>

    <template v-else-if="purchase !== null">
      <p v-if="justSaved" class="notice is-ok" role="status">
        Saved. Stock is updated and the supplier's account is up to date.
        <span class="sher-bn">মাল স্টকে যোগ হয়েছে</span>
      </p>

      <!--
        §5.26 puts warnings beside the data, and the screen must show them: the
        bill is posted, and the shopkeeper still needs to know before the next
        customer that this item now costs what it sells for.
      -->
      <div v-for="warning in purchase.warnings" :key="warning" class="callout is-warn">
        <i class="pi pi-exclamation-triangle callout-icon" aria-hidden="true" />
        <div class="callout-body">
          <p>{{ warning }}</p>
        </div>
      </div>

      <AppCard>
        <div class="head">
          <div>
            <button type="button" class="linkish no-print" @click="router.push('/purchases')">
              ← Back to list
            </button>
            <h2>{{ purchase.supplierName }}</h2>
            <p class="meta">
              {{ purchase.number }} · {{ purchase.businessDate }}
              <template v-if="purchase.supplierBillRef">
                · their bill {{ purchase.supplierBillRef }}
              </template>
            </p>
          </div>
          <div v-if="showCost" class="due">
            <span>Still owed <span class="sher-bn">বাকি</span></span>
            <strong :class="{ settled: dueMinor === 0 }">{{ taka(dueMinor) }}</strong>
            <Tag
              v-if="dueMinor === 0"
              severity="success"
              value="Paid"
            />
            <Tag
              v-else-if="purchase.dueDate !== null"
              severity="warn"
              :value="`Due ${purchase.dueDate}`"
            />
          </div>
        </div>

        <div v-if="(canPay && dueMinor > 0) || canReturn || canEdit || canVoid" class="bill-actions no-print">
          <!-- Deliberately the small, secondary actions (owner decision). -->
          <Button
            v-if="canPay && dueMinor > 0"
            icon="pi pi-wallet"
            label="Pay this bill"
            size="small"
            outlined
            @click="paying = true"
          />
          <Button
            v-if="canReturn"
            icon="pi pi-reply"
            label="Return to supplier"
            size="small"
            outlined
            @click="returning = true"
          />
          <Button
            v-if="canEdit && purchase.status === 'POSTED'"
            icon="pi pi-pencil"
            label="Edit bill"
            size="small"
            outlined
            @click="router.push({ path: '/purchases/new', query: { correct: purchase.id } })"
          />
          <Button
            v-if="canEdit && purchase.status === 'POSTED'"
            icon="pi pi-truck"
            label="Add extra cost"
            size="small"
            outlined
            @click="addingCost = true"
          />
          <Button
            v-if="canVoid && purchase.status === 'POSTED'"
            icon="pi pi-times-circle"
            label="Cancel bill"
            size="small"
            outlined
            severity="danger"
            @click="cancelling = true"
          />
        </div>
      </AppCard>

      <!--
        Serial numbers still to be typed (§5.19, owner decision 2026-08-26).
        The card only exists while something is outstanding: a bill whose
        serials are all in has nothing to say here.
      -->
      <AppCard
        v-if="serialLines.some((line) => line.outstanding > 0)"
        title="Serial numbers to enter"
        subtitle="সিরিয়াল নম্বর বাকি আছে"
      >
        <ul class="serial-progress">
          <li v-for="line in serialLines" :key="line.purchaseLineId">
            <span>
              <strong>{{ line.displayName }}</strong>
              — {{ line.recorded }} of {{ line.recorded + line.outstanding }} entered
            </span>
            <Button
              v-if="line.outstanding > 0"
              label="Enter serials"
              size="small"
              outlined
              @click="serialLine = line"
            />
          </li>
        </ul>
        <p class="serial-note">
          Units without a serial stay on the shelf but cannot be sold.
        </p>
      </AppCard>

      <AppCard title="What came in">
        <table class="lines">
          <thead>
            <tr>
              <th>Product</th>
              <th class="num">Quantity</th>
              <th v-if="showCost" class="num">Rate</th>
              <th v-if="showCost" class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="line in purchase.lines" :key="line.id">
              <td>
                <strong>{{ line.productName }}</strong>
                <span v-if="line.expiryDate" class="muted">Expires {{ line.expiryDate }}</span>
              </td>
              <td class="num">{{ (line.qty / 1000).toLocaleString() }} {{ line.unitName }}</td>
              <td v-if="showCost" class="num">{{ taka(line.unitPriceMinor ?? 0) }}</td>
              <td v-if="showCost" class="num">{{ taka(line.lineTotalMinor ?? 0) }}</td>
            </tr>
          </tbody>
        </table>
      </AppCard>

      <AppCard v-if="showCost" title="What it came to">
        <div class="totals">
          <div class="total-row">
            <span>Items total <span class="sher-bn">মালের দাম</span></span>
            <span>{{ taka(purchase.itemsTotalMinor ?? 0) }}</span>
          </div>
          <div v-if="(purchase.discountMinor ?? 0) > 0" class="total-row">
            <span>Discount <span class="sher-bn">ছাড়</span></span>
            <span>− {{ taka(purchase.discountMinor ?? 0) }}</span>
          </div>
          <div v-if="(purchase.extraCostMinor ?? 0) > 0" class="total-row">
            <span>Extra cost <span class="sher-bn">গাড়ি ভাড়া, মজুরি</span></span>
            <span>+ {{ taka(purchase.extraCostMinor ?? 0) }}</span>
          </div>
          <div class="total-row is-grand">
            <span>Grand total <span class="sher-bn">সর্বমোট</span></span>
            <strong>{{ taka(purchase.grandTotalMinor ?? 0) }}</strong>
          </div>
          <div class="total-row">
            <span>
              Paid <span class="sher-bn">দেওয়া হয়েছে</span>
              <template v-if="purchase.paidAccountName">
                · {{ purchase.paidAccountName }}
              </template>
            </span>
            <span>{{ taka(purchase.paidMinor ?? 0) }}</span>
          </div>
          <div class="total-row is-grand">
            <span>Still owed <span class="sher-bn">বাকি</span></span>
            <strong>{{ taka(dueMinor) }}</strong>
          </div>
        </div>

        <div v-if="(purchase.payments ?? []).length > 0" class="payments">
          <h3>Payments against this bill</h3>
          <ul>
            <li v-for="payment in purchase.payments" :key="payment.id">
              <span>{{ payment.businessDate }} · {{ payment.number }} · {{ payment.accountName }}</span>
              <span>{{ taka(payment.amountMinor) }}</span>
            </li>
          </ul>
        </div>
      </AppCard>

      <AppCard v-if="purchase.notes" title="Notes">
        <p class="notes">{{ purchase.notes }}</p>
      </AppCard>

      <ConfirmDialog
        v-if="cancelling && purchase"
        :title="`Cancel bill ${purchase.number}?`"
        message="The goods come off the shelf, the lots close, and the supplier is no longer owed. The bill keeps its number and stays visible, marked cancelled."
        :amount-minor="purchase.grandTotalMinor ?? 0"
        danger
        confirm-label="Cancel the bill"
        confirm-label-bn="বিল বাতিল করুন"
        :busy="working"
        :error="failure"
        @cancel="cancelling = false"
        @confirm="onVoid"
      />

      <PurchaseReturnDialog
        v-if="returning"
        :purchase-id="purchase.id"
        @close="returning = false"
        @returned="onReturned"
      />

      <PaySupplierDialog
        v-if="paying"
        :supplier-id="purchase.supplierPartyId"
        :supplier-name="purchase.supplierName"
        :purchase-id="purchase.id"
        :purchase-number="purchase.number"
        @paid="onPaid"
        @close="paying = false"
      />

      <AddLandedCostDialog
        :purchase-id="addingCost ? purchase.id : null"
        :purchase-number="purchase.number"
        :accounts="accounts"
        :purchase-lines="purchase.lines.map((line) => ({ id: line.id, productName: line.productName }))"
        @close="addingCost = false"
        @added="afterExtra"
      />
      <SerialEntryDialog :line="serialLine" @close="serialLine = null" @saved="afterExtra" />
    </template>
  </AppShell>
</template>

<style scoped>
.serial-progress {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--sher-space-2);
}

.serial-progress li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sher-space-3);
  flex-wrap: wrap;
}

.serial-note {
  margin: var(--sher-space-2) 0 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sher-space-4, 16px);
}

.head h2 {
  margin: 4px 0 0;
  font-size: 20px;
}

.meta {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.due {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.due strong {
  font-size: 22px;
  color: var(--sher-text);
}

.due strong.settled {
  color: var(--sher-ok, #16a34a);
}

.bill-actions {
  margin-top: var(--sher-space-3, 12px);
}

.linkish {
  border: 0;
  background: none;
  padding: 0;
  color: var(--sher-primary, #2563eb);
  cursor: pointer;
  font: inherit;
}

.lines {
  width: 100%;
  border-collapse: collapse;
}

.lines th,
.lines td {
  padding: 8px 6px;
  border-bottom: 1px solid var(--sher-border, #e3e8ee);
}

.lines .muted {
  display: block;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.totals {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.total-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
}

.total-row.is-grand {
  padding-top: 6px;
  border-top: 1px solid var(--sher-border, #e3e8ee);
  font-size: 17px;
}

.payments {
  margin-top: var(--sher-space-4, 16px);
}

.payments h3 {
  margin: 0 0 6px;
  font-size: 13px;
}

.payments ul {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.payments li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--sher-border, #e3e8ee);
}

.notes {
  margin: 0;
  white-space: pre-wrap;
}
</style>
