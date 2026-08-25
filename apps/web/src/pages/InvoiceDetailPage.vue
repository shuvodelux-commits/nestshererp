<script setup lang="ts">
import type { SaleResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchSale } from '../api/sales';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka } from '../components/money/money-text';
import InvoicePreviewDialog from '../components/sales/InvoicePreviewDialog.vue';
import ReceivePaymentDialog from '../components/sales/ReceivePaymentDialog.vue';

/**
 * One posted invoice, and everything §5.8 says must be reachable from it:
 * Receive Payment, Print/Reprint, Export/Share, correct, and cancel.
 *
 * The printing, sharing and cosmetic-edit controls are the **same dialog** the
 * counter sees the moment a sale completes — one implementation, so a reprint a
 * week later is the identical document, and a correction made here goes through
 * the same path (§5.8's "one invoice edit implementation").
 */
const route = useRoute();
const router = useRouter();
const session = useSession();

const sale = ref<SaleResponse | null>(null);
const failure = ref<{ code: string; message: string } | null>(null);
const showInvoice = ref(false);
const receiving = ref(false);

const canReceive = computed(() => session.can('sale.payment.record'));

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    sale.value = await fetchSale(token, String(route.params['id']));
    if (route.query['edit'] === '1') showInvoice.value = true;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load this invoice' };
  }
}

async function onReceived(): Promise<void> {
  receiving.value = false;
  await load();
}

onMounted(load);
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);
</script>

<template>
  <AppShell title="Invoice" help-bn="ইনভয়েস">
    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div v-if="sale" class="invoice-page">
      <header class="invoice-page__head">
        <div>
          <h1>{{ sale.number }}</h1>
          <p class="invoice-page__sub">
            {{ sale.businessDate }} · {{ sale.customerName }}
            <span v-if="sale.customerPhone">· {{ sale.customerPhone }}</span>
            <span v-if="sale.status === 'VOIDED'" class="invoice-page__void">· cancelled</span>
          </p>
        </div>
        <div class="invoice-page__actions">
          <Button
            v-if="canReceive && sale.dueMinor > 0 && !sale.isWalkIn"
            label="Receive Payment"
            @click="receiving = true"
          />
          <Button
            label="Print / Share"
            icon="pi pi-print"
            severity="secondary"
            outlined
            @click="showInvoice = true"
          />
          <Button label="Back to sales" text @click="router.push({ name: 'sales' })" />
        </div>
      </header>

      <div class="invoice-page__tiles">
        <AppCard><p class="tile__label">Total</p><p class="tile__value">{{ taka(sale.grandTotalMinor) }}</p></AppCard>
        <AppCard><p class="tile__label">Paid</p><p class="tile__value">{{ taka(sale.paidMinor) }}</p></AppCard>
        <AppCard><p class="tile__label">Due</p><p class="tile__value" :class="{ due: sale.dueMinor > 0 }">{{ taka(sale.dueMinor) }}</p></AppCard>
        <AppCard v-if="sale.profitMinor !== undefined">
          <p class="tile__label">Profit</p>
          <p class="tile__value">{{ taka(sale.profitMinor) }}</p>
        </AppCard>
      </div>

      <AppCard>
        <table class="invoice-page__table">
          <thead>
            <tr>
              <th>Item</th>
              <th class="num">Qty</th>
              <th class="num">Rate</th>
              <th class="num">Discount</th>
              <th class="num">Amount</th>
              <th v-if="sale.lines.some((line) => line.costMinor !== undefined)" class="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="line in sale.lines" :key="line.id">
              <td>
                {{ line.displayName ?? line.productName }}
                <small v-if="line.source === 'VENDOR_CONSIGNMENT'"> · vendor {{ line.vendorName }}</small>
                <small v-if="line.isProvisionalCost"> · provisional cost</small>
              </td>
              <td class="num">{{ (line.qty / 1000).toString() }} {{ line.unitName }}</td>
              <td class="num">{{ taka(line.unitPriceMinor) }}</td>
              <td class="num">{{ taka(line.lineDiscountMinor + line.discountShareMinor) }}</td>
              <td class="num">{{ taka(line.netAmountMinor) }}</td>
              <td v-if="line.costMinor !== undefined" class="num">{{ taka(line.costMinor) }}</td>
            </tr>
          </tbody>
        </table>
      </AppCard>

      <AppCard v-if="sale.payments.length > 0 || sale.receipts.length > 0">
        <h2 class="invoice-page__section">Payments</h2>
        <ul class="invoice-page__payments">
          <li v-for="payment in sale.payments" :key="payment.id">
            <span>At the counter · {{ payment.accountName }}</span>
            <strong>{{ taka(payment.amountMinor) }}</strong>
          </li>
          <li v-for="receipt in sale.receipts" :key="receipt.id">
            <span>{{ receipt.number }} · {{ receipt.businessDate }} · {{ receipt.accountName }}</span>
            <strong>{{ taka(receipt.amountMinor) }}</strong>
          </li>
        </ul>
      </AppCard>
    </div>

    <InvoicePreviewDialog
      v-if="showInvoice && sale"
      :sale="sale"
      @close="showInvoice = false"
      @updated="(updated: SaleResponse) => (sale = updated)"
    />

    <ReceivePaymentDialog
      v-if="receiving && sale"
      :party-id="sale.partyId"
      :party-name="sale.customerName"
      :sale-id="sale.id"
      @close="receiving = false"
      @received="onReceived"
    />
  </AppShell>
</template>

<style scoped>
.invoice-page {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.invoice-page__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}

.invoice-page__head h1 {
  margin: 0;
  font-size: 1.3rem;
}

.invoice-page__sub {
  margin: 0.15rem 0 0;
  opacity: 0.75;
  font-size: 0.85rem;
}

.invoice-page__void {
  color: #b91c1c;
}

.invoice-page__actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.invoice-page__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.5rem;
}

.tile__label {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.7;
}

.tile__value {
  margin: 0.15rem 0 0;
  font-size: 1.2rem;
  font-weight: 700;
}

.tile__value.due {
  color: #b91c1c;
}

.invoice-page__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.invoice-page__table th,
.invoice-page__table td {
  text-align: left;
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.invoice-page__section {
  font-size: 0.95rem;
  margin: 0 0 0.35rem;
}

.invoice-page__payments {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 0.85rem;
}

.invoice-page__payments li {
  display: flex;
  justify-content: space-between;
  padding: 0.15rem 0;
}
</style>
