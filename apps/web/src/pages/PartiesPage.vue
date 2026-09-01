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
import Dialog from 'primevue/dialog';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import Select from 'primevue/select';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import {
  createCustomerGroup,
  deleteParty,
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
import OfflineBar from '../components/offline/OfflineBar.vue';
import { NEEDS_INTERNET, NEEDS_INTERNET_BN } from '../components/offline/offline-text';
import AppShell from '../components/shell/AppShell.vue';
import { useConnectivity } from '../offline/connectivity';
import PartyOpeningDialog from '../components/parties/PartyOpeningDialog.vue';
import PartyFormPage from './PartyFormPage.vue';

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

/*
 * Phase 12.3. The list needs no branch: `fetchParties` reads the local copy
 * when the server cannot be reached and answers in the same shape. The page
 * only has to say that it is offline and stop offering what cannot be saved.
 */
const { isOffline } = useConnectivity();

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
const summary = ref<PartySummary>({
  total: 0,
  active: 0,
  inactive: 0,
  ungrouped: 0,
  totalOutstandingMinor: 0,
  totalAdvanceMinor: 0,
  overCreditLimit: 0,
});
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

/* --------------------------------------------------------- row action menu */

const rowMenu = ref<InstanceType<typeof Menu> | null>(null);
const actionParty = ref<PartyResponse | null>(null);
/**
 * §5.6's row menu: "only permitted contextual actions such as `View Ledger`,
 * `Edit`, `Delete/Deactivate` and other source-module actions that are actually
 * implemented", and "posted financial history is never hard-deleted".
 *
 * Unimplemented actions are absent, not disabled (UI-09). Sales, receipts and
 * payments join this menu as their modules ship.
 */
const rowMenuItems = computed<MenuItem[]>(() => {
  const party = actionParty.value;
  if (party === null || party.isSystemReserved) return [];
  return [
    {
      label: 'View ledger',
      icon: 'pi pi-book',
      command: () => { openLedger(party); },
    },
    ...(canEdit.value ? [{
      label: `Edit ${NOUN[role.value]} details`,
      icon: 'pi pi-pencil',
      command: () => { editing.value = party; },
    }] : []),
    ...(canEdit.value ? [{
      label: party.hasLedgerEntries ? 'Correct opening balance' : 'Set opening balance',
      icon: 'pi pi-wallet',
      command: () => { openingFor.value = party; },
    }] : []),
    ...(canDeactivate.value ? [{
      label: party.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate',
      icon: party.status === 'ACTIVE' ? 'pi pi-ban' : 'pi pi-check-circle',
      command: () => { confirming.value = party; },
    }] : []),
    /*
     * §3.6 and §5.6: a party nothing has ever posted against was a mistake and
     * can go; one with a statement can only ever be deactivated, because
     * deleting it would leave its journal lines pointing at nothing. The server
     * refuses either way — this only keeps the menu from offering it.
     */
    ...(canDeactivate.value && !party.hasLedgerEntries ? [{
      label: 'Delete',
      icon: 'pi pi-trash',
      command: () => { deleting.value = party; },
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

/**
 * §5.6: Supplier and Vendor use the same compact shape, "replacing the balance
 * column with the role-relevant current Payable/Advance".
 *
 * Same figure, same sign, different word — a customer's positive balance is
 * money coming in, a supplier's is money going out, and one heading reading
 * "Balance" for both is how someone pays a customer.
 */
const balanceHeading = computed(() =>
  role.value === 'CUSTOMER' ? 'Current Due' : 'Payable',
);
const balanceHeadingBn = computed(() => (role.value === 'CUSTOMER' ? 'পাবো' : 'দিব'));

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

/**
 * §5.6: "clicking the customer name opens that customer's working ledger hub."
 *
 * The name used to open the edit form, which answered a question nobody was
 * asking — someone tapping a customer wants to know what they owe and what
 * happened, not to rename them. Editing is on the `⋯` menu and on the hub.
 */
function openParty(party: PartyResponse): void {
  void router.push(`/parties/${party.id}/ledger?role=${role.value}`);
}

/* ------------------------------------------------------------------ balance */

function openLedger(party: PartyResponse): void {
  void router.push(`/parties/${party.id}/ledger?role=${role.value}`);
}

/**
 * The balance in the words the shop uses (§2.4's display mapping).
 *
 * "Settled" rather than "৳0.00 পাবো": a zero with a direction on it invites a
 * second look for the missing amount, and the whole point of this column is
 * that a glance is enough.
 */
function balanceText(party: PartyResponse): string {
  const { direction, outstandingMinor, advanceMinor } = party.balance;
  if (direction === 'SETTLED') return 'Settled';
  return direction === 'RECEIVABLE'
    ? `৳${Money(outstandingMinor).format()} পাবো`
    : `৳${Money(advanceMinor).format()} দিব`;
}

/**
 * Red for what is outstanding, green for an advance (owner decision,
 * 2026-08-22). Muted when settled.
 *
 * Keyed on the role, not the direction alone. "Outstanding" is a customer
 * **owing** the shop and the shop **owing** a supplier — the same alarming
 * colour for the two opposite directions, because what a shopkeeper wants to
 * spot is the money still to be dealt with, whichever way it points. Colouring
 * by direction would have made a supplier the shop owes look as comfortable as
 * a customer who has paid.
 */
function isOutstanding(direction: string): boolean {
  return role.value === 'CUSTOMER' ? direction === 'RECEIVABLE' : direction === 'PAYABLE';
}

function balanceClass(party: PartyResponse): string {
  const { direction } = party.balance;
  if (direction === 'SETTLED') return 'balance-settled';
  return isOutstanding(direction) ? 'balance-due' : 'balance-advance';
}

/**
 * The card splits the same figure into a label and an amount.
 *
 * **One of the two, never both.** A party either owes the shop or is owed by
 * it — `partyBalanceOf` has already netted an advance against a due, so a
 * customer with 7,420 outstanding and 250 sitting as an advance is owed 7,170
 * and nothing else. Showing "Due 7,420" beside "Advance 250" would invite
 * collecting a figure that is not owed.
 */
function balanceLabelFor(party: PartyResponse): string {
  const { direction } = party.balance;
  if (direction === 'SETTLED') return 'Settled';
  if (direction === 'RECEIVABLE') return role.value === 'CUSTOMER' ? 'Current Due' : 'Advance paid';
  return role.value === 'CUSTOMER' ? 'Advance' : 'Payable';
}

function balanceAmountText(party: PartyResponse): string {
  const { direction, outstandingMinor, advanceMinor } = party.balance;
  if (direction === 'SETTLED') return '৳0.00';
  return `৳${Money(direction === 'RECEIVABLE' ? outstandingMinor : advanceMinor).format()}`;
}

/**
 * A name's initials for the card's avatar — a visual anchor while scanning, not
 * information. Two letters at most, and it degrades to one for a single word
 * and to nothing for a name with no letters in it.
 */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const letters = words.slice(0, 2).map((word) => word.charAt(0).toUpperCase());
  return letters.join('');
}

/**
 * `exceedsCreditLimit` on the client, for the badge only.
 *
 * The real check runs server-side when a credit sale is posted — this is UI-09's
 * "hide the control **and** enforce", and a client that got this wrong would
 * show a missing badge, never let an over-limit sale through.
 */
function overLimit(party: PartyResponse): boolean {
  return (
    party.creditLimitMinor !== null &&
    party.balance.outstandingMinor > party.creditLimitMinor
  );
}

/* --------------------------------------------------- deactivate / reactivate */

const confirming = ref<PartyResponse | null>(null);

/* ------------------------------------------------------- add / edit dialog */

/**
 * UI-50: master data is added and edited in a modal over its list, so the
 * shopkeeper keeps their place and the saved row appears behind the dialog as
 * its own confirmation. `PartyFormPage` is the same form the route renders —
 * embedded rather than copied, so both have one write path.
 */
const adding = ref(false);
const editing = ref<PartyResponse | null>(null);
const deleting = ref<PartyResponse | null>(null);
const openingFor = ref<PartyResponse | null>(null);

const formOpen = computed({
  get: () => adding.value || editing.value !== null,
  set: (open: boolean) => {
    if (!open) closeForm();
  },
});

function closeForm(): void {
  adding.value = false;
  editing.value = null;
}

/** The row is behind the dialog, so it has to be the saved one when it closes. */
async function onFormSaved(party: PartyResponse): Promise<void> {
  const added = adding.value;
  closeForm();
  notice.value = added ? `${party.name} added.` : `${party.name} saved.`;
  await load();
}

async function onOpeningSaved(): Promise<void> {
  openingFor.value = null;
  notice.value = 'Opening balance posted.';
  await load();
}

async function removeParty(): Promise<void> {
  const party = deleting.value;
  if (party === null) return;

  busy.value = true;
  try {
    await deleteParty(session.accessToken.value ?? '', party.id);
    notice.value = `${party.name} deleted.`;
    deleting.value = null;
    await load();
  } catch (cause) {
    loadError.value = describe(cause);
    deleting.value = null;
  } finally {
    busy.value = false;
  }
}

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
        :disabled="isOffline"
        @click="managingGroups = true"
      >
        <i class="pi pi-tags" aria-hidden="true" />
        Customer groups
      </button>
      <!-- §5.6: a shop with a list already written brings it in from a file.
           Vendors have no import file of their own, so the action is absent
           rather than offered and refused (UI-09). -->
      <button
        v-if="canCreate && role !== 'VENDOR'"
        type="button"
        class="btn btn-ghost"
        :disabled="isOffline"
        @click="router.push(`/import?type=${role === 'CUSTOMER' ? 'CUSTOMERS' : 'SUPPLIERS'}`)"
      >
        <i class="pi pi-upload" aria-hidden="true" />
        Import
      </button>
      <button
        v-if="canCreate"
        type="button"
        class="btn btn-primary"
        :disabled="isOffline"
        @click="adding = true"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        Add {{ NOUN[role] }}
      </button>
      <!--
        Owner decision 2026-08-31: greyed out and told why, never hidden.
        Hiding is for an action this person may not have; this one is simply
        waiting for the line to come back.
      -->
      <span v-if="isOffline" class="needs-internet">
        {{ NEEDS_INTERNET }}
        <span class="label-bn">{{ NEEDS_INTERNET_BN }}</span>
      </span>
    </template>

    <OfflineBar />

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
            @click="adding = true"
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
        <!--
          What the whole filtered set is worth (§2.7.I — same query as the rows,
          so a tile can never disagree with the table under it). Both totals show
          at once: netting them would hide a shop carrying large receivables and
          large advances behind a comfortable-looking difference.
        -->
        <div class="totals">
          <span class="total">
            <span class="total-label">Receivable <span class="sher-bn">পাবো</span></span>
            <strong class="balance-due">৳{{ Money(summary.totalOutstandingMinor).format() }}</strong>
          </span>
          <span class="total">
            <span class="total-label">Payable <span class="sher-bn">দিব</span></span>
            <strong class="balance-advance">৳{{ Money(summary.totalAdvanceMinor).format() }}</strong>
          </span>
          <span v-if="summary.overCreditLimit > 0" class="total">
            <span class="total-label">Over credit limit</span>
            <strong class="balance-due">{{ summary.overCreditLimit }}</strong>
          </span>
        </div>

        <!--
          The same five facts as a card, for a phone (§5.6's compact shape).
          A table scrolled sideways puts the balance off-screen, and the balance
          is what someone opened the list for — so on a narrow screen the row
          becomes a card with the name and the figure both in the first glance.
        -->
        <ul class="party-cards">
          <li
            v-for="party in parties"
            :key="party.id"
            class="party-card"
            :class="{ 'is-inactive': party.status === 'INACTIVE' }"
          >
            <span class="avatar" aria-hidden="true">{{ initials(party.name) }}</span>

            <div class="card-main">
              <button type="button" class="linkish name" @click="openParty(party)">
                {{ party.name }}
              </button>
              <span v-if="party.isSystemReserved" class="pill pill-info">Walk-in</span>
              <span
                v-for="other in party.roles.filter((value) => value !== role)"
                :key="other"
                class="pill pill-info other-role"
              >
                {{ other === 'CUSTOMER' ? 'Customer' : other === 'SUPPLIER' ? 'Supplier' : 'Vendor' }}
              </span>

              <p v-if="party.phone !== null" class="card-line mono">
                <i class="pi pi-phone" aria-hidden="true" /> {{ party.phone }}
              </p>
              <p v-if="party.address !== null" class="card-line">
                <i class="pi pi-map-marker" aria-hidden="true" /> {{ party.address }}
              </p>
            </div>

            <div class="card-balance">
              <span class="card-balance-label">
                {{ balanceLabelFor(party) }}
              </span>
              <button
                type="button"
                class="linkish balance"
                :class="balanceClass(party)"
                :title="`Open ${party.name}'s ledger`"
                @click="openLedger(party)"
              >
                {{ balanceAmountText(party) }}
              </button>
              <span v-if="overLimit(party)" class="pill pill-bad limit-pill">Over limit</span>
            </div>

            <button
              v-if="!party.isSystemReserved && (canEdit || canDeactivate)"
              type="button"
              class="row-menu-trigger card-menu"
              :aria-label="`Actions for ${party.name}`"
              aria-haspopup="menu"
              :disabled="isOffline"
              :title="isOffline ? NEEDS_INTERNET : ''"
              @click="openRowMenu($event, party)"
            >
              <i class="pi pi-ellipsis-v" aria-hidden="true" />
            </button>
          </li>
        </ul>

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
                <!--
                  The reason this list exists for most people (§5.0). Nobody
                  should have to open a ledger to learn whether a customer owes
                  money, so the balance is on the row, colour-coded by which way
                  it points and labelled in the words the shop uses.

                  Sortable now: "Current Due (High to Low)" is the first thing
                  anyone asks a customer list, and the repository orders by the
                  same rollup the cell shows, so the two cannot disagree.
                -->
                <SortableHeader
                  class="num"
                  column="balance"
                  :label="balanceHeading"
                  :label-bn="balanceHeadingBn"
                  :active="sort"
                  :direction="direction"
                  @sort="sortBy"
                />
                <th class="actions-col"><span class="sr-only">Actions</span></th>
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
                  <!--
                    D-04's other roles, as a marker rather than the column they
                    used to have: §5.6 fixes this grid at five columns, but "this
                    supplier is also a customer" is the one fact that changes how
                    a row is read, and losing it entirely would hide it until
                    someone opened the party.
                  -->
                  <span
                    v-for="other in party.roles.filter((value) => value !== role)"
                    :key="other"
                    class="pill pill-info other-role"
                    :title="`Also a ${NOUN[other]}`"
                  >
                    {{ other === 'CUSTOMER' ? 'Customer' : other === 'SUPPLIER' ? 'Supplier' : 'Vendor' }}
                  </span>
                </td>
                <td class="mono">{{ party.phone ?? '—' }}</td>
                <td class="address">{{ party.address ?? '—' }}</td>
                <td class="num">
                  <button
                    type="button"
                    class="linkish balance"
                    :class="balanceClass(party)"
                    :title="`Open ${party.name}'s ledger`"
                    @click="openLedger(party)"
                  >
                    {{ balanceText(party) }}
                  </button>
                  <!--
                    §5.6's credit limit is only useful at the moment it is
                    breached, so it is shown then and not otherwise.
                  -->
                  <span v-if="overLimit(party)" class="pill pill-bad limit-pill">Over limit</span>
                </td>
                <td class="actions">
                  <button
                    v-if="!party.isSystemReserved && (canEdit || canDeactivate)"
                    type="button"
                    class="row-menu-trigger"
                    :aria-label="`Actions for ${party.name}`"
                    aria-haspopup="menu"
                    :disabled="isOffline"
                    :title="isOffline ? NEEDS_INTERNET : ''"
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

    <!--
      UI-50 and §5.6: adding and editing a party happen in a modal over the
      preserved list. The form inside is `PartyFormPage` itself, embedded — the
      screen this dialog replaced was a second, smaller create form with its own
      fields and its own call to `createParty`, which meant two write paths for
      one business action and an opening balance that could only be entered on
      one of them (R-D, DRY).
    -->
    <Dialog
      v-model:visible="formOpen"
      modal
      :header="editing === null ? `Add ${NOUN[role]}` : editing.name"
      :style="{ width: 'min(48rem, 96vw)' }"
      :draggable="false"
    >
      <PartyFormPage
        v-if="formOpen"
        embedded
        :embedded-party-id="editing?.id ?? null"
        :embedded-role="role"
        @saved="onFormSaved"
        @close="closeForm"
      />
    </Dialog>

    <!--
      Setting or correcting an opening balance from the row (§5.6, §2.5).
      Correcting never edits the posted entry: the dialog explains that the
      change is posted as a reversal and a repost, because a shopkeeper who
      expects a silent edit would be surprised by two extra ledger rows.
    -->
    <PartyOpeningDialog
      v-if="openingFor !== null"
      :party="openingFor"
      :role="role"
      @saved="onOpeningSaved"
      @close="openingFor = null"
    />

    <!-- ------------------------------------------------------------- delete -->
    <div v-if="deleting !== null" class="scrim" @click.self="deleting = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Delete {{ deleting.name }}?</h2>
        <p>
          Nothing has been posted against this {{ NOUN[role] }}, so the record can be removed
          completely. This cannot be undone.
        </p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="deleting = null">
            Cancel
          </button>
          <button type="button" class="btn btn-danger" :disabled="busy" @click="removeParty">
            {{ busy ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>

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
/* Phase 12.3 — the note under a saving action that is waiting for the line. */
.needs-internet {
  display: grid;
  align-self: center;
  font-size: 12px;
  line-height: 1.2;
  color: var(--sher-text-muted);
}

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

/*
 * Colour carries the direction, but never alone: the row also says পাবো or দিব
 * in words, so the column still reads correctly for someone who cannot tell the
 * two colours apart (UI accessibility, and print).
 */
.balance {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Outstanding is the one that needs attention, so it is the loud one. */
.balance-due {
  color: var(--sher-bad-fg, #b91c1c);
}

.balance-advance {
  color: var(--sher-ok-fg, #15803d);
}

.balance-settled {
  color: var(--sher-muted-fg, #64748b);
  font-weight: 400;
}

.limit-pill {
  margin-inline-start: 0.375rem;
}

.totals {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  padding: 0.75rem 0.25rem;
}

.total {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  font-variant-numeric: tabular-nums;
}

.total-label {
  font-size: 0.8125rem;
  color: var(--sher-muted-fg, #64748b);
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

/*
 * The list as cards on a phone (§5.6's compact shape).
 *
 * One or the other is in the document at a time — the table scrolls sideways on
 * a narrow screen, which puts the balance out of sight, and the balance is the
 * reason the list was opened. Both render the same five facts from the same
 * data, so nothing is hidden on either.
 */
.party-cards {
  display: none;
  list-style: none;
  margin: 0;
  padding: 0;
}

/*
 * Four columns for four children. With three, the `⋯` button had nowhere to go
 * on the first row and grid placed it on a second one under the avatar, which
 * is what put the menu dots adrift at the bottom-left of every card.
 */
.party-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: var(--sher-space-3);
  align-items: start;
  padding: var(--sher-space-3);
  border: 1px solid var(--sher-border);
  border-radius: var(--sher-radius-md);
  background: var(--sher-surface);
}

.party-card + .party-card {
  margin-top: var(--sher-space-2);
}

.party-card.is-inactive {
  opacity: 0.65;
}

.avatar {
  display: grid;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  background: var(--sher-surface-muted);
  color: var(--sher-text-muted);
  font-weight: 600;
  font-size: var(--sher-text-sm);
}

.card-main {
  min-width: 0;
}

.card-main .name {
  font-weight: 600;
  text-align: left;
  /* A long shop name wraps rather than pushing the balance off the card. */
  overflow-wrap: anywhere;
}

.card-main .pill {
  margin-left: 6px;
}

.card-line {
  overflow-wrap: anywhere;
}

.card-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}

.card-balance {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  text-align: right;
}

.card-balance-label {
  font-size: 0.75rem;
  color: var(--sher-text-muted);
}

.card-menu {
  align-self: start;
}

@media (max-width: 720px) {
  .party-cards { display: block; }
  .table-wrap { display: none; }
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
