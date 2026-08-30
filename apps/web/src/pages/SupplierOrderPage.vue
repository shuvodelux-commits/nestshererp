<script setup lang="ts">
import { qtyText } from '../components/money/money-text';
import type { SupplierPurchaseOrderResponse } from '@sher/core-contracts';
import { Qty } from '@sher/shared-utils';
import Button from 'primevue/button';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchSupplierOrder } from '../api/purchase-plans';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * One supplier order · সরবরাহকারীর অর্ডার (§5.9, owner decision 2026-08-26).
 *
 * **The two things you do with an order both live here**: print or share the
 * sheet, and convert it into a purchase.
 *
 * **The sheet carries no money.** Shop pad, supplier, product, quantity, order
 * number, date — and nothing else, ever. That is not restraint on this screen's
 * part: the response type it reads has no cost, price, stock or profit field on
 * it at all, so a sheet that gets photographed and sent to a supplier cannot
 * leak what the shop pays or charges.
 *
 * **Convert loads it into New Purchase and stops.** Nothing is posted here —
 * the shopkeeper still adds, removes, re-prices and dates the bill, and the
 * ordinary purchase use case is what writes stock and the supplier's ledger.
 * The order becomes Purchased at that moment, not this one.
 */
const session = useSession();
const route = useRoute();
const router = useRouter();

const order = ref<SupplierPurchaseOrderResponse | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const orderId = computed(() => String(route.params.id));
const totalQty = computed(() =>
  (order.value?.lines ?? []).reduce((sum, line) => sum + line.qty, 0),
);

onMounted(async () => {
  try {
    order.value = await fetchSupplierOrder(session.accessToken.value ?? '', orderId.value);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'LOAD_FAILED', message: 'The order could not be loaded. Try again.' };
  } finally {
    loading.value = false;
  }
});

/** Print, or “save as PDF” / screenshot-and-share, which is the same sheet. */
function print(): void {
  window.print();
}

/**
 * Hand the order's lines to New Purchase.
 *
 * The line format is the same one a plan uses — `planLineId:productId:qty` —
 * with the order's id travelling separately so the bill can close it. Every
 * figure stays editable until the shopkeeper saves.
 */
function convert(): void {
  const sheet = order.value;
  if (sheet === null) return;

  void router.push({
    name: 'purchase-new',
    query: {
      supplierPartyId: sheet.supplierPartyId,
      supplierOrderId: sheet.id,
      lines: sheet.lines.map((line) => `:${line.productId}:${line.qty}`).join(','),
    },
  });
}
</script>

<template>
  <AppShell
    :title="order?.orderNumber ?? 'Supplier order'"
    help-bn="ছাপুন, শেয়ার করুন, বা কেনায় রূপ দিন"
  >
    <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />
    <p v-if="loading" class="muted">Loading…</p>

    <template v-else-if="order !== null">
      <div class="order-actions no-print">
        <Button label="Print / Save PDF" icon="pi pi-print" outlined @click="print" />
        <Button
          v-if="order.status === 'OPEN'"
          label="Convert to Purchase"
          icon="pi pi-shopping-cart"
          @click="convert"
        />
        <p v-else-if="order.purchaseNumber !== null" class="converted">
          Already bought on <strong>{{ order.purchaseNumber }}</strong>
        </p>
      </div>

      <AppCard>
        <div class="order-sheet">
          <header class="pad">
            <div>
              <h2>{{ order.shopName }}</h2>
              <p v-if="order.shopAddress !== null">{{ order.shopAddress }}</p>
              <p v-if="order.shopPhone !== null">{{ order.shopPhone }}</p>
            </div>
            <div class="doc">
              <p class="doc-title">Purchase Order</p>
              <p><strong>{{ order.orderNumber }}</strong></p>
              <p>{{ order.businessDate }}</p>
            </div>
          </header>

          <section class="to">
            <p class="label">To <span>সরবরাহকারী</span></p>
            <p class="name">{{ order.supplierName }}</p>
            <p v-if="order.supplierAddress !== null">{{ order.supplierAddress }}</p>
            <p v-if="order.supplierPhone !== null">{{ order.supplierPhone }}</p>
          </section>

          <table class="sheet-lines">
            <thead>
              <tr>
                <th class="no">#</th>
                <th>Product · পণ্য</th>
                <th class="num">Quantity · পরিমাণ</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in order.lines" :key="line.lineNo">
                <td class="no">{{ line.lineNo }}</td>
                <td>{{ line.productName }}</td>
                <td class="num">{{ qtyText(line.qty) }} {{ line.unitName }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td><strong>Total</strong></td>
                <td class="num"><strong>{{ qtyText(totalQty) }}</strong></td>
              </tr>
            </tfoot>
          </table>

          <p v-if="order.note !== null" class="note">{{ order.note }}</p>

          <footer class="sign"><span>Authorised signature</span></footer>
        </div>
      </AppCard>
    </template>
  </AppShell>
</template>

<style scoped>
.order-actions {
  display: flex;
  gap: var(--sher-space-2);
  justify-content: flex-end;
  align-items: center;
  margin-bottom: var(--sher-space-3);
  flex-wrap: wrap;
}

.converted {
  margin: 0;
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.pad {
  display: flex;
  justify-content: space-between;
  gap: var(--sher-space-3);
  border-bottom: 2px solid var(--sher-line);
  padding-bottom: var(--sher-space-3);
  flex-wrap: wrap;
}

.pad h2 {
  margin: 0;
  font-size: 1.2rem;
}

.pad p,
.to p {
  margin: 2px 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}

.doc {
  text-align: right;
}

.doc-title,
.to .name {
  font-weight: 600;
  color: var(--sher-text) !important;
}

.to {
  margin: var(--sher-space-3) 0;
}

.to .name {
  font-size: 1rem;
}

.sheet-lines {
  width: 100%;
  border-collapse: collapse;
}

.sheet-lines th,
.sheet-lines td {
  padding: var(--sher-space-2);
  border-bottom: 1px solid var(--sher-line);
  text-align: left;
}

.sheet-lines .no {
  width: 2.5rem;
}

.sheet-lines .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.note {
  margin-top: var(--sher-space-3);
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}

.sign {
  margin-top: calc(var(--sher-space-3) * 2);
  text-align: right;
  font-size: 0.8rem;
  color: var(--sher-text-muted);
}

.sign span {
  border-top: 1px solid var(--sher-line);
  padding-top: 4px;
}

.muted {
  color: var(--sher-text-muted);
}

@media print {
  .no-print {
    display: none;
  }
}
</style>
