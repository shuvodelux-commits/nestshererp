<script setup lang="ts">
import type {
  PartyResponse,
  PartyRoleValue,
  PartySetupResponse,
  PartySort,
  PartySummary,
  SortDirection,
} from '@sher/core-contracts';
import { defaultDirectionFor } from '@sher/core-contracts';
import { Money } from '@sher/shared-utils';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import {
  createCustomerGroup,
  EMPTY_PARTY_SETUP,
  fetchParties,
  fetchPartySetup,
  removeCustomerGroup,
  renameCustomerGroup,
  setPartyStatus,
} from '../api/parties';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import SortableHeader from '../components/SortableHeader.vue';
import AppShell from '../components/shell/AppShell.vue';
import StatCard from '../components/StatCard.vue';

/**
 * The Parties screen (Phase 2, §5.6, D-04) — a List screen (UI-22): tabs →
 * filter bar → summary tiles → table → paging.
 *
 * **Tabs, not a "type" dropdown.** §5.6: "Sales/POS shows customers by default;
 * Purchase screens show suppliers by default … never show every party type by
 * default." The tab is part of every query, so there is no state in which this
 * screen is showing a mixture nobody asked for. A party that is both shows up
 * under both, because it is one record with two roles.
 *
 * Paging is keyset (§3.9, `OFFSET` banned).
 */
const session = useSession();
const router = useRouter();

const role = ref<PartyRoleValue>('CUSTOMER');

const RIGHTS: Record<PartyRoleValue, { view: string; create: string; edit: string; deactivate: string }> = {
  CUSTOMER: {
    view: 'party.customer.view',
    create: 'party.customer.create',
    edit: 'party.customer.edit',
    deactivate: 'party.customer.deactivate',
  },
  SUPPLIER: {
    view: 'party.supplier.view',
    create: 'party.supplier.create',
    edit: 'party.supplier.edit',
    deactivate: 'party.supplier.deactivate',
  },
  VENDOR: {
    view: 'party.vendor.view',
    create: 'party.vendor.create',
    edit: 'party.vendor.edit',
    deactivate: 'party.vendor.deactivate',
  },
};

const setup = ref<PartySetupResponse>(EMPTY_PARTY_SETUP);

/**
 * UI-09: never render a control that will 403 — or one the shop has switched
 * off. The Vendors tab is absent, not disabled, while vendors are off in
 * Settings, because a disabled control still advertises a feature nobody chose.
 */
const tabs = computed(() =>
  (['CUSTOMER', 'SUPPLIER', 'VENDOR'] as PartyRoleValue[]).filter((value) => {
    if (value === 'VENDOR' && !setup.value.features.vendors) return false;
    return session.can(RIGHTS[value].view);
  }),
);

const canCreate = computed(() => session.can(RIGHTS[role.value].create));
const canEdit = computed(() => session.can(RIGHTS[role.value].edit));
const canDeactivate = computed(() => session.can(RIGHTS[role.value].deactivate));
const canManageGroups = computed(() => session.can('party.group.manage'));

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const parties = ref<PartyResponse[]>([]);
const summary = ref<PartySummary>({ total: 0, active: 0, inactive: 0, ungrouped: 0 });
const nextCursor = ref<string | null>(null);

const search = ref('');
const groupId = ref('');
const status = ref('');

const busy = ref(false);
const notice = ref<string | null>(null);

const showsGroups = computed(
  () => role.value === 'CUSTOMER' && setup.value.features.customerGroups,
);

const filtersActive = computed(
  () => search.value !== '' || groupId.value !== '' || status.value !== '',
);

const NOUN: Record<PartyRoleValue, string> = {
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier',
  VENDOR: 'vendor',
};

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

/** UI-31/UI-32: formatted by shared-utils, right-aligned, two decimals, ৳. */
function money(minor: number | null): string {
  return minor === null ? '—' : `৳${Money(minor).format()}`;
}

function currentQuery(cursor: string | null = null) {
  return {
    role: role.value,
    ...(search.value === '' ? {} : { search: search.value }),
    ...(groupId.value === '' ? {} : { groupId: groupId.value }),
    ...(status.value === '' ? {} : { status: status.value as 'ACTIVE' | 'INACTIVE' }),
    ...(cursor === null ? {} : { cursor }),
    sort: sort.value,
    direction: direction.value,
  };
}

/**
 * Which header is tapped, and which way (UI-46) — identical behaviour to the
 * Products list, because a shopkeeper should only have to learn it once.
 */
const sort = ref<PartySort>('name');
const direction = ref<SortDirection>('ASC');

function sortBy(column: string): void {
  const next = column as PartySort;

  if (sort.value === next) {
    direction.value = direction.value === 'ASC' ? 'DESC' : 'ASC';
  } else {
    sort.value = next;
    direction.value = defaultDirectionFor(next);
  }

  void load();
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const page = await fetchParties(session.accessToken.value ?? '', currentQuery());
    parties.value = [...page.data];
    summary.value = page.summary;
    nextCursor.value = page.page.nextCursor;
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
}

/** Keyset paging: the next page is appended, never re-fetched from an offset. */
async function showMore(): Promise<void> {
  if (nextCursor.value === null || busy.value) return;
  busy.value = true;
  try {
    const page = await fetchParties(session.accessToken.value ?? '', currentQuery(nextCursor.value));
    parties.value = [...parties.value, ...page.data];
    nextCursor.value = page.page.nextCursor;
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    setup.value = await fetchPartySetup(session.accessToken.value ?? '');
  } catch {
    // The groups and the Vendors tab are a convenience; the list itself still
    // works, and its own failure is what the error card is for.
  }
  const first = tabs.value[0];
  if (first !== undefined && !tabs.value.includes(role.value)) role.value = first;
  await load();
});

watch(role, () => {
  groupId.value = '';
  void load();
});

function clearFilters(): void {
  search.value = '';
  groupId.value = '';
  status.value = '';
  void load();
}

function openParty(party: PartyResponse): void {
  void router.push(`/parties/${party.id}?role=${role.value}`);
}

/* --------------------------------------------------- deactivate / reactivate */

const confirming = ref<PartyResponse | null>(null);

async function toggleStatus(): Promise<void> {
  const party = confirming.value;
  if (party === null) return;

  busy.value = true;
  try {
    const next = party.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await setPartyStatus(session.accessToken.value ?? '', party.id, next);
    notice.value =
      next === 'INACTIVE'
        ? `${party.name} will not appear in new transactions. Their history and balance stay exactly as they are.`
        : `${party.name} can be used again.`;
    confirming.value = null;
    await load();
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------------ groups dialog */

const managingGroups = ref(false);
const newGroupName = ref('');
const groupError = ref<{ code: string; message: string } | null>(null);

async function addGroup(): Promise<void> {
  busy.value = true;
  groupError.value = null;
  try {
    setup.value = await createCustomerGroup(session.accessToken.value ?? '', newGroupName.value);
    newGroupName.value = '';
  } catch (cause) {
    groupError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

async function renameGroup(id: string, name: string): Promise<void> {
  busy.value = true;
  groupError.value = null;
  try {
    setup.value = await renameCustomerGroup(session.accessToken.value ?? '', id, name);
  } catch (cause) {
    groupError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * §3.6: a group nobody is filed under goes, one that is in use is archived —
 * and the person is told which happened, because they are different promises.
 */
async function removeGroup(id: string, name: string): Promise<void> {
  busy.value = true;
  groupError.value = null;
  try {
    const result = await removeCustomerGroup(session.accessToken.value ?? '', id);
    notice.value =
      result.outcome === 'DELETED'
        ? `${name} was removed.`
        : `${name} is no longer offered. Customers already in it keep showing it.`;
    setup.value = await fetchPartySetup(session.accessToken.value ?? '');
    if (groupId.value === id) groupId.value = '';
    await load();
  } catch (cause) {
    groupError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppShell
    title="Customers & Suppliers"
    :breadcrumb="['Dashboard', 'Customers & Suppliers']"
    help-bn="আপনার ক্রেতা, সরবরাহকারী আর ভেন্ডরের তালিকা"
  >
    <template #actions>
      <button
        v-if="showsGroups && canManageGroups"
        type="button"
        class="btn btn-ghost"
        @click="managingGroups = true"
      >
        <i class="pi pi-tags" aria-hidden="true" />
        Customer groups
      </button>
      <button
        v-if="canCreate"
        type="button"
        class="btn btn-primary"
        @click="router.push(`/parties/new?role=${role}`)"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        Add {{ NOUN[role] }}
      </button>
    </template>

    <!-- §5.6: one type at a time, never a mixture nobody asked for -->
    <div class="tabs" role="tablist" aria-label="Party type">
      <button
        v-for="tab in tabs"
        :key="tab"
        type="button"
        role="tab"
        class="tab"
        :class="{ 'is-current': role === tab }"
        :aria-selected="role === tab"
        @click="role = tab"
      >
        {{ tab === 'CUSTOMER' ? 'Customers' : tab === 'SUPPLIER' ? 'Suppliers' : 'Vendors' }}
      </button>
    </div>

    <form class="filters" @submit.prevent="load">
      <div class="field grow">
        <label for="party-search">Search</label>
        <input id="party-search" v-model="search" type="search" placeholder="Name or phone" />
      </div>

      <div v-if="showsGroups" class="field">
        <label for="filter-group">Group</label>
        <select id="filter-group" v-model="groupId" @change="load">
          <option value="">All groups</option>
          <option v-for="group in setup.groups" :key="group.id" :value="group.id">
            {{ group.name }}
          </option>
        </select>
      </div>

      <div class="field">
        <label for="filter-status">Status</label>
        <select id="filter-status" v-model="status" @change="load">
          <option value="">Active and inactive</option>
          <option value="ACTIVE">Active only</option>
          <option value="INACTIVE">Inactive only</option>
        </select>
      </div>

      <button type="submit" class="btn btn-ghost">Search</button>
      <button v-if="filtersActive" type="button" class="btn btn-ghost" @click="clearFilters">
        Clear
      </button>
    </form>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading">
      <div class="skeleton skeleton-tiles" />
      <div class="skeleton skeleton-table" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not load this list">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

      <div class="tiles">
        <StatCard
          :label="role === 'CUSTOMER' ? 'Customers' : role === 'SUPPLIER' ? 'Suppliers' : 'Vendors'"
          :value="String(summary.total)"
          detail="Matching these filters"
          icon="pi-users"
          tone="blue"
        />
        <StatCard
          label="Active"
          :value="String(summary.active)"
          detail="Available in new transactions"
          icon="pi-check-circle"
          tone="green"
        />
        <StatCard
          label="Inactive"
          :value="String(summary.inactive)"
          detail="Kept in history, not offered"
          icon="pi-ban"
          tone="slate"
        />
        <StatCard
          v-if="showsGroups"
          label="Not in a group"
          :value="String(summary.ungrouped)"
          detail="No group chosen yet"
          icon="pi-tag"
          tone="amber"
        />
      </div>

      <EmptyState
        v-if="parties.length === 0 && !filtersActive"
        icon="pi-users"
        title="Nobody here yet"
      >
        A customer needs a name and a phone number. A supplier needs only a name — you can add
        the rest whenever you have it.
        <template #action>
          <button
            v-if="canCreate"
            type="button"
            class="btn btn-primary"
            @click="router.push(`/parties/new?role=${role}`)"
          >
            Add the first {{ NOUN[role] }}
          </button>
        </template>
      </EmptyState>

      <EmptyState v-else-if="parties.length === 0" icon="pi-search" title="Nothing matched">
        Nobody matches these filters.
        <template #action>
          <button type="button" class="btn btn-ghost" @click="clearFilters">
            Clear the filters
          </button>
        </template>
      </EmptyState>

      <template v-else>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <SortableHeader
                  column="name"
                  label="Name"
                  label-bn="নাম"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <SortableHeader
                  column="phone"
                  label="Phone"
                  label-bn="মোবাইল নম্বর"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <SortableHeader
                  v-if="showsGroups"
                  column="groupName"
                  label="Group"
                  label-bn="কোন দলে রাখা আছে"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <!--
                  `Also` is the other roles this party holds — badges built from
                  `party_roles` rows, not a column the database can order by. UI-46
                  says such a column is left unsortable rather than sorted in the
                  client, which would only order the page you can see.
                -->
                <th>Also</th>
                <SortableHeader
                  v-if="role === 'CUSTOMER'"
                  column="creditLimit"
                  label="Credit limit"
                  label-bn="সর্বোচ্চ কত টাকা বাকি দেওয়া যাবে"
                  numeric
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <SortableHeader
                  column="status"
                  label="Status"
                  label-bn="চালু আছে কি না"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <th class="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="party in parties"
                :key="party.id"
                :class="{ 'is-inactive': party.status === 'INACTIVE' }"
              >
                <td>
                  <button type="button" class="linkish name" @click="openParty(party)">
                    {{ party.name }}
                  </button>
                  <!--
                    D-02's walk-in party. Named as what it is, and offered no
                    action, because every fully paid counter sale points at it.
                  -->
                  <span v-if="party.isSystemReserved" class="pill pill-info">Walk-in</span>
                </td>
                <td class="mono">{{ party.phone ?? '—' }}</td>
                <td v-if="showsGroups">{{ party.customerGroupName ?? '—' }}</td>
                <td>
                  <span
                    v-for="other in party.roles.filter((value) => value !== role)"
                    :key="other"
                    class="pill pill-info other-role"
                  >
                    {{ other === 'CUSTOMER' ? 'Customer' : other === 'SUPPLIER' ? 'Supplier' : 'Vendor' }}
                  </span>
                  <span v-if="party.roles.length === 1">—</span>
                </td>
                <td v-if="role === 'CUSTOMER'" class="num">{{ money(party.creditLimitMinor) }}</td>
                <td>
                  <span v-if="party.status === 'ACTIVE'" class="pill pill-ok">Active</span>
                  <span v-else class="pill pill-bad">Inactive</span>
                </td>
                <td class="actions">
                  <template v-if="!party.isSystemReserved">
                    <button v-if="canEdit" type="button" class="linkish" @click="openParty(party)">
                      Edit
                    </button>
                    <button
                      v-if="canDeactivate"
                      type="button"
                      class="linkish"
                      :class="{ danger: party.status === 'ACTIVE' }"
                      @click="confirming = party"
                    >
                      {{ party.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate' }}
                    </button>
                  </template>
                  <span v-else class="muted">System</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="paging">
          <span class="muted">Showing {{ parties.length }} of {{ summary.total }}</span>
          <button
            v-if="nextCursor !== null"
            type="button"
            class="btn btn-ghost"
            :disabled="busy"
            @click="showMore"
          >
            {{ busy ? 'Loading…' : 'Show more' }}
          </button>
        </div>
      </template>

      <p class="fine">
        Balances, statements and transaction history appear on this screen once purchases and
        sales exist — they are read from the ledger, never stored on the record.
      </p>
    </template>

    <!-- --------------------------------------------- deactivate / reactivate -->
    <div v-if="confirming !== null" class="scrim" @click.self="confirming = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>
          {{ confirming.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate' }} {{ confirming.name }}?
        </h2>
        <p class="lede">
          <template v-if="confirming.status === 'ACTIVE'">
            They stop appearing in new sales and purchases. Everything already recorded — every
            invoice, payment and balance — stays exactly as it is.
          </template>
          <template v-else> They can be used in new transactions again straight away. </template>
        </p>
        <p class="sher-bn">
          {{
            confirming.status === 'ACTIVE'
              ? 'নতুন বিক্রি বা কেনায় আর দেখা যাবে না — পুরনো হিসাব ঠিক থাকবে'
              : 'আবার নতুন লেনদেনে ব্যবহার করা যাবে'
          }}
        </p>

        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="confirming = null">
            Cancel
          </button>
          <button
            type="button"
            class="btn"
            :class="confirming.status === 'ACTIVE' ? 'btn-danger' : 'btn-primary'"
            :disabled="busy"
            @click="toggleStatus"
          >
            {{ busy ? 'Saving…' : confirming.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------ customer groups -->
    <div v-if="managingGroups" class="scrim" @click.self="managingGroups = false">
      <div class="dialog wide" role="dialog" aria-modal="true">
        <h2>Customer groups</h2>
        <p class="lede">
          Groups sort your customers so a whole group can be priced differently later. Removing a
          group that customers are in keeps it on them and stops offering it to new ones.
        </p>

        <ErrorNotice
          v-if="groupError !== null"
          :code="groupError.code"
          :message="groupError.message"
        />

        <form class="group-add" @submit.prevent="addGroup">
          <div class="field grow">
            <label for="new-group">New group</label>
            <input id="new-group" v-model="newGroupName" type="text" placeholder="Dealer" />
          </div>
          <button type="submit" class="btn btn-primary" :disabled="busy || newGroupName === ''">
            Add
          </button>
        </form>

        <ul class="group-list">
          <li v-for="group in setup.groups" :key="group.id">
            <input
              :value="group.name"
              type="text"
              :aria-label="`Rename ${group.name}`"
              @change="renameGroup(group.id, ($event.target as HTMLInputElement).value)"
            />
            <button
              type="button"
              class="linkish danger"
              :disabled="busy"
              @click="removeGroup(group.id, group.name)"
            >
              Remove
            </button>
          </li>
          <li v-if="setup.groups.length === 0" class="muted">No groups yet.</li>
        </ul>

        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" @click="managingGroups = false">Close</button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
/*
 * Buttons, fields, tables, badges, dialogs and skeletons come from
 * `design/components.css`. What is left is the tab strip, the filter bar, the
 * tile row, the paging line and the group editor.
 */
.tabs {
  display: flex;
  gap: 2px;
  margin-bottom: var(--sher-space-4);
  border-bottom: 1px solid var(--sher-line);
}

.tab {
  appearance: none;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 10px 16px;
  font-size: var(--sher-text-base);
  font-weight: 500;
  color: var(--sher-text-muted);
  cursor: pointer;
}

.tab.is-current {
  color: var(--sher-nav-active-fg);
  border-bottom-color: var(--sher-nav-active-fg);
  font-weight: 600;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--sher-space-3);
  margin-bottom: var(--sher-space-5);
}

.filters .field {
  margin: 0;
  min-width: 170px;
}

.filters .field.grow {
  flex: 1 1 260px;
}

.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton-tiles {
  height: 118px;
}

.skeleton-table {
  height: 320px;
}

.retry {
  margin-top: var(--sher-space-4);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sher-space-4);
  margin-bottom: var(--sher-space-5);
}

/* UI-32: money right-aligned, with tabular figures. */
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.name {
  font-weight: 600;
}

.muted {
  color: var(--sher-text-muted);
}

td .pill {
  margin-left: 8px;
}

td .other-role {
  margin-left: 0;
  margin-right: 6px;
}

tbody tr.is-inactive td:not(.actions) {
  color: var(--sher-text-muted);
}

.paging {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sher-space-3);
  margin-top: var(--sher-space-4);
  font-size: var(--sher-text-sm);
}

.group-add {
  display: flex;
  align-items: flex-end;
  gap: var(--sher-space-3);
  margin: var(--sher-space-4) 0;
}

.group-add .field.grow {
  flex: 1;
  margin: 0;
}

.group-list {
  list-style: none;
  margin: 0 0 var(--sher-space-4);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-2);
}

.group-list li {
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
}

.group-list input {
  flex: 1;
}
</style>
