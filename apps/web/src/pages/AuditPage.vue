<script setup lang="ts">
import type { AuditEventResponse, AuditListResponse } from '@sher/core-contracts';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { fetchAuditEvents } from '../api/audit';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * The audit trail (slice 1.6, §5.22).
 *
 * Read-only, and visibly so: there is no edit, no delete and no export-and-
 * clear. §5.22's promise is that "the system must never make a financially
 * meaningful historical event disappear without an auditable trail", and a
 * screen offering to tidy it up would undo that in one click.
 *
 * Each row says what changed, from what, to what, who did it and when. The
 * before/after values are shown exactly as stored — an audit trail that
 * reformats numbers is not evidence (R-D4).
 *
 * Filters are the four dimensions a shopkeeper actually asks in: which days,
 * who, what kind of thing, and what was done to it. Their choices come from the
 * server's own facets, so a later module's events appear in the dropdowns the
 * moment it writes its first one.
 */
const session = useSession();

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const result = ref<AuditListResponse | null>(null);
/**
 * "No filter" is a value the dropdown can hold. PrimeVue reads an empty model
 * as *nothing chosen* and draws the placeholder instead, which left a filter
 * resting on its own default looking like an empty box.
 */
const ANY = 'any';

const actorOptions = computed(() => [{ id: ANY, name: 'Anyone' }, ...(result.value?.actors ?? [])]);
const entityOptions = computed(() => [
  { label: 'Everything', value: ANY },
  ...(result.value?.entityTypes ?? []).map((value) => ({ label: value, value })),
]);
const actionOptions = computed(() => [
  { label: 'Any action', value: ANY },
  ...(result.value?.actions ?? []).map((value) => ({ label: value, value })),
]);
/** Rows accumulated across "Show older" — the trail reads as one list. */
const events = ref<AuditEventResponse[]>([]);
const loadingMore = ref(false);

const filters = ref({ from: '', to: '', actorId: ANY, entityType: ANY, action: ANY });

/** A dropdown left on its default is not a filter, so it never reaches the query. */
function currentQuery(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filters.value).map(([key, value]) => [key, value === ANY ? '' : value]),
  );
}

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const page = await fetchAuditEvents(session.accessToken.value ?? '', currentQuery());
    result.value = page;
    events.value = [...page.events];
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  const cursor = result.value?.page.nextCursor;
  if (cursor === null || cursor === undefined) return;

  loadingMore.value = true;
  try {
    const page = await fetchAuditEvents(session.accessToken.value ?? '', {
      ...currentQuery(),
      cursor,
    });
    result.value = page;
    events.value = [...events.value, ...page.events];
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loadingMore.value = false;
  }
}

onMounted(load);

function clearFilters(): void {
  filters.value = { from: '', to: '', actorId: ANY, entityType: ANY, action: ANY };
  void load();
}

const anyFilter = computed(() =>
  Object.values(currentQuery()).some((value) => value !== ''),
);

/**
 * Rendered in the tenant's own timezone, so a 00:30 Dhaka event reads as that
 * day and not as the UTC one (§3.5). The zone comes from the response rather
 * than being assumed here — the tenant can change it in Settings.
 *
 * Formatting only. No business decision is taken in a component (R-B8).
 */
const when = computed(() => {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: result.value?.timezone ?? 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (iso: string): string => format.format(new Date(iso));
});

/** `{ value: 'off' }` reads as `value: off` — one line per field that moved. */
function summarize(values: Record<string, string | number | null> | null): string {
  if (values === null) return '—';
  const pairs = Object.entries(values).map(([key, value]) => `${key}: ${String(value ?? '—')}`);
  return pairs.length === 0 ? '—' : pairs.join(', ');
}

/** A denial is not a change; colouring it like one would hide it in the list. */
function toneFor(action: string): string {
  if (action === 'DENIED') return 'pill-bad';
  if (action === 'CREATE') return 'pill-ok';
  if (action === 'DELETE') return 'pill-warn';
  return 'pill-info';
}
</script>

<template>
  <AppShell
    title="Audit trail"
    :breadcrumb="['SherERP']"
    help-bn="কে কী পরিবর্তন করেছে তার পূর্ণ তালিকা"
  >
    <AppCard title="Filters" subtitle="Narrow the trail to the days, person or record you mean.">
      <form class="filters" @submit.prevent="load">
        <div class="field">
          <label for="filter-from">From</label>
          <DateOnlyPicker input-id="filter-from" v-model="filters.from" />
        </div>
        <div class="field">
          <label for="filter-to">To</label>
          <DateOnlyPicker input-id="filter-to" v-model="filters.to" />
        </div>
        <div class="field">
          <label for="filter-actor">Who</label>
          <Select input-id="filter-actor" v-model="filters.actorId" :options="actorOptions" option-label="name" option-value="id" fluid />
        </div>
        <div class="field">
          <label for="filter-entity">What</label>
          <Select input-id="filter-entity" v-model="filters.entityType" :options="entityOptions" option-label="label" option-value="value" fluid />
        </div>
        <div class="field">
          <label for="filter-action">Action</label>
          <Select input-id="filter-action" v-model="filters.action" :options="actionOptions" option-label="label" option-value="value" fluid />
        </div>

        <div class="filter-actions">
          <button type="submit" class="btn btn-primary" :disabled="loading">Apply</button>
          <button
            v-if="anyFilter"
            type="button"
            class="btn btn-ghost"
            :disabled="loading"
            @click="clearFilters"
          >
            Clear
          </button>
        </div>
      </form>
    </AppCard>

    <div v-if="loading" class="skeleton" role="status" aria-live="polite">Loading the trail…</div>

    <ErrorNotice v-else-if="loadError" :code="loadError.code" :message="loadError.message">
      <button type="button" class="btn btn-ghost" @click="load">Try again</button>
    </ErrorNotice>

    <AppCard v-else class="trail-card">
      <EmptyState
        v-if="events.length === 0"
        icon="pi-history"
        title="Nothing recorded for this filter"
      >
        Every change anyone makes is recorded here automatically. Widen the dates, or clear the
        filters, to see more.
      </EmptyState>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">Action</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in events" :key="event.id">
              <td>{{ when(event.occurredAt) }}</td>
              <td>{{ event.actorName }}</td>
              <td>
                <span class="entity">{{ event.entityType }}</span>
                <span class="mono entity-id">{{ event.entityId }}</span>
              </td>
              <td>
                <span class="pill" :class="toneFor(event.action)">{{ event.action }}</span>
                <span v-if="event.reason" class="reason">{{ event.reason }}</span>
              </td>
              <td class="values">{{ summarize(event.before) }}</td>
              <td class="values">{{ summarize(event.after) }}</td>
              <td>{{ event.source }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="result?.page.hasMore" class="more">
        <button type="button" class="btn btn-ghost" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? 'Loading…' : 'Show older' }}
        </button>
      </div>
    </AppCard>
  </AppShell>
</template>

<style scoped>
.filter-actions {
  display: flex;
  gap: var(--sher-space-2);
}

.trail-card {
  margin-top: var(--sher-space-4);
}

.entity {
  display: block;
  font-weight: 500;
}

.entity-id {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
  word-break: break-all;
}

.reason {
  display: block;
  margin-top: 4px;
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
}

.values {
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
  max-width: 240px;
  word-break: break-word;
}

.more {
  display: flex;
  justify-content: center;
  padding-top: var(--sher-space-4);
}
</style>
