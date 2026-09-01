<script setup lang="ts">
import { computed } from 'vue';

import { useConnectivity } from '../../offline/connectivity';
import { useSnapshot } from '../../offline/snapshot';
import {
  offlineBarText,
  offlineBarTextBn,
  OFFLINE_NO_COPY,
  OFFLINE_NO_COPY_BN,
  SNAPSHOT_BN,
} from './offline-text';

/**
 * "Offline — showing local data · Last synced: 2:15 PM" (owner wording,
 * 2026-08-31).
 *
 * The bar sits above the page on every screen that can read the local copy, and
 * it carries the two facts that matter in the order a shopkeeper needs them:
 * the internet is gone, and this is how old what you are looking at is. Without
 * the second half somebody quotes a stale price believing it is live, which is
 * the whole reason the owner asked for a bar rather than a quiet chip.
 *
 * From three days old it turns to its warning colours and says the age in days
 * instead of a clock time — the owner's threshold, chosen because a shop is
 * rarely off the internet for three days by accident, and a warning that fired
 * after every overnight gap would be read by nobody within a week.
 */
const { isOffline } = useConnectivity();
const { stored, ageInDays, isStale } = useSnapshot();

/**
 * The clock time for today's copy, the age in days for an older one.
 *
 * Western digits throughout (UI-47), including inside the Bangla helper: a
 * shopkeeper reads the time off a phone in the same digits all day.
 */
const when = computed<string | null>(() => {
  const takenAt = stored.value?.takenAt;
  if (takenAt === undefined) return null;

  const days = ageInDays.value;
  if (days !== null && days >= 1) return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`;

  const taken = Date.parse(takenAt);
  if (Number.isNaN(taken)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(taken);
});

const whenBn = computed<string | null>(() => {
  const days = ageInDays.value;
  if (days !== null && days >= 1) return `${String(days)} দিন আগে`;
  return when.value;
});
</script>

<template>
  <div
    v-if="isOffline"
    class="offline-bar"
    :class="{ 'offline-bar--stale': isStale }"
    role="status"
    aria-live="polite"
  >
    <template v-if="when !== null">
      <span class="offline-bar__text">{{ offlineBarText(when) }}</span>
      <span class="offline-bar__bn label-bn">{{ offlineBarTextBn(whenBn ?? when) }}</span>
    </template>
    <template v-else>
      <span class="offline-bar__text">{{ OFFLINE_NO_COPY }}</span>
      <span class="offline-bar__bn label-bn">{{ OFFLINE_NO_COPY_BN }}</span>
    </template>
    <span v-if="isStale" class="offline-bar__warn label-bn">{{ SNAPSHOT_BN.warning }}</span>
  </div>
</template>

<style scoped>
.offline-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sher-space-1) var(--sher-space-3);
  padding: var(--sher-space-2) var(--sher-space-3);
  margin-bottom: var(--sher-space-3);
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface-2, var(--sher-surface));
  color: var(--sher-text);
}

/* Three days old: the same warning colours the rest of the app already uses. */
.offline-bar--stale {
  border-color: var(--sher-warn-line);
  background: var(--sher-warn-bg);
  color: var(--sher-warn);
}

.offline-bar__text {
  font-weight: 600;
}

.offline-bar__bn,
.offline-bar__warn {
  color: inherit;
  opacity: 0.85;
}
</style>
