<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api } from '../api/client';

interface Session {
  id: string; tenantName: string; installationLabel: string; operatorName: string;
  reason: string; state: string; createdAt: string; expiresAt: string;
  absoluteExpiresAt: string; connected: boolean;
}

const sessions = ref<Session[]>([]);

onMounted(async () => {
  sessions.value = (await api<{ sessions: Session[] }>('/support-sessions')).sessions;
});
</script>

<template>
  <h2>Support</h2>
  <p class="lede">Sessions that are open right now.</p>

  <div class="ctl-card">
    <table class="ctl">
      <thead><tr><th>Customer</th><th>Installation</th><th>Operator</th><th>Reason</th><th>Tunnel</th><th>Ends by</th><th /></tr></thead>
      <tbody>
        <tr v-for="row in sessions" :key="row.id">
          <td>{{ row.tenantName }}</td>
          <td>{{ row.installationLabel }}</td>
          <td>{{ row.operatorName }}</td>
          <td>{{ row.reason }}</td>
          <td>
            <span class="pill" :class="row.connected ? 'ok' : 'warn'">
              {{ row.connected ? 'CONNECTED' : 'WAITING' }}
            </span>
          </td>
          <td class="ctl-note">{{ row.absoluteExpiresAt.slice(11, 16) }}</td>
          <td><RouterLink :to="`/support/${row.id}`">Open</RouterLink></td>
        </tr>
        <tr v-if="sessions.length === 0"><td colspan="7" class="ctl-note">No open sessions.</td></tr>
      </tbody>
    </table>
  </div>
</template>
