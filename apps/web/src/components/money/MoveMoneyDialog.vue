<script setup lang="ts">
import type { MoneyAccountResponse } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../../api/client';
import { fetchAccounts, recordMovement } from '../../api/money';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';
import CounterAmountField from './CounterAmountField.vue';
import CounterChoice from './CounterChoice.vue';
import type { CounterOption } from './CounterChoice.vue';
import { MONEY_BN, MONEY_EN, parseTaka } from './money-text';

/**
 * `টাকা সরান` — money in or out during the day (§5.16.3, §5.16.5).
 *
 * The owner takes ৳10,000 out at 3pm, cash goes to the safe, a deposit is made
 * on the way home. All of it is one dialog, because to the person at the
 * counter it is one act — money left the drawer and they know where it went.
 *
 * **What it is, not which accounts to debit.** The cashier picks
 * `মালিক টাকা নিলেন` or `ব্যাংকে জমা দিলাম`; the two account codes and the
 * direction are derived from that choice. Owner money posts against
 * `OWNER_CURRENT_ACCOUNT` and never through an expense, because what the owner
 * takes is not a cost of running the shop.
 */
const props = defineProps<{ drawerAccountId: string; businessDate: string }>();
const emit = defineEmits<{ (event: 'recorded'): void; (event: 'close'): void }>();

const session = useSession();
const clock = new SystemClock();

const picked = ref<string | null>(null);
const amount = ref('');
const note = ref('');
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const operationId = ref(Ulid.generate(clock));
const accounts = ref<readonly MoneyAccountResponse[]>([]);

const DRAWER = computed(() => `CASH:${props.drawerAccountId}`);

/**
 * Each preset is a whole movement: a kind and both sides. Building them here
 * rather than asking three questions is the point — "money to the safe" is one
 * thought, and splitting it into direction, from and to would be three taps for
 * something the shopkeeper already said.
 */
interface Move extends CounterOption {
  readonly kind: 'OWNER_INJECTION' | 'OWNER_WITHDRAWAL' | 'TRANSFER';
  readonly from: string;
  readonly to: string;
}

const moves = computed<readonly Move[]>(() => {
  const drawer = DRAWER.value;
  const others = accounts.value.filter(
    (account) => account.id !== props.drawerAccountId && account.status === 'ACTIVE',
  );

  const list: Move[] = [
    {
      value: 'OWNER_OUT',
      kind: 'OWNER_WITHDRAWAL',
      from: drawer,
      to: 'OWNER_CURRENT_ACCOUNT',
      labelBn: MONEY_BN.ownerTook,
      labelEn: MONEY_EN.ownerTook,
      icon: 'pi-user-minus',
    },
    {
      value: 'OWNER_IN',
      kind: 'OWNER_INJECTION',
      from: 'OWNER_CURRENT_ACCOUNT',
      to: drawer,
      labelBn: MONEY_BN.ownerGave,
      labelEn: MONEY_EN.ownerGave,
      icon: 'pi-user-plus',
    },
  ];

  for (const account of others) {
    const code = `${account.type === 'CASH' ? 'CASH' : 'BANK'}:${account.id}`;
    const isCash = account.type === 'CASH';

    list.push({
      value: `OUT_${account.id}`,
      kind: 'TRANSFER',
      from: drawer,
      to: code,
      labelBn: isCash ? MONEY_BN.toSafe : MONEY_BN.toBank,
      labelEn: `To ${account.name}`,
      icon: isCash ? 'pi-lock' : 'pi-building-columns',
    });
    list.push({
      value: `IN_${account.id}`,
      kind: 'TRANSFER',
      from: code,
      to: drawer,
      labelBn: isCash ? MONEY_BN.fromSafe : MONEY_BN.fromBank,
      labelEn: `From ${account.name}`,
      icon: isCash ? 'pi-lock-open' : 'pi-building-columns',
    });
  }

  return list;
});

const chosen = computed(() => moves.value.find((move) => move.value === picked.value) ?? null);
const amountMinor = computed(() => parseTaka(amount.value));
const canSubmit = computed(
  () => chosen.value !== null && amountMinor.value !== null && amountMinor.value > 0 && !busy.value,
);

onMounted(async () => {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    accounts.value = (await fetchAccounts(token)).accounts;
  } catch {
    accounts.value = [];
  }
});

async function submit(): Promise<void> {
  const token = session.accessToken.value;
  const move = chosen.value;
  const value = amountMinor.value;
  if (token === null || move === null || value === null) return;

  busy.value = true;
  failure.value = null;

  try {
    await recordMovement(token, {
      kind: move.kind,
      fromAccountCode: move.from,
      toAccountCode: move.to,
      amountMinor: value,
      businessDate: props.businessDate,
      note: note.value.trim() === '' ? null : note.value.trim(),
      operationId: operationId.value,
    });
    emit('recorded');
  } catch (error) {
    failure.value =
      error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: 'Could not record that' };
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
    class="counter-dialog"
    :style="{ width: '32rem' }"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="counter-header">
        <span class="head-bn">{{ MONEY_BN.moveMoney }}</span>
        <span class="head-en sher-bn">{{ MONEY_EN.moveMoney }}</span>
      </div>
    </template>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <CounterChoice v-model="picked" :options="moves" />

    <template v-if="chosen">
      <CounterAmountField
        v-model="amount"
        :label-bn="MONEY_BN.amount"
        :label-en="MONEY_EN.amount"
        autofocus
      />

      <label class="note">
        <span class="sher-bn">{{ MONEY_BN.note }}</span>
        <InputText v-model="note" maxlength="500" />
      </label>
    </template>

    <template #footer>
      <Button text :label="MONEY_BN.cancel" :disabled="busy" @click="emit('close')" />
      <Button
        class="primary-action"
        icon="pi pi-check"
        :label="MONEY_BN.confirm"
        :loading="busy"
        :disabled="!canSubmit"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.counter-header {
  display: flex;
  flex-direction: column;
}

.head-bn {
  font-size: 20px;
  font-weight: 700;
}

.head-en {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 14px;
}

.primary-action {
  min-height: 48px;
  font-size: 16px;
  font-weight: 600;
}
</style>
