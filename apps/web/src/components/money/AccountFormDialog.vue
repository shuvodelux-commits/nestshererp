<script setup lang="ts">
import type { MoneyAccountResponse, MoneyAccountTypeValue } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Checkbox from 'primevue/checkbox';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { createAccount, updateAccount } from '../../api/money';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import { parseTaka, taka } from './money-text';

/**
 * Adding or correcting a money account (§5.16, §5.17).
 *
 * A dialog rather than a page: it is four fields the shop fills once at setup,
 * and sending someone to a screen of their own to type a name loses the list
 * they were looking at.
 *
 * **The opening balance is here** (owner decision 2026-08-24: typed, not
 * imported). It is not a column on the account — saving posts a document
 * against `OPENING_EQUITY`, and changing it later posts the §2.5 delta beside
 * the original. The form says so once the opening exists, because a shopkeeper
 * who expected a silent edit and then finds two rows in the statement trusts
 * the statement less, not more.
 */
const props = defineProps<{ account: MoneyAccountResponse | null; startType: MoneyAccountTypeValue }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'saved'): void }>();

const session = useSession();
const clock = new SystemClock();

const isNew = computed(() => props.account === null);

const name = ref('');
const type = ref<MoneyAccountTypeValue>('CASH');
const holderName = ref('');
const reference = ref('');
const isDrawer = ref(false);
const openingAmount = ref('');
const openingDate = ref('');
const version = ref(1);
const hadOpening = ref(false);

const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const typeOptions = [
  { value: 'CASH', label: 'Cash — ক্যাশ' },
  { value: 'BANK', label: 'Bank — ব্যাংক' },
  { value: 'MFS', label: 'bKash / Nagad — মোবাইল ব্যাংকিং' },
  { value: 'LOAN', label: 'Loan — ঋণ' },
];

/** Only cash can be counted at night, so only cash can be the drawer. */
const isCash = computed(() => type.value === 'CASH');

/**
 * A loan is money the shop **owes**, so the same three fields mean the opposite
 * thing and the form says so: the holder is the lender, and the opening figure
 * is what is still owed rather than what is held. The type is fixed when the
 * dialog is opened from Manage Loan Accounts — a loan is not something a
 * shopkeeper turns into a bank account by changing a dropdown.
 */
const isLoan = computed(() => type.value === 'LOAN');
const openingMinor = computed(() => parseTaka(openingAmount.value) ?? 0);
const openingIsSet = computed(() => openingMinor.value > 0);

const heading = computed(() => {
  if (!isNew.value) return isLoan.value ? 'Edit loan account' : 'Edit account';
  if (isLoan.value) return 'Add loan account';
  return isCash.value ? 'Add cash account' : 'Add bank account';
});

/** A drawer has no account number and is in nobody's name — the counter's box. */
const wantsHolder = computed(() => !isCash.value || !isDrawer.value);

const canSave = computed(
  () => name.value.trim() !== '' && !busy.value && (!openingIsSet.value || openingDate.value !== ''),
);

// A fresh intent gets a fresh idempotency key (UI-34): reusing the last one
// would make a second, genuinely different account look like a retry.
watch(
  () => [props.account?.id, props.startType] as const,
  () => {
    const account = props.account;
    name.value = account?.name ?? '';
    type.value = account?.type ?? props.startType;
    holderName.value = account?.holderName ?? '';
    reference.value = account?.reference ?? '';
    isDrawer.value = account?.isDrawer ?? false;
    openingAmount.value =
      account == null || account.openingAmountMinor === null
        ? ''
        : String(account.openingAmountMinor / 100);
    openingDate.value = account?.openingDate ?? '';
    version.value = account?.version ?? 1;
    hadOpening.value = account != null && account.openingAmountMinor !== null;
    failure.value = null;
    operationId.value = Ulid.generate(clock);
  },
  { immediate: true },
);

async function save(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  busy.value = true;
  failure.value = null;

  const payload = {
    name: name.value.trim(),
    type: type.value,
    holderName: holderName.value.trim() === '' ? null : holderName.value.trim(),
    reference: reference.value.trim() === '' ? null : reference.value.trim(),
    isDrawer: isCash.value && isDrawer.value,
    openingAmountMinor: openingMinor.value,
    openingDate: openingIsSet.value && openingDate.value !== '' ? openingDate.value : null,
  };

  try {
    if (props.account === null) {
      await createAccount(token, { ...payload, operationId: operationId.value });
    } else {
      await updateAccount(token, props.account.id, { ...payload, version: version.value });
    }
    emit('saved');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not save the account' };
    operationId.value = Ulid.generate(clock);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    :draggable="false"
    :style="{ width: 'min(38rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="head">
        <span class="head-en">{{ heading }}</span>
        <span class="head-bn sher-bn">টাকা কোথায় রাখা হয় — নাম, ধরন ও শুরুর টাকা</span>
      </div>
    </template>

    <form class="account-form" @submit.prevent="save">
      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <div class="grid">
        <div class="field">
          <label for="account-name">Name <span class="label-bn">নাম</span></label>
          <input
            id="account-name"
            v-model="name"
            maxlength="80"
            autocomplete="off"
            :placeholder="isCash ? 'Cash drawer' : 'City Bank — main account'"
          />
        </div>

        <div class="field">
          <label for="account-type">Type <span class="label-bn">ধরন</span></label>
          <Select
            v-model="type"
            input-id="account-type"
            :options="typeOptions"
            option-label="label"
            option-value="value"
            append-to="self"
            :disabled="startType === 'LOAN'"
            fluid
          />
        </div>
      </div>

      <label v-if="isCash" class="drawer-toggle">
        <Checkbox v-model="isDrawer" :binary="true" input-id="is-drawer" />
        <span>
          <strong>This is the drawer counted at the end of each day</strong>
          <span class="sher-bn">প্রতিদিন যে ড্রয়ার গোনা হয়</span>
        </span>
      </label>

      <div v-if="wantsHolder" class="grid">
        <div class="field">
          <label for="account-holder">
            <template v-if="isLoan">Lender <span class="label-bn">কার কাছ থেকে ঋণ</span></template>
            <template v-else>In the name of <span class="label-bn">কার নামে</span></template>
          </label>
          <input
            id="account-holder"
            v-model="holderName"
            maxlength="80"
            autocomplete="off"
            :placeholder="isLoan ? 'Dutch-Bangla Bank' : 'Optional'"
          />
        </div>

        <div class="field">
          <label for="account-reference">
            <template v-if="isLoan">Loan number <span class="label-bn">ঋণের নম্বর</span></template>
            <template v-else>Account or phone number <span class="label-bn">নম্বর</span></template>
          </label>
          <input
            id="account-reference"
            v-model="reference"
            maxlength="64"
            autocomplete="off"
            :placeholder="type === 'MFS' ? '01XXXXXXXXX' : 'Optional'"
          />
        </div>
      </div>

      <div class="grid opening">
        <div class="field">
          <label for="account-opening">
            <template v-if="isLoan">
              Amount still owed <span class="label-bn">এখনো কত বাকি</span>
            </template>
            <template v-else>Opening balance <span class="label-bn">শুরুর টাকা</span></template>
          </label>
          <input
            id="account-opening"
            v-model="openingAmount"
            inputmode="decimal"
            autocomplete="off"
            placeholder="0"
          />
          <p class="hint">
            <template v-if="isLoan">
              <template v-if="openingIsSet">
                {{ taka(openingMinor) }} still owed on the day this figure is true from. Leave it
                empty for a loan that has not been drawn yet.
              </template>
              <template v-else>
                What is still owed today. Money received later is recorded as “Loan received”.
              </template>
            </template>
            <template v-else-if="openingIsSet">{{ taka(openingMinor) }} — money already in the account
              on the day the shop joined SherERP.</template>
            <template v-else>Only for money already in the account. Leave it empty otherwise.</template>
          </p>
        </div>

        <div v-if="openingIsSet" class="field">
          <label for="opening-date">As at <span class="label-bn">কোন তারিখ থেকে</span></label>
          <DateOnlyPicker v-model="openingDate" input-id="opening-date" />
        </div>
      </div>

      <p v-if="hadOpening" class="posted-note">
        <i class="pi pi-info-circle" aria-hidden="true" />
        This opening is already posted. Changing it posts a correction beside the original — the
        first entry stays in the statement, as §2.5 requires.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" :disabled="!canSave">
          {{ busy ? 'Saving…' : 'Save account' }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.head {
  display: flex;
  flex-direction: column;
}

.head-en {
  font-size: var(--sher-text-lg, 18px);
  font-weight: 700;
}

.head-bn {
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.account-form {
  display: grid;
  gap: var(--sher-space-3, 12px);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sher-space-3, 12px);
}

/* The opening pair is the last thing read, and the date only appears once an
   amount is typed — so it keeps its own row rather than reflowing the ones above. */
.opening {
  align-items: start;
  padding-top: var(--sher-space-2, 8px);
  border-top: 1px solid var(--sher-line, rgba(127, 127, 127, 0.2));
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.drawer-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.drawer-toggle span {
  display: flex;
  flex-direction: column;
}

.drawer-toggle strong {
  font-size: var(--sher-text-sm, 13px);
}

.drawer-toggle .sher-bn {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.posted-note {
  display: flex;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-3, 12px);
  padding-top: var(--sher-space-2, 8px);
}

@media (max-width: 30rem) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
