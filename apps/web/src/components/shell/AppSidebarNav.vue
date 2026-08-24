<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { useSession } from '../../auth/session';
import { resolveNavigation } from './navigation';

/**
 * The module list itself, written once.
 *
 * It used to exist twice — once in the desktop `<aside>` and again inside the
 * mobile drawer — which is how the two drifted apart and how a change to one
 * silently missed the other. Both surfaces now render this component; only the
 * frame around it differs.
 *
 * The list is **flat and always open**: a small section caption, then every page
 * under it. It was an accordion once. Nothing was gained by it — the whole list
 * is shorter than the viewport, so collapsing one category only ever hid
 * destinations — and plenty was lost: the open category was remembered in
 * `localStorage`, which fought the rule that reopens the category you are
 * standing in, so a category could snap shut or spring open a moment after the
 * page arrived. A caption is not a control, so there is nothing left to fight
 * over and nothing left to mis-tap.
 *
 * A category holding exactly one page is drawn as that page (Overview →
 * Dashboard). A caption above a single row is a heading that names one thing.
 */
const props = defineProps<{ collapsed?: boolean }>();
const emit = defineEmits<{ navigate: [] }>();

const route = useRoute();
const router = useRouter();
const session = useSession();

const navigation = computed(() =>
  resolveNavigation({ can: session.can, featureEnabled: session.featureEnabled }),
);

const sections = computed(() =>
  navigation.value.map((category) => {
    const only =
      !category.alwaysGroup && category.subcategories.length === 1
        ? category.subcategories[0]
        : undefined;
    return {
      id: category.id,
      label: category.label,
      icon: category.icon,
      /** Set when the whole category is one page — drawn as a link, not a caption. */
      single:
        only === undefined
          ? undefined
          : { id: only.id, route: only.route, activePrefixes: only.activePrefixes },
      items: only === undefined ? category.subcategories : [],
    };
  }),
);

const collapsedCategories = computed(() =>
  navigation.value.map((category) => ({
    id: category.id,
    label: category.label,
    icon: category.icon,
    to: category.subcategories[0]?.route ?? '/dashboard',
    purpose: category.subcategories.map((subcategory) => subcategory.label).join(' · '),
  })),
);

function routeMatches(target: string, prefixes: readonly string[]): boolean {
  const resolved = router.resolve(target);
  const targetRole = resolved.query.role;
  if (typeof targetRole === 'string' && route.path === resolved.path)
    return route.query.role === targetRole;
  return prefixes.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`));
}

/**
 * The most specific match wins, so `/settings/security` lights Security alone
 * rather than Business as well.
 */
const activeSubcategoryId = computed(
  () =>
    navigation.value
      .flatMap((category) => category.subcategories)
      .filter((subcategory) => routeMatches(subcategory.route, subcategory.activePrefixes))
      .sort(
        (left, right) =>
          router.resolve(right.route).path.length - router.resolve(left.route).path.length,
      )[0]?.id,
);

function categoryActive(categoryId: string): boolean {
  const category = navigation.value.find((item) => item.id === categoryId);
  return (
    category?.subcategories.some((subcategory) =>
      routeMatches(subcategory.route, subcategory.activePrefixes),
    ) ?? false
  );
}

const listClass = computed(() => (props.collapsed === true ? 'collapsed-nav' : 'module-menu'));
</script>

<template>
  <nav v-if="collapsed === true" class="nav collapsed-nav" aria-label="Modules">
    <RouterLink
      v-for="item in collapsedCategories"
      :key="item.id"
      v-tooltip.right="`${item.label} — ${item.purpose}`"
      :to="item.to"
      class="nav-item"
      :class="{ 'is-current': categoryActive(item.id) }"
      :aria-current="categoryActive(item.id) ? 'page' : undefined"
      :aria-label="item.label"
      @click="emit('navigate')"
    >
      <i class="pi" :class="item.icon" aria-hidden="true" />
      <span class="nav-label">{{ item.label }}</span>
    </RouterLink>
  </nav>

  <nav v-else class="nav" :class="listClass" aria-label="Modules">
    <template v-for="section in sections" :key="section.id">
      <RouterLink
        v-if="section.single !== undefined"
        :to="section.single.route"
        class="nav-item"
        :class="{ 'is-current': activeSubcategoryId === section.single.id }"
        :aria-current="activeSubcategoryId === section.single.id ? 'page' : undefined"
        @click="emit('navigate')"
      >
        <i class="pi" :class="section.icon" aria-hidden="true" />
        <span class="nav-label">{{ section.label }}</span>
      </RouterLink>

      <template v-else>
        <p class="nav-section">
          <i class="pi" :class="section.icon" aria-hidden="true" />
          <span>{{ section.label }}</span>
        </p>
        <RouterLink
          v-for="item in section.items"
          :key="item.id"
          :to="item.route"
          class="nav-item is-nested"
          :class="{ 'is-current': activeSubcategoryId === item.id }"
          :aria-current="activeSubcategoryId === item.id ? 'page' : undefined"
          @click="emit('navigate')"
        >
          <i class="pi" :class="item.icon" aria-hidden="true" />
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </template>
    </template>
  </nav>
</template>

<style scoped>
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sher-space-2) var(--sher-space-3);
}

.module-menu,
.collapsed-nav {
  flex: 1;
  overflow-y: auto;
}

/* A caption, not a control: it names the group and never moves anything. */
.nav-section {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: var(--sher-space-3) 0 2px;
  padding: 0 10px;
  color: var(--sher-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  font-size: var(--sher-text-2xs);
  font-weight: 700;
}

.nav-section .pi {
  width: 18px;
  flex-shrink: 0;
  text-align: center;
  font-size: 14px;
}

.nav > .nav-section:first-child {
  margin-top: 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  min-height: 40px;
  border-radius: var(--sher-radius);
  color: var(--sher-text-muted);
  text-decoration: none;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background var(--sher-transition),
    color var(--sher-transition);
}

/* Indented to the caption's text, so the group reads as one block. */
.nav-item.is-nested {
  margin-left: 10px;
}

.nav-item .pi {
  width: 18px;
  flex-shrink: 0;
  text-align: center;
  font-size: 17px;
  color: currentColor !important;
  transition: color var(--sher-transition);
}

.nav-item:hover {
  background: var(--sher-hover);
  color: var(--sher-text);
}

.nav-item.is-current {
  background: var(--sher-nav-active-bg);
  color: var(--sher-nav-active-fg);
  font-weight: 600;
}

.nav-item.is-current .pi {
  color: currentColor !important;
}

.collapsed-nav .nav-label {
  display: none;
}

.collapsed-nav .nav-item {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
  gap: 0;
}
</style>
