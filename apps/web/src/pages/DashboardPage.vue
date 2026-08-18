<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { fetchDashboardSummary } from '../api/auth';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import type { StatTone } from '../design/tones';

/**
 * The dashboard after slice 1.1 — deliberately without figures.
 *
 * UI-29: an empty state says what the screen would contain and links to the
 * action that creates the first record. Filling the six summary tiles with
 * placeholder figures would be worse than showing none: those numbers arrive in
 * Phase 9 (slice 9.6) derived from journal lines and stock movements (INV-10),
 * and a dashboard that ever disagreed with the ledger is the exact failure that
 * invariant exists to prevent. What the tiles *will* be — their wording, tone
 * and order — is listed below instead, which costs nothing and promises nothing.
 *
 * UI-27: loading, empty and error states are all implemented; the router guard
 * covers the unauthenticated case.
 */
const { accessToken, businessName, setBusinessName } = useSession();

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const summary = await fetchDashboardSummary(accessToken.value ?? '');
    setBusinessName(summary.businessName);
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

/**
 * The six tiles this screen will carry, in the order and tone §2.7.I assigns
 * them. Listing the tone here is not decoration: it is the record of which
 * colour means what, so slice 9.6 renders the same tile the shopkeeper was
 * promised rather than picking a colour again.
 */
const planned: readonly { label: string; icon: string; tone: StatTone; when: string; phase: string }[] = [
  { label: "Today's sales", icon: 'pi-shopping-bag', tone: 'blue', when: 'Sales & POS', phase: '6' },
  { label: "Today's purchases", icon: 'pi-shopping-cart', tone: 'slate', when: 'Purchases', phase: '5' },
  { label: 'Gross profit', icon: 'pi-chart-bar', tone: 'green', when: 'Costing', phase: '9' },
  { label: 'Low and out of stock', icon: 'pi-box', tone: 'amber', when: 'Inventory', phase: '3' },
  { label: 'Due collection', icon: 'pi-users', tone: 'violet', when: 'Customer payments', phase: '6' },
  { label: 'Payable amount', icon: 'pi-wallet', tone: 'rose', when: 'Supplier payments', phase: '5' },
];
</script>

<template>
  <AppShell
    title="Dashboard"
    help-bn="আজকের বিক্রি, হাতে থাকা নগদ আর স্টকের অবস্থা এক জায়গায়"
  >
    <!-- Loading: skeleton blocks in the shape of the real screen (UI-27). -->
    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading dashboard">
      <div class="skeleton skeleton-tiles" />
      <div class="skeleton skeleton-panel" />
    </div>

    <!-- Error: the server's own code and message, plus a retry (UI-28). -->
    <AppCard v-else-if="error !== null" title="Could not load your dashboard">
      <ErrorNotice :code="error.code" :message="error.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <EmptyState icon="pi-chart-line" title="Nothing recorded yet">
        <strong>{{ businessName }}</strong> is set up and ready. This is where
        today's sales, cash position and low-stock alerts will appear once you
        start trading. There is nothing to add yet — products, customers and
        sales each arrive with the module that records them.
      </EmptyState>

      <AppCard
        title="What will appear here"
        subtitle="Each figure arrives with the module that produces it, calculated from your ledger — never estimated."
      >
        <ul class="planned">
          <li v-for="item in planned" :key="item.label" :class="`tone-${item.tone}`">
            <span class="planned-disc" aria-hidden="true">
              <i class="pi" :class="item.icon" />
            </span>
            <span class="planned-text">
              <strong>{{ item.label }}</strong>
              <span>{{ item.when }}</span>
            </span>
            <span class="pill">Phase {{ item.phase }}</span>
          </li>
        </ul>
      </AppCard>
    </template>
  </AppShell>
</template>

<style scoped>
.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton-tiles {
  height: 118px;
}

.skeleton-panel {
  height: 300px;
}

.retry {
  margin-top: var(--sher-space-4);
}

/* The tiles-to-be, as a list. Same tones, a third of the ink. */
.planned {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--sher-space-3);
}

.planned li {
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  padding: 12px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
}

.planned-disc {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--sher-radius-sm);
  background: var(--sher-tone-fill);
  color: var(--sher-on-tone);
  font-size: var(--sher-text-base);
}

.planned-text {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  min-width: 0;
}

.planned-text strong {
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.planned-text span {
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.planned .pill {
  margin-left: auto;
}

.tone-blue {
  --sher-tone-fill: var(--sher-tone-blue-fill);
}

.tone-slate {
  --sher-tone-fill: var(--sher-tone-slate-fill);
}

.tone-green {
  --sher-tone-fill: var(--sher-tone-green-fill);
}

.tone-amber {
  --sher-tone-fill: var(--sher-tone-amber-fill);
}

.tone-violet {
  --sher-tone-fill: var(--sher-tone-violet-fill);
}

.tone-rose {
  --sher-tone-fill: var(--sher-tone-rose-fill);
}
</style>
