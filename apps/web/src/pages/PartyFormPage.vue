<script setup lang="ts">
import type { PartyResponse, PartyRoleValue, PartySetupResponse, SavePartyRequest } from '@sher/core-contracts';
import { Money, parseMoney, SystemClock, Ulid } from '@sher/shared-utils';
import { computed, onMounted, ref, watch } from 'vue';
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
import HelpTip from '../components/HelpTip.vue';
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
/**
 * **The same form, hosted two ways** (UI-50).
 *
 * §5.6 and UI-50 both say master data is added and edited in a modal over its
 * list, so the shopkeeper keeps their place and the new row appears behind the
 * dialog as its own confirmation. But a party still needs a URL — a bookmark, a
 * link in a message, a deep link from search — so the route survives too.
 *
 * Rather than write the form twice, it takes its identity from props when a
 * dialog embeds it and from the route when it is the page. One write path, one
 * set of validations, one place to fix a bug (R-D, DRY).
 */
const props = withDefaults(
  defineProps<{
    /** True when hosted inside a dialog: no shell, no chrome, emits instead of navigating. */
    embedded?: boolean;
    /** The party being edited, or `null`/absent to add one. Embedded mode only. */
    embeddedPartyId?: string | null;
    /** Which list opened it, so a new party is created under the right role. */
    embeddedRole?: PartyRoleValue;
    /** Embedded add/edit always opens ready to type; the page defers to `?mode=`. */
    embeddedEditing?: boolean;
  }>(),
  { embedded: false, embeddedPartyId: null, embeddedRole: 'CUSTOMER', embeddedEditing: true },
);

const emit = defineEmits<{
  /** A save landed. The host closes and refreshes its list from the server. */
  (event: 'saved', party: PartyResponse): void;
  (event: 'close'): void;
}>();

const clock = new SystemClock();
const session = useSession();
const route = useRoute();
const router = useRouter();

const partyId = computed(() => {
  if (props.embedded) return props.embeddedPartyId;
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

/*
 * The opening balance (§5.0, §5.6) — what this party already owed, or was
 * already owed, on the day the shop moved onto SherERP.
 *
 * Create-only, and deliberately so: this posts a real journal entry, and §2.5
 * corrects a posted entry by reversing and reposting it rather than by editing
 * the form that made it. `openingRole` defaults to the role the list was on,
 * which is the one a shopkeeper adding "a supplier" means.
 */
const openingAmount = ref('');
const openingDirection = ref<'RECEIVABLE' | 'PAYABLE'>('RECEIVABLE');
const openingRole = ref<PartyRoleValue>('CUSTOMER');
const openingDate = ref(clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone));

/**
 * One operation id per user intent (UI-34): generated when the form opens and
 * reused on every retry of the same save, so a resubmitted create is recognised
 * as the same one rather than creating a second record.
 */
const operationId = ref(Ulid.generate(clock));

const isCustomer = computed(() => roles.value.includes('CUSTOMER'));

/*
 * Keep the opening's role among the ones the party actually holds — the server
 * refuses an opening for a role the party does not have, and the shopkeeper
 * should never be able to aim at one. Unticking a role while its opening was
 * selected falls back to the first remaining role rather than leaving a stale
 * selection pointing at nothing.
 *
 * A vendor can only ever be owed money, so the direction follows.
 */
watch(
  roles,
  (held) => {
    if (!held.includes(openingRole.value)) openingRole.value = held[0] ?? 'CUSTOMER';
    if (openingRole.value === 'VENDOR') openingDirection.value = 'PAYABLE';
  },
  { immediate: true, deep: true },
);

watch(openingRole, (value) => {
  if (value === 'VENDOR') openingDirection.value = 'PAYABLE';
});

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
const isEditing = computed(() =>
  props.embedded ? props.embeddedEditing : isNew.value || route.query['mode'] === 'edit',
);
const fieldsDisabled = computed(() => isSystemReserved.value || !isEditing.value);

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
      const wanted = props.embedded ? props.embeddedRole : route.query['role'];
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
    isEditing.value &&
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

  /*
   * The opening balance (§5.0, §5.6). Blank means no opening, which is the
   * normal case for a party added after go-live — it is not the same as an
   * opening of zero, and the server refuses zero rather than posting a document
   * that moves nothing.
   */
  let openingMinor = 0;
  if (openingAmount.value.trim() !== '') {
    const parsed = parseMoney(openingAmount.value);
    if (parsed === null || parsed <= 0) {
      formError.value = {
        code: 'VALIDATION_FAILED',
        message: 'Enter the opening balance as an amount greater than zero',
      };
      return null;
    }
    openingMinor = parsed;
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
    opening: openingMinor === 0 ? null : {
      role: openingRole.value,
      direction: openingDirection.value,
      amountMinor: openingMinor,
      businessDate: openingDate.value,
    },
  };
}

async function save(): Promise<void> {
  formError.value = null;

  /*
   * The submit button being disabled is not the guard — pressing Enter in a text
   * field submits the form without going near it. Without this check a customer
   * with no phone reaches the server, which refuses it correctly (D-02) but as a
   * round trip and a server error code, where the shopkeeper deserves to be told
   * on the spot which field is missing.
   */
  if (!canSubmit.value) {
    formError.value = {
      code: 'VALIDATION_FAILED',
      message: isCustomer.value && phone.value.trim() === ''
        ? 'A customer needs a phone number — it is how the same person is recognised next time'
        : 'Fill in the name before saving',
    };
    return;
  }

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
      if (props.embedded) {
        // UI-50: the dialog closes and the row appears behind it, which is the
        // confirmation. Navigating away would be the thing the modal exists to
        // avoid.
        emit('saved', created);
        return;
      }
      // UI-36: land on the saved record, showing what the server actually stored.
      await router.push(`/parties/${created.id}`);
    } else {
      // An edit never carries an opening (§2.5 — a posted document is corrected
      // by reversing and reposting, not by rewriting). The edit form does not
      // offer the fields, and the request schema refuses them outright.
      const { opening: _opening, ...editable } = payload;
      const saved = await updateParty(session.accessToken.value ?? '', partyId.value, {
        ...editable,
        version: version.value,
      });
      fill(saved);
      if (props.embedded) {
        emit('saved', saved);
        return;
      }
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
    if (props.embedded) {
      emit('close');
      return;
    }
    await router.push({ path: '/parties', query: { role: roles.value[0] ?? 'CUSTOMER' } });
  } catch (cause) {
    formError.value = describe(cause);
    confirmingDelete.value = false;
  } finally {
    busy.value = false;
  }
}

function backToList(): void {
  if (props.embedded) {
    emit('close');
    return;
  }
  void router.push({ path: '/parties', query: { role: roles.value[0] ?? 'CUSTOMER' } });
}

function editProfile(): void {
  if (partyId.value !== null) void router.push({ path: `/parties/${partyId.value}`, query: { role: roles.value[0] ?? 'CUSTOMER', mode: 'edit' } });
}
</script>

<template>
  <!--
    Embedded (UI-50): the dialog already carries the title and the surrounding
    list is still on screen, so a second shell, breadcrumb and page heading
    inside it would be chrome about chrome.
  -->
  <component
    :is="embedded ? 'div' : AppShell"
    :class="embedded ? 'party-form-embedded' : undefined"
    :title="isNew ? 'Add a record' : name"
    :breadcrumb="['Dashboard', roles[0] === 'SUPPLIER' ? 'Suppliers' : roles[0] === 'VENDOR' ? 'Vendors' : 'Customers', isNew ? 'New' : name]"
    help-bn="নাম আর ফোন নম্বর দিলেই ক্রেতা যোগ হয়ে যাবে"
  >
    <template v-if="!embedded && !isNew && !isEditing && canSave && !isSystemReserved" #actions>
      <button type="button" class="btn btn-primary" @click="editProfile">
        <i class="pi pi-pencil" aria-hidden="true" /> Edit details
      </button>
    </template>
    <div v-if="loading" class="skeleton skeleton-form" aria-busy="true" aria-label="Loading" />

    <AppCard v-else-if="loadError !== null" title="Could not open this record">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost" @click="backToList">
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

      <section class="party-fields">
        <ErrorNotice
          v-if="formError !== null"
          :code="formError.code"
          :message="formError.message"
        />

        <form class="form" @submit.prevent="save">
          <!--
            The order a shopkeeper thinks in, set by the owner 2026-08-19:
            who they are, how to reach them, where they are. Everything a
            record can exist without is folded below (UI-50).
          -->
          <div class="field">
            <label for="party-name">
              Name
              <span class="label-bn">নাম</span>
            </label>
            <input
              id="party-name"
              v-model="name"
              type="text"
              required
              :disabled="fieldsDisabled"
              placeholder="Karim Uddin"
            />
          </div>


          <div class="row">
            <div v-if="setup.fields.guardianName" class="field">
              <label for="party-guardian">
                Father&apos;s or guardian&apos;s name
                <span class="label-bn">বাবার বা অভিভাবকের নাম</span>
              </label>
              <input
                id="party-guardian"
                v-model="guardianName"
                type="text"
                :disabled="fieldsDisabled"
              />
            </div>
  

            <div class="field">
              <label for="party-phone">
                Phone
                <span v-if="isCustomer" class="req">required</span>
                <span v-else class="fine">optional</span>
                <span class="label-bn">মোবাইল নম্বর</span>
              </label>
              <input
                id="party-phone"
                v-model="phone"
                type="tel"
                :required="isCustomer"
                :disabled="fieldsDisabled"
                placeholder="01712345678"
              />
              <p v-if="isCustomer" class="fine">
                A customer is found by their phone number at the counter, so every customer needs
                one and no two customers may share it.
              </p>
            </div>
  
          </div>

          <div v-if="setup.fields.address" class="field">
            <label for="party-address">
              Address
              <span class="label-bn">ঠিকানা</span>
            </label>
            <textarea
              id="party-address"
              v-model="address"
              rows="2"
              :disabled="fieldsDisabled"
            />
          </div>


          <details class="more-details" :open="formError !== null">
            <summary>More details <span class="label-bn">আরও তথ্য</span></summary>
            <fieldset class="roles" :disabled="fieldsDisabled">
              <legend>
                This record is a
                <span class="label-bn">এই মানুষটি কী হিসেবে থাকবেন</span>
              </legend>
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
  

            <div v-if="setup.fields.nid" class="field">
              <label for="party-nid">
                NID number
                <span class="label-bn">জাতীয় পরিচয়পত্র নম্বর</span>
                <HelpTip
                  label="NID number"
                  text="Optional. If your shop stops asking for this in Settings later, whatever you have already saved stays — hiding a field never erases what is stored."
                  text-bn="না দিলেও চলবে। পরে সেটিংসে এই ঘরটি বন্ধ করলেও আগে যা সেভ করা আছে তা মুছে যাবে না।"
                />
              </label>
              <input id="party-nid" v-model="nid" type="text" :disabled="fieldsDisabled" />
            </div>
  
            <div v-if="setup.fields.email" class="field">
              <label for="party-email">
                Email
                <span class="label-bn">ইমেইল</span>
              </label>
              <input id="party-email" v-model="email" type="email" :disabled="fieldsDisabled" />
            </div>
  
            <template v-if="isCustomer">
              <!-- D-39 / UI-45: file them into a new group without leaving the form. -->
              <QuickAddSelect
                v-if="setup.features.customerGroups"
                v-model="customerGroupId"
                field-id="party-group"
                label="Customer group"
                label-bn="কোন দলে রাখবেন"
                empty-label="No group"
                :options="setup.groups"
                :can-add="canManageGroups"
                add-placeholder="e.g. Dealer"
                :disabled="fieldsDisabled"
                :create="addGroup"
              />
  
              <div class="field">
                <label for="party-credit">
                  Credit limit
                  <span class="label-bn">সর্বোচ্চ কত টাকা বাকি দেওয়া যাবে</span>
                  <HelpTip
                    label="Credit limit"
                    text="The most this customer may owe you at once. It is a limit you set, not money they owe — their actual due is worked out from their sales and payments."
                    text-bn="এই কাস্টমার সর্বোচ্চ কত টাকা বাকি রাখতে পারবেন, সেই সীমা। এটি তাঁর বকেয়া নয় — বকেয়া হিসাব হয় বেচাকেনা আর জমা থেকে।"
                  />
                </label>
                <input
                  id="party-credit"
                  v-model="creditLimit"
                  type="text"
                  inputmode="decimal"
                  :disabled="fieldsDisabled"
                  placeholder="Leave empty for no limit"
                />
                <p class="fine">
                  How much this customer may owe at once. Empty means no limit; 0 means no credit at
                  all. It starts being checked when selling arrives.
                </p>
              </div>
            </template>
  
            <div v-if="setup.fields.notes" class="field">
              <label for="party-notes">
                Description
                <span class="label-bn">এই পক্ষ সম্পর্কে কোনো তথ্য</span>
              </label>
              <textarea id="party-notes" v-model="notes" rows="3" :disabled="fieldsDisabled" />
            </div>

            <!--
              §5.0's opening balance. Only on create: this posts a journal entry,
              and a posted entry is corrected by reversing and reposting it
              (§2.5), never by retyping it on an edit form. Correcting one
              afterwards is `PartyOpeningDialog`, from the row menu or the hub.

              `isNew`, not `!isEditing`: `isEditing` is true while adding, so the
              earlier guard hid this field on the one screen it exists for, and
              showed it — disabled and useless — when viewing a saved party.
            -->
            <template v-if="isNew">
              <div class="field">
                <label for="party-opening">
                  Opening balance
                  <span class="label-bn">আগে থেকে যত টাকা বাকি আছে</span>
                  <HelpTip
                    label="Opening balance"
                    text="What this party already owed — or was already owed — on the day you started using SherERP. Leave it empty for someone new. It is posted as a real entry, so it shows up in their ledger with everything else."
                    text-bn="আপনি সফটওয়্যার চালু করার দিন এই পক্ষের কাছে যত টাকা পেতেন বা দিতেন। নতুন কারও ক্ষেত্রে খালি রাখুন। এটি নিয়মিত এন্ট্রি হিসেবে জমা হয়, তাই খাতায় বাকি সবকিছুর সঙ্গেই দেখা যাবে।"
                  />
                </label>
                <div class="opening-row">
                  <input
                    id="party-opening"
                    v-model="openingAmount"
                    type="text"
                    inputmode="decimal"
                    :disabled="fieldsDisabled"
                    placeholder="Leave empty if none"
                  />
                  <select v-model="openingDirection" :disabled="fieldsDisabled" aria-label="Direction">
                    <option value="RECEIVABLE">I will receive (পাবো)</option>
                    <option value="PAYABLE">I will pay (দিব)</option>
                  </select>
                </div>
              </div>

              <template v-if="openingAmount.trim() !== ''">
                <!--
                  Which relationship the opening belongs to. Only asked when a
                  party holds more than one role (D-04) — otherwise the answer
                  is not in doubt and the question is noise.
                -->
                <div v-if="roles.length > 1" class="field">
                  <label for="party-opening-role">Opening balance is for</label>
                  <select
                    id="party-opening-role"
                    v-model="openingRole"
                    :disabled="fieldsDisabled"
                  >
                    <option v-for="held in roles" :key="held" :value="held">
                      {{ held === 'CUSTOMER' ? 'Customer' : held === 'SUPPLIER' ? 'Supplier' : 'Vendor' }}
                    </option>
                  </select>
                </div>

                <div class="field">
                  <label for="party-opening-date">
                    As on
                    <span class="label-bn">কোন তারিখ পর্যন্ত</span>
                  </label>
                  <input
                    id="party-opening-date"
                    v-model="openingDate"
                    type="date"
                    :disabled="fieldsDisabled"
                  />
                  <p class="fine">
                    Usually the day you started using SherERP. It cannot be a future date.
                  </p>
                </div>
              </template>
            </template>

          </details>

          <!-- Saving is never folded away: it is the point of the screen. -->
          <div class="form-actions">
            <button type="button" class="btn btn-ghost" @click="backToList">
              {{ isEditing ? 'Cancel' : 'Back to list' }}
            </button>
            <button
              v-if="isEditing && canDelete && !isSystemReserved"
              type="button"
              class="btn btn-ghost danger"
              @click="confirmingDelete = true"
            >
              Delete
            </button>
            <button v-if="isEditing" type="submit" class="btn btn-primary" :disabled="!canSubmit">
              {{ busy ? 'Saving…' : isNew ? 'Save' : 'Save changes' }}
            </button>
          </div>

          <p v-if="!canSave" class="fine">
            Your role cannot save this record. Ask the owner if you need to.
          </p>
        </form>
      </section>

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
  </component>
</template>

<style scoped>
/* Fields, buttons, cards and dialogs come from `design/components.css`. */
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
  max-width: 560px;
}

.party-fields {
  max-width: 640px;
}

.more-details {
  padding-top: var(--sher-space-2);
  border-top: 1px solid var(--sher-line);
}

.more-details > summary {
  margin-bottom: var(--sher-space-4);
  color: var(--p-primary-color);
  font-weight: 600;
  cursor: pointer;
}

.more-details[open] {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
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
/*
 * Amount and direction read as one control, because they are one fact: an
 * amount without its direction is meaningless, and putting them on separate
 * rows invites filling in one and not the other.
 */
.opening-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.opening-row input {
  flex: 1 1 8rem;
  min-width: 0;
}
</style>
