<script setup lang="ts">
import AppSidebar from './AppSidebar.vue';
import AppTopBar from './AppTopBar.vue';

/**
 * UI-08: one shell — left sidebar (modules) · top bar (search, notifications,
 * business context) · content area. POS will run full-screen without the
 * sidebar when it arrives in Phase 6; that is a separate layout, not a variant
 * of this one.
 */
</script>

<template>
  <div class="shell">
    <AppSidebar />
    <div class="column">
      <AppTopBar />
      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}

.column {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: var(--sher-space-6);
}

@media (max-width: 767px) {
  .content {
    padding: var(--sher-space-4);
  }
}
</style>
