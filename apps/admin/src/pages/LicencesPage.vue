<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api } from '../api/client';

interface Expiring { id: string; tenantId: string; tenantName: string; validUntil: string }

const rows = ref<Expiring[]>([]);

onMounted(async () => {
  rows.value = (await api<{ licences: Expiring[] }>('/licences/expiring')).licences;
});

function daysLeft(iso: string): number {
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}
</script>

<template>
  <h2>Licences</h2>
  <p class="lede">
    Terms running out within 30 days. A licence is issued and renewed from the customer's own page,
    where the Business ID it must name is known.
  </p>

  <div class="ctl-card">
    <table class="ctl">
      <thead><tr><th>Customer</th><th>Runs out</th><th>Days left</th><th /></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.tenantName }}</td>
          <td>{{ row.validUntil.slice(0, 10) }}</td>
          <td>
            <span class="pill" :class="daysLeft(row.validUntil) < 0 ? 'bad' : daysLeft(row.validUntil) < 14 ? 'warn' : 'mute'">
              {{ daysLeft(row.validUntil) }}
            </span>
          </td>
          <td><RouterLink :to="`/customers/${row.tenantId}`">Renew</RouterLink></td>
        </tr>
        <tr v-if="rows.length === 0"><td colspan="4" class="ctl-note">Nothing running out soon.</td></tr>
      </tbody>
    </table>
  </div>
</template>
