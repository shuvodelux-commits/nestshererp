<script setup lang="ts">
import { computed, provide, ref } from 'vue';
import { useRoute } from 'vue-router';

import { can, session, signOut } from '../api/session';
import ReauthDialog from './ReauthDialog.vue';

/**
 * The console frame: navigation, the operator's identity, and the tenant banner.
 *
 * **The banner is the point.** Whenever a customer's context is open — a
 * customer page, an installation, a support session — their name sits at the
 * top of the screen and cannot be scrolled away from (owner decision
 * 2026-09-03). The console can embed a live shop in an iframe, so at some point
 * every operator will have two SherERPs on screen; the banner and the deliberately
 * different colour scheme are what stop the wrong one being acted on.
 *
 * Navigation is filtered by permission, which is presentation only. Every route
 * on the control plane checks the operator's role itself — a hidden button in
 * front of a server that would refuse anyway is a courtesy, not a boundary.
 */
const route = useRoute();

const reauth = ref<{ open: boolean; permission: string; resolve: (() => void) | null }>({
  open: false,
  permission: '',
  resolve: null,
});

/**
 * Any screen can ask for a re-authentication and continue where it left off.
 *
 * Provided rather than imported so a page does not have to know how the dialog
 * is rendered; it awaits a promise and retries its own call.
 */
provide('requireReauth', (permission: string): Promise<void> => {
  return new Promise((resolve) => {
    reauth.value = { open: true, permission, resolve };
  });
});

function reauthDone(): void {
  reauth.value.resolve?.();
  reauth.value = { open: false, permission: '', resolve: null };
}

function reauthCancel(): void {
  reauth.value = { open: false, permission: '', resolve: null };
}

const tenantBanner = computed(() => {
  const name = route.meta['tenantName'];
  const id = route.meta['tenantId'];
  if (typeof name !== 'string' || name === '') return null;
  return { name, id: typeof id === 'string' ? id : '' };
});

const links = computed(() =>
  [
    { to: '/', label: 'Overview', need: 'installation.view' },
    { to: '/customers', label: 'Customers', need: 'tenant.view' },
    { to: '/installations', label: 'Installations', need: 'installation.view' },
    { to: '/licences', label: 'Licences', need: 'licence.view' },
    { to: '/releases', label: 'Releases', need: 'release.view' },
    { to: '/deployments', label: 'Deployments', need: 'deployment.view' },
    { to: '/known-issues', label: 'Known issues', need: 'issue.view' },
    { to: '/support', label: 'Support', need: 'support.view' },
    { to: '/audit', label: 'Audit', need: 'audit.view' },
  ].filter((link) => can(link.need)),
);
</script>

<template>
  <div class="ctl-shell">
    <nav class="ctl-nav">
      <h1>SherERP Control</h1>
      <p class="brand-sub">Vendor operations</p>
      <RouterLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        :class="{ active: route.path === link.to || (link.to !== '/' && route.path.startsWith(link.to)) }"
      >
        {{ link.label }}
      </RouterLink>
      <div class="spacer" />
      <div class="who">
        {{ session.operator?.name }}<br />
        <span style="opacity: 0.7">{{ session.operator?.role.replace('_', ' ').toLowerCase() }}</span>
      </div>
      <button class="ctl" @click="signOut().then(() => $router.push('/login'))">Sign out</button>
    </nav>

    <main class="ctl-main">
      <div v-if="tenantBanner" class="ctl-tenant-banner">
        <span>Customer: {{ tenantBanner.name }}</span>
        <span v-if="tenantBanner.id" class="id mono">{{ tenantBanner.id }}</span>
      </div>
      <RouterView />
    </main>

    <ReauthDialog
      :open="reauth.open"
      :permission="reauth.permission"
      @done="reauthDone"
      @cancel="reauthCancel"
    />
  </div>
</template>
