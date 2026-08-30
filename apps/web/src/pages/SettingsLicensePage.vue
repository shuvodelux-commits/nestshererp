<script setup lang="ts">
import type { LicenseStatusResponse } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchLicenseStatus } from '../api/license';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Settings → Licence · লাইসেন্স (Phase 10, §5.4, D-35, D-36).
 *
 * Read-only, because a licence is read-only: it comes from a signed key file on
 * this computer and nothing on this screen — or anywhere in the API — can
 * change, extend or renew it. Restoring a backup cannot either.
 *
 * The four states are D-36's ladder. `RESTORED` appears after a renewal and
 * reads as normal, because that is what it is.
 */
const session = useSession();

const status = ref<LicenseStatusResponse | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const stateText = computed(() => {
  const current = status.value;
  if (current === null) return '';
  if (!current.licenceReadable) {
    return 'No licence could be read on this computer. SherERP is running read-only: everything already recorded can still be opened, printed and backed up, but nothing new can be saved.';
  }
  if (current.state === 'ACTIVE' || current.state === 'RESTORED') {
    return current.validUntil === null
      ? 'Active. This installation has no fixed end date.'
      : `Active until ${dayText(current.validUntil)}.`;
  }
  if (current.state === 'EXPIRING') {
    return `Ends in ${String(current.daysRemaining ?? 0)} days, on ${dayText(current.validUntil)}. Renew before then to avoid interruption.`;
  }
  if (current.state === 'GRACE') {
    return `The term ended on ${dayText(current.validUntil)}. Work continues for ${String(current.graceDaysRemaining ?? 0)} more days, then nothing new can be saved.`;
  }
  return 'The term and its grace period have both ended. Everything recorded is still here and can still be read and exported; nothing new can be saved until the licence is renewed.';
});

const toneClass = computed(() => {
  const state = status.value?.state;
  if (state === 'READ_ONLY') return 'lic__state--bad';
  if (state === 'GRACE') return 'lic__state--warn';
  if (state === 'EXPIRING') return 'lic__state--soft';
  return 'lic__state--ok';
});

function dayText(iso: string | null): string {
  return iso === null
    ? 'an unknown date'
    : new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'long' });
}

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  try {
    status.value = await fetchLicenseStatus(token);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not read the licence' };
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <AppShell
    title="Licence"
    :breadcrumb="['Dashboard', 'Settings', 'Licence']"
    help-bn="লাইসেন্স — কত দিন পর্যন্ত চলবে, আর কী কী আছে"
  >
    <div class="lic">
      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <AppCard v-if="status !== null">
        <h2 class="lic__business">{{ status.businessName }}</h2>
        <p class="lic__state" :class="toneClass">{{ stateText }}</p>
      </AppCard>

      <AppCard v-if="status !== null">
        <h2 class="lic__title">What this licence includes <span class="label-bn">কী কী আছে</span></h2>
        <ul class="lic__modules">
          <li v-for="module in status.modules" :key="module.code">
            <span class="lic__module-name">
              {{ module.label }} <span class="label-bn">{{ module.labelBn }}</span>
            </span>
            <span v-if="module.included" class="lic__pill lic__pill--in">Included</span>
            <span v-else-if="module.readOnlyHistorical" class="lic__pill lic__pill--old">
              Your old records only
            </span>
            <span v-else class="lic__pill lic__pill--out">Not included</span>
          </li>
        </ul>
        <p class="lic__note">
          Selling, buying, stock, money, people and backup are always available and cannot be
          removed by a licence. A part that is not included but that this shop has already used
          stays open to read — your own records are never hidden.
        </p>
      </AppCard>

      <p v-if="loading" class="lic__note">Loading…</p>
    </div>
  </AppShell>
</template>

<style scoped>
.lic {
  display: grid;
  gap: 1rem;
  max-width: 52rem;
}

.lic__business {
  margin: 0 0 0.4rem;
  font-size: 1.15rem;
}

.lic__title {
  margin: 0 0 0.6rem;
  font-size: 1rem;
}

.lic__state {
  margin: 0;
  padding: 0.7rem 0.85rem;
  border-radius: var(--sher-radius);
  line-height: 1.5;
}

.lic__state--ok {
  background: var(--sher-success-soft, #ecfdf5);
}

.lic__state--soft {
  background: var(--sher-surface-muted, #f4f4f5);
}

.lic__state--warn {
  background: var(--sher-warning-soft, #fff6e5);
  color: var(--sher-warning-ink, #6b4a00);
}

.lic__state--bad {
  background: var(--sher-danger-soft, #fee2e2);
  color: var(--sher-danger-ink, #7f1d1d);
}

.lic__modules {
  list-style: none;
  margin: 0 0 0.75rem;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}

.lic__modules li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--sher-line);
}

.lic__pill {
  font-size: var(--sher-text-xs);
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  white-space: nowrap;
}

.lic__pill--in {
  background: var(--sher-success-soft, #ecfdf5);
}

.lic__pill--old {
  background: var(--sher-surface-muted, #f4f4f5);
  color: var(--sher-text-muted);
}

.lic__pill--out {
  background: var(--sher-danger-soft, #fee2e2);
  color: var(--sher-danger-ink, #7f1d1d);
}

.lic__note {
  margin: 0;
  color: var(--sher-text-muted);
  line-height: 1.5;
}
</style>
