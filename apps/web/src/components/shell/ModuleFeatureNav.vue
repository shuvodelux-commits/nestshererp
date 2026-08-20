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
  const access = { can: session.can };
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

  const grouped = new Map<string, { labels: string[]; labelsBn: string[]; purpose: string }>();
  for (const feature of current.features) {
    if (feature.route === undefined) continue;
    const entry = grouped.get(feature.route) ?? { labels: [], labelsBn: [], purpose: feature.purpose };
    entry.labels.push(feature.label);
    entry.labelsBn.push(feature.labelBn);
    grouped.set(feature.route, entry);
  }
  return [...grouped.entries()].map(([target, entry]) => ({
    target,
    label: entry.labels.join(' & '),
    labelBn: entry.labelsBn.join(' ও '),
    purpose: entry.purpose,
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
.feature-nav {
  min-width: 0;
  overflow: hidden;
  border-bottom: 1px solid var(--p-content-border-color);
}
.feature-nav :deep(.p-tabs),
.feature-nav :deep(.p-tablist),
.feature-nav :deep(.p-tablist-tab-list) {
  background: transparent;
}
.feature-nav :deep(.p-tablist-tab-list) {
  border-width: 0;
}
.feature-nav :deep(.p-tab) {
  flex: 0 0 auto;
  min-width: 9rem;
  padding: 0.8rem 1.1rem 0.7rem;
  white-space: nowrap;
}
.feature-label,
.feature-label-bn {
  display: block;
  width: 100%;
  text-align: center;
}
.feature-label {
  color: var(--p-text-color);
  font-size: 0.9rem;
  font-weight: 600;
}
.feature-label-bn {
  margin-top: 0.15rem;
  color: var(--p-text-muted-color);
  font-size: 0.75rem;
  font-weight: 400;
}
.feature-nav :deep(.p-tab-active) .feature-label {
  color: var(--p-primary-color);
}

@media (max-width: 640px) {
  .feature-nav :deep(.p-tab) {
    min-width: 8rem;
    padding-inline: 0.8rem;
  }
}
</style>
