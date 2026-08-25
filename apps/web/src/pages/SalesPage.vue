<script setup lang="ts">
import type { SaleListItem, SaleResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { cancelSale, fetchSale, fetchSales } from '../api/sales';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import InvoicePreviewDialog from '../components/sales/InvoicePreviewDialog.vue';
import ReceivePaymentDialog from '../components/sales/ReceivePaymentDialog.vue';
import SalesReturnDialog from '../components/sales/SalesReturnDialog.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka } from '../components/money/money-text';

/**
 * Every invoice the shop has issued (§5.8).
 *
 * One search box answers two questions — an invoice number or a phone (owner
 * decision 2026-08-25) — because at a counter those are the only two things
 * anybody has to hand when they want to find a sale again. Guest invoices are
 * found by the phone written on them, which is the whole point of keeping the
 * snapshot.
 */
const session = useSession();
const router = useRouter();
const route = useRoute();

const search = ref(String(route.query['search'] ?? ''));
const unpaidOnly = ref(false);
const items = ref<readonly SaleListItem[]>([]);
const totals = ref({ salesMinor: 0, receivedMinor: 0, dueMinor: 0, invoiceCount: 0 });
const loading = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const canSell = computed(() => session.can('sale.invoice.create'));
const canReceive = computed(() => session.can('sale.payment.record'));
const canEditSale = computed(() => session.can('sale.invoice.edit'));
const canVoid = computed(() => session.can('sale.invoice.void'));
const canReturn = computed(() => session.can('sales.return.create'));

/*
 * Everything an invoice can have done to it lives on its own row (owner
 * decision 2026-08-26). A list where the only affordance is "the row is
 * clickable" teaches nobody what is possible; a row menu names the four things
 * that are, and opening one no longer leaves the list behind.
 */
const rowMenu = ref<InstanceType<typeof Menu> | null>(null);
const menuFor = ref<SaleListItem | null>(null);
const opened = ref<SaleResponse | null>(null);
const receivingFrom = ref<SaleListItem | null>(null);
const cancelling = ref<SaleResponse | null>(null);
/** A return is taken from the invoice it comes off (owner decision 2026-08-26). */
const returningFrom = ref<SaleListItem | null>(null);
const working = ref(false);

const rowMenuItems = computed<MenuItem[]>(() => {
  const sale = menuFor.value;
  if (sale === null) return [];
  const live = sale.status === 'POSTED';
  return [
    { label: 'View & print', icon: 'pi pi-print', command: () => void openInvoice(sale) },
    ...(canReceive.value && live && sale.dueMinor > 0
      ? [{
          label: 'Receive payment',
          icon: 'pi pi-wallet',
          command: (): void => {
            receivingFrom.value = sale;
          },
        }]
      : []),
    ...(canEditSale.value && live
      ? [{
          label: 'Edit sale',
          icon: 'pi pi-pencil',
          command: (): void => {
            void router.push({ name: 'pos', query: { edit: sale.id } });
          },
        }]
      : []),
    ...(canReturn.value && live
      ? [{
          label: 'Return goods',
          icon: 'pi pi-reply',
          command: (): void => {
            returningFrom.value = sale;
          },
        }]
      : []),
    ...(canVoid.value && live
      ? [{
          label: 'Cancel sale',
          icon: 'pi pi-times-circle',
          command: () => void askCancel(sale),
        }]
      : []),
  ];
});

function openMenu(event: Event, sale: SaleListItem): void {
  menuFor.value = sale;
  rowMenu.value?.toggle(event);
}

/** The invoice opens over the list, not instead of it (owner decision). */
async function openInvoice(sale: SaleListItem): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    opened.value = await fetchSale(token, sale.id);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not open that invoice' };
  }
}

async function askCancel(sale: SaleListItem): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  cancelling.value = await fetchSale(token, sale.id);
}

async function confirmCancel(): Promise<void> {
  const token = session.accessToken.value;
  const sale = cancelling.value;
  if (token === null || sale === null) return;
  working.value = true;
  try {
    await cancelSale(token, sale.id, sale.version, null);
    cancelling.value = null;
    await load();
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not cancel that invoice' };
  } finally {
    working.value = false;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  failure.value = null;
  try {
    const page = await fetchSales(token, {
      ...(search.value.trim() === '' ? {} : { search: search.value.trim() }),
      ...(unpaidOnly.value ? { unpaidOnly: true } : {}),
      limit: 50,
    });
    items.value = page.items;
    totals.value = page.totals;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load sales' };
  } finally {
    loading.value = false;
  }
}

watch([search, unpaidOnly], () => {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => void load(), 200);
});

const AGEING: Record<string, string> = {
  NOT_DUE: 'Not due',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  D90_PLUS: '90+ days',
};

onMounted(load);
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);
</script>

<template>
  <AppShell title="Sales" help-bn="বিক্রির তালিকা">
    <div class="sales">
      <header class="sales__head">
        <h1>Sales</h1>
        <Button
          v-if="canSell"
          label="POS — New Sale"
          icon="pi pi-shopping-cart"
          @click="router.push({ name: 'pos' })"
        />
      </header>

      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <div class="sales__tiles">
        <AppCard><p class="tile__label">Invoices</p><p class="tile__value">{{ totals.invoiceCount }}</p></AppCard>
        <AppCard><p class="tile__label">Sold</p><p class="tile__value">{{ taka(totals.salesMinor) }}</p></AppCard>
        <AppCard><p class="tile__label">Received</p><p class="tile__value">{{ taka(totals.receivedMinor) }}</p></AppCard>
        <AppCard><p class="tile__label">Due</p><p class="tile__value tile__value--due">{{ taka(totals.dueMinor) }}</p></AppCard>
      </div>

      <AppCard>
        <div class="sales__filters">
          <InputText v-model="search" placeholder="Invoice number or phone…" class="sales__search" />
          <Button
            :label="unpaidOnly ? 'Showing unpaid only' : 'Show unpaid only'"
            :severity="unpaidOnly ? 'primary' : 'secondary'"
            text
            @click="unpaidOnly = !unpaidOnly"
          />
        </div>

        <p v-if="loading" class="sales__muted">Loading…</p>
        <p v-else-if="items.length === 0" class="sales__muted">No sales yet.</p>

        <table v-else class="sales__table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th>Customer</th>
              <th class="num">Total</th>
              <th class="num">Paid</th>
              <th class="num">Due</th>
              <th>Ageing</th>
              <th class="sales__actions-head" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="sale in items"
              :key="sale.id"
              class="sales__row"
              @click="openInvoice(sale)"
            >
              <td>
                {{ sale.number }}
                <span v-if="sale.status === 'VOIDED'" class="sales__void">cancelled</span>
              </td>
              <td>{{ sale.businessDate }}</td>
              <td>{{ sale.customerName }}<small v-if="sale.customerPhone"> · {{ sale.customerPhone }}</small></td>
              <td class="num">{{ taka(sale.grandTotalMinor) }}</td>
              <td class="num">{{ taka(sale.paidMinor) }}</td>
              <td class="num" :class="{ 'sales__due': sale.dueMinor > 0 }">{{ taka(sale.dueMinor) }}</td>
              <td>{{ sale.dueMinor > 0 ? AGEING[sale.ageing] : '—' }}</td>
              <td class="sales__actions">
                <Button
                  icon="pi pi-ellipsis-v"
                  text
                  rounded
                  aria-label="What can be done with this invoice"
                  @click.stop="openMenu($event, sale)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </AppCard>
    </div>

    <Menu ref="rowMenu" :model="rowMenuItems" popup />

    <InvoicePreviewDialog
      v-if="opened"
      :sale="opened"
      @close="opened = null"
      @updated="(sale: SaleResponse) => (opened = sale)"
    />

    <SalesReturnDialog
      v-if="returningFrom"
      :sale-id="returningFrom.id"
      @close="returningFrom = null"
      @returned="() => { returningFrom = null; void load(); }"
    />

    <ReceivePaymentDialog
      v-if="receivingFrom"
      :party-id="receivingFrom.partyId"
      :party-name="receivingFrom.customerName"
      :sale-id="receivingFrom.id"
      @close="receivingFrom = null"
      @received="() => { receivingFrom = null; void load(); }"
    />

    <ConfirmDialog
      v-if="cancelling"
      :title="`Cancel invoice ${cancelling.number}?`"
      message="The goods go back on the shelf and the money comes back out of the day. The invoice keeps its number and stays visible, marked cancelled."
      :amount-minor="cancelling.grandTotalMinor"
      danger
      confirm-label="Cancel the sale"
      confirm-label-bn="বিক্রি বাতিল করুন"
      :busy="working"
      @cancel="cancelling = null"
      @confirm="confirmCancel"
    />
  </AppShell>
</template>

<style scoped>
.sales {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.sales__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sales__head h1 {
  margin: 0;
  font-size: 1.3rem;
}

.sales__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.5rem;
}

.tile__label {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.7;
}

.tile__value {
  margin: 0.15rem 0 0;
  font-size: 1.25rem;
  font-weight: 700;
}

.tile__value--due {
  color: #b91c1c;
}

.sales__filters {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.5rem;
}

.sales__search {
  flex: 1;
  max-width: 24rem;
}

.sales__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.sales__table th,
.sales__table td {
  text-align: left;
  padding: 0.35rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.sales__row {
  cursor: pointer;
}

.sales__actions,
.sales__actions-head {
  width: 3rem;
  text-align: right;
}

.sales__row:hover {
  background: var(--p-surface-100);
}

.sales__due {
  color: #b91c1c;
  font-weight: 600;
}

.sales__void {
  color: #b91c1c;
  font-size: 0.72rem;
  margin-left: 0.3rem;
}

.sales__muted {
  opacity: 0.7;
  font-size: 0.85rem;
}
</style>
