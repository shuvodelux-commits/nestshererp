<script setup lang="ts">
import Button from 'primevue/button';
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { useSession } from '../../auth/session';
import { resolveNavigation } from './navigation';

const emit = defineEmits<{ openNavigation: [] }>();
const route = useRoute();
const session = useSession();

const primary = computed(() =>
  resolveNavigation({ can: session.can })
    .flatMap((category) => category.subcategories.map((subcategory) => ({
      id: subcategory.id,
      label: subcategory.label,
      icon: subcategory.icon,
      to: subcategory.route,
      activePrefixes: subcategory.activePrefixes,
    })))
    .slice(0, 4),
);

function active(item: (typeof primary.value)[number]): boolean {
  return item.activePrefixes.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`));
}
</script>

<template>
  <nav class="bottom-nav" aria-label="Primary modules">
    <RouterLink
      v-for="item in primary"
      :key="item.id"
      :to="item.to"
      class="bottom-item"
      :class="{ 'is-current': active(item) }"
      :aria-current="active(item) ? 'page' : undefined"
    >
      <i class="pi" :class="item.icon" aria-hidden="true" />
      <span>{{ item.label }}</span>
    </RouterLink>
    <Button
      class="bottom-more"
      icon="pi pi-bars"
      label="More"
      text
      aria-label="Open all modules"
      @click="emit('openNavigation')"
    />
  </nav>
</template>

<style scoped>
.bottom-nav {
  display: none;
}

@media (max-width: 767px) {
  .bottom-nav {
    position: fixed;
    inset: auto 0 0;
    z-index: 45;
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    min-height: 64px;
    padding: 4px max(4px, env(safe-area-inset-right)) calc(4px + env(safe-area-inset-bottom))
      max(4px, env(safe-area-inset-left));
    border-top: 1px solid var(--sher-line);
    background: var(--sher-raised);
    box-shadow: 0 -2px 12px rgb(15 23 42 / 8%);
  }

  .bottom-item,
  :deep(.bottom-more) {
    min-width: 0;
    min-height: 56px;
    padding: 5px 2px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    border-radius: var(--sher-radius);
    color: var(--sher-text-muted);
    text-decoration: none;
    font-size: var(--sher-text-2xs);
    font-weight: 600;
    line-height: 1.15;
    text-align: center;
  }

  .bottom-item .pi,
  :deep(.bottom-more .p-button-icon) {
    font-size: 17px;
  }

  .bottom-item span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bottom-item.is-current {
    background: var(--sher-nav-active-bg);
    color: var(--sher-nav-active-fg);
  }

  :deep(.bottom-more .p-button-label) {
    flex: initial;
    font-size: var(--sher-text-2xs);
    font-weight: 600;
  }
}
</style>
