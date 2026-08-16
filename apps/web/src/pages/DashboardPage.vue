<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { fetchDashboardSummary } from '../api/auth';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppShell from '../components/shell/AppShell.vue';
import GlassCard from '../components/GlassCard.vue';

/**
 * The dashboard after slice 1.1 — deliberately empty.
 *
 * UI-29: an empty state says what the screen will contain and links to the
 * action that creates the first record. There is no such action yet, so it says
 * so plainly. Inventing Today's Sales, Due Collection and Low Stock cards with
 * placeholder figures would be worse than showing nothing: those numbers arrive
 * in Phase 9 (slice 9.6) derived from journal lines and stock movements
 * (INV-10), and a dashboard that ever disagreed with the ledger is the exact
 * failure the invariant exists to prevent.
 *
 * UI-27: all four states are implemented — loading, empty, error and the
 * permission-denied/unauthenticated case the router guard handles.
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
  { icon: 'pi-shopping-cart', label: "Today's sales", when: 'Sales & POS' },
  { icon: 'pi-wallet', label: 'Due collection', when: 'Sales & payments' },
  { icon: 'pi-credit-card', label: 'Payables', when: 'Purchase' },
  { icon: 'pi-box', label: 'Low stock', when: 'Inventory' },
] as const;
</script>

<template>
  <AppShell>
    <!-- Loading: a skeleton, not a bare spinner (UI-27). -->
    <div v-if="loading" class="grid" aria-busy="true" aria-label="Loading dashboard">
      <div v-for="n in 2" :key="n" class="skeleton" />
    </div>

    <!-- Error: the server's own code and message, plus a retry (UI-28). -->
    <GlassCard v-else-if="error !== null" title="Could not load your dashboard">
      <p class="error-code">{{ error.code }}</p>
      <p class="error-message">{{ error.message }}</p>
      <button type="button" class="retry" @click="load">Try again</button>
    </GlassCard>

    <div v-else class="grid">
      <GlassCard>
        <p class="eyebrow">Signed in to</p>
        <h1 class="business">{{ businessName }}</h1>
        <p class="welcome">
          Your business is set up. There is nothing to report yet because no
          products, sales or purchases have been recorded.
        </p>
      </GlassCard>

      <GlassCard
        title="What will appear here"
        subtitle="Each figure arrives with the module that produces it, calculated from your ledger — never estimated."
      >
        <ul class="planned">
          <li v-for="item in planned" :key="item.label">
            <i :class="['pi', item.icon]" aria-hidden="true" />
            <span class="planned-label">{{ item.label }}</span>
            <span class="planned-when">{{ item.when }}</span>
          </li>
        </ul>
      </GlassCard>
    </div>
  </AppShell>
</template>

<style scoped>
.grid {
  display: grid;
  gap: var(--sher-space-5);
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  align-items: start;
  max-width: 1100px;
}

.skeleton {
  height: 190px;
  border-radius: var(--sher-radius);
  background: linear-gradient(
    100deg,
    rgba(255, 255, 255, 0.4) 30%,
    rgba(255, 255, 255, 0.75) 50%,
    rgba(255, 255, 255, 0.4) 70%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
  border: 1px solid var(--sher-border-glass);
}

@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

.eyebrow {
  margin: 0;
  font-size: var(--sher-text-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sher-text-muted);
}

.business {
  margin: var(--sher-space-2) 0 var(--sher-space-3);
  font-size: var(--sher-text-2xl);
  font-weight: 680;
  letter-spacing: -0.02em;
}

.welcome {
  margin: 0;
  color: var(--sher-text-muted);
  line-height: 1.6;
}

.planned {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.planned li {
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  padding: var(--sher-space-3) 0;
  border-bottom: 1px solid var(--sher-border);
}

.planned li:last-child {
  border-bottom: none;
}

.planned i {
  color: var(--sher-primary);
}

.planned-label {
  flex: 1;
  font-weight: 550;
}

.planned-when {
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.error-code {
  margin: 0;
  font-size: var(--sher-text-xs);
  letter-spacing: 0.05em;
  color: var(--sher-danger);
}

.error-message {
  margin: var(--sher-space-2) 0 var(--sher-space-4);
  color: var(--sher-text-muted);
}

.retry {
  padding: 9px var(--sher-space-4);
  border: 1px solid var(--sher-border);
  border-radius: var(--sher-radius-sm);
  background: #ffffff;
  font: inherit;
  font-weight: 550;
  cursor: pointer;
}
</style>
