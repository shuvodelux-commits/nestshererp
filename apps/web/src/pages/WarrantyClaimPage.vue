<script setup lang="ts">
import type { ClaimStatusValue, WarrantyClaimResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchAccounts } from '../api/money';
import { fetchWarrantyClaim } from '../api/warranty';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import { taka } from '../components/money/money-text';
import ClaimStepDialog from '../components/warranty/ClaimStepDialog.vue';

/**
 * One warranty claim · একটি ওয়ারেন্টি (§5.19).
 *
 * The claim's own working page: what it is, who brought it, whether either
 * warranty still covers it, and the one or two things that can happen next.
 * The next steps come from the server, so the screen cannot offer a move the
 * use case would refuse.
 */
const session = useSession();
const route = useRoute();

const claim = ref<WarrantyClaimResponse | null>(null);
const accounts = ref<readonly { code: string; name: string }[]>([]);
const step = ref<ClaimStatusValue | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const statusLabels: Record<string, string> = {
  RECEIVED: 'Received — জমা নেওয়া',
  CHECKING: 'Checking — দেখা হচ্ছে',
  SENT_TO_SUPPLIER: 'With supplier — সাপ্লায়ারের কাছে',
  SETTLED: 'Settled — মীমাংসা',
  RETURNED_TO_CUSTOMER: 'Given back — ফেরত দেওয়া',
  CLOSED: 'Closed — শেষ',
};

const settlementLabels: Record<string, string> = {
  REPLACED: 'Replaced',
  REPAIRED: 'Repaired',
  ADJUSTED: 'Money adjusted',
  REJECTED: 'Refused by supplier',
};

const claimId = computed(() => String(route.params.id));

async function load(): Promise<void> {
  loading.value = true;
  try {
    claim.value = await fetchWarrantyClaim(session.accessToken.value ?? '', claimId.value);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'LOAD_FAILED', message: 'The claim could not be loaded. Try again.' };
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  try {
    const response = await fetchAccounts(session.accessToken.value ?? '');
    accounts.value = response.accounts.map((account) => ({
      code: `CASH:${account.id}`,
      name: account.name,
    }));
  } catch {
    // No accounts loaded means a supplier's cash settlement can only be put
    // against their account — still a correct posting, just fewer choices.
    accounts.value = [];
  }
});

function onMoved(): void {
  step.value = null;
  void load();
}
</script>

<template>
  <AppShell
    :title="claim?.claimNumber ?? 'Warranty claim'"
    help-bn="এই ওয়ারেন্টির অবস্থা আর পরের ধাপ"
  >
    <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />
    <p v-if="loading" class="muted">Loading…</p>

    <template v-else-if="claim !== null">
      <AppCard>
        <div class="claim-head">
          <div>
            <h2>{{ claim.displayName }}</h2>
            <p class="meta">
              {{ claim.customerName }}
              {{ claim.customerPhone === null ? '' : `· ${claim.customerPhone}` }}
              {{ claim.serialNo === null ? '' : `· ${claim.serialNo}` }}
              {{ claim.invoiceNumber === null ? '' : `· ${claim.invoiceNumber}` }}
            </p>
            <p class="complaint">“{{ claim.complaint }}”</p>
          </div>
          <span class="status">{{ statusLabels[claim.status] }}</span>
        </div>

        <div class="cover">
          <p :class="claim.customerWarrantyLive ? 'live' : 'dead'">
            Customer warranty:
            {{ claim.customerWarrantyLive ? 'still covered' : 'expired' }}
            {{ claim.customerWarrantyEnd === null ? '(not recorded)' : `· to ${claim.customerWarrantyEnd}` }}
          </p>
          <p :class="claim.supplierWarrantyLive ? 'live' : 'dead'">
            Supplier warranty:
            {{ claim.supplierWarrantyLive ? 'still covered' : 'expired' }}
            {{ claim.supplierWarrantyEnd === null ? '(not recorded)' : `· to ${claim.supplierWarrantyEnd}` }}
            {{ claim.supplierName === null ? '' : `· ${claim.supplierName}` }}
          </p>
        </div>
      </AppCard>

      <AppCard>
        <h3>What happened</h3>
        <ul class="facts">
          <li>Received: {{ claim.receivedDate }}</li>
          <li v-if="claim.sentToSupplierDate !== null">
            Sent to supplier: {{ claim.sentToSupplierDate }}
          </li>
          <li v-if="claim.settledDate !== null">
            Settled: {{ claim.settledDate }} ·
            {{ settlementLabels[claim.settlement ?? ''] ?? '' }}
          </li>
          <li v-if="claim.settlementNote !== null">Note: {{ claim.settlementNote }}</li>
          <li v-if="claim.warrantyCostMinor !== undefined">
            Cost to the shop so far: <strong>{{ taka(claim.warrantyCostMinor) }}</strong>
          </li>
        </ul>
      </AppCard>

      <AppCard v-if="claim.nextStatuses.length > 0">
        <h3>Next step</h3>
        <div class="steps">
          <Button
            v-for="next in claim.nextStatuses"
            :key="next"
            :label="statusLabels[next]"
            size="small"
            :severity="next === 'CLOSED' ? 'secondary' : undefined"
            :outlined="next === 'CLOSED'"
            @click="step = next"
          />
        </div>
      </AppCard>

      <ClaimStepDialog
        :claim="claim"
        :status="step"
        :accounts="accounts"
        @close="step = null"
        @moved="onMoved"
      />
    </template>
  </AppShell>
</template>

<style scoped>
.claim-head {
  display: flex;
  justify-content: space-between;
  gap: var(--sher-space-3);
  flex-wrap: wrap;
}

h2 {
  margin: 0;
  font-size: 1.15rem;
}

h3 {
  margin: 0 0 var(--sher-space-2);
  font-size: 1rem;
}

.meta {
  margin: 4px 0;
  color: var(--sher-text-muted);
  font-size: 0.85rem;
}

.complaint {
  margin: 0;
  font-style: italic;
}

.status {
  border-radius: 999px;
  padding: 4px 12px;
  background: var(--sher-surface-2);
  font-size: 0.8rem;
  white-space: nowrap;
  height: fit-content;
}

.cover {
  margin-top: var(--sher-space-3);
  display: grid;
  gap: 4px;
  font-size: 0.85rem;
}

.cover p {
  margin: 0;
}

.cover .live {
  color: var(--sher-success);
}

.cover .dead {
  color: var(--sher-danger);
}

.facts {
  margin: 0;
  padding-left: 1.1rem;
  color: var(--sher-text-muted);
  font-size: 0.9rem;
  display: grid;
  gap: 2px;
}

.facts strong {
  color: var(--sher-text);
}

.steps {
  display: flex;
  gap: var(--sher-space-2);
  flex-wrap: wrap;
}

.muted {
  color: var(--sher-text-muted);
}
</style>
