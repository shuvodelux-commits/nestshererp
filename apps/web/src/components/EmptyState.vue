<script setup lang="ts">
/**
 * UI-29: an empty state says what the screen would contain and links to the
 * action that creates the first record.
 *
 * The action is a slot rather than a prop, because the honest empty state
 * sometimes has **no** action — a screen whose first record cannot be created
 * until a later module exists, or a caller who lacks the permission to create
 * one (UI-09). An empty box with a button that 403s is worse than an empty box.
 */
defineProps<{ icon: string; title: string }>();
</script>

<template>
  <div class="empty">
    <span class="empty-mark" aria-hidden="true">
      <i class="pi" :class="icon" />
    </span>
    <h2>{{ title }}</h2>
    <p class="empty-body"><slot /></p>
    <div class="empty-action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.empty {
  border: 1px dashed var(--sher-line-strong);
  border-radius: var(--sher-radius-lg);
  background: var(--sher-raised);
  padding: 44px 32px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.empty-mark {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: var(--sher-radius-lg);
  background: var(--sher-primary-soft);
  color: var(--sher-primary-text);
  font-size: 22px;
  margin-bottom: 2px;
}

.empty h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
}

.empty-body {
  margin: 0;
  max-width: 56ch;
  color: var(--sher-text-muted);
}

.empty-body :deep(strong) {
  color: var(--sher-text);
  font-weight: 600;
}

.empty-action:empty {
  display: none;
}

.empty-action {
  margin-top: 6px;
}
</style>
