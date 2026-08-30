<script setup lang="ts">
import type { ClaimCandidateResponse, WarrantyClaimResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { createWarrantyClaim, fetchWarrantyClaims, lookupWarranty } from '../api/warranty';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Warranty claims · ওয়ারেন্টি (§5.19, owner decision 2026-08-26).
 *
 * **A customer walks in with a faulty item and no receipt.** The serial alone
 * finds the unit, the invoice, the customer, which delivery it came in on, the
 * supplier and both warranty dates — nothing typed. With no serial on the item,
 * the phone number or the invoice number does the same job less exactly.
 *
 * Taking one in is the only thing this screen writes; everything that follows
 * happens on the claim's own page.
 */
const session = useSession();
const router = useRouter();

const claims = ref<readonly WarrantyClaimResponse[]>([]);
const openOnly = ref(true);
const lookupText = ref('');
const candidates = ref<readonly ClaimCandidateResponse[]>([]);
const chosen = ref<ClaimCandidateResponse | null>(null);
const complaint = ref('');
const customerName = ref('');
const customerPhone = ref('');
const searching = ref(false);
const saving = ref(false);
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

async function load(): Promise<void> {
  loading.value = true;
  try {
    const response = await fetchWarrantyClaims(session.accessToken.value ?? '', {
      openOnly: openOnly.value,
      limit: 100,
    });
    claims.value = response.data;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'LOAD_FAILED', message: 'Claims could not be loaded. Try again.' };
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/**
 * One box, three ways in.
 *
 * The shopkeeper does not have to say which of the three they are holding — a
 * serial, a phone number or an invoice number all go into the same box, and all
 * three are asked at once.
 */
async function lookup(): Promise<void> {
  const text = lookupText.value.trim();
  if (text === '') return;

  searching.value = true;
  failure.value = null;
  try {
    const response = await lookupWarranty(session.accessToken.value ?? '', {
      serial: text,
      phone: text,
      invoiceNumber: text,
    });
    candidates.value = response.data;
    if (response.data.length === 0) {
      failure.value = {
        code: 'NOT_FOUND',
        message: 'Nothing found for that. Check the number, or take the claim in by hand.',
      };
    }
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'LOOKUP_FAILED', message: 'The lookup failed. Try again.' };
  } finally {
    searching.value = false;
  }
}

function choose(candidate: ClaimCandidateResponse): void {
  chosen.value = candidate;
  customerName.value = candidate.customerName ?? '';
  customerPhone.value = candidate.customerPhone ?? '';
}

async function take(): Promise<void> {
  const candidate = chosen.value;
  if (candidate === null) return;

  if (complaint.value.trim() === '') {
    failure.value = { code: 'VALIDATION_FAILED', message: 'Write what is wrong with it' };
    return;
  }

  saving.value = true;
  failure.value = null;
  try {
    const claim = await createWarrantyClaim(session.accessToken.value ?? '', {
      productId: candidate.productId,
      inventoryUnitId: candidate.inventoryUnitId,
      saleId: candidate.saleId,
      customerPartyId: candidate.customerPartyId,
      customerName: customerName.value.trim() === '' ? 'Walk-in customer' : customerName.value.trim(),
      customerPhone: customerPhone.value.trim() === '' ? null : customerPhone.value.trim(),
      complaint: complaint.value.trim(),
      handling: 'SHOP',
      courierName: null,
    });
    await router.push({ name: 'warranty-claim', params: { id: claim.id } });
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'SAVE_FAILED', message: 'The claim could not be saved. Try again.' };
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppShell title="Warranty" help-bn="নষ্ট মাল জমা নিন, সাপ্লায়ারের কাছে পাঠান">
    <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

    <AppCard>
      <h3>Take a claim in <span class="bn">নতুন ওয়ারেন্টি</span></h3>
      <div class="lookup">
        <div class="field grow">
          <label for="wc-lookup">
            Serial, phone or invoice number
            <span class="label-bn">সিরিয়াল, ফোন নম্বর বা বিলের নম্বর</span>
          </label>
          <input
            id="wc-lookup"
            v-model="lookupText"
            autocomplete="off"
            placeholder="Scan the serial, or type a phone number"
            @keydown.enter.prevent="lookup"
          />
        </div>
        <Button label="Find" :loading="searching" @click="lookup" />
      </div>

      <ul v-if="candidates.length > 0" class="candidates">
        <li
          v-for="candidate in candidates"
          :key="candidate.inventoryUnitId ?? candidate.productId"
          :class="{ chosen: chosen?.inventoryUnitId === candidate.inventoryUnitId }"
          @click="choose(candidate)"
        >
          <strong>{{ candidate.displayName }}</strong>
          <span v-if="candidate.serialNo !== null" class="serial">{{ candidate.serialNo }}</span>
          <span class="muted">
            {{ candidate.customerName ?? 'Walk-in' }} ·
            {{ candidate.invoiceNumber ?? 'no invoice' }} ·
            sold {{ candidate.soldDate ?? '—' }}
          </span>
          <span class="cover">
            <em :class="candidate.customerWarrantyLive ? 'live' : 'dead'">
              Customer: {{ candidate.customerWarrantyLive ? 'covered' : 'expired' }}
              {{ candidate.customerWarrantyEnd === null ? '' : `to ${candidate.customerWarrantyEnd}` }}
            </em>
            <em :class="candidate.supplierWarrantyLive ? 'live' : 'dead'">
              Supplier: {{ candidate.supplierWarrantyLive ? 'covered' : 'expired' }}
              {{ candidate.supplierWarrantyEnd === null ? '' : `to ${candidate.supplierWarrantyEnd}` }}
            </em>
          </span>
        </li>
      </ul>

      <div v-if="chosen !== null" class="take">
        <div class="grid">
          <div class="field">
            <label for="wc-name">Customer <span class="label-bn">কে এনেছেন</span></label>
            <input id="wc-name" v-model="customerName" placeholder="Name on the claim" />
          </div>
          <div class="field">
            <label for="wc-phone">Phone <span class="label-bn">ফোন নম্বর</span></label>
            <input id="wc-phone" v-model="customerPhone" placeholder="01XXXXXXXXX" />
          </div>
        </div>
        <div class="field">
          <label for="wc-complaint">What is wrong <span class="label-bn">কী সমস্যা</span></label>
          <input id="wc-complaint" v-model="complaint" placeholder="Screen not turning on" />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" @click="chosen = null">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="take">
            {{ saving ? 'Saving…' : 'Take it in' }}
          </button>
        </div>
      </div>
    </AppCard>

    <AppCard>
      <div class="list-head">
        <h3>Claims</h3>
        <label class="open-only">
          <input v-model="openOnly" type="checkbox" @change="load" />
          <span>Only the ones still open <em>যেগুলো এখনো শেষ হয়নি</em></span>
        </label>
      </div>

      <p v-if="loading" class="muted">Loading…</p>
      <EmptyState v-else-if="claims.length === 0" icon="pi-verified" title="No claims">
        When a customer brings a faulty item back, take it in above and it will appear here.
      </EmptyState>
      <table v-else class="claims">
        <thead>
          <tr>
            <th>Claim</th>
            <th>Product</th>
            <th>Customer</th>
            <th>Received</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="claim in claims"
            :key="claim.id"
            class="row"
            @click="router.push({ name: 'warranty-claim', params: { id: claim.id } })"
          >
            <td>
              <strong>{{ claim.claimNumber }}</strong>
              <span v-if="claim.serialNo !== null" class="muted">{{ claim.serialNo }}</span>
            </td>
            <td>{{ claim.displayName }}</td>
            <td>{{ claim.customerName }}</td>
            <td>{{ claim.receivedDate }}</td>
            <td><span class="status">{{ statusLabels[claim.status] }}</span></td>
          </tr>
        </tbody>
      </table>
    </AppCard>
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

h3 {
  margin: 0 0 var(--sher-space-2);
  font-size: 1rem;
}

.bn {
  color: var(--sher-text-muted);
  font-size: 0.8rem;
  font-weight: 400;
}

.lookup {
  display: flex;
  align-items: flex-end;
  gap: var(--sher-space-3);
}

.grow {
  flex: 1;
}

.candidates {
  list-style: none;
  margin: var(--sher-space-3) 0 0;
  padding: 0;
  display: grid;
  gap: var(--sher-space-2);
}

.candidates li {
  border: 1px solid var(--sher-border);
  border-radius: var(--sher-radius);
  padding: var(--sher-space-2);
  cursor: pointer;
  display: grid;
  gap: 2px;
}

.candidates li.chosen {
  border-color: var(--sher-primary);
  background: var(--sher-surface-2);
}

.serial {
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
}

.cover {
  display: flex;
  gap: var(--sher-space-3);
  flex-wrap: wrap;
  font-size: 0.78rem;
}

.cover em {
  font-style: normal;
}

.cover .live {
  color: var(--sher-success);
}

.cover .dead {
  color: var(--sher-danger);
}

.take {
  margin-top: var(--sher-space-3);
  display: grid;
  gap: var(--sher-space-3);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sher-space-3);
}

@media (max-width: 40rem) {
  .grid,
  .lookup {
    grid-template-columns: 1fr;
    flex-direction: column;
    align-items: stretch;
  }
}

.list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sher-space-3);
  flex-wrap: wrap;
}

.open-only {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
  font-size: 0.9rem;
}

.open-only em {
  color: var(--sher-text-muted);
  font-style: normal;
  font-size: 0.8rem;
}

.claims {
  width: 100%;
  border-collapse: collapse;
  margin-top: var(--sher-space-2);
}

.claims th,
.claims td {
  padding: var(--sher-space-2);
  border-bottom: 1px solid var(--sher-border);
  text-align: left;
}

.row {
  cursor: pointer;
}

.row:hover {
  background: var(--sher-surface-2);
}

.status {
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 0.75rem;
  background: var(--sher-surface-2);
  color: var(--sher-text-muted);
  white-space: nowrap;
}

.muted {
  display: block;
  color: var(--sher-text-muted);
  font-size: 0.78rem;
}
</style>
