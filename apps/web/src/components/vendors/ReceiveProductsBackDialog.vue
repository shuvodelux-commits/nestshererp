<script setup lang="ts">
import type { VendorProductIssueResponse } from '@sher/core-contracts';
import { QTY_SCALE, SystemClock, Ulid, formatForDisplay } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { receiveProductsBack } from '../../api/vendors';
import { useSession } from '../../auth/session';
import AmountInput from '../fields/AmountInput.vue';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Goods on temporary issue coming back (§5.6 M07).
 *
 * They return into **the very lots they left**, at the cost they left at, so
 * the shop's stock value is exactly what it was before the goods went out and
 * FIFO order still means something afterwards.
 *
 * Goods that were *charged* to the vendor are not settled here: they were sold,
 * so they come back as a sales return against their invoice — the workspace
 * opens that dialog instead, because unwinding a sale's COGS and its receivable
 * is the returns module's work and there is only one of it.
 */
const props = defineProps<{
  vendorName: string;
  issues: readonly VendorProductIssueResponse[];
}>();

const emit = defineEmits<{ (event: 'received'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();

const issueId = ref<string | null>(props.issues[0]?.id ?? null);
const qty = ref(0);
const note = ref('');
const businessDate = ref(clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone));
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const issueOptions = computed(() =>
  props.issues.map((issue) => ({
    value: issue.id,
    label: `${issue.number} — ${issue.displayName} · ${formatForDisplay(issue.openQty, QTY_SCALE)} ${issue.unitName} out`,
  })),
);

const selected = computed(
  () => props.issues.find((issue) => issue.id === issueId.value) ?? null,
);
/** What is still at the vendor's, in display units. */
const outstanding = computed(() => (selected.value?.openQty ?? 0) / 1000);
const overOutstanding = computed(() => qty.value > outstanding.value + 1e-9);
const ready = computed(
  () => issueId.value !== null && qty.value > 0 && !overOutstanding.value,
);

/* Instant recalculation: picking an issue proposes all of what is still out,
 * which is the commonest case, and the shopkeeper types over it when it is
 * only some of them. */
watch(
  selected,
  (issue) => {
    qty.value = issue === null ? 0 : issue.openQty / 1000;
  },
  { immediate: true },
);

async function save(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || issueId.value === null || !ready.value) return;

  busy.value = true;
  failure.value = null;
  try {
    await receiveProductsBack(
      token,
      {
        issueId: issueId.value,
        qty: Math.round(qty.value * 1000),
        note: note.value.trim() === '' ? null : note.value.trim(),
        businessDate: businessDate.value,
      },
      operationId.value,
    );
    emit('received');
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not record this return' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    visible
    modal
    :header="`Receive back from ${vendorName} — মাল ফেরত নিন`"
    :style="{ width: 'min(34rem, 96vw)' }"
    @update:visible="emit('close')"
  >
    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <p v-if="issues.length === 0" class="notice is-ok">
      Nothing is out on temporary issue with this vendor. Goods charged to them come back as a
      sales return against their invoice — use Received back on the invoice row below.
    </p>

    <template v-else>
      <div class="two-column">
        <div class="field">
          <label for="back-issue">Issue <span class="label-bn">কোন চালান</span></label>
          <Select
            input-id="back-issue"
            v-model="issueId"
            :options="issueOptions"
            option-label="label"
            option-value="value"
            append-to="body"
            fluid
          />
        </div>

        <div class="field">
          <label for="back-qty">
            Quantity <span class="label-bn">পরিমাণ</span>
            <span v-if="selected" class="unit">({{ selected.unitName }})</span>
          </label>
          <AmountInput input-id="back-qty" v-model="qty" :decimals="2" />
        </div>

        <div class="field">
          <label for="back-date">Date <span class="label-bn">তারিখ</span></label>
          <DateOnlyPicker v-model="businessDate" input-id="back-date" />
        </div>

        <div class="field">
          <label for="back-note">Note <span class="label-bn">মন্তব্য</span></label>
          <InputText id="back-note" v-model="note" maxlength="300" fluid />
        </div>
      </div>

      <p v-if="overOutstanding" class="notice is-warn">
        Only {{ selected ? formatForDisplay(selected.openQty, QTY_SCALE) : 0 }} are still out on
        this issue.
      </p>
      <p v-else class="notice is-ok">
        The goods go back into the lots they came from, at the cost they left at. No money moves.
        <span class="label-bn">হিসাবে কোনো টাকা যোগ হবে না</span>
      </p>
    </template>

    <template #footer>
      <Button label="Cancel" text @click="emit('close')" />
      <Button
        icon="pi pi-check"
        label="Receive back"
        :disabled="!ready"
        :loading="busy"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.two-column {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--sher-space-3, 12px);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
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

.unit {
  margin-left: 4px;
  font-weight: 400;
  color: var(--sher-text-muted);
}
</style>
