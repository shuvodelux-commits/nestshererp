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
import { parseMoney, SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import {
  createCustomerGroup,
  createParty,
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
import SearchField from '../components/SearchField.vue';
import SortableHeader from '../components/SortableHeader.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * The Parties screen (Phase 2, §5.6, D-04) — a List screen (UI-22): role
 * context → filter bar → table → paging.
 *
 * The sidebar/route supplies the role context. §5.6 says Sales/POS shows
 * customers by default and Purchase screens show suppliers by default; the
 * role remains part of every query, so the screen never shows an accidental
 * mixture. A party with two roles appears in either role-specific entry.
 *
 * Paging is keyset (§3.9, `OFFSET` banned).
 */
const session = useSession();
const router = useRouter();
const route = useRoute();
const clock = new SystemClock();

function roleFromQuery(value: unknown): PartyRoleValue | null {
  return value === 'CUSTOMER' || value === 'SUPPLIER' || value === 'VENDOR' ? value : null;
}

const role = ref<PartyRoleValue>(roleFromQuery(route.query.role) ?? 'CUSTOMER');

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
const accessibleRoles = computed(() =>
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

/**
 * "No filter" is a value the dropdown can hold. PrimeVue reads an empty model
 * as *nothing chosen* and draws the placeholder instead, which left a filter
 * resting on its own default looking like an empty box.
 */
const ANY = 'any';

const search = ref('');
const groupId = ref(ANY);
const status = ref(ANY);
const statusOptions = [
  { label: 'Active and inactive', value: ANY },
  { label: 'Active only', value: 'ACTIVE' },
  { label: 'Inactive only', value: 'INACTIVE' },
];
const groupOptions = computed(() => [{ id: ANY, name: 'All groups' }, ...setup.value.groups]);

const busy = ref(false);
const notice = ref<string | null>(null);

/* ----------------------------------------------- add party dialog (UI-50) */

const createVisible = ref(false);
const createName = ref('');
const createPhone = ref('');
const createAddress = ref('');
const createGuardianName = ref('');
const createNid = ref('');
const createEmail = ref('');
const createNotes = ref('');
const createGroupId = ref('');
const createCreditLimit = ref('');
const createError = ref<{ code: string; message: string } | null>(null);
const createOperationId = ref(Ulid.generate(clock));

function openCreateDialog(): void {
  createName.value = '';
  createPhone.value = '';
  createAddress.value = '';
  createGuardianName.value = '';
  createNid.value = '';
  createEmail.value = '';
  createNotes.value = '';
  createGroupId.value = '';
  createCreditLimit.value = '';
  createError.value = null;
  createOperationId.value = Ulid.generate(clock);
  createVisible.value = true;
}

async function saveCreatedParty(): Promise<void> {
  const isCustomer = role.value === 'CUSTOMER';
  const limitMinor = createCreditLimit.value.trim() === '' ? null : parseMoney(createCreditLimit.value);
  if (createName.value.trim() === '' || (isCustomer && createPhone.value.trim() === '')) {
    createError.value = { code: 'VALIDATION_FAILED', message: isCustomer ? 'Enter the customer name and phone number' : 'Enter the name' };
    return;
  }
  if (createCreditLimit.value.trim() !== '' && limitMinor === null) {
    createError.value = { code: 'VALIDATION_FAILED', message: 'Enter the credit limit with at most two decimal places' };
    return;
  }
  const blank = (value: string): string | null => value.trim() === '' ? null : value.trim();
  busy.value = true;
  createError.value = null;
  try {
    const created = await createParty(session.accessToken.value ?? '', {
      name: createName.value.trim(),
      roles: [role.value],
      phone: blank(createPhone.value),
      address: blank(createAddress.value),
      guardianName: blank(createGuardianName.value),
      nid: blank(createNid.value),
      email: blank(createEmail.value),
      notes: blank(createNotes.value),
      customerGroupId: isCustomer && createGroupId.value !== '' ? createGroupId.value : null,
      creditLimitMinor: isCustomer ? limitMinor : null,
    }, createOperationId.value);
    createVisible.value = false;
    notice.value = `${created.name} was added.`;
    await load();
  } catch (cause) {
    createError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

/* --------------------------------------------------------- row action menu */

const rowMenu = ref<InstanceType<typeof Menu> | null>(null);
const actionParty = ref<PartyResponse | null>(null);
const rowMenuItems = computed<MenuItem[]>(() => {
  const party = actionParty.value;
  if (party === null || party.isSystemReserved) return [];
  return [
    ...(canEdit.value ? [{
      label: 'Edit customer details',
      icon: 'pi pi-pencil',
      command: () => void router.push(`/parties/${party.id}?role=${role.value}&mode=edit`),
    }] : []),
    ...(canDeactivate.value ? [{
      label: party.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate',
      icon: party.status === 'ACTIVE' ? 'pi pi-ban' : 'pi pi-check-circle',
      command: () => { confirming.value = party; },
    }] : []),
  ];
});

function openRowMenu(event: Event, party: PartyResponse): void {
  actionParty.value = party;
  rowMenu.value?.toggle(event);
}

const showsGroups = computed(
  () => role.value === 'CUSTOMER' && setup.value.features.customerGroups,
);

const filtersActive = computed(
  () => search.value !== '' || groupId.value !== ANY || status.value !== ANY,
);

const NOUN: Record<PartyRoleValue, string> = {
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier',
  VENDOR: 'vendor',
};

const PAGE_COPY: Record<PartyRoleValue, { title: string; helpBn: string }> = {
  CUSTOMER: { title: 'Customers', helpBn: 'আপনার ক্রেতাদের তালিকা' },
  SUPPLIER: { title: 'Suppliers', helpBn: 'আপনার সরবরাহকারীদের তালিকা' },
  VENDOR: { title: 'Vendors', helpBn: 'আপনার ভেন্ডরদের তালিকা' },
};

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

function currentQuery(cursor: string | null = null) {
  return {
    role: role.value,
    ...(search.value === '' ? {} : { search: search.value }),
    ...(groupId.value === ANY ? {} : { groupId: groupId.value }),
    ...(status.value === ANY ? {} : { status: status.value as 'ACTIVE' | 'INACTIVE' }),
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
  const first = accessibleRoles.value[0];
  if (first !== undefined && !accessibleRoles.value.includes(role.value)) role.value = first;
  await load();
});

watch(role, () => {
  groupId.value = ANY;
  void load();
});

watch(() => route.query.role, (value) => {
  const requested = roleFromQuery(value);
  if (requested !== null && accessibleRoles.value.includes(requested)) role.value = requested;
});

function clearFilters(): void {
  search.value = '';
  groupId.value = ANY;
  status.value = ANY;
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
    if (groupId.value === id) groupId.value = ANY;
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
    :title="PAGE_COPY[role].title"
    :breadcrumb="['Dashboard', PAGE_COPY[role].title]"
    :help-bn="PAGE_COPY[role].helpBn"
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
        @click="openCreateDialog"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        Add {{ NOUN[role] }}
      </button>
    </template>

    <form class="filters" @submit.prevent="load">
      <div class="field grow">
        <SearchField
          v-model="search"
          field-id="party-search"
          :label="`Search ${NOUN[role]}s`"
          placeholder="Name or phone"
          @search="load"
        />
      </div>

      <div v-if="showsGroups" class="field">
        <label for="filter-group">Group</label>
        <Select input-id="filter-group" v-model="groupId" :options="groupOptions" option-label="name" option-value="id" fluid @change="load" />
      </div>

      <div class="field">
        <label for="filter-status">Status</label>
        <Select input-id="filter-status" v-model="status" :options="statusOptions" option-label="label" option-value="value" fluid @change="load" />
      </div>

      <button v-if="filtersActive" type="button" class="btn btn-ghost" @click="clearFilters">
        Clear
      </button>
    </form>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading">
      <div class="skeleton skeleton-table" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not load this list">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

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
                <!--
                  Where they are — the field a shopkeeper reads to tell two
                  Kamals apart, and the one they need when sending goods. Not
                  sortable: `address` is free text with no index behind it, and
                  UI-46 leaves such a column unsorted rather than ordering only
                  the page you can see.
                -->
                <th>Address <span class="sher-bn header-bn">ঠিকানা</span></th>
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
                <td class="address">{{ party.address ?? '—' }}</td>
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
                <td>
                  <span v-if="party.status === 'ACTIVE'" class="pill pill-ok">Active</span>
                  <span v-else class="pill pill-bad">Inactive</span>
                </td>
                <td class="actions">
                  <button
                    v-if="!party.isSystemReserved && (canEdit || canDeactivate)"
                    type="button"
                    class="row-menu-trigger"
                    :aria-label="`Actions for ${party.name}`"
                    aria-haspopup="menu"
                    @click="openRowMenu($event, party)"
                  >
                    <i class="pi pi-ellipsis-v" aria-hidden="true" />
                  </button>
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

    </template>

    <Menu ref="rowMenu" :model="rowMenuItems" popup />

    <Dialog
      v-model:visible="createVisible"
      modal
      :header="`Add ${NOUN[role]}`"
      :style="{ width: 'min(42rem, 96vw)' }"
      :draggable="false"
    >
      <form id="create-party-form" class="create-party-form" @submit.prevent="saveCreatedParty">
        <ErrorNotice v-if="createError" :code="createError.code" :message="createError.message" />
        <div class="field">
          <label for="create-party-name">Name <span class="label-bn">নাম</span></label>
          <input id="create-party-name" v-model="createName" type="text" required autofocus />
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="create-party-phone">Phone <span class="label-bn">মোবাইল নম্বর</span></label>
            <input id="create-party-phone" v-model="createPhone" type="tel" :required="role === 'CUSTOMER'" />
          </div>
          <div v-if="role === 'CUSTOMER'" class="field">
            <label for="create-party-limit">Credit limit <span class="label-bn">বাকির সীমা</span></label>
            <input id="create-party-limit" v-model="createCreditLimit" type="text" inputmode="decimal" placeholder="0.00" />
          </div>
        </div>
        <div v-if="setup.fields.address" class="field">
          <label for="create-party-address">Address <span class="label-bn">ঠিকানা</span></label>
          <textarea id="create-party-address" v-model="createAddress" rows="2" />
        </div>
        <details class="more-fields">
          <summary>More details <span class="label-bn">আরও তথ্য</span></summary>
          <div v-if="setup.fields.guardianName" class="field">
            <label for="create-party-guardian">Father's or guardian's name</label>
            <input id="create-party-guardian" v-model="createGuardianName" type="text" />
          </div>
          <div v-if="setup.fields.nid" class="field">
            <label for="create-party-nid">NID number</label>
            <input id="create-party-nid" v-model="createNid" type="text" />
          </div>
          <div v-if="setup.fields.email" class="field">
            <label for="create-party-email">Email</label>
            <input id="create-party-email" v-model="createEmail" type="email" />
          </div>
          <div v-if="role === 'CUSTOMER' && setup.features.customerGroups" class="field">
            <label for="create-party-group">Customer group</label>
            <Select input-id="create-party-group" v-model="createGroupId" :options="groupOptions" option-label="name" option-value="id" fluid />
          </div>
          <div v-if="setup.fields.notes" class="field">
            <label for="create-party-notes">Notes</label>
            <textarea id="create-party-notes" v-model="createNotes" rows="2" />
          </div>
        </details>
      </form>
      <template #footer>
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="createVisible = false">Cancel</button>
        <button type="submit" form="create-party-form" class="btn btn-primary" :disabled="busy">
          {{ busy ? 'Saving…' : `Add ${NOUN[role]}` }}
        </button>
      </template>
    </Dialog>

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
 * `design/components.css`. What is left is the filter bar, paging line and
 * party-specific overlays.
 */

/* A long address wraps the row twice and pushes Status off the screen. */
.address {
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton-table {
  height: 320px;
}

.retry {
  margin-top: var(--sher-space-4);
}

/* UI-32: money right-aligned, with tabular figures. */
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.name {
  font-weight: 600;
}

.row-menu-trigger {
  display: inline-grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  margin-left: auto;
  border: 0;
  border-radius: 50%;
  color: var(--sher-text-muted);
  background: transparent;
  cursor: pointer;
}

.row-menu-trigger:hover,
.row-menu-trigger:focus-visible {
  color: var(--p-primary-color);
  background: var(--p-primary-50);
}

.create-party-form,
.more-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sher-space-4);
}

.more-fields {
  padding-top: var(--sher-space-2);
}

.more-fields summary {
  color: var(--p-primary-color);
  font-weight: 600;
  cursor: pointer;
}

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
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
