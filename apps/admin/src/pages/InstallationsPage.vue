<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { api } from '../api/client';

interface Installation {
  id: string; tenantId: string; tenantName: string; label: string;
  state: string; health: string; appVersion: string; schemaVersion: string;
  licenceState: string; licenceValidUntil: string; lastSeenAt: string | null;
  syncPending: number; syncConflictsOpen: number;
}

const rows = ref<Installation[]>([]);
const filter = ref('');

onMounted(async () => {
  rows.value = (await api<{ installations: Installation[] }>('/installations')).installations;
});

const shown = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (needle === '') return rows.value;
  return rows.value.filter(
    (row) =>
      row.tenantName.toLowerCase().includes(needle) ||
      row.label.toLowerCase().includes(needle) ||
      row.state.toLowerCase().includes(needle) ||
      row.appVersion.includes(needle),
  );
});

function stateClass(state: string): string {
  if (state === 'ONLINE') return 'ok';
  if (state === 'OFFLINE' || state === 'PENDING_ENROLMENT') return 'mute';
  if (state === 'MIGRATION_FAILED' || state === 'REVOKED') return 'bad';
  return 'warn';
}
</script>

<template>
  <h2>Installations</h2>
  <p class="lede">Every enrolled machine, and what it last told us.</p>

  <div style="margin-bottom: 12px; max-width: 22rem">
    <input v-model="filter" class="ctl" placeholder="Filter by customer, label, state or version" />
  </div>

  <div class="ctl-card">
    <table class="ctl">
      <thead>
        <tr>
          <th>Customer</th><th>Installation</th><th>State</th><th>Health</th>
          <th>Version</th><th>Licence</th><th>Queue</th><th>Last seen</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in shown" :key="row.id">
          <td><RouterLink :to="`/customers/${row.tenantId}`">{{ row.tenantName }}</RouterLink></td>
          <td><RouterLink :to="`/installations/${row.id}`">{{ row.label || row.id }}</RouterLink></td>
          <td><span class="pill" :class="stateClass(row.state)">{{ row.state.replace('_', ' ') }}</span></td>
          <td>
            <span
              class="pill"
              :class="row.health === 'HEALTHY' ? 'ok' : row.health === 'CRITICAL' ? 'bad' : row.health === 'WARNING' ? 'warn' : 'mute'"
            >{{ row.health }}</span>
          </td>
          <td class="mono">{{ row.appVersion || '—' }}</td>
          <td>
            {{ row.licenceState }}
            <span v-if="row.licenceValidUntil" class="ctl-note">· {{ row.licenceValidUntil.slice(0, 10) }}</span>
          </td>
          <td>
            <span v-if="row.syncConflictsOpen > 0" class="pill warn">{{ row.syncConflictsOpen }} conflicts</span>
            <span v-else-if="row.syncPending > 0" class="ctl-note">{{ row.syncPending }} pending</span>
            <span v-else class="ctl-note">clear</span>
          </td>
          <td class="ctl-note">{{ row.lastSeenAt?.slice(0, 16).replace('T', ' ') ?? 'never' }}</td>
        </tr>
        <tr v-if="shown.length === 0"><td colspan="8" class="ctl-note">Nothing matches.</td></tr>
      </tbody>
    </table>
  </div>
</template>
