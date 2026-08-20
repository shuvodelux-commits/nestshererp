<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { loadMyAccess } from '../../auth/access';
import AppBottomNav from './AppBottomNav.vue';
import AppSidebar from './AppSidebar.vue';
import AppTopBar from './AppTopBar.vue';
import ModuleFeatureNav from './ModuleFeatureNav.vue';

/**
 * UI-08: one shell — 256px left sidebar (modules) · top bar · content area,
 * targeting desktop ≥1280px and usable at 1024px (UI-41).
 *
 * The page header inside the content area is part of the shell, not of each
 * page: every module gets the same breadcrumb → title → Bangla helper line on
 * the left and its own actions on the right. A page that drew its own header
 * would be the first crack in §2.7.I.
 *
 * POS runs full-screen without the sidebar when it arrives in Phase 6. That is
 * a separate layout, not a variant of this one.
 */
defineProps<{
  title: string;
  helpBn?: string;
  /** Trail above the title, most general first. The title is not repeated. */
  breadcrumb?: readonly string[];
}>();

const collapsed = ref(false);
const navigationOpen = ref(false);

function toggleNavigation(): void {
  if (typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches) {
    collapsed.value = !collapsed.value;
    return;
  }
  navigationOpen.value = true;
}

// UI-09: the sidebar cannot be permission-filtered until it knows the
// permissions. Loaded here, once, because every signed-in screen sits inside it.
onMounted(() => void loadMyAccess());
</script>

<template>
  <div class="shell">
    <AppSidebar v-model:drawer-visible="navigationOpen" :collapsed="collapsed" />

    <div class="main">
      <AppTopBar :collapsed="collapsed" @toggle-sidebar="toggleNavigation" />

      <div class="scroll">
        <div class="content">
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

        <footer class="foot">
          <span>© {{ new Date().getFullYear() }} SherERP. All rights reserved.</span>
          <span>Made in Bangladesh</span>
        </footer>
      </div>
    </div>

    <AppBottomNav @open-navigation="navigationOpen = true" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}

.main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--sher-surface);
}

.scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* Compact back-office density with enough room for touch and Bangla labels. */
.content {
  flex: 1;
  width: 100%;
  max-width: var(--sher-content-max);
  margin: 0 auto;
  padding: 18px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
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

.foot {
  display: flex;
  justify-content: space-between;
  gap: var(--sher-space-4);
  width: 100%;
  max-width: var(--sher-content-max);
  margin: 0 auto;
  padding: 12px 24px 16px;
  border-top: 1px solid var(--sher-line);
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

@media (max-width: 1023px) {
  .content {
    padding: 16px 14px 20px;
  }

  .foot {
    padding: 14px 16px 18px;
  }
}

@media (max-width: 767px) {
  .content {
    padding: 12px 10px 84px;
    gap: var(--sher-space-3);
  }

  .page-head {
    flex-direction: column;
  }

  .page-actions {
    width: 100%;
    margin-left: 0;
  }

  .foot {
    padding: 14px 12px calc(82px + env(safe-area-inset-bottom));
    flex-direction: column;
    gap: 2px;
  }
}
</style>
