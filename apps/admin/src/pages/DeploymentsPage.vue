<script setup lang="ts">
import { inject, onMounted, ref } from 'vue';

import { api, ReauthRequired } from '../api/client';
import { can } from '../api/session';

interface Job {
  id: string; releaseId: string; version: string; strategy: string; reason: string;
  state: string; haltedAt: string | null; haltReason: string; createdAt: string;
}
interface Target {
  installationId: string; label: string; tenantName: string; state: string;
  failureCode: string | null; detail: string;
  stages: { at: string; state: string; detail: string }[];
}
interface Release { id: string; version: string; channel: string }
interface Installation { id: string; label: string; tenantName: string; appVersion: string; state: string }

const jobs = ref<Job[]>([]);
const releases = ref<Release[]>([]);
const installations = ref<Installation[]>([]);
const open = ref<{ job: Job; targets: Target[] } | null>(null);
const dialog = ref(false);
const error = ref('');
const requireReauth = inject<(permission: string) => Promise<void>>('requireReauth');

const form = ref({ releaseId: '', strategy: 'STAGED', installationIds: [] as string[], pilotCount: 1, reason: '' });

async function load(): Promise<void> {
  jobs.value = (await api<{ jobs: Job[] }>('/deployments')).jobs;
  if (can('release.view')) releases.value = (await api<{ releases: Release[] }>('/releases')).releases;
  installations.value = (await api<{ installations: Installation[] }>('/installations')).installations;
}
onMounted(load);

async function openJob(id: string): Promise<void> {
  open.value = await api<{ job: Job; targets: Target[] }>(`/deployments/${id}`);
}

async function withReauth(permission: string, call: () => Promise<void>): Promise<void> {
  error.value = '';
  try {
    await call();
  } catch (caught) {
    if (caught instanceof ReauthRequired && requireReauth !== undefined) {
      await requireReauth(permission);
      await call().catch((retry: unknown) => {
        error.value = retry instanceof Error ? retry.message : 'Failed';
      });
      return;
    }
    error.value = caught instanceof Error ? caught.message : 'Failed';
  }
}

async function createJob(): Promise<void> {
  await withReauth('deployment.run', async () => {
    await api('/deployments', { method: 'POST', body: form.value });
    dialog.value = false;
    await load();
  });
}

async function advance(id: string): Promise<void> {
  await withReauth('deployment.run', async () => {
    await api(`/deployments/${id}/advance`, { method: 'POST', body: { count: 5 } });
    await openJob(id);
    await load();
  });
}

async function clearHalt(id: string): Promise<void> {
  const reason = window.prompt('What did you find? This is recorded in the audit trail.');
  if (reason === null || reason.trim().length < 3) return;
  await withReauth('deployment.run', async () => {
    await api(`/deployments/${id}/clear-halt`, { method: 'POST', body: { reason } });
    await openJob(id);
    await load();
  });
}

function targetClass(state: string): string {
  if (state === 'SUCCEEDED') return 'ok';
  if (state === 'FAILED' || state === 'ROLLED_BACK') return 'bad';
  if (state === 'QUEUED') return 'mute';
  return 'warn';
}
</script>

<template>
  <h2>Deployments</h2>
  <p class="lede">
    Staged rollouts. A failed migration halts the whole job — no further installation receives that
    release until somebody has looked.
  </p>

  <div style="margin-bottom: 12px">
    <button v-if="can('deployment.run')" class="ctl primary" @click="dialog = true">
      New rollout
    </button>
  </div>
  <p v-if="error" class="ctl-error">{{ error }}</p>

  <div class="ctl-card">
    <table class="ctl">
      <thead><tr><th>Release</th><th>Strategy</th><th>State</th><th>Reason</th><th>Started</th><th /></tr></thead>
      <tbody>
        <tr v-for="job in jobs" :key="job.id">
          <td class="mono">{{ job.version }}</td>
          <td>{{ job.strategy.toLowerCase().replace('_', ' ') }}</td>
          <td>
            <span class="pill" :class="job.haltedAt !== null ? 'bad' : job.state === 'SUCCEEDED' ? 'ok' : 'warn'">
              {{ job.haltedAt !== null ? 'HALTED' : job.state }}
            </span>
          </td>
          <td>{{ job.reason }}</td>
          <td class="ctl-note">{{ job.createdAt.slice(0, 16).replace('T', ' ') }}</td>
          <td><button class="ctl" @click="openJob(job.id)">Open</button></td>
        </tr>
        <tr v-if="jobs.length === 0"><td colspan="6" class="ctl-note">No rollouts yet.</td></tr>
      </tbody>
    </table>
  </div>

  <template v-if="open">
    <h3>{{ open.job.version }} — targets</h3>
    <div v-if="open.job.haltedAt !== null" class="ctl-card" style="border-color: var(--ctl-bad)">
      <strong style="color: var(--ctl-bad)">Halted.</strong>
      {{ open.job.haltReason }}
      <div style="margin-top: 8px">
        <button v-if="can('deployment.run')" class="ctl" @click="clearHalt(open.job.id)">
          I have looked — clear the halt
        </button>
      </div>
    </div>
    <div class="ctl-card">
      <table class="ctl">
        <thead><tr><th>Customer</th><th>Installation</th><th>State</th><th>Detail</th><th>Stages</th></tr></thead>
        <tbody>
          <tr v-for="target in open.targets" :key="target.installationId">
            <td>{{ target.tenantName }}</td>
            <td>{{ target.label }}</td>
            <td><span class="pill" :class="targetClass(target.state)">{{ target.state.replace('_', ' ') }}</span></td>
            <td>{{ target.failureCode ?? target.detail }}</td>
            <td class="ctl-note">
              {{ target.stages.map((stage) => stage.state).join(' → ') }}
            </td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top: 10px">
        <button
          v-if="can('deployment.run') && open.job.haltedAt === null"
          class="ctl"
          @click="advance(open.job.id)"
        >
          Send to the next five
        </button>
      </div>
    </div>
  </template>

  <div v-if="dialog" class="ctl-backdrop">
    <div class="ctl-modal">
      <h3>New rollout</h3>
      <p class="ctl-note">
        Recommended order: internal, a small pilot, then wider. Every target is checked for version
        compatibility before anything is queued, and one that is not eligible is simply left out.
      </p>
      <div class="two-col">
        <div>
          <label class="ctl" for="d-release">Release</label>
          <select id="d-release" v-model="form.releaseId" class="ctl">
            <option v-for="release in releases" :key="release.id" :value="release.id">
              {{ release.version }} ({{ release.channel.toLowerCase() }})
            </option>
          </select>
          <label class="ctl" for="d-strategy">Strategy</label>
          <select id="d-strategy" v-model="form.strategy" class="ctl">
            <option value="SINGLE">One installation</option>
            <option value="SELECTED">Selected installations</option>
            <option value="STAGED">Staged (pilot first)</option>
            <option value="ALL_ELIGIBLE">All eligible</option>
          </select>
          <label v-if="form.strategy === 'STAGED'" class="ctl" for="d-pilot">Pilot size</label>
          <input
            v-if="form.strategy === 'STAGED'"
            id="d-pilot"
            v-model.number="form.pilotCount"
            class="ctl"
            type="number"
            min="1"
          />
        </div>
        <div>
          <label class="ctl">Installations</label>
          <div style="max-height: 190px; overflow: auto; border: 1px solid var(--ctl-border); border-radius: 6px; padding: 6px">
            <label
              v-for="row in installations"
              :key="row.id"
              style="display: block; font-size: 12px; margin: 3px 0"
            >
              <input v-model="form.installationIds" type="checkbox" :value="row.id" />
              {{ row.tenantName }} — {{ row.label }}
              <span class="mono ctl-note">{{ row.appVersion }}</span>
            </label>
          </div>
        </div>
      </div>
      <label class="ctl" for="d-reason">Reason (audit trail)</label>
      <input id="d-reason" v-model="form.reason" class="ctl" placeholder="Fixes PURCHASE_RETURN_POSTING_001" />
      <footer>
        <button class="ctl" @click="dialog = false">Cancel</button>
        <button class="ctl primary" :disabled="form.releaseId === '' || form.reason.trim().length < 3" @click="createJob">
          Start rollout
        </button>
      </footer>
    </div>
  </div>
</template>
