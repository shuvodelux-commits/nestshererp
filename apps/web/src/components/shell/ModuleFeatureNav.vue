<script setup lang="ts">
import Tab from 'primevue/tab';
import TabList from 'primevue/tablist';
import Tabs from 'primevue/tabs';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useSession } from '../../auth/session';
import { navigationFeatureAccessible, SHER_NAVIGATION_ARCHITECTURE } from './navigation';

const route = useRoute();
const router = useRouter();
const session = useSession();

function matchScore(target: string, prefixes: readonly string[]): number {
  const resolved = router.resolve(target);
  const expectedQuery = Object.entries(resolved.query);
  if (route.path === resolved.path) {
    if (expectedQuery.length === 0) return 3;
    return expectedQuery.every(([key, value]) => route.query[key] === value) ? 4 : 0;
  }
  return prefixes.some((prefix) => route.path.startsWith(`${prefix}/`)) ? 1 : 0;
}

const pages = computed(() => {
  /*
   * `featureEnabled` is passed for the same reason the sidebar passes it
   * (bug found by the owner 2026-08-31): without it,
   * `navigationFeatureAccessible` reads `access.featureEnabled?.(flag)` as
   * `undefined` and **every capability behind a §5.21 setting disappears from
   * this strip** — even one the shop has switched on. That silently hid all
   * three vendor tabs, so the Vendor Workspace had no way in at all.
   */
  const access = { can: session.can, featureEnabled: session.featureEnabled };
  const candidates = SHER_NAVIGATION_ARCHITECTURE.flatMap((category) => category.subcategories)
    .map((subcategory) => {
      const features = subcategory.features.filter((feature) => navigationFeatureAccessible(feature, access));
      return {
        score: Math.max(0, ...features.map((feature) => feature.route === undefined ? 0 : matchScore(feature.route, feature.activePrefixes ?? []))),
        features,
      };
    })
    .sort((left, right) => right.score - left.score);
  const current = candidates[0];
  if (current === undefined || current.score === 0) return [];

  /**
   * **A tab is named after the page it opens, not after everything reachable
   * once you are there.**
   *
   * Joining every capability that shares a route produced "Products & Stock
   * Adjustment & Lots/Batch" on a control barely wider than the word Products —
   * a label nobody reads, wrapping over two lines, in a strip meant to be
   * scanned in one glance. Stock adjustment and lots are row actions on the
   * Products page; they are things you can do there, not places to go. They
   * stay in the hover text, where a full sentence costs nothing.
   */
  const grouped = new Map<string, { label: string; labelBn: string; purposes: string[] }>();
  for (const feature of current.features) {
    if (feature.route === undefined) continue;
    const entry = grouped.get(feature.route);
    if (entry === undefined) {
      grouped.set(feature.route, {
        label: feature.label,
        labelBn: feature.labelBn,
        purposes: [`${feature.label}: ${feature.purpose}`],
      });
      continue;
    }
    entry.purposes.push(`${feature.label}: ${feature.purpose}`);
  }

  return [...grouped.entries()].map(([target, entry]) => ({
    target,
    label: entry.label,
    labelBn: entry.labelBn,
    purpose: entry.purposes.join(' · '),
    active: matchScore(target, []) >= 3,
  }));
});

const activeTarget = computed(() => pages.value.find((page) => page.active)?.target ?? pages.value[0]?.target ?? '');
</script>

<template>
  <nav v-if="pages.length > 1" class="feature-nav" aria-label="Related pages">
    <Tabs :value="activeTarget" scrollable>
      <TabList>
        <Tab
          v-for="page in pages"
          :key="page.target"
          :value="page.target"
          :title="page.purpose"
          @click="router.push(page.target)"
        >
          <span class="feature-label">{{ page.label }}</span>
          <span class="feature-label-bn">{{ page.labelBn }}</span>
        </Tab>
      </TabList>
    </Tabs>
  </nav>
</template>

<style scoped>
/*
 * The pages of the module you are standing in, drawn as **underlined tabs**.
 *
 * They were chips in a segmented control for a while, on the argument that a
 * border makes it obvious a thing can be pressed. In practice it made the strip
 * heavy: two bordered boxes directly under the page title compete with it, and
 * on Products the box was wide enough to look like a section of its own. Tabs
 * are the convention this audience already meets in every app they use, and the
 * moving bar under the current one says where you are without drawing a box
 * around it.
 */
.feature-nav {
  min-width: 0;
  overflow: hidden;
}

.feature-nav :deep(.p-tabs),
.feature-nav :deep(.p-tablist),
.feature-nav :deep(.p-tablist-tab-list) {
  background: transparent;
}

.feature-nav :deep(.p-tablist-tab-list) {
  gap: var(--sher-space-5);
  border-bottom: 1px solid var(--sher-line);
}

.feature-nav :deep(.p-tab) {
  flex: 0 0 auto;
  padding: 0.4rem 0 0.55rem;
  border: 0;
  background: transparent;
  white-space: nowrap;
  transition: color var(--sher-transition);
}

/* The bar under the current tab is the only "selected" mark there is. */
.feature-nav :deep(.p-tablist-active-bar) {
  height: 2px;
  background: var(--sher-primary);
}

.feature-label,
.feature-label-bn {
  display: block;
  text-align: left;
}

.feature-label {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.feature-label-bn {
  margin-top: 0.1rem;
  color: var(--sher-text-faint);
  font-size: var(--sher-text-2xs);
  font-weight: 400;
}

.feature-nav :deep(.p-tab:hover) .feature-label {
  color: var(--sher-text);
}

.feature-nav :deep(.p-tab-active) .feature-label {
  color: var(--sher-primary-text);
}

.feature-nav :deep(.p-tab-active) .feature-label-bn {
  color: var(--sher-text-muted);
}
</style>
