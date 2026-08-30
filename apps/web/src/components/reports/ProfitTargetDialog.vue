<script setup lang="ts">
import type { TargetResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { ref } from 'vue';

import { parseTaka, taka } from '../money/money-text';

/**
 * The month's target (§5.20, O-10 — owner decision 2026-08-30).
 *
 * One number for the whole shop, per month, typed by the owner. The same
 * compact modal every one-task action uses: only the fields this action needs,
 * one primary button.
 *
 * The projection beside it on the dashboard is **not** entered here and never
 * stored — it is recomputed from the current daily rate every time it is read,
 * because a stored estimate becomes indistinguishable from a posted figure.
 */
const props = defineProps<{ month: string; current: TargetResponse | null }>();
const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'save', basis: 'PROFIT' | 'SALES', amountMinor: number): void;
}>();

const basis = ref<'PROFIT' | 'SALES'>(props.current?.basis ?? 'PROFIT');
const amount = ref(
  props.current?.targetMinor === null || props.current?.targetMinor === undefined
    ? ''
    : String(props.current.targetMinor / 100),
);
const problem = ref<string | null>(null);

const basisOptions = [
  { value: 'PROFIT', label: 'Profit — লাভের লক্ষ্য' },
  { value: 'SALES', label: 'Sales — বিক্রির লক্ষ্য' },
];

function save(): void {
  const minor = parseTaka(amount.value);
  if (minor === null || minor < 0) {
    problem.value = 'Type the amount in taka, like 50000';
    return;
  }
  emit('save', basis.value, minor);
}
</script>

<template>
  <Dialog
    visible
    modal
    :header="`Target for ${month} — এই মাসের লক্ষ্য`"
    :style="{ width: 'min(32rem, 94vw)' }"
    @update:visible="(open: boolean) => { if (!open) emit('close'); }"
  >
    <form class="target" @submit.prevent="save">
      <div class="field">
        <label for="target-basis">What are you aiming at <span>কীসের লক্ষ্য</span></label>
        <Select
          v-model="basis"
          input-id="target-basis"
          :options="basisOptions"
          option-label="label"
          option-value="value"
          append-to="self"
          fluid
        />
      </div>

      <div class="field">
        <label for="target-amount">Amount for the month <span>মাসের টাকার অঙ্ক</span></label>
        <input id="target-amount" v-model="amount" inputmode="decimal" placeholder="50000" />
        <p v-if="problem !== null" class="target__problem">{{ problem }}</p>
      </div>

      <p v-if="current !== null" class="target__note">
        So far this month: <strong>{{ taka(current.actualMinor) }}</strong>
      </p>
    </form>

    <template #footer>
      <Button label="Cancel" text @click="emit('close')" />
      <Button label="Save target" icon="pi pi-check" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.target { display: grid; gap: 0.75rem; }
.target__problem { margin: 0.25rem 0 0; color: var(--sher-bad, #b91c1c); font-size: 0.8rem; }
.target__note { margin: 0; color: var(--sher-text-muted, #64748b); font-size: 0.85rem; }
</style>
