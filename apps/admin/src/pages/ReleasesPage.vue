<script setup lang="ts">
import { inject, onMounted, ref } from 'vue';

import { api, ReauthRequired } from '../api/client';
import { can } from '../api/session';

interface Release {
  id: string; version: string; buildId: string; sha256: string; sizeBytes: string;
  requiredSchemaVersion: string; minCompatibleVersion: string; migrations: string[];
  rollbackSupported: boolean; channel: string; notes: string; publishedAt: string;
  withdrawnAt: string | null;
}

const releases = ref<Release[]>([]);
const dialog = ref(false);
const error = ref('');
const requireReauth = inject<(permission: string) => Promise<void>>('requireReauth');

const form = ref({
  version: '',
  buildId: '',
  artifactFile: '',
  requiredSchemaVersion: '',
  minCompatibleVersion: '',
  migrations: '',
  rollbackSupported: false,
  channel: 'INTERNAL',
  notes: '',
  reason: '',
});

async function load(): Promise<void> {
  releases.value = (await api<{ releases: Release[] }>('/releases')).releases;
}
onMounted(load);

async function publish(): Promise<void> {
  error.value = '';
  const body = {
    ...form.value,
    migrations: form.value.migrations.split(/[\s,]+/u).filter((name) => name !== ''),
  };
  const call = async (): Promise<void> => {
    await api('/releases', { method: 'POST', body });
    dialog.value = false;
    await load();
  };
  try {
    await call();
  } catch (caught) {
    if (caught instanceof ReauthRequired && requireReauth !== undefined) {
      await requireReauth('release.publish');
      await call().catch((retry: unknown) => {
        error.value = retry instanceof Error ? retry.message : 'Could not publish';
      });
      return;
    }
    error.value = caught instanceof Error ? caught.message : 'Could not publish';
  }
}
</script>

<template>
  <h2>Releases</h2>
  <p class="lede">
    Built artifacts, hashed from disk and signed. Only a signed release can be deployed, and the
    shop's agent checks both the hash and the signature before it replaces anything.
  </p>

  <div style="margin-bottom: 12px">
    <button v-if="can('release.publish')" class="ctl primary" @click="dialog = true">
      Publish release
    </button>
  </div>

  <div class="ctl-card">
    <table class="ctl">
      <thead>
        <tr><th>Version</th><th>Channel</th><th>Schema</th><th>Min. from</th><th>Migrations</th><th>Rollback</th><th>Published</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in releases" :key="row.id">
          <td class="mono">{{ row.version }}</td>
          <td><span class="pill" :class="row.channel === 'STABLE' ? 'ok' : 'warn'">{{ row.channel }}</span></td>
          <td class="mono">{{ row.requiredSchemaVersion }}</td>
          <td class="mono">{{ row.minCompatibleVersion }}</td>
          <td>{{ row.migrations.length }}</td>
          <td>
            <span class="pill" :class="row.rollbackSupported ? 'ok' : 'mute'">
              {{ row.rollbackSupported ? 'YES' : 'NO' }}
            </span>
          </td>
          <td class="ctl-note">{{ row.publishedAt.slice(0, 10) }}</td>
        </tr>
        <tr v-if="releases.length === 0"><td colspan="7" class="ctl-note">No releases yet.</td></tr>
      </tbody>
    </table>
  </div>

  <div v-if="dialog" class="ctl-backdrop">
    <div class="ctl-modal">
      <h3>Publish release</h3>
      <p class="ctl-note">
        The tarball must already be in the control plane's release directory. It is hashed here,
        from disk — never taken on trust — and the hash goes inside the signed manifest.
      </p>
      <div class="two-col">
        <div>
          <label class="ctl" for="r-version">Version</label>
          <input id="r-version" v-model="form.version" class="ctl mono" placeholder="2.3.3" />
          <label class="ctl" for="r-build">Build ID</label>
          <input id="r-build" v-model="form.buildId" class="ctl mono" />
          <label class="ctl" for="r-file">Artifact filename</label>
          <input id="r-file" v-model="form.artifactFile" class="ctl mono" placeholder="sher-2.3.3.tar.gz" />
          <label class="ctl" for="r-channel">Channel</label>
          <select id="r-channel" v-model="form.channel" class="ctl">
            <option value="INTERNAL">Internal</option>
            <option value="PILOT">Pilot</option>
            <option value="STABLE">Stable</option>
          </select>
        </div>
        <div>
          <label class="ctl" for="r-schema">Required schema version</label>
          <input id="r-schema" v-model="form.requiredSchemaVersion" class="ctl mono" placeholder="0053_…" />
          <label class="ctl" for="r-min">Minimum version it can update from</label>
          <input id="r-min" v-model="form.minCompatibleVersion" class="ctl mono" placeholder="2.3.0" />
          <label class="ctl" for="r-migrations">Migrations (space or comma separated)</label>
          <textarea id="r-migrations" v-model="form.migrations" class="ctl mono" rows="3" />
          <label class="ctl" style="display: flex; gap: 6px; align-items: center">
            <input v-model="form.rollbackSupported" type="checkbox" />
            Rollback is genuinely possible
          </label>
        </div>
      </div>
      <label class="ctl" for="r-notes">Release notes</label>
      <textarea id="r-notes" v-model="form.notes" class="ctl" rows="3" />
      <label class="ctl" for="r-reason">Reason (audit trail)</label>
      <input id="r-reason" v-model="form.reason" class="ctl" />
      <p v-if="error" class="ctl-error">{{ error }}</p>
      <footer>
        <button class="ctl" @click="dialog = false">Cancel</button>
        <button class="ctl primary" :disabled="form.version === '' || form.reason.trim().length < 3" @click="publish">
          Hash and sign
        </button>
      </footer>
    </div>
  </div>
</template>
