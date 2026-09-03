<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api } from '../api/client';

/**
 * The first screen (§25).
 *
 * Counts and short lists, not charts. An operator opening this at nine in the
 * morning is deciding whether to close the tab; anything that takes reading to
 * interpret gets skimmed, and a skimmed dashboard is worse than none because it
 * is trusted.
 */
interface Overview {
  customers: number;
  installations: Record<string, number>;
  health: Record<string, number>;
  outdated: number;
  licencesExpiringSoon: { id: string; tenantName: string; validUntil: string }[];
  failedDeployments: number;
  activeSupportSessions: { id: string; tenantName: string; operatorName: string; reason: string }[];
  topErrors: { code: string; total: number; installations: number }[];
}

const data = ref<Overview | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    data.value = await api<Overview>('/overview');
  } catch {
    error.value = 'The control plane could not be reached.';
  }
});

function day(iso: string): string {
  return iso.slice(0, 10);
}
</script>

<template>
  <h2>Overview</h2>
  <p class="lede">What needs you today.</p>
  <p v-if="error" class="ctl-error">{{ error }}</p>

  <template v-if="data">
    <div class="ctl-tiles">
      <div class="ctl-tile"><div class="n">{{ data.customers }}</div><div class="l">Customers</div></div>
      <div class="ctl-tile"><div class="n">{{ data.installations['online'] }}</div><div class="l">Online</div></div>
      <div class="ctl-tile"><div class="n">{{ data.installations['offline'] }}</div><div class="l">Offline</div></div>
      <div class="ctl-tile"><div class="n">{{ data.installations['degraded'] }}</div><div class="l">Degraded</div></div>
      <div class="ctl-tile"><div class="n">{{ data.installations['migrationFailed'] }}</div><div class="l">Migration failed</div></div>
      <div class="ctl-tile"><div class="n">{{ data.outdated }}</div><div class="l">Behind latest</div></div>
      <div class="ctl-tile"><div class="n">{{ data.failedDeployments }}</div><div class="l">Halted rollouts</div></div>
      <div class="ctl-tile"><div class="n">{{ data.activeSupportSessions.length }}</div><div class="l">Support sessions</div></div>
    </div>

    <h3>Licences expiring within 30 days</h3>
    <div class="ctl-card">
      <p v-if="data.licencesExpiringSoon.length === 0" class="ctl-note">None.</p>
      <table v-else class="ctl">
        <thead><tr><th>Customer</th><th>Runs out</th></tr></thead>
        <tbody>
          <tr v-for="row in data.licencesExpiringSoon" :key="row.id">
            <td>{{ row.tenantName }}</td>
            <td>{{ day(row.validUntil) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3>Active support sessions</h3>
    <div class="ctl-card">
      <p v-if="data.activeSupportSessions.length === 0" class="ctl-note">None.</p>
      <table v-else class="ctl">
        <thead><tr><th>Customer</th><th>Operator</th><th>Reason</th><th /></tr></thead>
        <tbody>
          <tr v-for="row in data.activeSupportSessions" :key="row.id">
            <td>{{ row.tenantName }}</td>
            <td>{{ row.operatorName }}</td>
            <td>{{ row.reason }}</td>
            <td><RouterLink :to="`/support/${row.id}`">Open</RouterLink></td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3>Most common errors across the fleet, last 24 hours</h3>
    <div class="ctl-card">
      <p v-if="data.topErrors.length === 0" class="ctl-note">Nothing reported.</p>
      <table v-else class="ctl">
        <thead><tr><th>Code</th><th>Occurrences</th><th>Installations</th></tr></thead>
        <tbody>
          <tr v-for="row in data.topErrors" :key="row.code">
            <td class="mono">{{ row.code }}</td>
            <td>{{ row.total }}</td>
            <td>{{ row.installations }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>
