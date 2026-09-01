<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';

import { useOfflineStatus } from '../../offline/status';
import { startOfflineWatch } from '../../offline/status';
import { OFFLINE_BN } from './offline-text';

/**
 * The offline pill in the top bar (owner decision 2026-08-31).
 *
 * It sits beside the day chip for the same reason that one does: whether this
 * machine can work without internet is a fact about the machine, not about the
 * screen you happen to be on, and a shop that finds it out during a power cut
 * has found out too late.
 *
 * **It never says the shop can trade offline.** `OFFLINE_SETUP_READY` means the
 * setup is done — the app is installed, storage is safe, there is room, and the
 * owner has approved this computer. Trading without internet needs the local
 * database and the sync engine, which are the next module's, and the pill's
 * wording keeps that line visible: "Offline setup ready", never "Offline
 * ready".
 *
 * Pressing it opens the one page that explains the state and holds the buttons
 * that change it — the chip itself is never the fix, because the fixes need
 * words.
 */
const router = useRouter();
const { state, loading } = useOfflineStatus();

onMounted(startOfflineWatch);

const label = computed(() => {
  if (state.value === 'UNKNOWN') return loading.value ? 'Checking…' : 'Offline: unknown';
  if (state.value === 'OFFLINE_SETUP_READY') return 'Offline setup ready';
  if (state.value === 'READ_ONLY') return 'Read-only offline';
  return 'Online only';
});

const labelBn = computed(() => {
  if (state.value === 'UNKNOWN') return OFFLINE_BN.chipChecking;
  if (state.value === 'OFFLINE_SETUP_READY') return OFFLINE_BN.chipSetupReady;
  if (state.value === 'READ_ONLY') return OFFLINE_BN.chipReadOnly;
  return OFFLINE_BN.chipOnlineOnly;
});

const tone = computed(() => {
  if (state.value === 'OFFLINE_SETUP_READY') return 'ready';
  if (state.value === 'READ_ONLY') return 'warn';
  return 'plain';
});
</script>

<template>
  <button
    type="button"
    class="offline-chip"
    :class="tone"
    :title="label"
    :aria-label="`${label} — open Offline and Devices`"
    @click="router.push('/settings/offline')"
  >
    <span class="dot" aria-hidden="true" />
    <span class="chip-text">
      <span class="chip-label">{{ label }}</span>
      <span class="chip-sub">{{ labelBn }}</span>
    </span>
  </button>
</template>

<style scoped>
.offline-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  /* The 40px touch target UI-59 protects, matching the day chip beside it. */
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

.offline-chip.ready .dot {
  background: var(--sher-success, #1e8449);
}

.offline-chip.warn .dot {
  background: var(--sher-warning, #b7791f);
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

/* On a narrow counter screen the pill keeps its dot and loses its words before
   the day chip does — the day is the thing a cashier acts on hourly. */
@media (max-width: 900px) {
  .chip-text {
    display: none;
  }
}
</style>
