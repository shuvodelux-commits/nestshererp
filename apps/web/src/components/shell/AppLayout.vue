<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from 'vue';
import { RouterView, useRouter } from 'vue-router';

import { loadMyAccess } from '../../auth/access';
import AppBottomNav from './AppBottomNav.vue';
import AppSidebar from './AppSidebar.vue';
import AppTopBar from './AppTopBar.vue';
import { navigationModuleId } from './navigation';

/**
 * UI-08: one shell — 256px left sidebar (modules) · top bar · content area,
 * targeting desktop ≥1280px and usable at 1024px (UI-41).
 *
 * **The shell is mounted once, above the router.** Every page used to mount its
 * own copy, which meant the sidebar, the top bar and the footer were destroyed
 * and rebuilt on every single navigation. That is what made the app feel
 * broken: the whole screen went blank for a frame and then snapped back, the
 * sidebar's collapsed state was forgotten the moment you went anywhere, and the
 * page-open animation restarted from nothing each time. Here the chrome simply
 * stays, and only the page inside it changes.
 *
 * POS runs full-screen without the sidebar when it arrives in Phase 6. That is
 * a separate layout, not a variant of this one.
 */
const router = useRouter();

const collapsed = ref(false);
const navigationOpen = ref(false);
const scroller = useTemplateRef<HTMLElement>('scroller');

/**
 * Sideways inside a module, a cross-fade between modules — decided before the
 * new page paints, so the class is already correct on the first frame.
 */
const transition = ref('sher-page-fade');

router.afterEach((to, from) => {
  if (to.path === from.path) return;
  transition.value =
    navigationModuleId(to.path) === navigationModuleId(from.path)
      ? 'sher-page-slide'
      : 'sher-page-fade';
  // The scroll container outlives the page now, so a new page has to be handed
  // its top; otherwise you arrive halfway down a list you have never seen.
  scroller.value?.scrollTo({ top: 0 });
});

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

      <div ref="scroller" class="scroll">
        <div class="content">
          <!--
            Both pages occupy the same grid cell, so the one leaving and the one
            arriving overlap instead of taking turns. `out-in` would be simpler
            and is exactly what produced the "everything vanishes, then appears"
            complaint — there is a real empty gap in the middle of it.
          -->
          <RouterView v-slot="{ Component, route }">
            <Transition :name="transition">
              <component :is="Component" :key="route.path" />
            </Transition>
          </RouterView>
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

/*
 * Compact back-office density with enough room for touch and Bangla labels.
 *
 * **Left-aligned, not centred.** The cap was centred with `margin: 0 auto`,
 * which the top bar above it never was — so on a 1920px screen the module
 * started 132px from the sidebar while the top bar started at 24px, and the
 * size of that dead column changed with every resize until it disappeared
 * entirely below 1656px. The sidebar is the left edge of the app; the content
 * begins one padding step away from it and stays there.
 */
.content {
  flex: 1;
  width: 100%;
  max-width: var(--sher-content-max);
  margin: 0;
  padding: 18px 24px 24px;
  /*
   * One cell, so the outgoing and incoming pages sit on top of each other for
   * the ~180ms they overlap. `align-items: start` keeps a short page short
   * rather than stretching it to the height of the one it replaced.
   */
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}

.content > * {
  grid-area: 1 / 1;
}

.foot {
  display: flex;
  justify-content: space-between;
  gap: var(--sher-space-4);
  width: 100%;
  max-width: var(--sher-content-max);
  margin: 0;
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
  }

  .foot {
    padding: 14px 12px calc(82px + env(safe-area-inset-bottom));
    flex-direction: column;
    gap: 2px;
  }
}
</style>
