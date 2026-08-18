<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { logout } from '../../api/auth';
import { forgetMyAccess } from '../../auth/access';
import { useSession } from '../../auth/session';
import { useTheme } from '../../design/theme';

/**
 * UI-08: global search, business date, avatar menu — plus the control that
 * collapses the sidebar.
 *
 * Two items §2.7 calls for are deliberately **not** here yet: the notification
 * bell (nothing emits a notification until later phases) and the cash-session
 * indicator (M19, Phase 6). Rendering either as a dead control would violate
 * UI-05; their space in the bar is what stays reserved, not a greyed icon. The
 * language selector is likewise absent — the UI is English with Bangla helper
 * text (UI-14), so there is nothing to switch.
 *
 * Search is rendered but disabled, with a title saying why — there is nothing
 * to search until products, parties and documents exist (slice 2.3 onward).
 */
defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ toggleSidebar: [] }>();

const { businessName, username, refreshToken, clear } = useSession();
const { theme, toggle: toggleTheme } = useTheme();
const router = useRouter();

const menuOpen = ref(false);
const menuRoot = ref<HTMLElement | null>(null);

function closeOnOutside(event: MouseEvent): void {
  if (menuRoot.value !== null && !menuRoot.value.contains(event.target as Node)) {
    menuOpen.value = false;
  }
}

onMounted(() => document.addEventListener('click', closeOnOutside));
onBeforeUnmount(() => document.removeEventListener('click', closeOnOutside));

/** Revokes the session server-side, then forgets it here (§5.3). */
async function signOut(): Promise<void> {
  const token = refreshToken.value;
  menuOpen.value = false;
  clear();
  forgetMyAccess();
  // Best effort: the device has already forgotten the session either way.
  if (token !== null) await logout(token).catch(() => undefined);
  await router.push('/login');
}

async function openSecurity(): Promise<void> {
  menuOpen.value = false;
  await router.push('/settings/security');
}

const initials = computed(() => {
  const name = (username.value ?? businessName.value ?? '').trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
});

/**
 * UI-33: the tenant-timezone business date, never a raw UTC instant. The tenant
 * timezone is fixed at Asia/Dhaka until Settings can change it (slice 1.5).
 */
const businessDate = computed(() =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date()),
);
</script>

<template>
  <header class="topbar">
    <button
      type="button"
      class="icon-btn hamburger"
      :aria-expanded="!collapsed"
      aria-label="Collapse or expand the sidebar"
      @click="emit('toggleSidebar')"
    >
      <i class="pi pi-bars" aria-hidden="true" />
    </button>

    <label class="search" title="Search arrives with products and parties">
      <i class="pi pi-search" aria-hidden="true" />
      <input
        type="search"
        placeholder="Search products, parties, documents"
        disabled
        aria-label="Global search"
      />
      <kbd>Ctrl K</kbd>
    </label>

    <div class="topbar-right">
      <div class="bizdate">
        <i class="pi pi-calendar" aria-hidden="true" />
        <span class="bizdate-text">
          <span class="bizdate-label">Business date</span>
          <span class="bizdate-value">{{ businessDate }}</span>
        </span>
      </div>

      <button
        type="button"
        class="icon-btn"
        :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="toggleTheme"
      >
        <i class="pi" :class="theme === 'dark' ? 'pi-sun' : 'pi-moon'" aria-hidden="true" />
      </button>

      <div ref="menuRoot" class="account">
        <button
          type="button"
          class="account-btn"
          :aria-expanded="menuOpen"
          aria-haspopup="menu"
          @click="menuOpen = !menuOpen"
        >
          <span class="avatar" aria-hidden="true">{{ initials }}</span>
          <span class="account-text">
            <strong>{{ username ?? 'Signed in' }}</strong>
            <span>{{ businessName ?? 'SherERP' }}</span>
          </span>
          <i class="pi pi-angle-down" aria-hidden="true" />
        </button>

        <div v-if="menuOpen" class="menu" role="menu">
          <button type="button" role="menuitem" class="menu-item" @click="openSecurity">
            <i class="pi pi-lock" aria-hidden="true" />
            Password &amp; PIN
          </button>
          <button type="button" role="menuitem" class="menu-item is-danger" @click="signOut()">
            <i class="pi pi-sign-out" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: var(--sher-space-4);
  padding: 12px 24px;
  background: var(--sher-headerbar);
  border-bottom: var(--sher-border-w) solid var(--sher-line);
}

.hamburger {
  flex-shrink: 0;
}

.search {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  max-width: 480px;
  height: var(--sher-control-h);
  padding: 0 14px;
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
}

.search .pi {
  color: var(--sher-text-faint);
  font-size: var(--sher-text-base);
}

.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: var(--sher-text-base);
  color: var(--sher-text);
}

.search input::placeholder {
  color: var(--sher-text-muted);
}

.search input:disabled {
  cursor: not-allowed;
}

.search kbd {
  font-family: var(--sher-font);
  font-size: var(--sher-text-2xs);
  font-weight: 600;
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius-sm);
  padding: 2px 6px;
  color: var(--sher-text-muted);
  background: var(--sher-raised);
}

.topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
}

.bizdate {
  display: flex;
  align-items: center;
  gap: 9px;
  height: var(--sher-control-h);
  padding: 0 14px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
}

.bizdate .pi {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-base);
}

.bizdate-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.bizdate-label {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
}

.bizdate-value {
  font-size: var(--sher-text-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------ account menu */
.account {
  position: relative;
}

.account-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--sher-control-h);
  padding: 0 10px 0 6px;
  border: 1px solid transparent;
  border-radius: var(--sher-radius);
  background: transparent;
  font: inherit;
  color: var(--sher-text);
  cursor: pointer;
  transition: background var(--sher-transition);
}

.account-btn:hover {
  background: var(--sher-hover);
}

.account-btn .pi-angle-down {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-xs);
}

.avatar {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--sher-tone-blue-fill);
  color: var(--sher-on-tone);
  display: grid;
  place-items: center;
  font-size: var(--sher-text-xs);
  font-weight: 700;
}

.account-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  text-align: left;
  min-width: 0;
}

.account-text strong {
  font-size: var(--sher-text-sm);
  font-weight: 600;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-text span {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  min-width: 200px;
  padding: 6px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-raised);
  box-shadow: var(--sher-shadow-raised);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: var(--sher-radius-sm);
  background: transparent;
  font: inherit;
  font-size: var(--sher-text-sm);
  color: var(--sher-text);
  text-align: left;
  cursor: pointer;
}

.menu-item .pi {
  font-size: var(--sher-text-base);
  color: var(--sher-text-muted);
}

.menu-item:hover {
  background: var(--sher-hover);
}

.menu-item.is-danger,
.menu-item.is-danger .pi {
  color: var(--sher-bad);
}

@media (max-width: 1023px) {
  .topbar {
    padding: 10px 16px;
  }

  .bizdate-label,
  .account-text,
  .search kbd {
    display: none;
  }
}
</style>
