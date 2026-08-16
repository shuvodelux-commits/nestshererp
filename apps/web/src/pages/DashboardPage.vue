<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { fetchDashboardSummary } from '../api/auth';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * The dashboard after slice 1.1 — deliberately empty.
 *
 * UI-29: an empty state says what the screen would contain and links to the
 * action that creates the first record. Inventing Today's Sales, Due Collection
 * and Low Stock cards with placeholder figures would be worse than showing
 * nothing: those numbers arrive in Phase 9 (slice 9.6) derived from journal
 * lines and stock movements (INV-10), and a dashboard that ever disagreed with
 * the ledger is the exact failure that invariant exists to prevent.
 *
 * UI-27: loading, empty and error states are all implemented; the router guard
 * covers the unauthenticated case.
 */
const { accessToken, businessName } = useSession();

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const summary = await fetchDashboardSummary(accessToken.value ?? '');
    businessName.value = summary.businessName;
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const planned = [
  { label: "Today's sales", when: 'Sales & POS', phase: '6' },
  { label: 'Due collection', when: 'Customer payments', phase: '6' },
  { label: 'Payables', when: 'Purchases', phase: '5' },
  { label: 'Cash in drawer', when: 'Cash & day session', phase: '4' },
  { label: 'Low stock', when: 'Inventory', phase: '3' },
] as const;
</script>

<template>
  <AppShell title="Dashboard" help-bn="আজকের বিক্রি, হাতে থাকা নগদ আর স্টকের অবস্থা এক জায়গায়">
    <!-- Loading: skeleton rows, not a bare spinner (UI-27). -->
    <div v-if="loading" class="skeleton-wrap" aria-busy="true" aria-label="Loading dashboard">
      <div class="skeleton skeleton-lg" />
      <div class="skeleton" />
    </div>

    <!-- Error: the server's own code and message, plus a retry (UI-28). -->
    <AppCard v-else-if="error !== null" title="Could not load your dashboard">
      <p class="error-code">{{ error.code }}</p>
      <p class="error-message">{{ error.message }}</p>
      <button type="button" class="btn btn-ghost" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">▤</div>
        <h2>Nothing recorded yet</h2>
        <p>
          <strong>{{ businessName }}</strong> is set up and ready. This is where
          today's sales, cash position and low-stock alerts will appear once you
          start trading.
        </p>
        <p class="empty-foot">
          There is nothing to add yet — products, customers and sales each arrive
          with the module that records them.
        </p>
      </div>

      <AppCard
        title="What will appear here"
        subtitle="Each figure arrives with the module that produces it, calculated from your ledger — never estimated."
      >
        <ul class="planned">
          <li v-for="item in planned" :key="item.label">
            <span class="planned-label">{{ item.label }}</span>
            <span class="planned-when">{{ item.when }}</span>
            <span class="phase">Phase {{ item.phase }}</span>
          </li>
        </ul>
      </AppCard>
    </template>
  </AppShell>
</template>

<style scoped>
.skeleton-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton {
  height: 120px;
  border-radius: var(--sher-radius-lg);
  border: 1px solid var(--sher-line);
  background: linear-gradient(
    100deg,
    var(--sher-surface-3) 30%,
    var(--sher-surface-2) 50%,
    var(--sher-surface-3) 70%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

.skeleton-lg {
  height: 190px;
}

@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

.empty {
  border: 1px dashed var(--sher-line);
  border-radius: var(--sher-radius-lg);
  background: var(--sher-surface-3);
  padding: 36px 30px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
}

.empty-mark {
  width: 42px;
  height: 42px;
  border-radius: var(--sher-radius);
  background: var(--sher-primary-soft);
  color: var(--sher-primary-strong);
  display: grid;
  place-items: center;
  font-size: 19px;
  margin-bottom: 2px;
}

.empty h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
}

.empty p {
  margin: 0;
  max-width: 52ch;
  color: var(--sher-text-muted);
}

.empty p strong {
  color: var(--sher-text);
  font-weight: 600;
}

.empty-foot {
  margin-top: 6px !important;
  padding-top: 10px;
  border-top: 1px solid var(--sher-line-soft);
  font-size: 11px;
}

.planned {
  list-style: none;
  margin: 0;
  padding: 0;
}

.planned li {
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  padding: var(--sher-row-pad);
  padding-left: 0;
  padding-right: 0;
  border-bottom: 1px solid var(--sher-line-soft);
}

.planned li:last-child {
  border-bottom: 0;
}

.planned-label {
  font-weight: 600;
}

.planned-when {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
}

.phase {
  margin-left: auto;
  font-family: var(--sher-font-mono);
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
  border: 1px solid var(--sher-line);
  border-radius: 3px;
  padding: 1px 6px;
  white-space: nowrap;
}

.error-code {
  margin: 0;
  font-family: var(--sher-font-mono);
  font-size: var(--sher-text-2xs);
  letter-spacing: 0.04em;
  color: var(--sher-bad);
}

.error-message {
  margin: var(--sher-space-2) 0 var(--sher-space-4);
  color: var(--sher-text-muted);
}

.btn {
  height: var(--sher-control-h);
  padding: 0 16px;
  border-radius: var(--sher-radius);
  font: inherit;
  font-size: var(--sher-text-base);
  font-weight: 600;
  cursor: pointer;
}

.btn-ghost {
  background: var(--sher-surface-3);
  color: var(--sher-text);
  border: 1px solid var(--sher-line);
}

.btn-ghost:hover {
  background: var(--sher-surface-2);
}
</style>
