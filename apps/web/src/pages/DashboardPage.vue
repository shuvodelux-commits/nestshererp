<script setup lang="ts">
import type { DashboardResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { fetchDashboardCards, saveTarget } from '../api/reports';
import { useSession } from '../auth/session';
import { onDataChanged } from '../state/data-freshness';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatCard from '../components/StatCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import { fetchBackupStatus } from '../api/backup';
import ProfitTargetDialog from '../components/reports/ProfitTargetDialog.vue';
import { taka } from '../components/money/money-text';

/**
 * The dashboard, with real figures at last (§5.20, Phase 9).
 *
 * **A fixed card set, permission-gated** (owner decision 2026-08-30) — no
 * arrangement screen, nothing to configure. A card the user may not see is
 * **absent from the server's response**, not hidden here (UI-40): this screen
 * renders what it was sent, so a cashier reading the network tab finds no
 * profit in it.
 *
 * Every figure is journal-derived (INV-10) and nothing on this page is
 * computed in Vue. The profit card carries D-06's honesty rule: while any sale
 * in the day is still costed provisionally the card says so, rather than
 * presenting a half-costed profit as final.
 */
const { accessToken, businessName, setBusinessName, can } = useSession();
const router = useRouter();

const cards = ref<DashboardResponse | null>(null);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const editingTarget = ref(false);

/**
 * The two backup warnings (Phase 10, owner decision 2026-08-30).
 *
 * Loaded separately and allowed to fail silently: this is the shop's opening
 * screen, and a backup status that could not be read must never be the reason
 * the dashboard does not appear. Only the Owner holds `backup.export`, so only
 * the Owner is ever shown them — which is also who can act on either.
 *
 * The wording is the rule the owner set: nothing claims a copy is safely off
 * this computer, because nothing has confirmed that it is. It says what is
 * true — no copy has been downloaded from this server.
 */
const backupOverdue = ref(false);
const backupFailing = ref(false);

async function loadBackupWarnings(): Promise<void> {
  const token = accessToken.value;
  if (token === null) return;
  try {
    const status = await fetchBackupStatus(token);
    backupOverdue.value = status.manualExportOverdue;
    backupFailing.value = status.automaticFailing || !status.secretConfigured;
  } catch {
    backupOverdue.value = false;
    backupFailing.value = false;
  }
}

const canSetTarget = computed(() => can('report.target.manage'));
const hasAnyFigure = computed(() => {
  const data = cards.value;
  if (data === null) return false;
  return (
    data.todaySalesMinor !== undefined ||
    data.cashInHandMinor !== undefined ||
    data.stockValueMinor !== undefined ||
    data.lowStockCount !== undefined
  );
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await fetchDashboardCards(accessToken.value ?? '');
    cards.value = data;
    setBusinessName(data.businessName);
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    loading.value = false;
  }
}

async function onSaveTarget(basis: 'PROFIT' | 'SALES', amountMinor: number): Promise<void> {
  const token = accessToken.value;
  const month = cards.value?.businessDate.slice(0, 7) ?? '';
  if (token === null || month === '') return;
  await saveTarget(token, { month, basis, amountMinor });
  editingTarget.value = false;
  await load();
}

onMounted(load);
onMounted(loadBackupWarnings);
// Any posting anywhere refreshes what this screen is showing.
onDataChanged(load);
</script>

<template>
  <AppShell
    title="Dashboard"
    help-bn="আজকের বিক্রি, হাতে থাকা নগদ আর স্টকের অবস্থা এক জায়গায়"
  >
    <RouterLink v-if="backupFailing" to="/settings/backup" class="dash-warn dash-warn--bad">
      <strong>The automatic backup is not working.</strong>
      Open Backup and fix it — until then this shop has no nightly copy of its books.
      <span class="dash-warn__bn">রাতের ব্যাকআপ হচ্ছে না।</span>
    </RouterLink>

    <RouterLink v-else-if="backupOverdue" to="/settings/backup" class="dash-warn dash-warn--warn">
      <strong>No backup has been downloaded from this computer in the last 7 days.</strong>
      A copy that only exists here is lost with this computer.
      <span class="dash-warn__bn">এই কম্পিউটার থেকে ব্যাকআপ নামানো হয়নি।</span>
    </RouterLink>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading dashboard">
      <div class="skeleton skeleton-tiles" />
      <div class="skeleton skeleton-panel" />
    </div>

    <AppCard v-else-if="error !== null" title="Could not load your dashboard">
      <ErrorNotice :code="error.code" :message="error.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else-if="cards !== null">
      <EmptyState v-if="!hasAnyFigure" icon="pi-chart-line" title="Nothing recorded yet">
        <strong>{{ businessName }}</strong> is set up and ready. Today's sales, cash position and
        low-stock count appear here as soon as you start trading.
      </EmptyState>

      <template v-else>
        <div class="dash__tiles">
          <StatCard
            v-if="cards.todaySalesMinor !== undefined"
            label="Today's sales"
            :value="taka(cards.todaySalesMinor)"
            :detail="`${cards.todaySaleCount ?? 0} bills · আজকের বিক্রি`"
            icon="pi-shopping-bag"
            tone="blue"
            filled
          />
          <StatCard
            v-if="cards.todayProfitMinor !== undefined"
            label="Today's profit"
            :value="taka(cards.todayProfitMinor)"
            :detail="cards.profitProvisional === true ? 'not final yet — হিসাব চলছে' : 'আজকের লাভ'"
            icon="pi-chart-line"
            :tone="cards.profitProvisional === true ? 'amber' : 'green'"
            filled
          />
          <StatCard
            v-if="cards.cashInHandMinor !== undefined"
            label="Cash in hand"
            :value="taka(cards.cashInHandMinor)"
            detail="হাতে নগদ"
            icon="pi-wallet"
            tone="green"
          />
          <StatCard
            v-if="cards.bankBalanceMinor !== undefined"
            label="Bank & bKash"
            :value="taka(cards.bankBalanceMinor)"
            detail="ব্যাংকে জমা"
            icon="pi-building-columns"
            tone="blue"
          />
          <StatCard
            v-if="cards.stockValueMinor !== undefined"
            label="Stock value"
            :value="taka(cards.stockValueMinor)"
            detail="স্টকের মূল্য"
            icon="pi-box"
            tone="slate"
          />
          <StatCard
            v-if="cards.customerDueMinor !== undefined"
            label="Customers owe"
            :value="taka(cards.customerDueMinor)"
            detail="কাস্টমারের বাকি"
            icon="pi-users"
            tone="violet"
          />
          <StatCard
            v-if="cards.supplierPayableMinor !== undefined"
            label="Shop owes"
            :value="taka(cards.supplierPayableMinor)"
            detail="সাপ্লায়ারকে দেনা"
            icon="pi-truck"
            tone="rose"
          />
          <StatCard
            v-if="cards.lowStockCount !== undefined"
            label="Running out"
            :value="String(cards.lowStockCount)"
            detail="কম আছে এমন পণ্য"
            icon="pi-exclamation-triangle"
            tone="amber"
          />
        </div>

        <!-- The month's target and where it is heading (§5.20, O-10). -->
        <AppCard
          v-if="cards.target !== undefined"
          title="This month"
          subtitle="মাসের লক্ষ্য ও অগ্রগতি"
        >
          <div class="dash__target">
            <div>
              <p class="dash__target-label">
                {{ cards.target.basis === 'SALES' ? 'Sales so far' : 'Profit so far' }}
              </p>
              <p class="dash__target-value">{{ taka(cards.target.actualMinor) }}</p>
              <p class="dash__target-note">
                day {{ cards.target.elapsedDays }} of {{ cards.target.daysInMonth }}
              </p>
            </div>
            <div>
              <p class="dash__target-label">Target</p>
              <p class="dash__target-value">
                {{ cards.target.targetMinor === null ? 'not set' : taka(cards.target.targetMinor) }}
              </p>
              <p v-if="cards.target.achievedBp !== null" class="dash__target-note">
                {{ Math.trunc(cards.target.achievedBp / 100) }}% reached
              </p>
            </div>
            <div>
              <p class="dash__target-label">Heading for (estimate)</p>
              <p class="dash__target-value dash__estimate">{{ taka(cards.target.projectedMinor) }}</p>
              <p class="dash__target-note">
                at the current daily rate — এটি আন্দাজ, পাকা হিসাব নয়
              </p>
            </div>
            <Button
              v-if="canSetTarget"
              label="Set target"
              icon="pi pi-flag"
              text
              size="small"
              @click="editingTarget = true"
            />
          </div>
        </AppCard>

        <AppCard
          v-if="cards.recentSales !== undefined && cards.recentSales.length > 0"
          title="Recent sales"
          subtitle="শেষ কয়েকটি বিক্রি"
        >
          <ul class="dash__recent">
            <li v-for="sale in cards.recentSales" :key="sale.id">
              <button type="button" class="dash__link" @click="router.push(`/sales/${sale.id}`)">
                {{ sale.number }}
              </button>
              <span>{{ sale.customerName }}</span>
              <strong>{{ taka(sale.grandTotalMinor) }}</strong>
            </li>
          </ul>
        </AppCard>
      </template>
    </template>

    <ProfitTargetDialog
      v-if="editingTarget && cards !== null"
      :month="cards.businessDate.slice(0, 7)"
      :current="cards.target ?? null"
      @close="editingTarget = false"
      @save="onSaveTarget"
    />
  </AppShell>
</template>

<style scoped>
.dash-warn {
  display: block;
  padding: 0.7rem 0.9rem;
  border-radius: var(--sher-radius);
  line-height: 1.5;
  text-decoration: none;
  color: inherit;
}

.dash-warn__bn {
  display: block;
  margin-top: 0.2rem;
  font-family: var(--sher-font-bn);
  font-size: var(--sher-text-xs);
  opacity: 0.85;
}

.dash-warn--bad {
  background: var(--sher-danger-soft, #fee2e2);
  color: var(--sher-danger-ink, #7f1d1d);
}

.dash-warn--warn {
  background: var(--sher-warning-soft, #fff6e5);
  color: var(--sher-warning-ink, #6b4a00);
}

.skeletons { display: flex; flex-direction: column; gap: var(--sher-space-5); }
.skeleton-tiles { height: 118px; }
.skeleton-panel { height: 300px; }
.retry { margin-top: var(--sher-space-4); }

.dash__tiles {
  display: grid;
  gap: var(--sher-space-3);
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  margin-bottom: var(--sher-space-5);
}

.dash__target { display: flex; flex-wrap: wrap; gap: var(--sher-space-5); align-items: flex-start; }
.dash__target-label { margin: 0; font-size: var(--sher-text-xs); color: var(--sher-text-muted); }
.dash__target-value { margin: 0.1rem 0 0; font-size: var(--sher-text-lg); font-weight: 700; }
.dash__estimate { color: var(--sher-text-muted); }
.dash__target-note { margin: 0.1rem 0 0; font-size: var(--sher-text-xs); color: var(--sher-text-muted); }

.dash__recent { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.dash__recent li { display: flex; gap: 0.75rem; align-items: baseline; }
.dash__recent li strong { margin-left: auto; }
.dash__link { background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; text-decoration: underline dotted; }
</style>
