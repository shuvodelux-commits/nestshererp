<script setup lang="ts">
import type { MoneyAccountResponse, MoneyMovementRow } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Dialog from 'primevue/dialog';
import { computed, onMounted, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { correctMovement, fetchAccounts, recordMovement } from '../../api/money';
import { useSession } from '../../auth/session';
import DateOnlyPicker from '../DateOnlyPicker.vue';
import ErrorNotice from '../ErrorNotice.vue';
import MoneyAccountPicker from './MoneyAccountPicker.vue';
import { MONEY_BN, MONEY_EN, parseTaka, taka } from './money-text';

/**
 * Moving money between the shop's own accounts (Finance module, owner
 * decisions 2026-08-31).
 *
 * **The one transfer screen there is.** It replaced the preset-tile dialog that
 * drew a tile per account and per direction, and Counter opens this same
 * component with the drawer pre-filled — so there is one form, one set of
 * rules and one posting path, whether the transfer is entered at the counter or
 * from Finance.
 *
 * **DR destination, CR source**, decided by `CashMovementService` from the two
 * account codes. Nothing here computes a balance or adjusts one: the figures
 * under each account come from the server's own journal rollup, and the screen
 * re-reads them after a save rather than doing the arithmetic itself.
 *
 * **Overdrawing warns and still posts** (owner decision 2026-08-31): a shop
 * enters slips out of order, and refusing the entry would make a transfer that
 * really happened impossible to record. The warning names the balance and what
 * the account would fall to, and the balance it compares against is the one
 * **as at the transaction date** — warning about today's figure while posting
 * three days back would be a warning about a number this entry never touches.
 */
const props = defineProps<{
  /** Pre-selected source — Counter passes the drawer. */
  fromAccountId?: string | null;
  /** Set when an existing transfer is being corrected (§2.5). */
  editing?: MoneyMovementRow | null;
}>();

const emit = defineEmits<{ (event: 'saved'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const fromId = ref<string | null>(null);
const toId = ref<string | null>(null);
const amount = ref('');
const businessDate = ref(clock.businessDate(timezone));
const reference = ref('');
const note = ref('');
const reason = ref('');

const busy = ref(false);
const loading = ref(true);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));

const isEditing = computed(() => props.editing != null);

/**
 * Loans are not a way to move money.
 *
 * A loan account can only ever be one side of a loan movement, which is entered
 * on Capital & Loans — the server refuses it here too, and offering it in the
 * picker would be offering an action that ends in a refusal.
 */
const movable = computed(() =>
  accounts.value.filter((account) => account.type !== 'LOAN' && account.status === 'ACTIVE'),
);

const fromOptions = computed(() => movable.value.filter((a) => a.id !== toId.value));
const toOptions = computed(() => movable.value.filter((a) => a.id !== fromId.value));

const source = computed(() => accounts.value.find((a) => a.id === fromId.value) ?? null);
const destination = computed(() => accounts.value.find((a) => a.id === toId.value) ?? null);
const amountMinor = computed(() => parseTaka(amount.value));

/**
 * What the source would hold afterwards — recomputed on every keystroke, on
 * every account change and on every date change (instant recalculation).
 */
const afterMinor = computed(() => {
  if (source.value === null || amountMinor.value === null) return null;
  return source.value.balanceMinor - amountMinor.value;
});

const overdrawn = computed(() => afterMinor.value !== null && afterMinor.value < 0);

const canSave = computed(
  () =>
    fromId.value !== null &&
    toId.value !== null &&
    fromId.value !== toId.value &&
    amountMinor.value !== null &&
    amountMinor.value > 0 &&
    businessDate.value !== '' &&
    !busy.value,
);

/** Both sides at once — the shopkeeper picked the right two and the wrong way round. */
function swap(): void {
  const held = fromId.value;
  fromId.value = toId.value;
  toId.value = held;
}

async function loadAccounts(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  try {
    // Balances as at the date being entered, not as at now.
    const response = await fetchAccounts(token, false, businessDate.value);
    accounts.value = response.accounts;
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not load the accounts' };
  } finally {
    loading.value = false;
  }
}

// The date decides which balances are true, so changing it reloads them.
watch(businessDate, () => {
  if (businessDate.value !== '') void loadAccounts();
});

onMounted(async () => {
  const editing = props.editing ?? null;
  if (editing !== null) {
    fromId.value = idOf(editing.fromAccountCode);
    toId.value = idOf(editing.toAccountCode);
    amount.value = String(editing.amountMinor / 100);
    businessDate.value = editing.businessDate;
    reference.value = editing.reference ?? '';
    note.value = editing.note ?? '';
  } else {
    fromId.value = props.fromAccountId ?? null;
  }
  await loadAccounts();
});

/** `CASH:01J…` → `01J…`; the screen never shows or sends a bare code. */
function idOf(code: string): string | null {
  const at = code.indexOf(':');
  return at === -1 ? null : code.slice(at + 1);
}

function codeOf(account: MoneyAccountResponse): string {
  return `${account.type === 'CASH' ? 'CASH' : 'BANK'}:${account.id}`;
}

async function save(): Promise<void> {
  const token = session.accessToken.value;
  const from = source.value;
  const to = destination.value;
  const value = amountMinor.value;
  if (token === null || from === null || to === null || value === null) return;

  busy.value = true;
  failure.value = null;

  const payload = {
    kind: 'TRANSFER' as const,
    fromAccountCode: codeOf(from),
    toAccountCode: codeOf(to),
    amountMinor: value,
    businessDate: businessDate.value,
    reference: reference.value.trim() === '' ? null : reference.value.trim(),
    note: note.value.trim() === '' ? null : note.value.trim(),
  };

  try {
    const editing = props.editing ?? null;
    if (editing === null) {
      await recordMovement(token, { ...payload, operationId: operationId.value });
    } else {
      await correctMovement(token, editing.id, {
        ...payload,
        version: editing.version,
        reason: reason.value.trim() === '' ? null : reason.value.trim(),
      });
    }
    emit('saved');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not record that transfer' };
    // A refused attempt is a different intent next time (UI-34).
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
      <div class="dialog-head">
        <span class="head-en">{{ isEditing ? 'Edit Transfer' : MONEY_EN.transferMoney }}</span>
        <span class="head-bn sher-bn">{{ MONEY_BN.transferMoney }}</span>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <form class="transfer-form" @submit.prevent="save">
      <div class="sides">
        <div class="field">
          <label for="transfer-from">
            {{ MONEY_EN.fromAccount }} <span class="label-bn">{{ MONEY_BN.fromAccount }}</span>
          </label>
          <MoneyAccountPicker
            v-model="fromId"
            input-id="transfer-from"
            :accounts="fromOptions"
            :disabled="loading"
            placeholder="Where the money leaves"
          />
          <p v-if="source" class="balance">
            {{ MONEY_EN.availableBalance }} as of {{ businessDate }}
            <strong>{{ taka(source.balanceMinor) }}</strong>
          </p>
        </div>

        <button
          type="button"
          class="swap"
          title="Swap the two accounts"
          :disabled="busy"
          @click="swap"
        >
          <i class="pi pi-arrow-right-arrow-left" aria-hidden="true" />
        </button>

        <div class="field">
          <label for="transfer-to">
            {{ MONEY_EN.toAccount }} <span class="label-bn">{{ MONEY_BN.toAccount }}</span>
          </label>
          <MoneyAccountPicker
            v-model="toId"
            input-id="transfer-to"
            :accounts="toOptions"
            :disabled="loading"
            placeholder="Where it arrives"
          />
          <p v-if="destination" class="balance">
            {{ MONEY_EN.availableBalance }} as of {{ businessDate }}
            <strong>{{ taka(destination.balanceMinor) }}</strong>
          </p>
        </div>
      </div>

      <div class="row-2">
        <div class="field">
          <label for="transfer-amount">
            {{ MONEY_EN.amount }} <span class="label-bn">{{ MONEY_BN.amount }}</span>
          </label>
          <input
            id="transfer-amount"
            v-model="amount"
            inputmode="decimal"
            autocomplete="off"
            placeholder="20,000"
          />
        </div>

        <div class="field">
          <label for="transfer-date">
            {{ MONEY_EN.transactionDate }}
            <span class="label-bn">{{ MONEY_BN.transactionDate }}</span>
          </label>
          <DateOnlyPicker input-id="transfer-date" v-model="businessDate" />
        </div>
      </div>

      <div class="field">
        <label for="transfer-reference">
          {{ MONEY_EN.reference }} <span class="label-bn">{{ MONEY_BN.reference }}</span>
        </label>
        <input
          id="transfer-reference"
          v-model="reference"
          maxlength="64"
          autocomplete="off"
          placeholder="DEP-83721"
        />
      </div>

      <div class="field">
        <label for="transfer-note">
          {{ MONEY_EN.note }} <span class="label-bn">{{ MONEY_BN.note }}</span>
        </label>
        <input id="transfer-note" v-model="note" maxlength="500" placeholder="ব্যাংকে জমা" />
      </div>

      <div v-if="isEditing" class="field">
        <label for="transfer-reason">
          Why is it being changed? <span class="label-bn">কেন বদলাচ্ছেন</span>
        </label>
        <input
          id="transfer-reason"
          v-model="reason"
          maxlength="300"
          placeholder="Wrong amount typed"
        />
      </div>

      <p v-if="overdrawn && source" class="overdraw">
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        <span>
          Amount is greater than the available balance. Available
          <strong>{{ taka(source.balanceMinor) }}</strong>
          → After transfer: <strong>{{ taka(afterMinor ?? 0) }}</strong>
          <span class="sher-bn">এই অ্যাকাউন্টে এত টাকা নেই — তবু রাখতে পারেন</span>
        </span>
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          {{ MONEY_EN.cancel }}
        </button>
        <button type="submit" class="btn btn-primary" :disabled="!canSave">
          <i class="pi pi-check" aria-hidden="true" />
          {{ busy ? 'Saving…' : isEditing ? 'Save changes' : 'Confirm Transfer' }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.dialog-head {
  display: flex;
  flex-direction: column;
}

.head-en {
  font-size: 20px;
  font-weight: 700;
}

.head-bn {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.transfer-form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-2);
}

/* The swap button sits between the two pickers, aligned with their inputs. */
.sides {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: start;
  gap: var(--sher-space-2);
}

.swap {
  margin-top: 26px;
  width: 34px;
  height: 34px;
  border: 1px solid var(--sher-line);
  border-radius: 50%;
  background: var(--sher-raised);
  color: var(--sher-text-muted);
  cursor: pointer;
}

.swap:hover:not(:disabled) {
  background: var(--sher-hover);
  color: var(--sher-text);
}

.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sher-space-2);
}

.balance {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.balance strong {
  margin-left: 4px;
  color: var(--sher-text);
  font-variant-numeric: tabular-nums;
}

.overdraw {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--sher-warn-line);
  border-radius: var(--sher-radius-sm);
  background: var(--sher-warn-bg);
  color: var(--sher-warn);
  font-size: 12px;
}

.overdraw .sher-bn {
  display: block;
  margin-top: 2px;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-1);
  margin-top: var(--sher-space-1);
}

/* One phone column: the two accounts stack and the swap sits between them. */
@media (max-width: 640px) {
  .sides,
  .row-2 {
    grid-template-columns: 1fr;
  }

  .swap {
    margin: 0 auto;
  }
}
</style>
