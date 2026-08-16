<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';

/**
 * UI-08: left sidebar of modules. UI-10: one level deep.
 *
 * It holds exactly one destination, because exactly one module exists. The
 * permission-filtered generation UI-09 requires becomes meaningful once roles
 * exist (slice 1.4) and there is more than one thing to hide — adding the
 * machinery now would mean writing it against a list of one.
 *
 * The sidebar is a translucent layer over the same background as the content,
 * not a dark block bolted to the side.
 */
const route = useRoute();

const items = [{ label: 'Dashboard', icon: 'pi-home', to: '/dashboard' }] as const;
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="mark">S</span>
      <span class="name">SherERP</span>
    </div>

    <nav aria-label="Modules">
      <ul>
        <li v-for="item in items" :key="item.to">
          <RouterLink
            :to="item.to"
            class="link"
            :class="{ active: route.path === item.to }"
            :aria-current="route.path === item.to ? 'page' : undefined"
          >
            <i :class="['pi', item.icon]" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </li>
      </ul>
    </nav>

    <p class="footnote">
      More modules appear here as they are built — products, sales, inventory and
      accounting each arrive in their own release.
    </p>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sher-sidebar-width);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
  padding: var(--sher-space-5) var(--sher-space-4);
  background: var(--sher-glass-bg);
  backdrop-filter: blur(var(--sher-glass-blur));
  -webkit-backdrop-filter: blur(var(--sher-glass-blur));
  border-right: 1px solid var(--sher-border-glass);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  padding: 0 var(--sher-space-2);
}

.mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--sher-radius-sm);
  background: linear-gradient(135deg, var(--sher-primary), var(--sher-primary-dark));
  color: var(--sher-text-inverse);
  font-weight: 700;
}

.name {
  font-size: var(--sher-text-lg);
  font-weight: 650;
  letter-spacing: -0.01em;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-1);
}

.link {
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  padding: 10px var(--sher-space-3);
  border-radius: var(--sher-radius-sm);
  color: var(--sher-text);
  text-decoration: none;
  font-weight: 500;
  transition: background var(--sher-transition), color var(--sher-transition);
}

.link:hover {
  background: rgba(255, 255, 255, 0.6);
}

/* A subtle active state, not a heavy coloured block. */
.link.active {
  background: var(--sher-primary-soft);
  color: var(--sher-primary-dark);
  font-weight: 600;
}

.footnote {
  margin: auto 0 0;
  padding: 0 var(--sher-space-2);
  font-size: var(--sher-text-xs);
  line-height: 1.6;
  color: var(--sher-text-muted);
}

/* UI-11: the sidebar collapses on tablet; the same destinations, same order. */
@media (max-width: 1023px) {
  .sidebar {
    width: 68px;
    padding: var(--sher-space-5) var(--sher-space-2);
  }

  .name,
  .footnote {
    display: none;
  }

  .link {
    justify-content: center;
  }

  .link span {
    display: none;
  }
}
</style>
