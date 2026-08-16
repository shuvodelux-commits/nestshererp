<script setup lang="ts">
import { computed } from 'vue';

import { useSession } from '../../auth/session';

/**
 * UI-08: global search, notifications, business context, avatar menu.
 *
 * Search and notifications are rendered but explicitly disabled, with a title
 * explaining why — there is nothing to search and nothing to notify about until
 * products, parties and documents exist. UI-05 forbids hidden affordances, and a
 * control that silently does nothing is worse than one that says it is not ready.
 */
const { businessName, signOut } = useSession();

const initial = computed(() => (businessName.value ?? '?').trim().charAt(0).toUpperCase());
</script>

<template>
  <header class="topbar">
    <label class="search" :title="'Search arrives with products and parties'">
      <i class="pi pi-search" aria-hidden="true" />
      <input
        type="search"
        placeholder="Search products, customers, invoices"
        disabled
        aria-label="Global search"
      />
    </label>

    <div class="actions">
      <button
        type="button"
        class="icon-button"
        disabled
        title="Notifications arrive with the modules that raise them"
        aria-label="Notifications"
      >
        <i class="pi pi-bell" aria-hidden="true" />
      </button>

      <div class="business">
        <span class="avatar" aria-hidden="true">{{ initial }}</span>
        <span class="label">{{ businessName ?? 'SherERP' }}</span>
      </div>

      <button type="button" class="sign-out" @click="signOut()">Sign out</button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--sher-topbar-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sher-space-4);
  padding: 0 var(--sher-space-5);
  background: var(--sher-glass-bg);
  backdrop-filter: blur(var(--sher-glass-blur));
  -webkit-backdrop-filter: blur(var(--sher-glass-blur));
  border-bottom: 1px solid var(--sher-border-glass);
}

.search {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
  flex: 1;
  max-width: 460px;
  padding: 8px var(--sher-space-3);
  border-radius: var(--sher-radius-sm);
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid var(--sher-border);
  color: var(--sher-text-muted);
}

.search input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  color: var(--sher-text);
}

.search input:disabled {
  cursor: not-allowed;
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--sher-space-4);
}

.icon-button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--sher-text-muted);
  cursor: not-allowed;
}

.business {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
}

.avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--sher-primary), var(--sher-primary-dark));
  color: var(--sher-text-inverse);
  font-size: var(--sher-text-sm);
  font-weight: 650;
}

.label {
  font-weight: 550;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sign-out {
  padding: 7px var(--sher-space-3);
  border: 1px solid var(--sher-border);
  border-radius: var(--sher-radius-sm);
  background: rgba(255, 255, 255, 0.6);
  color: var(--sher-text);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--sher-transition);
}

.sher-sign-out:hover,
.sign-out:hover {
  background: #ffffff;
}

@media (max-width: 767px) {
  .search {
    max-width: none;
  }

  .label {
    display: none;
  }
}
</style>
