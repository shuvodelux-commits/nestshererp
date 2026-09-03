<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { api } from '../api/client';
import { can } from '../api/session';
import LicenceDialog from '../components/LicenceDialog.vue';

interface Tenant { id: string; name: string; contactName: string; contactPhone: string; contactEmail: string; notes: string }
interface Installation { id: string; label: string; state: string; appVersion: string; licenceState: string; lastSeenAt: string | null; businessId: string }
interface Licence {
  id: string; licenceId: string; validUntil: string; modules: string[];
  deliveryState: string; revokedAt: string | null; keyText: string;
}

const route = useRoute();
const tenant = ref<Tenant | null>(null);
const installations = ref<Installation[]>([]);
const licences = ref<Licence[]>([]);
const newInstallation = ref<{ open: boolean; label: string; url: string }>({ open: false, label: '', url: '' });
const issuedToken = ref<{ token: string; expiresAt: string } | null>(null);
const licenceDialog = ref(false);
const copied = ref('');

async function load(): Promise<void> {
  const id = String(route.params['id']);
  tenant.value = await api<Tenant>(`/tenants/${id}`);
  installations.value = (await api<{ installations: Installation[] }>(`/installations?tenantId=${id}`)).installations;
  if (can('licence.view')) {
    licences.value = (await api<{ licences: Licence[] }>(`/licences?tenantId=${id}`)).licences;
  }
  // The banner in AppShell reads these, so the customer's name stays on screen
  // for as long as their context is open.
  route.meta['tenantName'] = tenant.value.name;
  route.meta['tenantId'] = tenant.value.id;
}
onMounted(load);

async function createInstallation(): Promise<void> {
  await api('/installations', {
    method: 'POST',
    body: { tenantId: route.params['id'], label: newInstallation.value.label, deploymentUrl: newInstallation.value.url },
  });
  newInstallation.value = { open: false, label: '', url: '' };
  await load();
}

/**
 * The enrolment token, shown once.
 *
 * Only its hash is stored, so this is genuinely the only time it can be read.
 * If it is lost, another one is issued — which is cheaper than a system in
 * which a vendor can read back every shop's enrolment secret.
 */
async function issueToken(installationId: string): Promise<void> {
  issuedToken.value = await api<{ token: string; expiresAt: string }>(
    `/installations/${installationId}/enrolment-token`,
    { method: 'POST', body: {} },
  );
}

async function copy(text: string, what: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  copied.value = what;
  setTimeout(() => (copied.value = ''), 1800);
}
</script>

<template>
  <template v-if="tenant">
    <h2>{{ tenant.name }}</h2>
    <p class="lede">
      {{ tenant.contactName }}<span v-if="tenant.contactPhone"> · {{ tenant.contactPhone }}</span>
      <span v-if="tenant.contactEmail"> · {{ tenant.contactEmail }}</span>
    </p>

    <h3>Installations</h3>
    <div class="ctl-card">
      <table class="ctl">
        <thead><tr><th>Label</th><th>State</th><th>Version</th><th>Licence</th><th>Last seen</th><th /></tr></thead>
        <tbody>
          <tr v-for="row in installations" :key="row.id">
            <td><RouterLink :to="`/installations/${row.id}`">{{ row.label || row.id }}</RouterLink></td>
            <td>
              <span class="pill" :class="row.state === 'ONLINE' ? 'ok' : row.state === 'OFFLINE' ? 'mute' : 'warn'">
                {{ row.state.replace('_', ' ') }}
              </span>
            </td>
            <td class="mono">{{ row.appVersion || '—' }}</td>
            <td>{{ row.licenceState }}</td>
            <td class="ctl-note">{{ row.lastSeenAt?.slice(0, 16).replace('T', ' ') ?? 'never' }}</td>
            <td>
              <button v-if="can('installation.enrol')" class="ctl" @click="issueToken(row.id)">
                Enrolment token
              </button>
            </td>
          </tr>
          <tr v-if="installations.length === 0"><td colspan="6" class="ctl-note">No installations yet.</td></tr>
        </tbody>
      </table>
      <div style="margin-top: 10px">
        <button v-if="can('installation.enrol')" class="ctl" @click="newInstallation.open = true">
          Add installation
        </button>
      </div>
    </div>

    <h3>Licences</h3>
    <div class="ctl-card">
      <table class="ctl">
        <thead><tr><th>Issued</th><th>Runs until</th><th>Modules</th><th>Delivery</th><th /></tr></thead>
        <tbody>
          <tr v-for="row in licences" :key="row.id">
            <td class="mono">{{ row.licenceId.slice(0, 10) }}</td>
            <td>{{ row.validUntil.slice(0, 10) }}</td>
            <td>{{ row.modules.length === 0 ? 'all' : row.modules.join(', ') }}</td>
            <td>
              <span class="pill" :class="row.deliveryState === 'INSTALLED' ? 'ok' : row.deliveryState === 'FAILED' ? 'bad' : 'warn'">
                {{ row.deliveryState }}
              </span>
              <span v-if="row.revokedAt" class="pill bad" style="margin-left: 4px">REVOKED</span>
            </td>
            <td>
              <button class="ctl" @click="copy(row.keyText, row.id)">
                {{ copied === row.id ? 'Copied' : 'Copy key' }}
              </button>
            </td>
          </tr>
          <tr v-if="licences.length === 0"><td colspan="5" class="ctl-note">No licence issued yet.</td></tr>
        </tbody>
      </table>
      <div style="margin-top: 10px">
        <button v-if="can('licence.issue')" class="ctl primary" @click="licenceDialog = true">
          Issue or renew licence
        </button>
      </div>
    </div>

    <div v-if="newInstallation.open" class="ctl-backdrop">
      <div class="ctl-modal">
        <h3>Add installation</h3>
        <p class="ctl-note">
          This creates the record. It gains an identity when the shop's agent enrols against a
          one-time token — the private key is made on their machine and never leaves it.
        </p>
        <div class="two-col">
          <div>
            <label class="ctl" for="i-label">Label</label>
            <input id="i-label" v-model="newInstallation.label" class="ctl" placeholder="Counter PC" />
          </div>
          <div>
            <label class="ctl" for="i-url">Deployment URL (optional)</label>
            <input id="i-url" v-model="newInstallation.url" class="ctl" />
          </div>
        </div>
        <footer>
          <button class="ctl" @click="newInstallation.open = false">Cancel</button>
          <button class="ctl primary" :disabled="newInstallation.label.trim() === ''" @click="createInstallation">
            Create
          </button>
        </footer>
      </div>
    </div>

    <div v-if="issuedToken" class="ctl-backdrop">
      <div class="ctl-modal">
        <h3>Enrolment token</h3>
        <p class="ctl-note">
          Shown once — only its hash is stored. Valid until
          {{ issuedToken.expiresAt.slice(0, 16).replace('T', ' ') }}. On the shop's machine, run:
        </p>
        <p class="mono" style="background: var(--ctl-bg); padding: 10px; border-radius: 6px; word-break: break-all">
          pnpm --filter @sher/agent enrol -- --token {{ issuedToken.token }}
        </p>
        <footer>
          <button class="ctl" @click="copy(issuedToken.token, 'token')">
            {{ copied === 'token' ? 'Copied' : 'Copy token' }}
          </button>
          <button class="ctl primary" @click="issuedToken = null">Done</button>
        </footer>
      </div>
    </div>

    <LicenceDialog
      v-if="licenceDialog"
      :tenant-id="tenant.id"
      :installations="installations"
      @close="licenceDialog = false"
      @issued="licenceDialog = false; load()"
    />
  </template>
</template>
