<script setup lang="ts">
import type { PartyResponse, PartyRoleValue, PartySetupResponse, SavePartyRequest } from '@sher/core-contracts';
import { Money, parseMoney, SystemClock, Ulid } from '@sher/shared-utils';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import {
  createCustomerGroup,
  createParty,
  deleteParty,
  EMPTY_PARTY_SETUP,
  fetchParty,
  fetchPartySetup,
  updateParty,
} from '../api/parties';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import QuickAddSelect from '../components/QuickAddSelect.vue';

/**
 * Add or edit a customer, supplier or vendor (Phase 2, §5.6, D-02, D-04) — a
 * Form screen (UI-22): single column, grouped fields, one save.
 *
 * **What is required depends on the roles ticked**, exactly as D-02 says: a
 * customer must have a phone number, a supplier need not. Nothing else is
 * mandatory, and G2.2 forbids making an optional field mandatory because a
 * column exists.
 *
 * **Optional customer fields are hidden, not disabled** (UI-09, §5.6): the
 * father/guardian name, NID, email, address and notes appear only while the shop
 * asks for them in Settings. A value already stored under a field that has since
 * been hidden is kept untouched by the server — hiding a field never erases
 * history.
 */
const clock = new SystemClock();
const session = useSession();
const route = useRoute();
const router = useRouter();

const partyId = computed(() => {
  const id = route.params['id'];
  return typeof id === 'string' && id !== 'new' ? id : null;
});
const isNew = computed(() => partyId.value === null);

const RIGHTS: Record<PartyRoleValue, { create: string; edit: string; deactivate: string }> = {
  CUSTOMER: {
    create: 'party.customer.create',
    edit: 'party.customer.edit',
    deactivate: 'party.customer.deactivate',
  },
  SUPPLIER: {
    create: 'party.supplier.create',
    edit: 'party.supplier.edit',
    deactivate: 'party.supplier.deactivate',
  },
  VENDOR: {
    create: 'party.vendor.create',
    edit: 'party.vendor.edit',
    deactivate: 'party.vendor.deactivate',
  },
};

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const formError = ref<{ code: string; message: string } | null>(null);
/** What just happened, shown above the form (UI-30: a toast is never the record). */
const notice = ref<string | null>(null);
const busy = ref(false);

const setup = ref<PartySetupResponse>(EMPTY_PARTY_SETUP);
const version = ref(1);
const isSystemReserved = ref(false);

const roles = ref<PartyRoleValue[]>(['CUSTOMER']);
const name = ref('');
const phone = ref('');
const address = ref('');
const guardianName = ref('');
const nid = ref('');
const email = ref('');
const notes = ref('');
const customerGroupId = ref('');
const creditLimit = ref('');

/**
 * One operation id per user intent (UI-34): generated when the form opens and
 * reused on every retry of the same save, so a resubmitted create is recognised
 * as the same one rather than creating a second record.
 */
const operationId = ref(Ulid.generate(clock));

const isCustomer = computed(() => roles.value.includes('CUSTOMER'));

/** Roles the caller may put on a record at all — never a tick-box that 403s. */
const offerableRoles = computed(() =>
  (['CUSTOMER', 'SUPPLIER', 'VENDOR'] as PartyRoleValue[]).filter((role) => {
    if (role === 'VENDOR' && !setup.value.features.vendors) return false;
    if (roles.value.includes(role)) return true;
    return session.can(RIGHTS[role].create);
  }),
);

const canSave = computed(() =>
  isNew.value
    ? roles.value.every((role) => session.can(RIGHTS[role].create))
    : roles.value.some((role) => session.can(RIGHTS[role].edit)),
);
const canDelete = computed(
  () => !isNew.value && roles.value.some((role) => session.can(RIGHTS[role].deactivate)),
);

/*
 * D-39 / UI-45 — quick add from the point of use. The same use case the Parties
 * screen's group editor calls, so there is one write path and one audit trail.
 */
const canManageGroups = computed(() => session.can('party.group.manage'));

async function addGroup(name: string): Promise<string> {
  const known = new Set(setup.value.groups.map((group) => group.id));
  const updated = await createCustomerGroup(session.accessToken.value ?? '', name);
  setup.value = updated;

  const created = updated.groups.find((group) => !known.has(group.id));
  if (created === undefined) throw new Error('The group list did not come back with the new group');
  return created.id;
}

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

/** Minor units back to the text a person edits — via shared-utils (UI-31). */
function moneyText(minor: number | null): string {
  return minor === null ? '' : Money(minor).format().replace(/,/g, '');
}

function fill(party: PartyResponse): void {
  roles.value = [...party.roles];
  name.value = party.name;
  phone.value = party.phone ?? '';
  address.value = party.address ?? '';
  guardianName.value = party.guardianName ?? '';
  nid.value = party.nid ?? '';
  email.value = party.email ?? '';
  notes.value = party.notes ?? '';
  customerGroupId.value = party.customerGroupId ?? '';
  creditLimit.value = moneyText(party.creditLimitMinor);
  version.value = party.version;
  isSystemReserved.value = party.isSystemReserved;
}

onMounted(async () => {
  loading.value = true;
  try {
    setup.value = await fetchPartySetup(session.accessToken.value ?? '');

    if (partyId.value !== null) {
      fill(await fetchParty(session.accessToken.value ?? '', partyId.value));
    } else {
      // The tab the person came from decides what they are adding (§5.6).
      const wanted = route.query['role'];
      const asRole =
        wanted === 'SUPPLIER' || wanted === 'VENDOR' ? (wanted as PartyRoleValue) : 'CUSTOMER';
      roles.value = [asRole];
    }
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
});

function toggleRole(role: PartyRoleValue): void {
  roles.value = roles.value.includes(role)
    ? roles.value.filter((value) => value !== role)
    : [...roles.value, role];
}

/* -------------------------------------------------------------- saving */

const canSubmit = computed(
  () =>
    !busy.value &&
    canSave.value &&
    !isSystemReserved.value &&
    roles.value.length > 0 &&
    name.value.trim() !== '' &&
    (!isCustomer.value || phone.value.trim() !== ''),
);

/**
 * Turns what was typed into the request, in minor units.
 *
 * A credit limit that is not a number returns `null` from `parseMoney` and this
 * stops with a message — never a silently rounded or coerced value (R-C3).
 */
function toRequest(): SavePartyRequest | null {
  const limitMinor = creditLimit.value.trim() === '' ? null : parseMoney(creditLimit.value);
  if (creditLimit.value.trim() !== '' && limitMinor === null) {
    formError.value = {
      code: 'VALIDATION_FAILED',
      message: 'Enter the credit limit as an amount, with at most two decimal places',
    };
    return null;
  }

  const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

  return {
    name: name.value.trim(),
    roles: [...roles.value],
    phone: blank(phone.value),
    address: blank(address.value),
    guardianName: blank(guardianName.value),
    nid: blank(nid.value),
    email: blank(email.value),
    notes: blank(notes.value),
    customerGroupId: isCustomer.value && customerGroupId.value !== '' ? customerGroupId.value : null,
    creditLimitMinor: isCustomer.value ? limitMinor : null,
  };
}

async function save(): Promise<void> {
  formError.value = null;
  const payload = toRequest();
  if (payload === null) return;

  busy.value = true;
  try {
    if (partyId.value === null) {
      const created = await createParty(
        session.accessToken.value ?? '',
        payload,
        operationId.value,
      );
      // UI-36: land on the saved record, showing what the server actually stored.
      await router.push(`/parties/${created.id}`);
    } else {
      const saved = await updateParty(session.accessToken.value ?? '', partyId.value, {
        ...payload,
        version: version.value,
      });
      fill(saved);
      notice.value = 'Changes saved.';
    }
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

const confirmingDelete = ref(false);

async function remove(): Promise<void> {
  if (partyId.value === null) return;
  busy.value = true;
  formError.value = null;
  try {
    await deleteParty(session.accessToken.value ?? '', partyId.value);
    await router.push('/parties');
  } catch (cause) {
    formError.value = describe(cause);
    confirmingDelete.value = false;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppShell
    :title="isNew ? 'Add a record' : name"
    :breadcrumb="['Dashboard', 'Customers & Suppliers', isNew ? 'New' : name]"
    help-bn="নাম আর ফোন নম্বর দিলেই ক্রেতা যোগ হয়ে যাবে"
  >
    <div v-if="loading" class="skeleton skeleton-form" aria-busy="true" aria-label="Loading" />

    <AppCard v-else-if="loadError !== null" title="Could not open this record">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost" @click="router.push('/parties')">
        Back to the list
      </button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

      <!--
        D-02's walk-in party. It is shown, because hiding a record that every
        counter sale points at would be worse, but nothing about it is editable.
      -->
      <p v-if="isSystemReserved" class="notice is-info" role="status">
        This is the walk-in customer. Fully paid counter sales are recorded against it, so it
        cannot be renamed, deactivated or removed.
      </p>

      <AppCard title="Who this is">
        <ErrorNotice
          v-if="formError !== null"
          :code="formError.code"
          :message="formError.message"
        />

        <form class="form" @submit.prevent="save">
          <fieldset class="roles" :disabled="isSystemReserved">
            <legend>This record is a</legend>
            <label v-for="role in offerableRoles" :key="role" class="check">
              <input
                type="checkbox"
                :checked="roles.includes(role)"
                :aria-label="role"
                @change="toggleRole(role)"
              />
              {{ role === 'CUSTOMER' ? 'Customer' : role === 'SUPPLIER' ? 'Supplier' : 'Vendor' }}
            </label>
            <p class="fine">
              One person can be more than one. A supplier you also sell to is one record with
              both ticked — not two records with two balances.
            </p>
          </fieldset>

          <div class="field">
            <label for="party-name">Name</label>
            <input
              id="party-name"
              v-model="name"
              type="text"
              required
              :disabled="isSystemReserved"
              placeholder="Karim Uddin"
            />
          </div>

          <div class="field">
            <label for="party-phone">
              Phone
              <span v-if="isCustomer" class="req">required</span>
              <span v-else class="fine">optional</span>
            </label>
            <input
              id="party-phone"
              v-model="phone"
              type="tel"
              :required="isCustomer"
              :disabled="isSystemReserved"
              placeholder="01712345678"
            />
            <p v-if="isCustomer" class="fine">
              A customer is found by their phone number at the counter, so every customer needs
              one and no two customers may share it.
            </p>
          </div>

          <div v-if="setup.fields.address" class="field">
            <label for="party-address">Address</label>
            <textarea
              id="party-address"
              v-model="address"
              rows="2"
              :disabled="isSystemReserved"
            />
          </div>

          <div v-if="setup.fields.guardianName" class="field">
            <label for="party-guardian">Father's or guardian's name</label>
            <input
              id="party-guardian"
              v-model="guardianName"
              type="text"
              :disabled="isSystemReserved"
            />
          </div>

          <div v-if="setup.fields.nid" class="field">
            <label for="party-nid">NID number</label>
            <input id="party-nid" v-model="nid" type="text" :disabled="isSystemReserved" />
          </div>

          <div v-if="setup.fields.email" class="field">
            <label for="party-email">Email</label>
            <input id="party-email" v-model="email" type="email" :disabled="isSystemReserved" />
          </div>

          <template v-if="isCustomer">
            <!-- D-39 / UI-45: file them into a new group without leaving the form. -->
            <QuickAddSelect
              v-if="setup.features.customerGroups"
              v-model="customerGroupId"
              field-id="party-group"
              label="Customer group"
              empty-label="No group"
              :options="setup.groups"
              :can-add="canManageGroups"
              add-label="New group"
              add-placeholder="Dealer"
              :disabled="isSystemReserved"
              :create="addGroup"
            />

            <div class="field">
              <label for="party-credit">Credit limit</label>
              <input
                id="party-credit"
                v-model="creditLimit"
                type="text"
                inputmode="decimal"
                :disabled="isSystemReserved"
                placeholder="Leave empty for no limit"
              />
              <p class="fine">
                How much this customer may owe at once. Empty means no limit; 0 means no credit at
                all. It starts being checked when selling arrives.
              </p>
            </div>
          </template>

          <div v-if="setup.fields.notes" class="field">
            <label for="party-notes">Notes</label>
            <textarea id="party-notes" v-model="notes" rows="3" :disabled="isSystemReserved" />
          </div>

          <div class="form-actions">
            <button type="button" class="btn btn-ghost" @click="router.push('/parties')">
              Cancel
            </button>
            <button
              v-if="canDelete && !isSystemReserved"
              type="button"
              class="btn btn-ghost danger"
              @click="confirmingDelete = true"
            >
              Delete
            </button>
            <button type="submit" class="btn btn-primary" :disabled="!canSubmit">
              {{ busy ? 'Saving…' : isNew ? 'Save' : 'Save changes' }}
            </button>
          </div>

          <p v-if="!canSave" class="fine">
            Your role cannot save this record. Ask the owner if you need to.
          </p>
        </form>
      </AppCard>

      <AppCard v-if="!isNew" title="History and balance">
        <p class="lede">
          Sales, purchases, payments, returns and the running balance appear here once those
          modules exist. They are read from the ledger every time, never stored on this record —
          which is what keeps the balance and the accounts from ever disagreeing.
        </p>
      </AppCard>
    </template>

    <div v-if="confirmingDelete" class="scrim" @click.self="confirmingDelete = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Delete {{ name }}?</h2>
        <p class="lede">
          This removes the record completely. It only works while nothing refers to them — once
          they have an invoice or a payment, deactivate them instead so the history survives.
        </p>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="busy"
            @click="confirmingDelete = false"
          >
            Cancel
          </button>
          <button type="button" class="btn btn-danger" :disabled="busy" @click="remove">
            {{ busy ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
/* Fields, buttons, cards and dialogs come from `design/components.css`. */
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
  max-width: 560px;
}

.roles {
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  padding: var(--sher-space-3) var(--sher-space-4);
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-4);
  align-items: center;
}

.roles legend {
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
  padding: 0 6px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--sher-text-base);
}

.roles .fine {
  flex-basis: 100%;
  margin: 0;
}

.req {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
  margin-left: 6px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-3);
  margin-top: var(--sher-space-2);
}

.skeleton-form {
  height: 420px;
}
</style>
