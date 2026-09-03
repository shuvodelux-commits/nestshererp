<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api } from '../api/client';

interface AuditRow {
  id: string; at: string; operatorName: string; action: string;
  tenantId: string | null; installationId: string | null;
  reason: string; subject: string; ip: string;
}

const events = ref<AuditRow[]>([]);
const action = ref('');

async function load(): Promise<void> {
  const query = action.value === '' ? '' : `?action=${encodeURIComponent(action.value)}`;
  events.value = (await api<{ events: AuditRow[] }>(`/audit${query}`)).events;
}
onMounted(load);
</script>

<template>
  <h2>Audit</h2>
  <p class="lede">
    Every security-sensitive thing done from this console. The table refuses UPDATE and DELETE at the
    database itself — a vendor who could tidy this record would not have been audited, only logged.
  </p>

  <div style="margin-bottom: 12px; max-width: 22rem; display: flex; gap: 8px">
    <input v-model="action" class="ctl mono" placeholder="Filter by action, e.g. licence.issue" />
    <button class="ctl" @click="load">Filter</button>
  </div>

  <div class="ctl-card">
    <table class="ctl">
      <thead><tr><th>When</th><th>Operator</th><th>Action</th><th>Subject</th><th>Reason</th><th>IP</th></tr></thead>
      <tbody>
        <tr v-for="row in events" :key="row.id">
          <td class="ctl-note">{{ row.at.slice(0, 19).replace('T', ' ') }}</td>
          <td>{{ row.operatorName }}</td>
          <td class="mono">{{ row.action }}</td>
          <td>{{ row.subject }}</td>
          <td>{{ row.reason }}</td>
          <td class="ctl-note mono">{{ row.ip }}</td>
        </tr>
        <tr v-if="events.length === 0"><td colspan="6" class="ctl-note">Nothing recorded.</td></tr>
      </tbody>
    </table>
  </div>
</template>
