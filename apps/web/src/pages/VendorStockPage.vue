<script setup lang="ts">
import type {
  PartyResponse,
  ProductResponse,
  VendorStockReceiptResponse,
} from '@sher/core-contracts';
import { Qty } from '@sher/shared-utils';
import Button from 'primevue/button';
import { onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchParties } from '../api/parties';
import { fetchProducts } from '../api/products';
import { fetchVendorStock } from '../api/vendors';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka, qtyText } from '../components/money/money-text';
import VendorStockReceiveDialog from '../components/vendors/VendorStockReceiveDialog.vue';
import VendorStockReturnDialog from '../components/vendors/VendorStockReturnDialog.vue';

/**
 * Consignment · ভেন্ডরের স্টক (§5.6 M07, DR13.10).
 *
 * Everything a vendor has left with the shop, and what has become of it:
 * `Received · Sold · Returned · On hand`, with what selling their goods has
 * made the shop owe. The money column is the vendor's ledger's business — this
 * screen only says what the goods did.
 */
const session = useSession();

const receipts = ref<readonly VendorStockReceiptResponse[]>([]);
const vendors = ref<readonly PartyResponse[]>([]);
const products = ref<readonly ProductResponse[]>([]);
const receiving = ref(false);
const returning = ref<VendorStockReceiptResponse | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const response = await fetchVendorStock(session.accessToken.value ?? '');
    receipts.value = response.data;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'LOAD_FAILED', message: 'Vendor stock could not be loaded. Try again.' };
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  try {
    const [vendorList, productList] = await Promise.all([
      fetchParties(session.accessToken.value ?? '', { role: 'VENDOR', limit: 200 }),
      fetchProducts(session.accessToken.value ?? '', { limit: 200 }),
    ]);
    vendors.value = vendorList.data;
    products.value = productList.data;
  } catch {
    // Pickers that could not load leave the button unable to help, not the
    // page broken — what is already on the shelf still reads correctly.
  }
});

function onSaved(): void {
  receiving.value = false;
  returning.value = null;
  void load();
}
</script>

<template>
  <AppShell title="Consignment" help-bn="ভেন্ডরের মাল — যা বিক্রি হলে তবেই টাকা দিতে হবে">
    <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

    <div class="vendor-actions">
      <Button label="Receive vendor stock" icon="pi pi-plus" @click="receiving = true" />
    </div>

    <AppCard>
      <p v-if="loading" class="muted">Loading…</p>
      <EmptyState v-else-if="receipts.length === 0" icon="pi-briefcase" title="No vendor stock">
        When a vendor leaves goods to be sold on their behalf, record it here. Nothing is owed
        until one of them sells.
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="vendor-table">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Vendor</th>
              <th>Product</th>
              <th class="num">Received</th>
              <th class="num">Sold</th>
              <th class="num">Returned</th>
              <th class="num">On hand</th>
              <th class="num">Owed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="receipt in receipts" :key="receipt.id">
              <td>
                <strong>{{ receipt.receiptNumber }}</strong>
                <span class="muted">{{ receipt.businessDate }}</span>
              </td>
              <td>{{ receipt.vendorName }}</td>
              <td>{{ receipt.displayName }}</td>
              <td class="num">{{ qtyText(receipt.receivedQty) }}</td>
              <td class="num">{{ qtyText(receipt.soldQty) }}</td>
              <td class="num">{{ qtyText(receipt.returnedQty) }}</td>
              <td class="num">{{ qtyText(receipt.onHandQty) }}</td>
              <td class="num">
                {{ receipt.dueMinor === undefined ? '—' : taka(receipt.dueMinor) }}
              </td>
              <td>
                <Button
                  v-if="receipt.onHandQty > 0"
                  label="Return"
                  size="small"
                  severity="secondary"
                  outlined
                  @click="returning = receipt"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AppCard>

    <VendorStockReceiveDialog
      :open="receiving"
      :vendors="vendors"
      :products="products"
      @close="receiving = false"
      @received="onSaved"
    />
    <VendorStockReturnDialog
      :receipt="returning"
      @close="returning = null"
      @returned="onSaved"
    />
  </AppShell>
</template>

<style scoped>
/*
 * The Bangla name under the English one, not trailing it (owner decision
 * 2026-08-26, pointing at the module tabs as the shape to copy).
 *
 * These labels are longer than a form's usual one or two words — "Target Stock
 * Cover কত দিনের মাল রাখবেন" on a single line wrapped mid-phrase and threw the
 * controls out of alignment. Stacked, each language reads as its own line.
 */
.field label {
  display: grid;
  gap: 1px;
  line-height: 1.3;
}

/* The 6px lead-in only makes sense when it trails the English on one line. */
.field label .label-bn {
  margin-left: 0;
}

.vendor-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--sher-space-3);
}

.table-wrap {
  overflow-x: auto;
}

.vendor-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.vendor-table th,
.vendor-table td {
  padding: var(--sher-space-2);
  border-bottom: 1px solid var(--sher-border);
  text-align: left;
  white-space: nowrap;
}

.vendor-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.muted {
  display: block;
  color: var(--sher-text-muted);
  font-size: 0.78rem;
}
</style>
