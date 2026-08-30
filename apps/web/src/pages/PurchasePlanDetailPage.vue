<script setup lang="ts">
import type { PurchasePlanResponse } from '@sher/core-contracts';
import { Qty } from '@sher/shared-utils';
import Button from 'primevue/button';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { decidePurchasePlan, fetchPurchasePlan } from '../api/purchase-plans';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka, qtyText } from '../components/money/money-text';

/**
 * One purchase plan · একটি কেনার পরিকল্পনা (§5.9).
 *
 * A read view with one decision on it. Approving here does exactly what
 * approving from the list does — it is the same use case — and it is what
 * creates the supplier orders. Nothing on this screen posts stock or money.
 */
const session = useSession();
const route = useRoute();
const router = useRouter();

const plan = ref<PurchasePlanResponse | null>(null);
const loading = ref(true);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const planId = computed(() => String(route.params.id));

/** Grouped the way it leaves the shop: one sheet per supplier. */
const groups = computed(() => {
  const bySupplier = new Map<
    string,
    { name: string; lines: PurchasePlanResponse['lines'] }
  >();
  for (const line of plan.value?.lines ?? []) {
    const key = line.supplierPartyId ?? 'none';
    const existing = bySupplier.get(key);
    if (existing === undefined) {
      bySupplier.set(key, { name: line.supplierName ?? 'No supplier yet', lines: [line] });
    } else {
      existing.lines = [...existing.lines, line];
    }
  }
  return [...bySupplier.values()];
});

const statusLabels: Record<string, string> = {
  DRAFT: 'Draft · খসড়া',
  APPROVED: 'Approved · অনুমোদিত',
  REJECTED: 'Rejected · বাতিল',
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    plan.value = await fetchPurchasePlan(session.accessToken.value ?? '', planId.value);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'LOAD_FAILED', message: 'The plan could not be loaded. Try again.' };
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function decide(decision: 'APPROVED' | 'REJECTED'): Promise<void> {
  const current = plan.value;
  if (current === null) return;

  busy.value = true;
  failure.value = null;
  try {
    plan.value = await decidePurchasePlan(session.accessToken.value ?? '', planId.value, {
      decision,
      version: current.version,
    });
    if (decision === 'APPROVED') await router.push({ name: 'purchase-plans' });
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'DECIDE_FAILED', message: 'The plan could not be updated. Try again.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppShell
    :title="plan?.planNumber ?? 'Purchase plan'"
    help-bn="সরবরাহকারী অনুযায়ী ভাগ করা"
  >
    <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />
    <p v-if="loading" class="muted">Loading…</p>

    <template v-else-if="plan !== null">
      <AppCard>
        <div class="head">
          <div>
            <p class="meta">
              <span :class="['status', plan.status.toLowerCase()]">
                {{ statusLabels[plan.status] }}
              </span>
              · {{ plan.businessDate }} · measured over {{ plan.lookBackDays }} days · holding
              {{ plan.coverDays }} days
            </p>
            <p v-if="plan.notes !== null" class="notes">{{ plan.notes }}</p>
            <p v-if="plan.totals !== undefined" class="money">
              <strong>{{ taka(plan.totals.investmentMinor) }}</strong> to spend ·
              {{ taka(plan.totals.expectedProfitMinor) }} expected profit ·
              {{ (plan.totals.marginPercentHundredths / 100).toFixed(2) }}% margin
            </p>
          </div>
          <div v-if="plan.status === 'DRAFT'" class="head-actions">
            <Button label="Approve" :disabled="busy" @click="decide('APPROVED')" />
            <Button
              label="Reject"
              severity="secondary"
              outlined
              :disabled="busy"
              @click="decide('REJECTED')"
            />
          </div>
        </div>
        <p v-if="plan.status === 'DRAFT'" class="hint">
          Approving makes one order for each supplier below, ready to print, save as a PDF or
          share. Nothing is bought until an order is converted.
        </p>
      </AppCard>

      <AppCard v-for="group in groups" :key="group.name">
        <h3>{{ group.name }}</h3>
        <table class="lines">
          <thead>
            <tr>
              <th>Product</th>
              <th class="num">Planned</th>
              <th class="num">Bought</th>
              <th class="num">Still to come</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="line in group.lines" :key="line.id">
              <td>{{ line.displayName }} <span class="unit">{{ line.unitName }}</span></td>
              <td class="num">{{ qtyText(line.plannedQty) }}</td>
              <td class="num">{{ qtyText(line.receivedQty) }}</td>
              <td class="num" :class="{ done: line.remainingQty === 0 }">
                {{ line.remainingQty === 0 ? 'all in' : qtyText(line.remainingQty) }}
              </td>
            </tr>
          </tbody>
        </table>
      </AppCard>

      <AppCard v-if="plan.orders.length > 0">
        <h3>Orders made</h3>
        <ul class="orders">
          <li v-for="order in plan.orders" :key="order.id">
            <button type="button" @click="router.push({ name: 'supplier-order', params: { id: order.id } })">
              {{ order.orderNumber }}
            </button>
            · {{ order.supplierName }} · {{ order.businessDate }} · {{ order.lineCount }} item(s)
          </li>
        </ul>
      </AppCard>
    </template>
  </AppShell>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sher-space-3);
  flex-wrap: wrap;
}

.head-actions {
  display: flex;
  gap: var(--sher-space-2);
}

.meta,
.notes,
.money,
.hint {
  margin: 0 0 4px;
  color: var(--sher-text-muted);
  font-size: 0.85rem;
}

.money strong {
  color: var(--sher-text);
}

.hint {
  margin-top: var(--sher-space-3);
}

.status {
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 0.74rem;
  background: var(--sher-surface-2);
}

.status.draft {
  background: color-mix(in srgb, var(--sher-warning) 18%, transparent);
  color: var(--sher-warning);
}

.status.approved {
  background: color-mix(in srgb, var(--sher-success) 16%, transparent);
  color: var(--sher-success);
}

.status.rejected {
  background: color-mix(in srgb, var(--sher-danger) 14%, transparent);
  color: var(--sher-danger);
}

h3 {
  margin: 0 0 var(--sher-space-2);
  font-size: 1rem;
}

.lines {
  width: 100%;
  border-collapse: collapse;
}

.lines th,
.lines td {
  padding: var(--sher-space-2);
  border-bottom: 1px solid var(--sher-line);
  text-align: left;
}

.lines .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.lines .done {
  color: var(--sher-success);
}

.unit {
  color: var(--sher-text-muted);
  font-size: 0.75rem;
}

.orders {
  margin: 0;
  padding-left: 1.1rem;
  color: var(--sher-text-muted);
  font-size: 0.9rem;
}

.orders button {
  background: none;
  border: none;
  padding: 0;
  color: var(--sher-primary);
  cursor: pointer;
  font: inherit;
}

.muted {
  color: var(--sher-text-muted);
}
</style>
