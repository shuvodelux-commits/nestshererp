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
 * `icon` puts a tinted square beside the title. It is decoration with a job: on
 * a long form of five or six cards it is what the eye finds when scrolling back
 * to "the one about prices", which a row of identical headings never gives you.
 * It is `aria-hidden`, because the heading already says what the card is.
 *
 * `subtitleBn` is the Bangla sibling of `subtitle` (UI-15…UI-17) — the business
 * meaning of the section, not a translation of the English line.
 *
 * The `actions` slot is where a card's own control goes — "View all", a period
 * selector — sitting on the title line rather than floating in the body.
 */
defineProps<{ title?: string; subtitle?: string; subtitleBn?: string; icon?: string }>();
</script>

<template>
  <section class="card">
    <header v-if="title !== undefined" class="head">
      <span v-if="icon !== undefined" class="head-icon" aria-hidden="true">
        <i class="pi" :class="icon" />
      </span>
      <div class="head-text">
        <h2>{{ title }}</h2>
        <p v-if="subtitle !== undefined">{{ subtitle }}</p>
        <p v-if="subtitleBn !== undefined" class="sher-bn">{{ subtitleBn }}</p>
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

.head-icon {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--sher-radius);
  background: var(--sher-primary-soft);
  color: var(--sher-primary);
  font-size: 15px;
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

/* The Bangla line keeps its own face and size rather than inheriting the
   English subtitle's (UI-17). */
.head p.sher-bn {
  margin-top: 2px;
  font-family: var(--sher-font-bn);
  font-size: var(--sher-text-xs);
}
</style>
