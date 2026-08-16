<script setup lang="ts">
import AppSidebar from './AppSidebar.vue';
import AppTopBar from './AppTopBar.vue';

/**
 * UI-08: one shell — left sidebar (modules) · top bar · content area, targeting
 * desktop ≥1280px and usable at 1024px (UI-41).
 *
 * POS runs full-screen without the sidebar when it arrives in Phase 6. That is
 * a separate layout, not a variant of this one.
 */
defineProps<{ title: string; helpBn?: string }>();
</script>

<template>
  <div class="shell">
    <AppSidebar />
    <div class="main">
      <AppTopBar />
      <div class="content">
        <div class="page-title">
          <h1>{{ title }}</h1>
          <p v-if="helpBn !== undefined" class="sher-bn">{{ helpBn }}</p>
        </div>
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}

.main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--sher-surface);
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 30px;
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.page-title h1 {
  margin: 0;
  font-size: var(--sher-text-xl);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.page-title p {
  margin: 3px 0 0;
}
</style>
