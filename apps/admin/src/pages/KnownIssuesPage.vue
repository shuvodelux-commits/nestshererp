<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api } from '../api/client';
import { can } from '../api/session';

interface Issue {
  id: string; title: string; description: string;
  affectedFromVersion: string; affectedToVersion: string; fixedInVersion: string;
  severity: string; status: string; workaround: string; affectedCount: number;
}
interface Affected { id: string; tenantName: string; label: string; appVersion: string }

const issues = ref<Issue[]>([]);
const affected = ref<{ issue: Issue; rows: Affected[] } | null>(null);
const dialog = ref(false);
const error = ref('');

const form = ref({
  title: '',
  description: '',
  affectedFromVersion: '',
  affectedToVersion: '',
  affectedSchemaVersion: '',
  severity: 'MEDIUM',
  workaround: '',
  fixedInVersion: '',
  status: 'OPEN',
});

async function load(): Promise<void> {
  issues.value = (await api<{ issues: Issue[] }>('/known-issues')).issues;
}
onMounted(load);

async function showAffected(issue: Issue): Promise<void> {
  const result = await api<{ installations: Affected[] }>(`/known-issues/${issue.id}/affected`);
  affected.value = { issue, rows: result.installations };
}

async function create(): Promise<void> {
  error.value = '';
  try {
    await api('/known-issues', { method: 'POST', body: form.value });
    dialog.value = false;
    await load();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not save';
  }
}
</script>

<template>
  <h2>Known issues</h2>
  <p class="lede">
    Which installations are <em>likely</em> running a version with a given bug in it. Likely is the
    honest word — a version range shows the code is present, not that anybody hit it.
  </p>

  <div style="margin-bottom: 12px">
    <button v-if="can('issue.manage')" class="ctl primary" @click="dialog = true">Record an issue</button>
  </div>

  <div class="ctl-card">
    <table class="ctl">
      <thead><tr><th>Issue</th><th>Affected versions</th><th>Fixed in</th><th>Severity</th><th>Status</th><th>Installations</th></tr></thead>
      <tbody>
        <tr v-for="issue in issues" :key="issue.id">
          <td>
            <strong>{{ issue.title }}</strong>
            <div v-if="issue.workaround" class="ctl-note">Workaround: {{ issue.workaround }}</div>
          </td>
          <td class="mono">{{ issue.affectedFromVersion }} – {{ issue.affectedToVersion }}</td>
          <td class="mono">{{ issue.fixedInVersion || '—' }}</td>
          <td>
            <span class="pill" :class="issue.severity === 'CRITICAL' || issue.severity === 'HIGH' ? 'bad' : 'warn'">
              {{ issue.severity }}
            </span>
          </td>
          <td>{{ issue.status }}</td>
          <td>
            <button class="ctl" @click="showAffected(issue)">
              {{ issue.affectedCount }} potentially affected
            </button>
          </td>
        </tr>
        <tr v-if="issues.length === 0"><td colspan="6" class="ctl-note">Nothing recorded.</td></tr>
      </tbody>
    </table>
  </div>

  <div v-if="affected" class="ctl-backdrop">
    <div class="ctl-modal">
      <h3>{{ affected.issue.title }}</h3>
      <p class="ctl-note">
        Installations running {{ affected.issue.affectedFromVersion }} –
        {{ affected.issue.affectedToVersion }}. Nothing has been changed on any of them; fixing this
        means deploying a release, or correcting a document through the shop's own workflows in a
        support session.
      </p>
      <table class="ctl">
        <thead><tr><th>Customer</th><th>Installation</th><th>Version</th></tr></thead>
        <tbody>
          <tr v-for="row in affected.rows" :key="row.id">
            <td>{{ row.tenantName }}</td>
            <td><RouterLink :to="`/installations/${row.id}`">{{ row.label }}</RouterLink></td>
            <td class="mono">{{ row.appVersion }}</td>
          </tr>
          <tr v-if="affected.rows.length === 0"><td colspan="3" class="ctl-note">None.</td></tr>
        </tbody>
      </table>
      <footer><button class="ctl primary" @click="affected = null">Close</button></footer>
    </div>
  </div>

  <div v-if="dialog" class="ctl-backdrop">
    <div class="ctl-modal">
      <h3>Record a known issue</h3>
      <div class="two-col">
        <div>
          <label class="ctl" for="k-title">Title</label>
          <input id="k-title" v-model="form.title" class="ctl" placeholder="Purchase return posts to the wrong account" />
          <label class="ctl" for="k-from">Affected from version</label>
          <input id="k-from" v-model="form.affectedFromVersion" class="ctl mono" placeholder="2.3.0" />
          <label class="ctl" for="k-to">Affected to version</label>
          <input id="k-to" v-model="form.affectedToVersion" class="ctl mono" placeholder="2.3.2" />
        </div>
        <div>
          <label class="ctl" for="k-fixed">Fixed in</label>
          <input id="k-fixed" v-model="form.fixedInVersion" class="ctl mono" placeholder="2.3.3" />
          <label class="ctl" for="k-sev">Severity</label>
          <select id="k-sev" v-model="form.severity" class="ctl">
            <option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option>
          </select>
          <label class="ctl" for="k-work">Workaround</label>
          <input id="k-work" v-model="form.workaround" class="ctl" />
        </div>
      </div>
      <label class="ctl" for="k-desc">Description</label>
      <textarea id="k-desc" v-model="form.description" class="ctl" rows="3" />
      <p v-if="error" class="ctl-error">{{ error }}</p>
      <footer>
        <button class="ctl" @click="dialog = false">Cancel</button>
        <button class="ctl primary" :disabled="form.title.trim() === ''" @click="create">Save</button>
      </footer>
    </div>
  </div>
</template>
