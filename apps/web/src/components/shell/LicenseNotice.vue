<script setup lang="ts">
import type { LicenseNotice } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import { fetchLicenseNotice } from '../../api/license';
import { useSession } from '../../auth/session';

/**
 * The licence banner (Phase 10, D-36, owner decision 2026-08-30).
 *
 * Escalating, and only when something has to be done about it:
 *
 *   ACTIVE / RESTORED  nothing at all — a healthy licence is not news, and a
 *                      countdown in front of a shopkeeper for eleven months of
 *                      a good year is noise they learn to stop reading.
 *   EXPIRING           a quiet line.
 *   GRACE              a prominent countdown, while writes still work.
 *   READ_ONLY          a persistent notice, **for every user including the
 *                      cashier**, saying writes are blocked and everything
 *                      recorded is still readable and exportable.
 *
 * Not gated on `license.term.view`. That permission guards the Settings page;
 * this is the sentence a cashier needs on the screen they are standing at when
 * a sale will not save.
 */
const session = useSession();

const notice = ref<LicenseNotice | null>(null);

const visible = computed(() => {
  const state = notice.value?.state;
  return state === 'EXPIRING' || state === 'GRACE' || state === 'READ_ONLY';
});

const tone = computed(() => {
  const state = notice.value?.state;
  if (state === 'READ_ONLY') return 'lic-note--bad';
  if (state === 'GRACE') return 'lic-note--warn';
  return 'lic-note--soft';
});

const message = computed(() => {
  const current = notice.value;
  if (current === null) return '';
  if (current.state === 'READ_ONLY') {
    return 'This SherERP licence has ended, so nothing new can be saved. Everything already recorded is still here — you can open it, print it and download a backup.';
  }
  if (current.state === 'GRACE') {
    return `The licence term has ended. SherERP keeps working for ${String(current.graceDaysRemaining ?? 0)} more days, then nothing new can be saved.`;
  }
  return `The licence ends in ${String(current.daysRemaining ?? 0)} days.`;
});

const messageBn = computed(() => {
  const state = notice.value?.state;
  if (state === 'READ_ONLY') return 'লাইসেন্স শেষ — নতুন কিছু সেভ হবে না, পুরনো সব হিসাব দেখা ও ব্যাকআপ নেওয়া যাবে।';
  if (state === 'GRACE') return 'লাইসেন্সের মেয়াদ শেষ হয়ে গেছে — অল্প কিছু দিন বাকি।';
  return 'লাইসেন্সের মেয়াদ শেষ হয়ে আসছে।';
});

onMounted(async () => {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    notice.value = await fetchLicenseNotice(token);
  } catch {
    // A banner that could not load must never break the screen behind it. The
    // read-only guard still refuses writes with its own message either way.
    notice.value = null;
  }
});
</script>

<template>
  <div v-if="visible" class="lic-note" :class="tone" role="status">
    <span class="lic-note__text">{{ message }}</span>
    <span class="lic-note__bn">{{ messageBn }}</span>
  </div>
</template>

<style scoped>
.lic-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
  padding: 0.55rem 1rem;
  line-height: 1.45;
  border-bottom: 1px solid var(--sher-line);
}

.lic-note__bn {
  font-family: var(--sher-font-bn);
  font-size: var(--sher-text-xs);
  opacity: 0.85;
}

.lic-note--soft {
  background: var(--sher-surface-muted, #f4f4f5);
  color: var(--sher-text-muted);
}

.lic-note--warn {
  background: var(--sher-warning-soft, #fff6e5);
  color: var(--sher-warning-ink, #6b4a00);
  font-weight: 500;
}

.lic-note--bad {
  background: var(--sher-danger-soft, #fee2e2);
  color: var(--sher-danger-ink, #7f1d1d);
  font-weight: 500;
}
</style>
