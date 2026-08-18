<script setup lang="ts">
/**
 * The standard panel: a white surface, a hairline border, a 12px radius and one
 * soft shadow (§2.7.I).
 *
 * Restrained on purpose. §2.7-D keeps transactional data clean and readable, so
 * a card lifts itself off the page just enough to be a container — a heavier
 * shadow or a translucent fill behind a dense table costs contrast that UI-42's
 * 4.5:1 floor cannot spare.
 *
 * The `actions` slot is where a card's own control goes — "View all", a period
 * selector — sitting on the title line rather than floating in the body.
 */
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <section class="card">
    <header v-if="title !== undefined" class="head">
      <div class="head-text">
        <h2>{{ title }}</h2>
        <p v-if="subtitle !== undefined">{{ subtitle }}</p>
      </div>
      <div class="head-actions">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.card {
  background: var(--sher-raised);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  box-shadow: var(--sher-shadow-card);
  padding: var(--sher-card-pad);
}

.head {
  display: flex;
  align-items: flex-start;
  gap: var(--sher-space-3);
  margin-bottom: var(--sher-space-4);
}

.head-text {
  min-width: 0;
}

.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
}

.head-actions:empty {
  display: none;
}

h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.head p {
  margin: 4px 0 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
  line-height: 1.55;
}
</style>
