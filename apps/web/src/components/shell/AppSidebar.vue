<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { useSession } from '../../auth/session';

/**
 * UI-08: the 256px left sidebar — brand → navigation → spacer → business
 * identity. UI-10: one level deep.
 *
 * A **white** sidebar (§2.7.I). The accent is spent on the selected row and
 * nothing else, so the eye finds "where am I" without the rail competing with
 * the content beside it.
 *
 * UI-09: navigation is generated from the permission-filtered feature list —
 * never render a control that will 403. Modules that do not exist yet are
 * therefore **absent**, not greyed out: a disabled item is still a rendered
 * control. The list grows as each slice ships it.
 */
defineProps<{ collapsed: boolean }>();

const route = useRoute();
const session = useSession();
const { businessName } = session;

/**
 * `needs` is the permission that makes a destination reachable. An entry with
 * none is reachable by anyone signed in — the dashboard shows only your own
 * business name, and Security only ever edits your own credentials.
 *
 * Icons are primeicons (UI-04): one self-hosted set, familiar meanings only.
 */
const items = [
  { label: 'Dashboard', icon: 'pi-home', to: '/dashboard', needs: null },
  { label: 'Products', icon: 'pi-box', to: '/products', needs: 'catalog.product.view' },
  { label: 'Catalog setup', icon: 'pi-sitemap', to: '/catalog', needs: 'catalog.product.view' },
  {
    label: 'Customers & Suppliers',
    icon: 'pi-id-card',
    to: '/parties',
    needs: 'party.customer.view',
  },
  { label: 'Users', icon: 'pi-users', to: '/users', needs: 'user.account.view' },
  { label: 'Roles & Permissions', icon: 'pi-shield', to: '/roles', needs: 'user.role.view' },
  { label: 'Settings', icon: 'pi-cog', to: '/settings', needs: 'settings.setting.view' },
  { label: 'Audit trail', icon: 'pi-history', to: '/audit', needs: 'audit.event.view' },
  // Security is separate from Settings and needs no permission: it only ever
  // edits the caller's own credentials, so everyone reaches their own.
  { label: 'Security', icon: 'pi-lock', to: '/settings/security', needs: null },
] as const;

/**
 * UI-09: "Never render a control that will 403." A destination the caller cannot
 * open is **absent**, not greyed — a disabled item is still a rendered control,
 * and it advertises a feature they cannot use.
 */
const visible = computed(() =>
  items.filter((item) => item.needs === null || session.can(item.needs)),
);

/** The initials shown when the sidebar is collapsed to icons. */
const businessInitials = computed(() => {
  const words = (businessName.value ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
});
</script>

<template>
  <aside class="sidebar" :class="{ 'is-collapsed': collapsed }">
    <RouterLink to="/dashboard" class="brand" aria-label="SherERP home">
      <span class="brand-mark" aria-hidden="true">S</span>
      <span class="brand-text">
        <span class="brand-name">SHER<strong>ERP</strong></span>
        <span class="brand-tag">Bangladesh's Smart ERP</span>
      </span>
    </RouterLink>

    <nav class="nav" aria-label="Modules">
      <RouterLink
        v-for="item in visible"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :class="{ 'is-current': route.path === item.to }"
        :aria-current="route.path === item.to ? 'page' : undefined"
        :title="collapsed ? item.label : ''"
      >
        <i class="pi" :class="item.icon" aria-hidden="true" />
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <div class="sidebar-foot">
      <p class="absent-note">
        Products, sales, POS, inventory and reports appear here as each module is
        built.
      </p>

      <!--
        The business this session belongs to. Not a switcher: one account holds
        one business today, and a control that opens nothing is exactly what
        UI-05 forbids.
      -->
      <div class="biz" :title="businessName ?? ''">
        <span class="biz-mark" aria-hidden="true">{{ businessInitials }}</span>
        <span class="biz-text">
          <strong>{{ businessName ?? '—' }}</strong>
          <span>Head office</span>
        </span>
      </div>
    </div>
  </aside>
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

/* --------------------------------------------------------------- brand */
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

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  min-width: 0;
}

.brand-name {
  font-size: var(--sher-text-lg);
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--sher-text-muted);
}

.brand-name strong {
  font-weight: 800;
  color: var(--sher-text);
}

.brand-tag {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
  white-space: nowrap;
}

/* ---------------------------------------------------------------- nav */
.nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--sher-space-2) var(--sher-space-3);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  height: 42px;
  border-radius: var(--sher-radius);
  color: var(--sher-text-muted);
  text-decoration: none;
  font-size: var(--sher-text-base);
  font-weight: 500;
  white-space: nowrap;
  transition:
    background var(--sher-transition),
    color var(--sher-transition);
}

.nav-item .pi {
  font-size: 17px;
  width: 20px;
  flex-shrink: 0;
  text-align: center;
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
  color: var(--sher-nav-active-icon);
}

/* ---------------------------------------------------------------- foot */
.sidebar-foot {
  margin-top: auto;
  padding: var(--sher-space-4) var(--sher-space-3) 0;
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3);
}

.absent-note {
  margin: 0;
  padding: 0 4px var(--sher-space-3);
  border-bottom: 1px solid var(--sher-line);
  font-size: var(--sher-text-2xs);
  line-height: 1.55;
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

.biz-text {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  min-width: 0;
}

.biz-text strong {
  font-size: var(--sher-text-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.biz-text span {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
}

/*
 * UI-11: the same destinations, in the same order, collapsed to icons. Driven
 * by the top bar's toggle on desktop and by the viewport on tablet, because at
 * 1024px the content needs the 190px back more than the labels earn it.
 */
.sidebar.is-collapsed {
  width: var(--sher-sidebar-width-collapsed);
}

.sidebar.is-collapsed .brand-text,
.sidebar.is-collapsed .nav-label,
.sidebar.is-collapsed .absent-note,
.sidebar.is-collapsed .biz-text {
  display: none;
}

.sidebar.is-collapsed .brand,
.sidebar.is-collapsed .nav-item,
.sidebar.is-collapsed .biz {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
  gap: 0;
}

@media (max-width: 1023px) {
  .sidebar {
    width: var(--sher-sidebar-width-collapsed);
  }

  .brand-text,
  .nav-label,
  .absent-note,
  .biz-text {
    display: none;
  }

  .brand,
  .nav-item,
  .biz {
    justify-content: center;
    padding-left: 0;
    padding-right: 0;
    gap: 0;
  }
}
</style>
