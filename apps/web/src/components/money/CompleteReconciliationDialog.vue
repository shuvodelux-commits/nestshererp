<script setup lang="ts">
import type { ReconciliationWorkspaceResponse } from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import { computed, ref } from 'vue';

import { ApiError } from '../../api/client';
import { completeReconciliation } from '../../api/reconciliation';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';
import AmountInput from '../fields/AmountInput.vue';
import { taka } from './money-text';

/**
 * Signing the reconciliation off (§5.17).
 *
 * The owner types the closing balance **the statement shows**, and the three
 * figures underneath move as they type: what the bank says, what the matched
 * entries come to, and the difference between them. Nothing is hidden and
 * nothing is nudged — if the difference is not zero, the button stays disabled
 * and the screen says which rows are still loose.
 */
const props = defineProps<{ workspace: ReconciliationWorkspaceResponse }>();
const emit = defineEmits<{ close: []; completed: [workspace: ReconciliationWorkspaceResponse] }>();

const session = useSession();

const closing = ref((props.workspace.summary.statementClosingMinor ?? 0) / 100);
const note = ref('');
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const closingMinor = computed(() => Math.round(closing.value * 100));
/** Recomputed on every keystroke — a stale difference is worse than none. */
const differenceMinor = computed(
  () => closingMinor.value - props.workspace.summary.reconciledBalanceMinor,
);
/** The blockers the server will apply, minus the one this dialog is answering. */
const otherBlockers = computed(() =>
  props.workspace.summary.blockers.filter(
    (blocker) => !blocker.startsWith('Confirm the closing balance') && !blocker.startsWith('The statement and'),
  ),
);
const ready = computed(() => differenceMinor.value === 0 && otherBlockers.value.length === 0);

async function complete(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !ready.value) return;

  busy.value = true;
  failure.value = null;
  try {
    const updated = await completeReconciliation(token, props.workspace.id, {
      statementClosingBalanceMinor: closingMinor.value,
      note: note.value.trim() === '' ? null : note.value.trim(),
      version: props.workspace.version,
    });
    emit('completed', updated);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not complete the reconciliation' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    header="Finish this reconciliation — মিলিয়ে দেখা শেষ করুন"
    :style="{ width: 'min(36rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <form class="complete" @submit.prevent="complete">
      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <div class="field">
        <label for="closing-balance">
          Closing balance on the statement <span>ব্যাংকের কাগজে শেষ ব্যালেন্স</span>
        </label>
        <AmountInput id="closing-balance" v-model="closing" />
      </div>

      <dl class="figures">
        <div>
          <dt>The statement says</dt>
          <dd>{{ taka(closingMinor) }}</dd>
        </div>
        <div>
          <dt>Our matched entries come to</dt>
          <dd>{{ taka(workspace.summary.reconciledBalanceMinor) }}</dd>
        </div>
        <div :class="{ off: differenceMinor !== 0 }">
          <dt>Difference</dt>
          <dd>{{ taka(differenceMinor) }}</dd>
        </div>
      </dl>

      <ul v-if="otherBlockers.length > 0" class="blockers">
        <li v-for="blocker in otherBlockers" :key="blocker">{{ blocker }}</li>
      </ul>

      <p v-else-if="differenceMinor !== 0" class="blockers">
        Keep going until this is zero — the gap is real, and it is a transaction somebody has to
        look at.
      </p>

      <div class="field">
        <label for="recon-note">Note <span>মন্তব্য — ঐচ্ছিক</span></label>
        <input id="recon-note" v-model="note" autocomplete="off" placeholder="Anything worth remembering" />
      </div>

      <p class="consequence">
        Once signed off, this becomes the shop's record for these dates. It stays exactly as it is
        — if one of these transactions is corrected later, this reconciliation is marked for review
        rather than quietly changed.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy || !ready">
          {{ busy ? 'Finishing…' : 'Complete' }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.complete {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3, 12px);
}

.figures {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--sher-space-3, 12px);
  border-radius: 8px;
  background: var(--sher-surface-muted, #f5f5f4);
}

.figures > div {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.figures dt,
.figures dd {
  margin: 0;
}

.figures dd {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.figures .off dd {
  color: var(--sher-danger, #b91c1c);
}

.blockers {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--sher-danger, #b91c1c);
}

.consequence {
  margin: 0;
  font-size: 12px;
  color: var(--sher-text-muted);
}
</style>
