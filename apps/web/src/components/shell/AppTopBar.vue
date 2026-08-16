<script setup lang="ts">
import { computed } from 'vue';

import { useSession } from '../../auth/session';

/**
 * UI-08: global search, business date, avatar menu.
 *
 * Two items §2.7 calls for are deliberately **not** here yet: the notification
 * bell (nothing emits a notification until later phases) and the cash-session
 * indicator (M19, Phase 6). Rendering either as a dead control would violate
 * UI-05; their space in the bar is what stays reserved, not a greyed icon.
 *
 * Search is rendered but disabled, with a title saying why — there is nothing
 * to search until products, parties and documents exist (slice 2.3 onward).
 */
const { businessName, signOut } = useSession();

const initials = computed(() => {
  const words = (businessName.value ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  const first = words[0]?.charAt(0) ?? '';
  const second = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + second).toUpperCase();
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
    <label class="search" title="Search arrives with products and parties">
      <span class="ico" aria-hidden="true">⌕</span>
      <input
        type="search"
        placeholder="Search products, parties, documents"
        disabled
        aria-label="Global search"
      />
      <kbd>/</kbd>
    </label>

    <div class="topbar-right">
      <div class="bizdate">
        <span class="bizdate-label">Business date</span>
        <span class="bizdate-value">{{ businessDate }}</span>
      </div>

      <div class="avatar-group">
        <span class="avatar" aria-hidden="true">{{ initials }}</span>
        <span class="avatar-name">{{ businessName ?? 'SherERP' }}</span>
      </div>

      <button type="button" class="sign-out" @click="signOut()">Sign out</button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 9px 18px;
  background: var(--sher-headerbar);
  border-bottom: var(--sher-border-w) solid var(--sher-line);
}

.search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 460px;
  height: var(--sher-control-h);
  padding: 0 10px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface-3);
}

.search .ico {
  color: var(--sher-text-muted);
  font-size: 14px;
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
  font-family: var(--sher-font-mono);
  font-size: var(--sher-text-2xs);
  border: 1px solid var(--sher-line);
  border-radius: 3px;
  padding: 1px 5px;
  color: var(--sher-text-muted);
  background: var(--sher-surface-2);
}

.topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 18px;
}

.bizdate {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  text-align: right;
}

.bizdate-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sher-text-muted);
}

.bizdate-value {
  font-size: var(--sher-text-base);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.avatar-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.avatar {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--sher-primary);
  color: var(--sher-on-primary);
  display: grid;
  place-items: center;
  font-size: var(--sher-text-2xs);
  font-weight: 700;
}

.avatar-name {
  font-size: var(--sher-text-base);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sign-out {
  height: var(--sher-control-h);
  padding: 0 12px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface-3);
  font: inherit;
  font-size: var(--sher-text-base);
  font-weight: 600;
  color: var(--sher-text);
  cursor: pointer;
  transition: background var(--sher-transition);
}

.sign-out:hover {
  background: var(--sher-surface-2);
}

@media (max-width: 767px) {
  .bizdate,
  .avatar-name,
  .search kbd {
    display: none;
  }
}
</style>
