<script setup lang="ts">
import type { WhyResponse } from '@sher/core-contracts';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { fetchWhy } from '../../api/reports';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';
import { qtyText, taka } from '../money/money-text';

/**
 * "Why?" (§5.20) — the transactions behind one figure.
 *
 * This is the practical test of INV-10: a total that cannot name the journal
 * lines or stock movements under it was computed the wrong way. It is a modal
 * over the report, in the same shape as every other one-task dialog, so the
 * shopkeeper keeps their place on the screen they were reading.
 */
const props = defineProps<{
  subject: string | null;
  itemKey: string;
  label: string;
  from: string;
  to: string;
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'open', sourceId: string, sourceType: string): void }>();

const session = useSession();
const answer = ref<WhyResponse | null>(null);
const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

const visible = computed({
  get: () => props.subject !== null,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || props.subject === null) return;
  loading.value = true;
  error.value = null;
  answer.value = null;
  try {
    answer.value = await fetchWhy(token, {
      subject: props.subject,
      key: props.itemKey,
      from: props.from,
      to: props.to,
    });
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load the details' };
  } finally {
    loading.value = false;
  }
}

watch(() => [props.subject, props.itemKey], () => void load(), { immediate: true });
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="`Why? — এই হিসাব কোথা থেকে এলো`"
    :style="{ width: 'min(52rem, 96vw)' }"
  >
    <div class="why">
      <p class="why__subject">
        <strong>{{ label }}</strong>
        <span>{{ from }} → {{ to }}</span>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <DataTable
        v-if="answer !== null"
        :value="[...answer.lines]"
        :loading="loading"
        data-key="id"
        striped-rows
        scrollable
        scroll-height="24rem"
      >
        <Column field="businessDate" header="Date">
          <template #body="{ data }">
            {{ data.businessDate }}
            <small class="why__sub">{{ data.sourceNumber }}</small>
          </template>
        </Column>
        <Column field="description" header="What happened">
          <template #body="{ data }">
            <button type="button" class="why__link" @click="emit('open', data.sourceId, data.sourceType)">
              {{ data.description }}
            </button>
            <small v-if="data.partyName" class="why__sub">{{ data.partyName }}</small>
          </template>
        </Column>
        <Column header="Quantity" class="why__num">
          <template #body="{ data }">
            <span v-if="data.qty !== null">{{ qtyText(data.qty) }}</span>
            <span v-else class="why__muted">—</span>
          </template>
        </Column>
        <Column header="Amount" class="why__num">
          <template #body="{ data }">
            <span v-if="data.amountMinor !== null" :class="data.direction === 'OUT' ? 'why__out' : 'why__in'">
              {{ taka(data.amountMinor) }}
            </span>
            <span v-else class="why__muted">—</span>
          </template>
        </Column>
      </DataTable>

      <p v-if="answer !== null" class="why__total">
        <span v-if="answer.totalMinor !== null">Total: <strong>{{ taka(answer.totalMinor) }}</strong></span>
        <span v-if="answer.totalQty !== null">Quantity: <strong>{{ qtyText(answer.totalQty) }}</strong></span>
        <span v-if="answer.truncated" class="why__muted">Showing the most recent entries only.</span>
      </p>
    </div>
  </Dialog>
</template>

<style scoped>
.why { display: grid; gap: 0.75rem; }
.why__subject { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin: 0; }
.why__subject span { color: var(--sher-text-muted, #64748b); font-size: 0.85rem; }
.why__sub { display: block; color: var(--sher-text-muted, #64748b); font-size: 0.75rem; }
.why__muted { color: var(--sher-text-muted, #94a3b8); }
.why__num { text-align: right; }
.why__in { color: var(--sher-ok, #15803d); }
.why__out { color: var(--sher-bad, #b91c1c); }
.why__link { background: none; border: 0; padding: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; text-decoration: underline dotted; }
.why__total { display: flex; gap: 1.5rem; margin: 0; }
</style>
