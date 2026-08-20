<script setup lang="ts">
import Drawer from 'primevue/drawer';
import type { MenuItem } from 'primevue/menuitem';
import PanelMenu from 'primevue/panelmenu';
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { useSession } from '../../auth/session';
import { resolveNavigation } from './navigation';

const props = defineProps<{ collapsed: boolean; drawerVisible: boolean }>();
const emit = defineEmits<{ 'update:drawerVisible': [visible: boolean] }>();

const route = useRoute();
const router = useRouter();
const session = useSession();
const { businessName } = session;
const NAV_STATE_KEY = 'sher.navigation.expanded';

const drawerOpen = computed({
  get: () => props.drawerVisible,
  set: (visible: boolean) => emit('update:drawerVisible', visible),
});

const navigation = computed(() => resolveNavigation({ can: session.can }));

const visibleGroups = computed<MenuItem[]>(() => navigation.value.map((category) => {
  const only = !category.alwaysGroup && category.subcategories.length === 1 ? category.subcategories[0] : undefined;
  if (only !== undefined) return {
    key: category.id,
    label: category.label,
    icon: `pi ${category.icon}`,
    route: only.route,
    title: only.purpose,
    activePrefixes: only.activePrefixes,
  };
  return {
    key: category.id,
    label: category.label,
    icon: `pi ${category.icon}`,
    defaultRoute: category.subcategories[0]?.route,
    items: category.subcategories.map((subcategory) => ({
      key: subcategory.id,
      label: subcategory.label,
      icon: `pi ${subcategory.icon}`,
      route: subcategory.route,
      title: subcategory.purpose,
      activePrefixes: subcategory.activePrefixes,
    })),
  };
}));

const collapsedCategories = computed(() => navigation.value.map((category) => ({
  id: category.id,
  label: category.label,
  icon: category.icon,
  to: category.subcategories[0]?.route ?? '/dashboard',
  purpose: category.subcategories.map((subcategory) => subcategory.label).join(' · '),
  subcategories: category.subcategories,
})));

function storedExpandedKeys(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(NAV_STATE_KEY);
    return stored === null ? {} : JSON.parse(stored) as Record<string, boolean>;
  } catch {
    return {};
  }
}

const expansionIsUserManaged = ref(localStorage.getItem(NAV_STATE_KEY) !== null);
const expandedKeys = ref<Record<string, boolean>>(storedExpandedKeys());

function routeMatches(target: string, prefixes: readonly string[]): boolean {
  const resolved = router.resolve(target);
  const targetRole = resolved.query.role;
  if (typeof targetRole === 'string' && route.path === resolved.path) return route.query.role === targetRole;
  return prefixes.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`));
}

function menuItemActive(item: MenuItem): boolean {
  return typeof item.key === 'string' && item.key === activeSubcategoryId.value;
}

const activeSubcategoryId = computed(() => navigation.value
  .flatMap((category) => category.subcategories)
  .filter((subcategory) => routeMatches(subcategory.route, subcategory.activePrefixes))
  .sort((left, right) => router.resolve(right.route).path.length - router.resolve(left.route).path.length)[0]?.id);

function categoryActive(categoryId: string): boolean {
  const category = navigation.value.find((item) => item.id === categoryId);
  return category?.subcategories.some((subcategory) => routeMatches(subcategory.route, subcategory.activePrefixes)) ?? false;
}

function openCategoryDefault(item: MenuItem): void {
  if (typeof item.key !== 'string' || categoryActive(item.key) || typeof item.defaultRoute !== 'string') return;
  void router.push(item.defaultRoute);
}

watch([navigation, () => route.fullPath], () => {
  if (expansionIsUserManaged.value) return;
  const active = navigation.value.find((category) => categoryActive(category.id));
  if (active !== undefined) expandedKeys.value = { [active.id]: true };
}, { immediate: true });

watch(expandedKeys, (value) => localStorage.setItem(NAV_STATE_KEY, JSON.stringify(value)), { deep: true });

function updateExpandedKeys(value: Record<string, boolean>): void {
  expansionIsUserManaged.value = true;
  expandedKeys.value = value;
}

const businessInitials = computed(() => {
  const words = (businessName.value ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
});

function closeDrawer(): void {
  drawerOpen.value = false;
}
</script>

<template>
  <aside class="sidebar desktop-sidebar" :class="{ 'is-collapsed': collapsed }">
    <RouterLink to="/dashboard" class="brand" aria-label="SherERP home">
      <span class="brand-mark" aria-hidden="true">S</span>
      <span class="brand-text">
        <span class="brand-name">SHER<strong>ERP</strong></span>
        <span class="brand-tag">Bangladesh's Smart ERP</span>
      </span>
    </RouterLink>

    <nav v-if="collapsed" class="nav collapsed-nav" aria-label="Modules">
      <RouterLink
        v-for="item in collapsedCategories"
        :key="item.id"
        :to="item.to"
        v-tooltip.right="`${item.label} — ${item.purpose}`"
        class="nav-item"
        :class="{ 'is-current': categoryActive(item.id) }"
        :aria-current="categoryActive(item.id) ? 'page' : undefined"
        :aria-label="item.label"
      >
        <i class="pi" :class="item.icon" aria-hidden="true" />
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>
    <PanelMenu v-else :expanded-keys="expandedKeys" :model="visibleGroups" multiple class="module-menu" @update:expanded-keys="updateExpandedKeys">
      <template #item="{ item, props: menuProps }">
        <RouterLink v-if="item.route" v-slot="{ href, navigate }" :to="item.route" custom>
          <a :href="href" v-bind="menuProps.action" class="nav-item" :class="{ 'is-current': menuItemActive(item) }" @click="navigate">
            <span v-bind="menuProps.icon" aria-hidden="true" />
            <span v-bind="menuProps.label">{{ item.label }}</span>
          </a>
        </RouterLink>
        <a v-else v-bind="menuProps.action" class="nav-category" @click="openCategoryDefault(item)">
          <span v-bind="menuProps.icon" aria-hidden="true" />
          <span v-bind="menuProps.label">{{ item.label }}</span>
          <span v-bind="menuProps.submenuicon" />
        </a>
      </template>
    </PanelMenu>

    <div class="sidebar-foot">
      <p class="absent-note">More modules appear here as each approved phase is built.</p>
      <div class="biz" :title="businessName ?? ''">
        <span class="biz-mark" aria-hidden="true">{{ businessInitials }}</span>
        <span class="biz-text">
          <strong>{{ businessName ?? '—' }}</strong>
          <span>Head office</span>
        </span>
      </div>
    </div>
  </aside>

  <Drawer v-model:visible="drawerOpen" class="navigation-drawer" header="Modules" position="left">
    <RouterLink to="/dashboard" class="brand drawer-brand" aria-label="SherERP home" @click="closeDrawer">
      <span class="brand-mark" aria-hidden="true">S</span>
      <span class="brand-text">
        <span class="brand-name">SHER<strong>ERP</strong></span>
        <span class="brand-tag">Bangladesh's Smart ERP</span>
      </span>
    </RouterLink>

    <PanelMenu :expanded-keys="expandedKeys" :model="visibleGroups" multiple class="module-menu drawer-nav" @update:expanded-keys="updateExpandedKeys">
      <template #item="{ item, props: menuProps }">
        <RouterLink v-if="item.route" v-slot="{ href, navigate }" :to="item.route" custom>
          <a :href="href" v-bind="menuProps.action" class="nav-item" :class="{ 'is-current': menuItemActive(item) }" @click="navigate(); closeDrawer()">
            <span v-bind="menuProps.icon" aria-hidden="true" />
            <span v-bind="menuProps.label">{{ item.label }}</span>
          </a>
        </RouterLink>
        <a v-else v-bind="menuProps.action" class="nav-category" @click="openCategoryDefault(item)">
          <span v-bind="menuProps.icon" aria-hidden="true" />
          <span v-bind="menuProps.label">{{ item.label }}</span>
          <span v-bind="menuProps.submenuicon" />
        </a>
      </template>
    </PanelMenu>

    <div class="drawer-business biz" :title="businessName ?? ''">
      <span class="biz-mark" aria-hidden="true">{{ businessInitials }}</span>
      <span class="biz-text">
        <strong>{{ businessName ?? '—' }}</strong>
        <span>Head office</span>
      </span>
    </div>
  </Drawer>
</template>

<style scoped>
.sidebar {
  width: var(--sher-sidebar-width);
  flex-shrink: 0;
  background: var(--sher-sidebar);
  border-right: var(--sher-border-w) solid var(--sher-line);
  display: flex;
  flex-direction: column;
  padding-bottom: var(--sher-space-4);
  transition: width var(--sher-transition);
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 18px 16px;
  text-decoration: none;
  color: inherit;
  min-height: 74px;
}

.brand-mark {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--sher-radius);
  background: var(--sher-tone-blue-fill);
  color: var(--sher-on-tone);
  font-weight: 700;
  font-size: var(--sher-text-lg);
  box-shadow: var(--sher-shadow-tone);
}

.brand-text,
.biz-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}

.brand-name {
  font-size: var(--sher-text-lg);
  color: var(--sher-text-muted);
}

.brand-name strong {
  font-weight: 800;
  color: var(--sher-text);
}

.brand-tag,
.biz-text span {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--sher-space-2) var(--sher-space-3);
}

:deep(.module-menu) {
  flex: 1;
  overflow-y: auto;
  border: 0;
  background: transparent;
  padding: var(--sher-space-2) var(--sher-space-3);
}

:deep(.module-menu .p-panelmenu-panel) { border: 0; background: transparent; }
:deep(.module-menu .p-panelmenu-header-content),
:deep(.module-menu .p-panelmenu-content) { border: 0; background: transparent; }
:deep(.module-menu .p-panelmenu-content) { padding: 0 0 var(--sher-space-2); }
:deep(.module-menu .p-panelmenu-item-content) { background: transparent; }
:deep(.module-menu .p-panelmenu-item-link) { padding: 0; }

.nav-category {
  display:flex;
  align-items:center;
  gap:9px;
  min-height:34px;
  padding:8px 10px 5px;
  color:var(--sher-text-faint);
  text-transform:uppercase;
  letter-spacing:.07em;
  font-size:var(--sher-text-2xs);
  font-weight:700;
  text-decoration:none;
}
.nav-category :last-child { margin-left:auto; }

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  min-height: 42px;
  border-radius: var(--sher-radius);
  color: var(--sher-text-muted);
  text-decoration: none;
  font-weight: 500;
  white-space: nowrap;
  transition: background var(--sher-transition), color var(--sher-transition);
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

.nav-item.is-current .pi { color: currentColor !important; }

.sidebar-foot {
  margin-top: auto;
  padding: var(--sher-space-4) var(--sher-space-3) 0;
}

.absent-note {
  margin: 0 4px var(--sher-space-3);
  padding-bottom: var(--sher-space-3);
  border-bottom: 1px solid var(--sher-line);
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
}

.biz {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
  min-width: 0;
}

.biz-mark {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--sher-radius-sm);
  background: var(--sher-primary-soft);
  color: var(--sher-primary-text);
  font-size: var(--sher-text-xs);
  font-weight: 700;
}

.biz-text strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--sher-text-sm);
}

.sidebar.is-collapsed {
  width: var(--sher-sidebar-width-collapsed);
}

.sidebar.is-collapsed .brand-text,
.sidebar.is-collapsed .nav-label,
.sidebar.is-collapsed .absent-note,
.sidebar.is-collapsed .biz-text {
  display: none;
}

.collapsed-nav { overflow-y:auto; }

.sidebar.is-collapsed .brand,
.sidebar.is-collapsed .nav-item,
.sidebar.is-collapsed .biz {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
  gap: 0;
}

.drawer-brand {
  padding: 0 12px 16px;
}

.drawer-nav {
  padding: 0;
}

.drawer-business {
  margin: var(--sher-space-4) var(--sher-space-3);
}

@media (max-width: 1279px) {
  .desktop-sidebar {
    display: none;
  }
}

@media (min-width: 1280px) {
  :deep(.navigation-drawer) {
    display: none;
  }
}
</style>
