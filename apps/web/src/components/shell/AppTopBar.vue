<script setup lang="ts">
import type { MenuItem } from 'primevue/menuitem';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Menu from 'primevue/menu';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { logout } from '../../api/auth';
import { forgetMyAccess } from '../../auth/access';
import { useSession } from '../../auth/session';
import { useTheme } from '../../design/theme';
import DayStatusChip from '../money/DayStatusChip.vue';
import OfflineStatusChip from '../offline/OfflineStatusChip.vue';

defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ toggleSidebar: [] }>();

const { businessName, username, refreshToken, clear } = useSession();
const { theme, toggle: toggleTheme } = useTheme();
const router = useRouter();
const accountMenu = ref<InstanceType<typeof Menu> | null>(null);

async function signOut(): Promise<void> {
  const token = refreshToken.value;
  clear();
  forgetMyAccess();
  if (token !== null) await logout(token).catch(() => undefined);
  await router.push('/login');
}

const initials = computed(() => {
  const words = (username.value ?? businessName.value ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
});

const businessDate = computed(() =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date()),
);

const accountItems = computed<MenuItem[]>(() => [
  {
    label: 'Password & PIN',
    icon: 'pi pi-lock',
    command: () => void router.push('/settings/security'),
  },
  { separator: true },
  {
    label: 'Sign out',
    icon: 'pi pi-sign-out',
    styleClass: 'sher-menu-danger',
    command: () => void signOut(),
  },
]);
</script>

<template>
  <header class="topbar">
    <Button
      v-tooltip.bottom="collapsed ? 'Open module navigation' : 'Collapse module navigation'"
      class="hamburger"
      icon="pi pi-bars"
      text
      rounded
      :aria-expanded="!collapsed"
      aria-label="Open or collapse module navigation"
      @click="emit('toggleSidebar')"
    />

    <label class="search" title="Search arrives with products and parties">
      <i class="pi pi-search" aria-hidden="true" />
      <InputText
        type="search"
        placeholder="Search products, parties, documents"
        disabled
        aria-label="Global search"
      />
      <kbd>Ctrl K</kbd>
    </label>

    <div class="topbar-right">
      <!--
        The day chip (owner decision 2026-08-24). On every screen because
        whether the day is open is what a cashier most often needs to know and
        most easily forgets — and the fix is the chip itself, so nobody leaves
        the counter to start or close the day.
      -->
      <DayStatusChip />

      <!--
        Phase 12.1 (owner decision 2026-08-31). Beside the day chip and for the
        same reason: whether this machine is ready to work without internet is a
        fact about the machine, and a shop that finds it out during a power cut
        has found out too late.
      -->
      <OfflineStatusChip />

      <div class="bizdate">
        <i class="pi pi-calendar" aria-hidden="true" />
        <span class="bizdate-text">
          <span class="bizdate-label">Business date</span>
          <span class="bizdate-value">{{ businessDate }}</span>
        </span>
      </div>

      <Button
        v-tooltip.bottom="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        :icon="theme === 'dark' ? 'pi pi-sun' : 'pi pi-moon'"
        text
        rounded
        :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="toggleTheme"
      />

      <Button
        v-tooltip.bottom="'Open account menu'"
        class="account-trigger"
        text
        aria-haspopup="menu"
        aria-label="Open account menu"
        @click="accountMenu?.toggle($event)"
      >
        <span class="avatar" aria-hidden="true">{{ initials }}</span>
        <span class="account-text">
          <strong>{{ username ?? 'Signed in' }}</strong>
          <span>{{ businessName ?? 'SherERP' }}</span>
        </span>
        <i class="pi pi-angle-down" aria-hidden="true" />
      </Button>
      <Menu ref="accountMenu" :model="accountItems" popup />
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
  padding: 0 12px;
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
}

.search > .pi {
  color: var(--sher-text-faint);
}

.search :deep(.p-inputtext) {
  flex: 1;
  min-width: 0;
  height: auto;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
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
  gap: var(--sher-space-2);
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

.bizdate > .pi {
  color: var(--sher-text-muted);
}

.bizdate-text,
.account-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  text-align: left;
  min-width: 0;
}

.bizdate-label,
.account-text span {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
}

.bizdate-value,
.account-text strong {
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.bizdate-value {
  font-variant-numeric: tabular-nums;
}

:deep(.account-trigger) {
  padding: 4px 8px 4px 4px;
  color: var(--sher-text);
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

.account-text strong,
.account-text span {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

@media (max-width: 767px) {
  .topbar {
    gap: var(--sher-space-2);
    padding: 8px 10px;
  }

  .search,
  .bizdate {
    display: none;
  }
}
</style>

<style>
.sher-menu-danger .p-menu-item-link,
.sher-menu-danger .p-menu-item-icon {
  color: var(--sher-bad);
}
</style>
