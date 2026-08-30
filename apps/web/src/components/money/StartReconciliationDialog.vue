<script setup lang="ts">
import type { MoneyAccountResponse } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import { computed, ref } from 'vue';

import { ApiError } from '../../api/client';
import { startReconciliation } from '../../api/reconciliation';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Starting a reconciliation — the two dates on the bank's statement (§5.17).
 *
 * Nothing else is asked, because nothing else is known yet: the statement's
 * closing balance is confirmed at the end, once the rows have been matched and
 * the figure means something.
 */
const props = defineProps<{ account: MoneyAccountResponse }>();
const emit = defineEmits<{ close: []; started: [id: string] }>();

const clock = new SystemClock();
const session = useSession();
const today = clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone);

/** A month back is what a bank statement covers, so it is what this opens on. */
const firstOfMonth = `${today.slice(0, 8)}01`;

const fromDate = ref(firstOfMonth);
const toDate = ref(today);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const ready = computed(() => fromDate.value !== '' && toDate.value !== '' && fromDate.value <= toDate.value);

async function begin(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;

  busy.value = true;
  failure.value = null;
  try {
    const workspace = await startReconciliation(token, {
      accountId: props.account.id,
      fromDate: fromDate.value,
      toDate: toDate.value,
      operationId: operationId.value,
    });
    emit('started', workspace.id);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not start the reconciliation' };
    operationId.value = Ulid.generate(clock);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    :header="`Reconcile ${account.name} — ব্যাংকের সাথে মিলিয়ে দেখুন`"
    :style="{ width: 'min(34rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <form class="recon-start" @submit.prevent="begin">
      <p class="lead">
        Take the statement the bank gave you, and put the two dates it covers here.
      </p>

      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <div class="two-up">
        <div class="field">
          <label for="recon-from">From <span>শুরুর তারিখ</span></label>
          <DateOnlyPicker input-id="recon-from" v-model="fromDate" />
        </div>
        <div class="field">
          <label for="recon-to">To <span>শেষ তারিখ</span></label>
          <DateOnlyPicker input-id="recon-to" v-model="toDate" />
        </div>
      </div>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy || !ready">
          {{ busy ? 'Opening…' : 'Start' }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.recon-start {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3, 12px);
}

.lead {
  margin: 0;
  font-size: 13px;
  color: var(--sher-text-muted);
}

.two-up {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sher-space-3, 12px);
}

@media (max-width: 520px) {
  .two-up {
    grid-template-columns: 1fr;
  }
}
</style>
