<script setup lang="ts">
import { inject, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api, ReauthRequired } from '../api/client';
import { can } from '../api/session';

/**
 * One installation, and the five actions §25 asks for.
 *
 * Four of the five queue a signed command and let the sidecar do the work. The
 * fifth opens a support session, which is the same shape plus a grant. There is
 * no other mechanism on this screen — no console, no query box, no file
 * browser — because there is no other mechanism in the system (§13, §27).
 */
interface Installation {
  id: string; tenantId: string; tenantName: string; label: string; state: string; health: string;
  appVersion: string; schemaVersion: string; runtime: string; businessId: string;
  licenceState: string; licenceValidUntil: string; licenceFingerprint: string;
  lastSeenAt: string | null; lastBackupAt: string; lastBackupOk: boolean;
  syncPending: number; syncConflictsOpen: number; migrationState: string; revokedAt: string | null;
  deploymentUrl: string; localUrl: string;
}
interface CommandRow { id: string; type: string; status: string; createdAt: string; failureCode: string | null; rejection: string | null }
interface DiagnosticRow { code: string; module: string; route: string; httpStatus: number; occurredAt: string; count: number; appVersion: string }
interface SupportRow { id: string; reason: string; state: string; createdAt: string; operatorName: string }

const route = useRoute();
const router = useRouter();
const requireReauth = inject<(permission: string) => Promise<void>>('requireReauth');

const installation = ref<Installation | null>(null);
const commands = ref<CommandRow[]>([]);
const diagnostics = ref<DiagnosticRow[]>([]);
const supportHistory = ref<SupportRow[]>([]);
const busy = ref('');
const message = ref('');
const supportDialog = ref<{ open: boolean; reason: string }>({ open: false, reason: '' });
const revokeDialog = ref<{ open: boolean; reason: string }>({ open: false, reason: '' });

async function load(): Promise<void> {
  const id = String(route.params['id']);
  const result = await api<{
    installation: Installation;
    commands: CommandRow[];
    diagnostics: DiagnosticRow[];
    supportHistory: SupportRow[];
  }>(`/installations/${id}`);
  installation.value = result.installation;
  commands.value = result.commands;
  diagnostics.value = result.diagnostics;
  supportHistory.value = result.supportHistory;
  route.meta['tenantName'] = result.installation.tenantName;
  route.meta['tenantId'] = result.installation.tenantId;
}
onMounted(load);

async function runCommand(type: string, label: string): Promise<void> {
  busy.value = type;
  message.value = '';
  try {
    await api(`/installations/${String(route.params['id'])}/command/${type}`, { method: 'POST', body: {} });
    // Deliberately honest wording: the command is queued, and the shop acts on
    // it at its next check-in. Saying "done" would be a lie on a machine that
    // is offline.
    message.value = `${label} queued — it runs at the next check-in.`;
    await load();
  } catch (caught) {
    message.value = caught instanceof Error ? caught.message : 'Could not queue that';
  } finally {
    busy.value = '';
  }
}

async function openSupport(): Promise<void> {
  const body = { installationId: String(route.params['id']), reason: supportDialog.value.reason };
  const start = async (): Promise<void> => {
    const result = await api<{ session: { id: string } }>('/support-sessions', { method: 'POST', body });
    await router.push(`/support/${result.session.id}`);
  };
  try {
    await start();
  } catch (caught) {
    if (caught instanceof ReauthRequired && requireReauth !== undefined) {
      await requireReauth('support.open');
      await start();
      return;
    }
    message.value = caught instanceof Error ? caught.message : 'Could not open a session';
  }
}

async function revoke(): Promise<void> {
  const body = { reason: revokeDialog.value.reason };
  const call = async (): Promise<void> => {
    await api(`/installations/${String(route.params['id'])}/revoke`, { method: 'POST', body });
    revokeDialog.value = { open: false, reason: '' };
    await load();
  };
  try {
    await call();
  } catch (caught) {
    if (caught instanceof ReauthRequired && requireReauth !== undefined) {
      await requireReauth('installation.revoke');
      await call();
      return;
    }
    message.value = caught instanceof Error ? caught.message : 'Could not revoke';
  }
}
</script>

<template>
  <template v-if="installation">
    <h2>{{ installation.label || installation.id }}</h2>
    <p class="lede">
      <span class="pill" :class="installation.state === 'ONLINE' ? 'ok' : installation.state === 'OFFLINE' ? 'mute' : 'warn'">
        {{ installation.state.replace('_', ' ') }}
      </span>
      &nbsp;last seen {{ installation.lastSeenAt?.slice(0, 16).replace('T', ' ') ?? 'never' }}
    </p>

    <div class="ctl-card">
      <div class="two-col" style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px">
        <div>
          <p><span class="ctl-note">Installation ID</span><br /><span class="mono">{{ installation.id }}</span></p>
          <p><span class="ctl-note">Business ID (what a licence names)</span><br /><span class="mono">{{ installation.businessId || '—' }}</span></p>
          <p><span class="ctl-note">Application version</span><br /><span class="mono">{{ installation.appVersion || '—' }}</span></p>
          <p><span class="ctl-note">Schema version</span><br /><span class="mono">{{ installation.schemaVersion || '—' }}</span></p>
          <p><span class="ctl-note">Runtime</span><br />{{ installation.runtime || '—' }}</p>
        </div>
        <div>
          <p><span class="ctl-note">Licence</span><br />{{ installation.licenceState }} <span v-if="installation.licenceValidUntil">until {{ installation.licenceValidUntil.slice(0, 10) }}</span></p>
          <p><span class="ctl-note">Last backup</span><br />
            <span class="pill" :class="installation.lastBackupOk ? 'ok' : 'bad'">{{ installation.lastBackupOk ? 'OK' : 'FAILING' }}</span>
          </p>
          <p><span class="ctl-note">Offline queue</span><br />{{ installation.syncPending }} pending, {{ installation.syncConflictsOpen }} conflicts</p>
          <p v-if="installation.migrationState"><span class="ctl-note">Migration</span><br />{{ installation.migrationState }}</p>
          <p><span class="ctl-note">Deployment URL</span><br />{{ installation.deploymentUrl || '—' }}</p>
        </div>
      </div>
    </div>

    <h3>Actions</h3>
    <div class="ctl-card" style="display: flex; gap: 8px; flex-wrap: wrap">
      <button class="ctl" :disabled="busy !== ''" @click="runCommand('COLLECT_DIAGNOSTICS', 'Collect diagnostics')">Collect diagnostics</button>
      <button class="ctl" :disabled="busy !== ''" @click="runCommand('HEALTH_CHECK', 'Health check')">Health check</button>
      <button class="ctl" :disabled="busy !== ''" @click="runCommand('CREATE_BACKUP', 'Backup')">Create backup</button>
      <button class="ctl" :disabled="busy !== ''" @click="runCommand('CHECK_FOR_UPDATE', 'Update check')">Check for update</button>
      <button v-if="can('support.open')" class="ctl primary" @click="supportDialog = { open: true, reason: '' }">
        Start support session
      </button>
      <button
        v-if="can('installation.revoke') && installation.revokedAt === null"
        class="ctl danger"
        @click="revokeDialog = { open: true, reason: '' }"
      >
        Revoke installation
      </button>
    </div>
    <p v-if="message" class="ctl-note">{{ message }}</p>

    <h3>Recent errors</h3>
    <div class="ctl-card">
      <p class="ctl-note" style="margin-top: 0">
        Codes and routes only — never message text, so nothing about a customer's business can leak
        into a diagnostic.
      </p>
      <table class="ctl">
        <thead><tr><th>Code</th><th>Module</th><th>Route</th><th>Status</th><th>Count</th><th>When</th></tr></thead>
        <tbody>
          <tr v-for="(row, index) in diagnostics.slice(0, 40)" :key="index">
            <td class="mono">{{ row.code }}</td>
            <td>{{ row.module }}</td>
            <td class="mono">{{ row.route }}</td>
            <td>{{ row.httpStatus }}</td>
            <td>{{ row.count }}</td>
            <td class="ctl-note">{{ row.occurredAt.slice(0, 16).replace('T', ' ') }}</td>
          </tr>
          <tr v-if="diagnostics.length === 0"><td colspan="6" class="ctl-note">Nothing reported.</td></tr>
        </tbody>
      </table>
    </div>

    <h3>Commands</h3>
    <div class="ctl-card">
      <table class="ctl">
        <thead><tr><th>Type</th><th>Status</th><th>Queued</th><th>Outcome</th></tr></thead>
        <tbody>
          <tr v-for="row in commands" :key="row.id">
            <td class="mono">{{ row.type }}</td>
            <td>
              <span class="pill" :class="row.status === 'SUCCEEDED' ? 'ok' : row.status === 'PENDING' || row.status === 'DISPATCHED' ? 'warn' : 'bad'">
                {{ row.status }}
              </span>
            </td>
            <td class="ctl-note">{{ row.createdAt.slice(0, 16).replace('T', ' ') }}</td>
            <td class="mono">{{ row.failureCode ?? row.rejection ?? '' }}</td>
          </tr>
          <tr v-if="commands.length === 0"><td colspan="4" class="ctl-note">Nothing queued.</td></tr>
        </tbody>
      </table>
    </div>

    <h3>Support history</h3>
    <div class="ctl-card">
      <table class="ctl">
        <thead><tr><th>When</th><th>Operator</th><th>Reason</th><th>State</th><th /></tr></thead>
        <tbody>
          <tr v-for="row in supportHistory" :key="row.id">
            <td class="ctl-note">{{ row.createdAt.slice(0, 16).replace('T', ' ') }}</td>
            <td>{{ row.operatorName }}</td>
            <td>{{ row.reason }}</td>
            <td>{{ row.state }}</td>
            <td><RouterLink :to="`/support/${row.id}`">Open</RouterLink></td>
          </tr>
          <tr v-if="supportHistory.length === 0"><td colspan="5" class="ctl-note">No sessions yet.</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="supportDialog.open" class="ctl-backdrop">
      <div class="ctl-modal">
        <h3>Start support session</h3>
        <p class="ctl-note">
          A short-lived signed authorization — 30 minutes of inactivity, four hours absolute. The
          shop sees a small indicator while you are in, and every action you take is recorded
          against your name.
        </p>
        <label class="ctl" for="s-reason">Why (mandatory, and signed into the grant)</label>
        <input id="s-reason" v-model="supportDialog.reason" class="ctl" placeholder="Purchase posting issue reported by phone" />
        <footer>
          <button class="ctl" @click="supportDialog = { open: false, reason: '' }">Cancel</button>
          <button class="ctl primary" :disabled="supportDialog.reason.trim().length < 3" @click="openSupport">
            Open session
          </button>
        </footer>
      </div>
    </div>

    <div v-if="revokeDialog.open" class="ctl-backdrop">
      <div class="ctl-modal">
        <h3>Revoke installation</h3>
        <p class="ctl-note">
          This stops the management channel: no further command is accepted and its key is retired.
          It does <strong>not</strong> stop the shop trading — their installed licence stays valid
          locally until its own expiry.
        </p>
        <label class="ctl" for="r-reason">Reason</label>
        <input id="r-reason" v-model="revokeDialog.reason" class="ctl" />
        <footer>
          <button class="ctl" @click="revokeDialog = { open: false, reason: '' }">Cancel</button>
          <button class="ctl danger" :disabled="revokeDialog.reason.trim().length < 3" @click="revoke">
            Revoke
          </button>
        </footer>
      </div>
    </div>
  </template>
</template>
