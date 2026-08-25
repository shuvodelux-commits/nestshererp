<script setup lang="ts">
import type { PurchaseResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchPurchase } from '../api/purchasing';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka } from '../components/money/money-text';
import PaySupplierDialog from '../components/purchasing/PaySupplierDialog.vue';

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
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);
const paying = ref(false);

const justSaved = computed(() => route.query['saved'] === '1');
const canPay = computed(() => session.can('purchase.payment.record'));
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
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not open this purchase' };
  } finally {
    loading.value = false;
  }
}

async function onPaid(): Promise<void> {
  paying.value = false;
  await load();
}

onMounted(load);
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);
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

        <div v-if="canPay && dueMinor > 0" class="bill-actions no-print">
          <!-- Deliberately the small, secondary action (owner decision). -->
          <Button
            icon="pi pi-wallet"
            label="Pay this bill"
            size="small"
            outlined
            @click="paying = true"
          />
        </div>
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

      <PaySupplierDialog
        v-if="paying"
        :supplier-id="purchase.supplierPartyId"
        :supplier-name="purchase.supplierName"
        :purchase-id="purchase.id"
        :purchase-number="purchase.number"
        @paid="onPaid"
        @close="paying = false"
      />
    </template>
  </AppShell>
</template>

<style scoped>
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
