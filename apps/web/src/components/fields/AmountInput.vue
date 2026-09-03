<script setup lang="ts">
import InputNumber from 'primevue/inputnumber';
import type { InputNumberInputEvent } from 'primevue/inputnumber';
import { computed } from 'vue';

/**
 * A number box that reports **every keystroke** (owner rule, binding).
 *
 * PrimeVue's `InputNumber` commits `v-model` on blur, not on input. On a form
 * that is saved and re-read that is invisible; on a transaction screen it is
 * the defect the owner named: a quantity is typed and the line total, the grand
 * total, the due and the change all sit still until the cursor leaves the
 * field. Every figure on a transaction screen must move the moment anything
 * changes, so this control forwards `@input` — which fires per keystroke and
 * carries the parsed number — straight into `update:modelValue`.
 *
 * It is a component rather than six copies of `@input` because the rule applies
 * to every amount, quantity and discount in the application: POS, purchase,
 * payment dialogs, and every transaction screen after them.
 *
 * **Phase 18.4 — the phone keypad.** PrimeVue decides `inputmode` for itself:
 * `numeric` unless `minFractionDigits` is set, and `numeric` is the keypad with
 * **no decimal point on it**. Every amount and quantity in SherERP goes through
 * this control, so a cashier on a phone could not type `৳120.50` or half a
 * kilo anywhere in the application. `minFractionDigits` would have fixed it by
 * forcing trailing zeros into every box on every screen, which is a display
 * change to buy a keyboard change; the pass-through sets the one attribute that
 * was actually wrong (owner decision 2026-09-03: assert `type`/`inputmode`).
 */
const props = defineProps<{
  modelValue: number;
  min?: number;
  max?: number;
  fractionDigits?: number;
  placeholder?: string;
  disabled?: boolean;
  showButtons?: boolean;
  /** Stacked arrows fit a narrow cell; horizontal needs room on both sides. */
  buttonLayout?: 'stacked' | 'horizontal';
  inputId?: string;
  /** Right-aligned by default: money and quantities line up on the decimal. */
  align?: 'left' | 'right';
}>();

const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

const fractionDigits = computed(() => props.fractionDigits ?? 2);
const alignRight = computed(() => props.align !== 'left');

/** An emptied box is zero for every figure that reads it. */
function commit(value: number | string | null | undefined): void {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  emit('update:modelValue', Number.isFinite(parsed) ? parsed : 0);
}

function onInput(event: InputNumberInputEvent): void {
  commit(event.value);
}
</script>

<template>
  <InputNumber
    :model-value="modelValue"
    :min="min ?? 0"
    :max="max"
    :max-fraction-digits="fractionDigits"
    :placeholder="placeholder"
    :disabled="disabled === true"
    :show-buttons="showButtons === true"
    :input-id="inputId"
    :input-class="alignRight ? 'amount-input__field' : undefined"
    :pt="{ pcInputText: { root: { inputmode: 'decimal' } } }"
:button-layout="buttonLayout ?? 'stacked'"
    class="amount-input"
    @input="onInput"
    @update:model-value="commit"
  />
</template>

<style>
.amount-input__field {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
