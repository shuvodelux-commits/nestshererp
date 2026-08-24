<script setup lang="ts">
import type { PartyResponse, PartyRoleValue } from '@sher/core-contracts';
import { Money, parseMoney, SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { correctPartyOpening, fetchPartyOpening, setPartyOpening } from '../../api/parties';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Setting or correcting a party's opening balance (§5.6, §5.0, §2.5).
 *
 * §5.6 puts the opening figure on the create form, and a shop onboarding a
 * hundred customers will miss it on some of them — so it is reachable
 * afterwards too, from the row menu and from the party's hub.
 *
 * **An opening balance is a document, not a field.** Saving posts a real
 * journal entry against `OPENING_EQUITY`, which is why this dialog talks about
 * posting rather than saving, and why correcting one says plainly that the
 * original stays in the ledger with a reversal beside it (§2.5). A shopkeeper
 * who expected a silent edit and then found two extra rows in the statement
 * would trust the statement less, not more.
 *
 * The amount is **always positive and the direction is a separate choice.**
 * §5.6's 2026-08-20 decision describes a single signed box; the owner chose to
 * keep the two apart on 2026-08-22, because a mistyped minus sign on an opening
 * balance silently reverses who owes whom, and the figure is rarely looked at
 * again once it is in.
 */
const props = defineProps<{
  party: PartyResponse;
  /** The list or hub this was opened from — a party may hold several roles (D-04). */
  role: PartyRoleValue;
}>();

const emit = defineEmits<{
  (event: 'saved'): void;
  (event: 'close'): void;
}>();

const session = useSession();
const clock = new SystemClock();

const loading = ref(true);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

/** The posted opening, if there is one. `null` means this is a first entry. */
const existingId = ref<string | null>(null);
const version = ref(1);

const amount = ref('');
const direction = ref<'RECEIVABLE' | 'PAYABLE'>('RECEIVABLE');
const businessDate = ref(clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone));
const operationId = ref(Ulid.generate(clock));

const isCorrection = computed(() => existingId.value !== null);

/**
 * What each direction means for this role, in the shop's own words (§5.6).
 *
 * A vendor is payable-only: §5.6 describes no case where a vendor owes the
 * shop, and on an opening balance a wrong-way vendor entry is far more likely
 * to be a mistyped direction than the real thing. The domain refuses it too —
 * this only keeps the choice off the screen (UI-09).
 */
const directionOptions = computed(() => {
  if (props.role === 'VENDOR') {
    return [{ value: 'PAYABLE', label: 'I owe them — দিব' }];
  }
  if (props.role === 'SUPPLIER') {
    return [
      { value: 'PAYABLE', label: 'I owe them — দিব' },
      { value: 'RECEIVABLE', label: 'They hold my advance — পাবো' },
    ];
  }
  return [
    { value: 'RECEIVABLE', label: 'They owe me — পাবো' },
    { value: 'PAYABLE', label: 'They paid in advance — দিব' },
  ];
});

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'NETWORK_UNREACHABLE', message: 'Could not reach the server.' };
}

onMounted(async () => {
  try {
    const opening = await fetchPartyOpening(
      session.accessToken.value ?? '',
      props.party.id,
      props.role,
    );
    if (opening !== null) {
      existingId.value = opening.id;
      version.value = opening.version;
      direction.value = opening.direction;
      businessDate.value = opening.businessDate;
      amount.value = Money(opening.amountMinor).format();
    } else if (props.role !== 'CUSTOMER') {
      direction.value = 'PAYABLE';
    }
  } catch (cause) {
    failure.value = describe(cause);
  } finally {
    loading.value = false;
  }
});

async function submit(): Promise<void> {
  const amountMinor = parseMoney(amount.value);
  if (amountMinor === null || amountMinor <= 0) {
    failure.value = {
      code: 'VALIDATION_FAILED',
      message: 'Enter an amount greater than zero, with at most two decimal places',
    };
    return;
  }

  busy.value = true;
  failure.value = null;
  try {
    const payload = {
      role: props.role,
      direction: direction.value,
      amountMinor,
      businessDate: businessDate.value,
    };

    if (existingId.value === null) {
      await setPartyOpening(
        session.accessToken.value ?? '',
        props.party.id,
        payload,
        operationId.value,
      );
    } else {
      await correctPartyOpening(
        session.accessToken.value ?? '',
        props.party.id,
        { ...payload, version: version.value },
        operationId.value,
      );
    }
    emit('saved');
  } catch (cause) {
    failure.value = describe(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    :header="isCorrection ? 'Correct opening balance' : 'Set opening balance'"
    :style="{ width: 'min(32rem, 96vw)' }"
    :draggable="false"
    @update:visible="emit('close')"
  >
    <div v-if="loading" class="skeleton skeleton-form" aria-busy="true" aria-label="Loading" />

    <form v-else id="party-opening-form" @submit.prevent="submit">
      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <p class="lede">
        What {{ party.name }} owed, or was owed, on the day you started using SherERP.
      </p>

      <!--
        §2.5, said before the shopkeeper presses the button rather than after.
        The posted entry is never rewritten, so a correction leaves three rows
        in the statement: the original, its reversal, and the new figure.
      -->
      <p v-if="isCorrection" class="notice is-info" role="status">
        The opening already posted stays in the ledger. This posts a reversal and the new
        figure beside it, so the statement shows what changed.
      </p>

      <div class="field">
        <label for="opening-direction">Which way <span class="label-bn">কোন দিকে</span></label>
        <Select
          input-id="opening-direction"
          v-model="direction"
          :options="directionOptions"
          option-label="label"
          option-value="value"
          :disabled="directionOptions.length === 1"
          fluid
        />
      </div>

      <div class="field">
        <label for="opening-amount">Amount <span class="label-bn">টাকার পরিমাণ</span></label>
        <input
          id="opening-amount"
          v-model="amount"
          type="text"
          inputmode="decimal"
          placeholder="0.00"
          autofocus
        />
        <p class="hint">Always a positive number — the choice above decides which way it points.</p>
      </div>

      <div class="field">
        <label for="opening-date">As at <span class="label-bn">কোন তারিখ থেকে</span></label>
        <input id="opening-date" v-model="businessDate" type="date" />
        <p class="hint">Your go-live date, not necessarily today.</p>
      </div>
    </form>

    <template #footer>
      <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
        Cancel
      </button>
      <button type="submit" form="party-opening-form" class="btn btn-primary" :disabled="busy || loading">
        {{ busy ? 'Posting…' : isCorrection ? 'Post correction' : 'Post opening balance' }}
      </button>
    </template>
  </Dialog>
</template>

<style scoped>
.lede {
  margin: 0 0 0.75rem;
  color: var(--sher-text-muted);
}

.hint {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--sher-text-muted);
}
</style>
