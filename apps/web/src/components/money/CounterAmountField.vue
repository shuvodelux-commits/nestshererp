<script setup lang="ts">
import InputText from 'primevue/inputtext';
import { computed } from 'vue';

import { parseTaka, taka } from './money-text';

/**
 * The one field a cashier types into (UI-75).
 *
 * Deliberately not a spinner, a currency mask or a stepper: the shopkeeper's
 * whole computing experience is an Android phone, and the control they know is
 * a big box with a number keypad. `inputmode="decimal"` is what makes the phone
 * open that keypad rather than a QWERTY keyboard, which is the difference
 * between typing 64500 in two seconds and hunting for the number row.
 *
 * The Bangla question is the label at full size; the English sits under it in
 * the shared muted helper style. It echoes the amount back as `৳64,500` while
 * you type, because a missing or extra zero is the mistake this field exists to
 * catch and it is invisible in a bare string of digits.
 */
const props = defineProps<{
  modelValue: string;
  labelBn: string;
  labelEn: string;
  autofocus?: boolean;
}>();

const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>();

const minor = computed(() => parseTaka(props.modelValue));
const echo = computed(() => (minor.value === null ? null : taka(minor.value)));
</script>

<template>
  <label class="amount-field">
    <span class="ask-bn">{{ labelBn }}</span>
    <span class="ask-en sher-bn">{{ labelEn }}</span>
    <InputText
      class="amount-input"
      :model-value="modelValue"
      inputmode="decimal"
      autocomplete="off"
      :autofocus="autofocus"
      placeholder="0"
      @update:model-value="emit('update:modelValue', $event ?? '')"
    />
    <span class="echo" :class="{ empty: echo === null }">{{ echo ?? '—' }}</span>
  </label>
</template>

<style scoped>
.amount-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* The Bangla question is the label — UI-74 inverts UI-15 on this surface. */
.ask-bn {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
}

.ask-en {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.amount-input {
  /* Big enough to hit on a phone and to read at arm's length across a counter. */
  font-size: 28px;
  font-weight: 600;
  text-align: right;
  padding: 12px 16px;
  min-height: 56px;
}

.echo {
  align-self: flex-end;
  font-size: 13px;
  color: var(--sher-text-muted);
  min-height: 18px;
}

.echo.empty {
  opacity: 0.5;
}
</style>
