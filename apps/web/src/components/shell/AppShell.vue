<script setup lang="ts">
import ModuleFeatureNav from './ModuleFeatureNav.vue';

/**
 * The page inside the shell: breadcrumb → title → Bangla helper line, the
 * module's own actions, the strip of related pages, then the page body.
 *
 * The chrome around it — sidebar, top bar, footer — lives in `AppLayout` and is
 * mounted once for the whole session. This component is what changes when you
 * navigate, and it is deliberately the *only* thing that changes.
 *
 * The header belongs here rather than to each page: every module gets the same
 * one, and a page that drew its own would be the first crack in §2.7.I.
 *
 * **Spacing is owned here too.** Pages used to add their own margin under the
 * filter row on top of the container's gap, so the distance from the title to
 * the first card was 36px on Products, 32px on the Inventory Report and 16px on
 * Audit — the same screen furniture at three different heights. One `gap` on
 * one flex column means there is nothing left for a page to disagree with.
 */
defineProps<{
  title: string;
  helpBn?: string;
  /** Trail above the title, most general first. The title is not repeated. */
  breadcrumb?: readonly string[];
}>();
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="page-head-text">
        <nav v-if="breadcrumb !== undefined" class="crumbs" aria-label="Breadcrumb">
          <span v-for="crumb in breadcrumb" :key="crumb" class="crumb">{{ crumb }}</span>
        </nav>
        <h1>{{ title }}</h1>
        <p v-if="helpBn !== undefined" class="sher-bn">{{ helpBn }}</p>
      </div>

      <!-- A module's own primary actions: "Add user", "Add role", Export. -->
      <div class="page-actions">
        <slot name="actions" />
      </div>
    </header>

    <ModuleFeatureNav />

    <slot />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
  min-width: 0;
}

.page-head {
  display: flex;
  align-items: flex-start;
  gap: var(--sher-space-3);
  flex-wrap: wrap;
}

.page-head-text {
  min-width: 0;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
  margin-bottom: 4px;
}

.crumb + .crumb::before {
  content: '›';
  margin-right: 6px;
  color: var(--sher-text-faint);
}

.page-head h1 {
  margin: 0;
  font-size: var(--sher-text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.page-head p {
  margin: 4px 0 0;
}

.page-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  flex-wrap: wrap;
}

.page-actions:empty {
  display: none;
}

@media (max-width: 767px) {
  .page {
    gap: var(--sher-space-3);
  }

  .page-head {
    flex-direction: column;
  }

  .page-actions {
    width: 100%;
    margin-left: 0;
  }
}
</style>
