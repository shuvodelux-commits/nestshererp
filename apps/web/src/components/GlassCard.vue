<script setup lang="ts">
/**
 * The floating glass surface every summary panel sits on.
 *
 * Used for *chrome* — cards, panels, forms. Never wrapped around dense
 * transactional data: §2.7-D keeps tables clean and readable, and UI-42's
 * contrast floor is not reachable through a blurred translucent row.
 */
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <section class="card">
    <header v-if="title !== undefined" class="head">
      <h2>{{ title }}</h2>
      <p v-if="subtitle !== undefined" class="subtitle">{{ subtitle }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.card {
  background: var(--sher-glass-bg);
  backdrop-filter: blur(var(--sher-glass-blur));
  -webkit-backdrop-filter: blur(var(--sher-glass-blur));
  border: 1px solid var(--sher-border-glass);
  box-shadow: var(--sher-shadow);
  border-radius: var(--sher-radius);
  padding: var(--sher-space-5);
}

.head {
  margin-bottom: var(--sher-space-4);
}

h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.subtitle {
  margin: var(--sher-space-1) 0 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}
</style>
