<script setup lang="ts">
import type { LicenseStatusResponse } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchLicenseStatus, installLicense } from '../api/license';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Settings → Licence · লাইসেন্স (§5.4, D-35, D-36, owner decisions 2026-09-02).
 *
 * The page now does the two things a shop actually needs from it. It shows the
 * **Business ID**, because that is what the supplier has to be told before a
 * licence can be issued at all, and it takes a **pasted key**, because a screen
 * that tells someone to renew and cannot accept the renewal is a dead end —
 * the alternative was somebody with access to the computer putting a file in
 * place.
 *
 * Everything the key means is still decided by the server: this sends one
 * string and reports the answer. A key for another business, or one ending
 * earlier than the licence already here, is refused there and nothing changes.
 */
const session = useSession();

const status = ref<LicenseStatusResponse | null>(null);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);

const canInstall = computed(() => session.can('license.install'));
const keyText = ref('');
const installing = ref(false);
const installed = ref<string | null>(null);
const installFailure = ref<string | null>(null);
const copied = ref(false);

const stateText = computed(() => {
  const current = status.value;
  if (current === null) return '';
  if (current.foreignBusiness) {
    return 'The licence on this computer was issued for a different business, so it does not apply here. Nothing new can be saved until a licence for this business is installed.';
  }
  if (!current.licenceReadable) {
    return 'No licence is installed on this computer. SherERP is running read-only: everything already recorded can still be opened, printed and backed up, but nothing new can be saved. Paste the licence key below to start.';
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
  const current = status.value;
  if (current === null) return 'lic__state--ok';
  if (current.foreignBusiness) return 'lic__state--bad';
  if (current.state === 'READ_ONLY') return 'lic__state--bad';
  if (current.state === 'GRACE') return 'lic__state--warn';
  if (current.state === 'EXPIRING') return 'lic__state--soft';
  return 'lic__state--ok';
});

function dayText(iso: string | null): string {
  return iso === null
    ? 'an unknown date'
    : new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'long' });
}

async function copyBusinessId(): Promise<void> {
  const id = status.value?.businessId;
  if (id === undefined) return;
  try {
    await navigator.clipboard.writeText(id);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard permission refused, or an insecure origin. The id is on screen
    // in full and can be read out or selected by hand, so this is not an error
    // worth putting in front of anybody.
  }
}

async function install(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || keyText.value.trim() === '') return;

  installing.value = true;
  installFailure.value = null;
  installed.value = null;
  try {
    const result = await installLicense(token, keyText.value.trim());
    installed.value = `Licence installed. It runs until ${dayText(result.validUntil)}.`;
    keyText.value = '';
    await load();
  } catch (cause) {
    installFailure.value =
      cause instanceof ApiError ? cause.message : 'The licence could not be installed.';
  } finally {
    installing.value = false;
  }
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

        <dl class="lic__facts">
          <div>
            <dt>Business ID <span class="label-bn">ব্যবসার আইডি</span></dt>
            <dd>
              <code class="lic__id">{{ status.businessId }}</code>
              <button type="button" class="btn-ghost lic__copy" @click="copyBusinessId">
                {{ copied ? 'Copied' : 'Copy' }}
              </button>
            </dd>
          </div>
          <div v-if="status.licenceId !== null">
            <dt>Licence number</dt>
            <dd><code class="lic__id">{{ status.licenceId }}</code></dd>
          </div>
        </dl>
        <p class="lic__note">
          Send the Business ID to your supplier when asking for a licence or a renewal. It only
          identifies this shop — it unlocks nothing on its own.
        </p>

        <p v-if="status.clockWarning !== null" class="lic__clock">{{ status.clockWarning }}</p>
      </AppCard>

      <!--
        Only once the licence has actually been read. Offering the paste box
        while the status is still loading — or, worse, above the error notice
        after the read failed — invites an owner to paste a key into a screen
        that cannot yet say what licence is installed, and an install refused
        for regression then reads as the key being wrong.
      -->
      <AppCard v-if="canInstall && status !== null">
        <h2 class="lic__title">
          Install or renew licence <span class="label-bn">লাইসেন্স বসান</span>
        </h2>
        <p class="lic__note">
          Paste the whole licence line your supplier sent, then press Install. It is checked before
          anything changes, and a key meant for another business — or one that ends sooner than the
          licence already here — is refused and nothing is altered.
        </p>
        <textarea
          v-model="keyText"
          class="lic__key"
          rows="4"
          spellcheck="false"
          placeholder="SHERLIC1...."
          aria-label="Licence key"
        ></textarea>
        <div class="lic__actions">
          <button
            type="button"
            class="btn-primary"
            :disabled="installing || keyText.trim() === ''"
            @click="install"
          >
            {{ installing ? 'Checking…' : 'Install licence' }}
          </button>
        </div>
        <p v-if="installed !== null" class="lic__ok">{{ installed }}</p>
        <p v-if="installFailure !== null" class="lic__bad">{{ installFailure }}</p>
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
          stays open to read — your own records are never hidden — and anything already taken in,
          such as a vendor's goods or a warranty claim, can still be handed back.
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

.lic__facts {
  margin: 0.85rem 0 0.5rem;
  display: grid;
  gap: 0.5rem;
}

.lic__facts dt {
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.lic__facts dd {
  margin: 0.15rem 0 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.lic__id {
  font-family: var(--sher-font-mono, ui-monospace, monospace);
  word-break: break-all;
}

.lic__copy {
  padding: 0.1rem 0.55rem;
}

.lic__clock {
  margin: 0.6rem 0 0;
  padding: 0.55rem 0.75rem;
  border-radius: var(--sher-radius);
  background: var(--sher-surface-muted, #f4f4f5);
  color: var(--sher-text-muted);
  line-height: 1.5;
}

.lic__key {
  width: 100%;
  margin: 0.6rem 0;
  padding: 0.6rem;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  font-family: var(--sher-font-mono, ui-monospace, monospace);
  font-size: var(--sher-text-xs);
  resize: vertical;
}

.lic__actions {
  display: flex;
  gap: 0.5rem;
}

.lic__ok {
  margin: 0.7rem 0 0;
  color: var(--sher-success-ink, #065f46);
}

.lic__bad {
  margin: 0.7rem 0 0;
  padding: 0.55rem 0.75rem;
  border-radius: var(--sher-radius);
  background: var(--sher-danger-soft, #fee2e2);
  color: var(--sher-danger-ink, #7f1d1d);
  line-height: 1.5;
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
