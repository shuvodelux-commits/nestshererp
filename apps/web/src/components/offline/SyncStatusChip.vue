<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';

import { startSyncWatch, useSync } from '../../offline/sync';

/**
 * What this machine is still holding, in the top bar (§14, §15, Phase 12.4).
 *
 * It appears only when there is something to say. A shop that has never worked
 * offline should never see it, and a shop that has just finished syncing should
 * watch it disappear — a permanent chip reading "0 waiting" teaches people to
 * stop reading the top bar.
 *
 * **Two different counts, deliberately not added together.** Waiting is work
 * that will go up by itself; needs review is work a person has to decide about.
 * One number covering both would be a number nobody can act on, and the second
 * kind is the one that stays stuck forever if nobody notices it.
 *
 * The colour escalates with age, never with failure: queued work is not an
 * error (§25), and a day-old queue on a shop with no internet is exactly what
 * this feature is for. What escalation says is "somebody should look at why
 * this machine has not got through", not "something went wrong".
 */
const router = useRouter();
const { pending, refused, urgency, phase, syncNow } = useSync();

onMounted(startSyncWatch);

const visible = computed(() => pending.value > 0 || refused.value > 0);

const label = computed(() => {
  if (phase.value === 'PUSHING') return 'Sending…';
  if (phase.value === 'PULLING') return 'Catching up…';
  if (refused.value > 0 && pending.value === 0) {
    return `${String(refused.value)} need review`;
  }
  if (refused.value > 0) {
    return `${String(pending.value)} waiting · ${String(refused.value)} need review`;
  }
  return `${String(pending.value)} waiting to send`;
});

const labelBn = computed(() => {
  if (phase.value === 'PUSHING') return 'পাঠানো হচ্ছে…';
  if (refused.value > 0) return 'কিছু বিষয় দেখতে হবে';
  return 'ইন্টারনেট এলে চলে যাবে';
});

const tone = computed(() => {
  if (refused.value > 0) return 'review';
  if (urgency.value === 'CRITICAL' || urgency.value === 'OVERDUE') return 'overdue';
  if (urgency.value === 'WARNING') return 'warn';
  return 'plain';
});

/**
 * Pressing it opens the queue; pressing it while nothing is refused tries the
 * line again first, because "send it now" is what a shopkeeper means when they
 * press a chip that says work is waiting.
 */
async function open(): Promise<void> {
  if (refused.value === 0) await syncNow();
  await router.push('/sync');
}
</script>

<template>
  <button
    v-if="visible"
    type="button"
    class="sync-chip"
    :class="tone"
    :aria-label="`${label} — open Sync`"
    @click="open"
  >
    <span class="dot" aria-hidden="true" />
    <span class="chip-text">
      <span class="chip-label">{{ label }}</span>
      <span class="chip-sub">{{ labelBn }}</span>
    </span>
  </button>
</template>

<style scoped>
.sync-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 4px 12px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: 999px;
  background: var(--sher-surface);
  color: inherit;
  cursor: pointer;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--sher-text-muted);
}

.sync-chip.warn .dot {
  background: var(--sher-warning, #b7791f);
}

.sync-chip.overdue .dot,
.sync-chip.review .dot {
  background: var(--sher-danger, #c0392b);
}

.chip-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.2;
}

.chip-label {
  font-size: 14px;
  font-weight: 600;
}

.chip-sub {
  font-size: 11px;
  color: var(--sher-text-muted);
}

@media (max-width: 900px) {
  .chip-text {
    display: none;
  }
}
</style>
