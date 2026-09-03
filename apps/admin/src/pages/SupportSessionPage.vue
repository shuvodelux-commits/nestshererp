<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api, ReauthRequired } from '../api/client';
import { can } from '../api/session';

/**
 * The support workspace (§13, §14, §16).
 *
 * **The customer's real ERP, in an iframe, through the tunnel.** Not a
 * vendor-built inspector: you see the screens the shop sees, with their data,
 * their settings and their version, so a bug reproduces in front of you rather
 * than in a second UI that always lags the real one. Every request the frame
 * makes goes through the gateway, which attaches the signed grant, and the
 * shop's ERP then applies its own permissions, its own domain rules and its own
 * audit writer — so a correction made here takes exactly the path a correction
 * made at the counter takes.
 *
 * The countdown is not decoration. With no per-session approval from the shop,
 * expiry and revocation are the whole of the containment, so the operator can
 * see at all times how long they have.
 */
interface Session {
  id: string; tenantName: string; tenantId: string; installationId: string;
  installationLabel: string; operatorName: string; reason: string; state: string;
  createdAt: string; expiresAt: string; absoluteExpiresAt: string;
}
interface Action { at: string; method: string; path: string; httpStatus: number; documentRef: string }

const route = useRoute();
const router = useRouter();
const requireReauth = inject<(permission: string) => Promise<void>>('requireReauth');

const session = ref<Session | null>(null);
const actions = ref<Action[]>([]);
const connected = ref(false);
const now = ref(Date.now());
const showActions = ref(false);
let ticker: ReturnType<typeof setInterval> | undefined;

const frameSrc = computed(() =>
  session.value === null ? '' : `/api/control/support/${session.value.id}/proxy/`,
);

const remaining = computed(() => {
  if (session.value === null) return '';
  const ends = Math.min(
    Date.parse(session.value.expiresAt),
    Date.parse(session.value.absoluteExpiresAt),
  );
  const seconds = Math.max(0, Math.floor((ends - now.value) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
});

async function load(): Promise<void> {
  const id = String(route.params['id']);
  const result = await api<{ session: Session; actions: Action[]; connected: boolean }>(
    `/support-sessions/${id}`,
  );
  session.value = result.session;
  actions.value = result.actions;
  connected.value = result.connected;
  route.meta['tenantName'] = result.session.tenantName;
  route.meta['tenantId'] = result.session.tenantId;
}

onMounted(async () => {
  await load();
  ticker = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  if (ticker !== undefined) clearInterval(ticker);
});

async function close(): Promise<void> {
  await api(`/support-sessions/${String(route.params['id'])}/close`, { method: 'POST', body: {} });
  await router.push('/support');
}

async function revoke(): Promise<void> {
  const reason = window.prompt('Why are you revoking this session?');
  if (reason === null || reason.trim().length < 3) return;
  const call = async (): Promise<void> => {
    await api(`/support-sessions/${String(route.params['id'])}/revoke`, {
      method: 'POST',
      body: { reason },
    });
    await router.push('/support');
  };
  try {
    await call();
  } catch (caught) {
    if (caught instanceof ReauthRequired && requireReauth !== undefined) {
      await requireReauth('support.revoke');
      await call();
    }
  }
}
</script>

<template>
  <template v-if="session">
    <h2>Support session</h2>
    <p class="lede">
      {{ session.installationLabel }} · {{ session.reason }} ·
      <span class="pill" :class="session.state === 'ACTIVE' ? 'ok' : 'mute'">{{ session.state }}</span>
      <span v-if="session.state === 'ACTIVE'" class="pill" :class="connected ? 'ok' : 'warn'" style="margin-left: 6px">
        {{ connected ? 'TUNNEL CONNECTED' : 'WAITING FOR THE SHOP' }}
      </span>
      <span class="mono" style="margin-left: 10px">ends in {{ remaining }}</span>
    </p>

    <div class="ctl-card" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
      <button class="ctl" @click="load">Refresh</button>
      <button class="ctl" @click="showActions = !showActions">
        {{ showActions ? 'Hide' : 'Show' }} what this session has done ({{ actions.length }})
      </button>
      <div style="flex: 1" />
      <button v-if="can('support.revoke')" class="ctl danger" @click="revoke">Revoke</button>
      <button class="ctl primary" @click="close">Close session</button>
    </div>

    <div v-if="showActions" class="ctl-card">
      <table class="ctl">
        <thead><tr><th>When</th><th>Method</th><th>Path</th><th>Status</th></tr></thead>
        <tbody>
          <tr v-for="(row, index) in actions" :key="index">
            <td class="ctl-note">{{ row.at.slice(11, 19) }}</td>
            <td class="mono">{{ row.method }}</td>
            <td class="mono">{{ row.path }}</td>
            <td>{{ row.httpStatus }}</td>
          </tr>
          <tr v-if="actions.length === 0"><td colspan="4" class="ctl-note">Nothing yet.</td></tr>
        </tbody>
      </table>
    </div>

    <template v-if="session.state === 'ACTIVE'">
      <p v-if="!connected" class="ctl-note">
        Waiting for the shop's agent to raise its tunnel. It does that at its next check-in — usually
        within three minutes. Nothing is wrong; the shop may simply be offline.
      </p>
      <iframe v-else class="ctl-frame" :src="frameSrc" title="Customer ERP" />
    </template>
    <p v-else class="ctl-note">
      This session has ended. Its record above is permanent; open a new session to continue.
    </p>
  </template>
</template>
