<script setup lang="ts">
import { computed } from 'vue';

import { appIsBusy } from '../../offline/app-busy';
import { applyUpdate, useAppUpdates } from '../../offline/service-worker';
import { OFFLINE_BN } from './offline-text';

/**
 * "Update available — reload" (owner decision 2026-08-31).
 *
 * A new build never takes over on its own. It waits behind the running one, and
 * this bar offers the swap — **except while a screen says it is busy**, which
 * on the POS means a cart with something in it. A cashier halfway through a
 * bill does not get their page reloaded, and the offer comes back the moment
 * the sale is finished.
 */
const { updateWaiting } = useAppUpdates();
const visible = computed(() => updateWaiting.value && !appIsBusy.value);
</script>

<template>
  <div v-if="visible" class="update-bar" role="status">
    <span class="update-bar__text">
      <strong>Update available</strong>
      <span class="label-bn">{{ OFFLINE_BN.updateReady }}</span>
    </span>
    <button type="button" class="btn btn-primary" @click="applyUpdate()">Reload</button>
  </div>
</template>

<style scoped>
.update-bar {
  position: fixed;
  right: var(--sher-space-4);
  bottom: var(--sher-space-4);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  padding: var(--sher-space-2) var(--sher-space-3);
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface);
  box-shadow: var(--sher-shadow-2, 0 8px 24px rgb(0 0 0 / 12%));
}

.update-bar__text {
  display: grid;
  line-height: 1.2;
}
</style>
