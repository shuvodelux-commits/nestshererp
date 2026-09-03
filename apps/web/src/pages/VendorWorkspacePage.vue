<script setup lang="ts">
import type {
  PartyResponse,
  ProductResponse,
  VendorActivityKind,
  VendorActivityRow,
  VendorWorkspaceSummaryResponse,
} from '@sher/core-contracts';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchAccounts } from '../api/money';
import { fetchParties } from '../api/parties';
import { fetchProducts } from '../api/products';
import { fetchVendorActivity, fetchVendorWorkspace } from '../api/vendors';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import { qtyText, taka } from '../components/money/money-text';
import GiveProductsToVendorDialog from '../components/vendors/GiveProductsToVendorDialog.vue';
import PayVendorDialog from '../components/vendors/PayVendorDialog.vue';
import ReceiveFromVendorDialog from '../components/vendors/ReceiveFromVendorDialog.vue';
import ReceiveProductsBackDialog from '../components/vendors/ReceiveProductsBackDialog.vue';
import VendorStockReceiveDialog from '../components/vendors/VendorStockReceiveDialog.vue';
import VendorStockReturnDialog from '../components/vendors/VendorStockReturnDialog.vue';
import VendorProductSettlementDrawer from '../components/vendors/VendorProductSettlementDrawer.vue';

/**
 * The vendor's hub · ভেন্ডর অপারেশন (§5.6 M07, UI-52, Phase 8.3).
 *
 * One vendor at a time: what stands between the shop and them, the six things
 * that can be done about it, what is still open, and everything that has
 * happened — every row of it linking back to the document that owns it.
 *
 * **This screen posts nothing.** Each action opens the dialog of the module
 * that owns that write, and three of the six are not vendor writes at all:
 * charging goods raises an ordinary sale, settling what they owe is an ordinary
 * customer receipt, and charged goods coming back are an ordinary sales return.
 * A hub that posted for itself would be a second engine, and the ledger would
 * eventually have two answers (R-D).
 */
const session = useSession();
const route = useRoute();
const router = useRouter();

const vendors = ref<readonly PartyResponse[]>([]);
const products = ref<readonly ProductResponse[]>([]);
const vendorId = ref<string | null>(null);
const summary = ref<VendorWorkspaceSummaryResponse | null>(null);
const activity = ref<readonly VendorActivityRow[]>([]);
const filter = ref<VendorActivityKind | 'ALL'>('ALL');
const loading = ref(true);
const busyPanel = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const paying = ref(false);
const receivingMoney = ref(false);
const giving = ref(false);
const receivingBack = ref(false);
const receivingStock = ref(false);
const returningStock = ref<string | null>(null);
const settlingWithProducts = ref(false);
const settlementAccounts = ref<readonly { code: string; label: string }[]>([]);

/* UI-09: an action the user may not perform is absent, never disabled. */
const canPay = computed(() => session.can('vendor.payment.record'));
const canReceiveMoney = computed(() => session.can('vendor.receipt.record'));
const canIssue = computed(() => session.can('vendor.issue.manage'));
const canManageStock = computed(() => session.can('vendor.stock.manage'));
const canSettleWithProducts = computed(
  () =>
    session.can('vendor.stock.manage') &&
    session.can('purchase.bill.create'),
);

const vendorOptions = computed(() =>
  vendors.value.map((vendor) => ({ label: vendor.name, value: vendor.id })),
);

const FILTERS: readonly { value: VendorActivityKind | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'VENDOR_STOCK', label: 'Vendor stock' },
  { value: 'VENDOR_STOCK_RETURN', label: 'Returns' },
  { value: 'GIVEN_TO_VENDOR', label: 'Given to vendor' },
  { value: 'RECEIVED_BACK', label: 'Received back' },
  { value: 'PAYMENT', label: 'Payments' },
  { value: 'RECEIPT', label: 'Receipts' },
  { value: 'PRODUCT_SETTLEMENT', label: 'Product settlements' },
];

const openConsignments = computed(() => summary.value?.openConsignments ?? []);
const openIssues = computed(() => summary.value?.openIssues ?? []);
const hasOpenItems = computed(
  () => openConsignments.value.length > 0 || openIssues.value.length > 0,
);

async function loadVendors(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const [vendorList, productList, money] = await Promise.all([
      fetchParties(token, { role: 'VENDOR', limit: 200 }),
      fetchProducts(token, { limit: 200 }),
      fetchAccounts(token),
    ]);
    vendors.value = vendorList.data;
    products.value = productList.data;
    settlementAccounts.value = money.accounts
      .filter((account) => account.status === 'ACTIVE')
      .map((account) => ({
        code: `${account.type}:${account.id}`,
        label: account.name,
      }));

    /* A vendor named in the URL wins, so the hub can be linked to from the
     * party list and from a ledger row without losing which vendor. */
    const wanted = typeof route.query['vendor'] === 'string' ? route.query['vendor'] : null;
    vendorId.value =
      wanted !== null && vendors.value.some((vendor) => vendor.id === wanted)
        ? wanted
        : (vendors.value[0]?.id ?? null);
  } catch (cause) {
    failure.value = describe(cause, 'Vendors could not be loaded');
  }
}

async function loadVendor(): Promise<void> {
  const token = session.accessToken.value;
  const id = vendorId.value;
  if (token === null || id === null) {
    loading.value = false;
    return;
  }

  busyPanel.value = true;
  failure.value = null;
  try {
    const [summaryResponse, activityResponse] = await Promise.all([
      fetchVendorWorkspace(token, id),
      fetchVendorActivity(token, id, filter.value === 'ALL' ? [] : [filter.value]),
    ]);
    summary.value = summaryResponse;
    activity.value = activityResponse.data;
  } catch (cause) {
    failure.value = describe(cause, 'This vendor could not be opened');
  } finally {
    busyPanel.value = false;
    loading.value = false;
  }
}

/** The filter chips re-read the list rather than filtering it in the browser. */
async function loadActivity(): Promise<void> {
  const token = session.accessToken.value;
  const id = vendorId.value;
  if (token === null || id === null) return;
  try {
    const response = await fetchVendorActivity(
      token,
      id,
      filter.value === 'ALL' ? [] : [filter.value],
    );
    activity.value = response.data;
  } catch (cause) {
    failure.value = describe(cause, 'The history could not be loaded');
  }
}

/** Every action moves the tiles and the history, so both are re-read. */
async function onChanged(): Promise<void> {
  paying.value = false;
  receivingMoney.value = false;
  giving.value = false;
  receivingBack.value = false;
  receivingStock.value = false;
  returningStock.value = null;
  settlingWithProducts.value = false;
  await loadVendor();
}

/** UI-52: every row source-links to the document that owns it. */
function openSource(row: VendorActivityRow): void {
  if (row.sourceType === 'sale') {
    void router.push({ name: 'invoice-detail', params: { id: row.sourceId } });
  } else if (row.sourceType === 'customer_receipt') {
    void router.push({ name: 'party-ledger', params: { id: vendorId.value ?? '' } });
  } else if (row.sourceType === 'vendor_payment' || row.sourceType === 'vendor_receipt') {
    void router.push({ name: 'party-ledger', params: { id: vendorId.value ?? '' } });
  } else if (row.sourceType === 'vendor_stock_receipt' || row.sourceType === 'vendor_stock_return') {
    void router.push({ name: 'vendor-stock' });
  } else if (row.sourceType === 'purchase') {
    void router.push({ name: 'purchase', params: { id: row.sourceId } });
  }
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'LOAD_FAILED', message: fallback };
}

watch(vendorId, async (next) => {
  if (next === null) return;
  await router.replace({ query: { ...route.query, vendor: next } });
  await loadVendor();
});

watch(filter, () => {
  void loadActivity();
});

onMounted(async () => {
  await loadVendors();
  await loadVendor();
});
</script>

<template>
  <AppShell
    title="Vendor Workspace"
    help-bn="ভেন্ডরের সব কাজ এক জায়গায় — মাল, টাকা ও ফেরত"
  >
    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div v-if="loading" class="skeleton skeleton-form" aria-busy="true" aria-label="Loading" />

    <EmptyState
      v-else-if="vendors.length === 0"
      icon="pi-briefcase"
      title="No vendors yet"
      message="Add a vendor first — someone whose goods you sell on their behalf."
    />

    <template v-else>
      <AppCard>
        <div class="picker">
          <div class="field">
            <label for="workspace-vendor">
              Vendor <span class="label-bn">ভেন্ডর নির্বাচন করুন</span>
            </label>
            <Select
              input-id="workspace-vendor"
              v-model="vendorId"
              :options="vendorOptions"
              option-label="label"
              option-value="value"
              filter
              append-to="body"
              fluid
            />
          </div>

          <div v-if="summary" class="picker-meta">
            <span class="pill" :class="summary.isActive ? 'is-ok' : 'is-muted'">
              {{ summary.isActive ? 'Active' : 'Inactive' }}
            </span>
            <Button
              icon="pi pi-book"
              label="Vendor ledger"
              text
              @click="router.push({ name: 'party-ledger', params: { id: summary.vendorPartyId } })"
            />
          </div>
        </div>
      </AppCard>

      <template v-if="summary">
        <!--
          Four figures, each read from the module that owns it. Vendor-owned
          stock sits beside the payable rather than inside it: those goods are
          the vendor's, and nothing is owed on them until one sells (DR13.10).
        -->
        <div class="tiles">
          <StatCard
            label="Payable — you owe"
            :value="taka(summary.payableMinor)"
            detail="দিতে হবে"
            icon="pi-arrow-up-right"
            tone="rose"
          />
          <StatCard
            label="Receivable — they owe you"
            :value="taka(summary.receivableMinor)"
            :detail="summary.advancePaidMinor > 0 ? `Advance out ${taka(summary.advancePaidMinor)}` : 'পাবো'"
            icon="pi-arrow-down-left"
            tone="violet"
          />
          <StatCard
            label="Vendor-owned stock"
            :value="qtyText(summary.vendorOwnedStockQty)"
            :detail="summary.vendorOwnedStockValueMinor > 0 ? taka(summary.vendorOwnedStockValueMinor) : 'ভেন্ডরের মাল'"
            icon="pi-box"
            tone="slate"
          />
          <StatCard
            label="Open product issues"
            :value="String(summary.openIssueCount)"
            detail="সাময়িকভাবে দেওয়া"
            icon="pi-send"
            tone="amber"
          />
        </div>

        <AppCard>
          <h2 class="section-title">
            Actions <span class="label-bn">কাজ</span>
          </h2>
          <div class="actions">
            <Button
              v-if="canManageStock"
              icon="pi pi-inbox"
              label="Receive vendor stock"
              @click="receivingStock = true"
            />
            <Button
              v-if="canManageStock"
              icon="pi pi-reply"
              label="Return vendor stock"
              severity="secondary"
              :disabled="openConsignments.length === 0"
              @click="returningStock = openConsignments[0]?.id ?? null"
            />
            <Button v-if="canPay" icon="pi pi-wallet" label="Pay vendor" @click="paying = true" />
            <Button
              v-if="canReceiveMoney"
              icon="pi pi-download"
              label="Receive payment"
              severity="secondary"
              @click="receivingMoney = true"
            />
            <Button
              v-if="canSettleWithProducts && summary.receivableMinor > 0"
              icon="pi pi-box"
              label="Receive products as settlement"
              severity="secondary"
              @click="settlingWithProducts = true"
            />
            <Button
              v-if="canIssue"
              icon="pi pi-send"
              label="Give products"
              severity="secondary"
              @click="giving = true"
            />
            <Button
              v-if="canIssue"
              icon="pi pi-undo"
              label="Receive products back"
              severity="secondary"
              @click="receivingBack = true"
            />
          </div>
        </AppCard>

        <AppCard v-if="hasOpenItems">
          <h2 class="section-title">
            Open items <span class="label-bn">যা এখনো বাকি</span>
          </h2>
          <div class="table-wrap">
            <table class="hub-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>What it is</th>
                  <th class="num">Open</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="receipt in openConsignments" :key="receipt.id">
                  <td>{{ receipt.receiptNumber }} — {{ receipt.displayName }}</td>
                  <td>Vendor's goods on your shelf</td>
                  <td class="num">{{ qtyText(receipt.onHandQty) }} {{ receipt.unitName }}</td>
                  <td>{{ receipt.businessDate }}</td>
                </tr>
                <tr v-for="issue in openIssues" :key="issue.id">
                  <td>{{ issue.number }} — {{ issue.displayName }}</td>
                  <td>Your goods, on temporary issue</td>
                  <td class="num">{{ qtyText(issue.openQty) }} {{ issue.unitName }}</td>
                  <td>{{ issue.businessDate }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </AppCard>

        <AppCard>
          <div class="history-head">
            <h2 class="section-title">
              Vendor activity <span class="label-bn">সব লেনদেনের ইতিহাস</span>
            </h2>
            <div class="chips">
              <Button
                v-for="option in FILTERS"
                :key="option.value"
                :label="option.label"
                size="small"
                :severity="filter === option.value ? undefined : 'secondary'"
                :text="filter !== option.value"
                @click="filter = option.value"
              />
            </div>
          </div>

          <div v-if="busyPanel" class="skeleton skeleton-form" aria-busy="true" />

          <EmptyState
            v-else-if="activity.length === 0"
            icon="pi-clock"
            title="Nothing yet"
            message="Consignments, returns, issues, payments and receipts for this vendor appear here."
          />

          <div v-else class="table-wrap">
            <table class="hub-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Document</th>
                  <th>What happened</th>
                  <th class="num">Qty</th>
                  <th class="num">Amount</th>
                  <th class="num">Open</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in activity" :key="`${row.kind}-${row.id}`">
                  <td>{{ row.businessDate }}</td>
                  <td>
                    <button type="button" class="link" @click="openSource(row)">
                      {{ row.number }}
                    </button>
                  </td>
                  <td>{{ row.description }}</td>
                  <td class="num">{{ row.qty === null ? '—' : qtyText(row.qty) }}</td>
                  <td class="num">{{ row.amountMinor === null ? '—' : taka(row.amountMinor) }}</td>
                  <td class="num">{{ row.openQty === null ? '—' : qtyText(row.openQty) }}</td>
                  <td>{{ row.status }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </AppCard>

        <PayVendorDialog
          v-if="paying"
          :vendor-id="summary.vendorPartyId"
          :vendor-name="summary.vendorName"
          :payable-minor="summary.payableMinor"
          @paid="onChanged"
          @close="paying = false"
        />

        <ReceiveFromVendorDialog
          v-if="receivingMoney"
          :vendor-id="summary.vendorPartyId"
          :vendor-name="summary.vendorName"
          :receivable-minor="summary.receivableMinor"
          :advance-paid-minor="summary.advancePaidMinor"
          @received="onChanged"
          @close="receivingMoney = false"
        />

        <GiveProductsToVendorDialog
          v-if="giving"
          :vendor-id="summary.vendorPartyId"
          :vendor-name="summary.vendorName"
          :products="products"
          @given="onChanged"
          @sell="() => { giving = false; void router.push({ name: 'pos', query: { customer: summary?.vendorPartyId } }); }"
          @close="giving = false"
        />

        <ReceiveProductsBackDialog
          v-if="receivingBack"
          :vendor-name="summary.vendorName"
          :issues="openIssues"
          @received="onChanged"
          @close="receivingBack = false"
        />

        <VendorStockReceiveDialog
          :open="receivingStock"
          :vendors="vendors"
          :products="products"
          @received="onChanged"
          @close="receivingStock = false"
        />

        <VendorStockReturnDialog
          v-if="returningStock !== null"
          :receipt="openConsignments.find((item) => item.id === returningStock) ?? null"
          @returned="onChanged"
          @close="returningStock = null"
        />

        <VendorProductSettlementDrawer
          :open="settlingWithProducts"
          :vendor-id="summary.vendorPartyId"
          :vendor-name="summary.vendorName"
          :receivable-minor="summary.receivableMinor"
          :products="products"
          :accounts="settlementAccounts"
          :can-add-landed-costs="session.can('purchase.bill.edit')"
          @settled="onChanged"
          @close="settlingWithProducts = false"
        />
      </template>
    </template>
  </AppShell>
</template>

<style scoped>
.picker {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sher-space-3, 12px);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: min(22rem, 100%);
}

.field label {
  font-size: 13px;
  font-weight: 600;
}

.label-bn {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.picker-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pill {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.pill.is-ok {
  background: var(--sher-success-soft, #dcfce7);
  color: var(--sher-success, #15803d);
}

.pill.is-muted {
  background: var(--sher-surface-muted, #f1f5f9);
  color: var(--sher-text-muted);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sher-space-3, 12px);
  margin: var(--sher-space-3, 12px) 0;
}

.section-title {
  margin: 0 0 var(--sher-space-3, 12px);
  font-size: 15px;
  font-weight: 700;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.history-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: var(--sher-space-3, 12px);
}

/* UI-41: a wide table scrolls inside its own box rather than the page. */
.table-wrap {
  overflow-x: auto;
}

.hub-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.hub-table th,
.hub-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--sher-border, #e3e8ee);
  white-space: nowrap;
}

/* UI-32: money and quantities right-aligned, with tabular figures. */
.hub-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--sher-primary, #0f766e);
  font: inherit;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}
</style>
