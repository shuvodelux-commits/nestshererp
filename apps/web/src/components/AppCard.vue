<script setup lang="ts">
/**
 * The standard panel: a white surface with a hairline border.
 *
 * Flat on purpose. §2.7-D keeps transactional data clean and readable, and a
 * translucent or heavily shadowed container behind a dense table costs contrast
 * that UI-42's 4.5:1 floor cannot spare.
 */
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <section class="card">
    <header v-if="title !== undefined" class="head">
      <h2>{{ title }}</h2>
      <p v-if="subtitle !== undefined">{{ subtitle }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.card {
  background: var(--sher-surface-3);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  padding: var(--sher-space-5);
}

.head {
  margin-bottom: var(--sher-space-4);
}

h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
}

.head p {
  margin: 3px 0 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}
</style>
