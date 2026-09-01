<script setup lang="ts">
import type { MoneyAccountResponse } from '@sher/core-contracts';
import { computed, ref, watch } from 'vue';

import { taka } from './money-text';

/**
 * Choosing one money account, by typing part of its name (Finance module,
 * owner decision 2026-08-31).
 *
 * **This replaces the preset tiles.** The old Move Money dialog drew one tile
 * per account and per direction: readable with three accounts, and a wall of
 * fifty with twenty-five. A shop with a till, a safe, four banks and three bKash
 * numbers has to be able to find "BRAC" by typing three letters, which is the
 * whole reason this component exists.
 *
 * Results are grouped **Cash · Bank · MFS · Loans**, because that is how a
 * shopkeeper already sorts the money in their head, and each row carries its
 * balance — picking where money comes from without seeing what is in it is how
 * a transfer gets entered against the wrong account.
 *
 * It renders a plain input and a list rather than a PrimeVue Select: the rows
 * are two lines with a right-aligned figure, and a native `<select>` cannot
 * draw that (the same reason `QuickAddSelect` exists).
 */
const props = defineProps<{
  modelValue: string | null;
  accounts: readonly MoneyAccountResponse[];
  inputId: string;
  /** Shown when nothing is chosen yet. */
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ (event: 'update:modelValue', value: string | null): void }>();

const open = ref(false);
const query = ref('');
const root = ref<HTMLElement | null>(null);

const chosen = computed(
  () => props.accounts.find((account) => account.id === props.modelValue) ?? null,
);

/** The four families, in the order a shopkeeper thinks about them. */
const GROUPS = [
  { type: 'CASH', label: 'Cash', labelBn: 'ক্যাশ' },
  { type: 'BANK', label: 'Bank', labelBn: 'ব্যাংক' },
  { type: 'MFS', label: 'MFS', labelBn: 'বিকাশ / নগদ' },
  { type: 'LOAN', label: 'Loans', labelBn: 'ঋণ' },
] as const;

const groups = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const matches = props.accounts.filter((account) => {
    if (needle === '') return true;
    return (
      account.name.toLowerCase().includes(needle) ||
      (account.holderName ?? '').toLowerCase().includes(needle) ||
      (account.reference ?? '').toLowerCase().includes(needle)
    );
  });

  return GROUPS.map((group) => ({
    ...group,
    rows: matches.filter((account) => account.type === group.type),
  })).filter((group) => group.rows.length > 0);
});

/**
 * A loan's balance is a credit, so it is negative in the journal. It is drawn
 * as what is owed, because "−৳50,000 owed" asks the reader to cancel two
 * negatives to learn a fact they already had (UI-21).
 */
function balanceText(account: MoneyAccountResponse): string {
  return account.type === 'LOAN'
    ? `${taka(-account.balanceMinor)} owed`
    : taka(account.balanceMinor);
}

function choose(account: MoneyAccountResponse): void {
  emit('update:modelValue', account.id);
  open.value = false;
  query.value = '';
}

// Clicking anywhere else closes the list: a dropdown left open over the next
// field is what makes a form feel stuck.
watch(open, (isOpen) => {
  if (!isOpen) return;
  const close = (event: MouseEvent): void => {
    if (root.value !== null && !root.value.contains(event.target as Node)) {
      open.value = false;
      document.removeEventListener('mousedown', close);
    }
  };
  document.addEventListener('mousedown', close);
});
</script>

<template>
  <div ref="root" class="picker">
    <button
      :id="inputId"
      type="button"
      class="picker-value"
      :class="{ 'is-empty': chosen === null }"
      :disabled="disabled === true"
      @click="open = !open"
    >
      <span class="picked">
        {{ chosen?.name ?? placeholder ?? 'Choose an account' }}
      </span>
      <i class="pi pi-chevron-down" aria-hidden="true" />
    </button>

    <div v-if="open" class="picker-list">
      <input
        v-model="query"
        class="picker-search"
        type="search"
        autocomplete="off"
        placeholder="Type a name — নাম লিখে খুঁজুন"
        @keydown.escape="open = false"
      />

      <p v-if="groups.length === 0" class="picker-empty">No account matches that.</p>

      <div v-for="group in groups" :key="group.type" class="picker-group">
        <p class="group-head">
          {{ group.label }}
          <span class="sher-bn">{{ group.labelBn }}</span>
        </p>
        <button
          v-for="account in group.rows"
          :key="account.id"
          type="button"
          class="picker-row"
          :class="{ 'is-chosen': account.id === modelValue }"
          @click="choose(account)"
        >
          <span class="row-name">
            {{ account.name }}
            <span v-if="account.holderName" class="row-holder">{{ account.holderName }}</span>
          </span>
          <span class="row-balance" :class="{ negative: account.balanceMinor < 0 && account.type !== 'LOAN' }">
            {{ balanceText(account) }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
}

.picker-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sher-space-1);
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-md);
  background: var(--sher-surface);
  font: inherit;
  color: var(--sher-text);
  text-align: left;
  cursor: pointer;
}

.picker-value:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.picker-value.is-empty .picked {
  color: var(--sher-text-muted);
}

.picked {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-list {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 18rem;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-md);
  background: var(--sher-raised);
  box-shadow: var(--sher-shadow-card);
}

.picker-search {
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 6px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-sm);
  font: inherit;
}

.picker-empty {
  margin: 8px;
  color: var(--sher-text-muted);
}

.group-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 8px 6px 4px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sher-text-muted);
}

.group-head .sher-bn {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
}

.picker-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sher-space-2);
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--sher-radius-sm);
  background: transparent;
  font: inherit;
  color: var(--sher-text);
  text-align: left;
  cursor: pointer;
}

.picker-row:hover,
.picker-row.is-chosen {
  background: var(--sher-hover);
}

.row-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.row-holder {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.row-balance {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--sher-text-muted);
}

.row-balance.negative {
  color: var(--sher-bad);
}
</style>
