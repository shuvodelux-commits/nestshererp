<script setup lang="ts">
import Drawer from 'primevue/drawer';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import { useSession } from '../../auth/session';
import AppSidebarNav from './AppSidebarNav.vue';

/**
 * Two frames around one module list.
 *
 * On a desk the sidebar is a permanent rail that can be narrowed to icons. On a
 * phone or a small laptop the same list is PrimeVue's `Drawer` — its `Sidebar`
 * under the v4 name — so the overlay, the focus trap, the escape key and the
 * scroll lock are the component library's job and not a second implementation
 * of them here.
 *
 * What is *inside* both is `AppSidebarNav`, once. The brand block and the
 * business footer are the only things this component draws itself.
 */
const props = defineProps<{ collapsed: boolean; drawerVisible: boolean }>();
const emit = defineEmits<{ 'update:drawerVisible': [visible: boolean] }>();

const session = useSession();
const { businessName } = session;

const drawerOpen = computed({
  get: () => props.drawerVisible,
  set: (visible: boolean) => emit('update:drawerVisible', visible),
});

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

    <AppSidebarNav :collapsed="collapsed" />

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

    <AppSidebarNav class="drawer-nav" @navigate="closeDrawer" />

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
.sidebar.is-collapsed .absent-note,
.sidebar.is-collapsed .biz-text {
  display: none;
}

.sidebar.is-collapsed .brand,
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
