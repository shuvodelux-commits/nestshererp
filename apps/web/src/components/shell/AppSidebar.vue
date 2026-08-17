<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { useSession } from '../../auth/session';

/**
 * UI-08: left sidebar of modules. UI-10: one level deep.
 *
 * A **light** sidebar, following the desktop convention — the accent colour is
 * spent on the selected row and nothing else. Not a dark rail.
 *
 * UI-09: navigation is generated from the permission-filtered feature list —
 * never render a control that will 403. Modules that do not exist yet are
 * therefore **absent**, not greyed out: a disabled item is still a rendered
 * control. The list grows as each slice ships it; the permission filtering
 * becomes real machinery once roles exist (slice 1.4).
 */
const route = useRoute();
const session = useSession();
const { businessName } = session;

/**
 * `needs` is the permission that makes a destination reachable. An entry with
 * none is reachable by anyone signed in — the dashboard shows only your own
 * business name, and Security only ever edits your own credentials.
 */
const items = [
  { label: 'Dashboard', icon: '▤', to: '/dashboard', slice: '1.1', needs: null },
  { label: 'Users', icon: '◑', to: '/users', slice: '1.3', needs: 'user.account.view' },
  { label: 'Roles', icon: '◈', to: '/roles', slice: '1.4', needs: 'user.role.view' },
  // Security is the whole of Settings today. The rest of §5.21 — costing method,
  // negative stock policy, terminology, numbering — arrives in slice 1.5, and
  // listing those names now would render controls that 403 (UI-09).
  { label: 'Security', icon: '⚿', to: '/settings/security', slice: '1.2b', needs: null },
] as const;

/**
 * UI-09: "Never render a control that will 403." A destination the caller cannot
 * open is **absent**, not greyed — a disabled item is still a rendered control,
 * and it advertises a feature they cannot use.
 */
const visible = computed(() =>
  items.filter((item) => item.needs === null || session.can(item.needs)),
);
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark">S</span>
      <span class="brand-text">
        <strong>SherERP</strong>
        <span>{{ businessName ?? '—' }}</span>
      </span>
    </div>

    <nav class="nav" aria-label="Modules">
      <RouterLink
        v-for="item in visible"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :class="{ 'is-current': route.path === item.to }"
        :aria-current="route.path === item.to ? 'page' : undefined"
      >
        <span class="ico" aria-hidden="true">{{ item.icon }}</span>
        {{ item.label }}
        <span class="slice">{{ item.slice }}</span>
      </RouterLink>
    </nav>

    <div class="sidebar-foot">
      <p class="absent-note">
        Users, roles, the rest of settings and the audit trail appear here as each is built.
        Products, sales, POS and inventory follow in later phases.
      </p>
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
  padding: 0 0 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 14px 16px;
}

.brand-mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: var(--sher-radius);
  background: var(--sher-primary);
  color: var(--sher-on-primary);
  font-weight: 700;
  font-size: 14px;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}

.brand-text strong {
  font-size: 14px;
  letter-spacing: 0.01em;
}

.brand-text span {
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: var(--sher-nav-pad);
  border-radius: var(--sher-radius);
  color: var(--sher-text);
  text-decoration: none;
  font-size: var(--sher-text-base);
  transition: background var(--sher-transition);
}

.nav-item:hover {
  background: rgba(31, 36, 41, 0.08);
}

.nav-item.is-current {
  background: var(--sher-primary);
  color: var(--sher-on-primary);
  font-weight: 600;
}

.ico {
  width: 16px;
  text-align: center;
  opacity: 0.75;
  font-size: 12px;
}

.slice {
  margin-left: auto;
  font-family: var(--sher-font-mono);
  font-size: 10px;
  color: var(--sher-text-muted);
  border: 1px solid var(--sher-line);
  border-radius: 3px;
  padding: 0 4px;
}

.nav-item.is-current .slice {
  color: var(--sher-on-primary);
  border-color: rgba(255, 255, 255, 0.45);
}

.sidebar-foot {
  margin-top: auto;
  padding: 14px 14px 0;
}

.absent-note {
  margin: 0;
  padding-top: 11px;
  border-top: 1px solid var(--sher-line);
  font-size: 11px;
  line-height: 1.5;
  color: var(--sher-text-muted);
}

/* UI-11: the same destinations, the same order, collapsed to icons on tablet. */
@media (max-width: 1023px) {
  .sidebar {
    width: 56px;
  }

  .brand-text,
  .sidebar-foot,
  .slice {
    display: none;
  }

  .nav-item {
    justify-content: center;
    font-size: 0;
    gap: 0;
  }

  .ico {
    font-size: 14px;
  }
}
</style>
