<script setup lang="ts">
import { qtyText } from '../money/money-text';
import type { SupplierPurchaseOrderResponse } from '@sher/core-contracts';
import { Qty } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import { computed } from 'vue';

/**
 * The supplier's copy of an order (§5.9, owner rule 2026-08-26).
 *
 * **It carries the shop's pad, the supplier, the products, the quantities, an
 * order number and a date — and nothing else.** No cost, no selling price, no
 * stock figure, no profit. That is not enforced by care here: the response type
 * this reads has no such field on it at all, so there is nothing to leak into a
 * sheet that gets photographed and sent to a supplier.
 */
const props = defineProps<{ order: SupplierPurchaseOrderResponse }>();
const emit = defineEmits<{ (event: 'close'): void }>();

const visible = computed({
  get: () => true,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

/** Printing the dialog alone: the sheet is what the supplier keeps. */
function print(): void {
  window.print();
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="`Order ${props.order.orderNumber}`"
    :style="{ width: 'min(46rem, 96vw)' }"
  >
    <div class="order-sheet">
      <header class="pad">
        <div>
          <h2>{{ props.order.shopName }}</h2>
          <p v-if="props.order.shopAddress !== null">{{ props.order.shopAddress }}</p>
          <p v-if="props.order.shopPhone !== null">{{ props.order.shopPhone }}</p>
        </div>
        <div class="doc">
          <p class="doc-title">Purchase Order</p>
          <p><strong>{{ props.order.orderNumber }}</strong></p>
          <p>{{ props.order.businessDate }}</p>
        </div>
      </header>

      <section class="to">
        <p class="label">To <span>সরবরাহকারী</span></p>
        <p class="name">{{ props.order.supplierName }}</p>
        <p v-if="props.order.supplierAddress !== null">{{ props.order.supplierAddress }}</p>
        <p v-if="props.order.supplierPhone !== null">{{ props.order.supplierPhone }}</p>
      </section>

      <table class="order-lines">
        <thead>
          <tr>
            <th class="no">#</th>
            <th>Product · পণ্য</th>
            <th class="num">Quantity · পরিমাণ</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="line in props.order.lines" :key="line.lineNo">
            <td class="no">{{ line.lineNo }}</td>
            <td>{{ line.productName }}</td>
            <td class="num">{{ qtyText(line.qty) }} {{ line.unitName }}</td>
          </tr>
        </tbody>
      </table>

      <p v-if="props.order.note !== null" class="note">{{ props.order.note }}</p>

      <footer class="sign">
        <span>Authorised signature</span>
      </footer>
    </div>

    <div class="dialog-actions no-print">
      <button type="button" class="btn btn-ghost" @click="emit('close')">Close</button>
      <button type="button" class="btn btn-primary" @click="print">Print / Share</button>
    </div>
  </Dialog>
</template>

<style scoped>
.order-sheet {
  color: var(--sher-text);
}

.pad {
  display: flex;
  justify-content: space-between;
  gap: var(--sher-space-3);
  border-bottom: 2px solid var(--sher-border);
  padding-bottom: var(--sher-space-3);
  flex-wrap: wrap;
}

.pad h2 {
  margin: 0;
  font-size: 1.2rem;
}

.pad p {
  margin: 2px 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}

.doc {
  text-align: right;
}

.doc-title {
  font-weight: 600;
  color: var(--sher-text) !important;
}

.to {
  margin: var(--sher-space-3) 0;
}

.to p {
  margin: 2px 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}

.to .label span {
  font-size: 0.75rem;
}

.to .name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--sher-text) !important;
}

.order-lines {
  width: 100%;
  border-collapse: collapse;
}

.order-lines th,
.order-lines td {
  padding: var(--sher-space-2);
  border-bottom: 1px solid var(--sher-border);
  text-align: left;
}

.order-lines .no {
  width: 2.5rem;
}

.order-lines .num {
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
  border-top: 1px solid var(--sher-border);
  padding-top: 4px;
}

@media print {
  .no-print {
    display: none;
  }
}
</style>
