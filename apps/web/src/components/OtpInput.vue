<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

/**
 * Single-digit boxes behaving as one field — six for a signup code, four for a
 * PIN. The behaviour is identical, so both use this rather than two components
 * that would drift apart.
 *
 * Typing advances, Backspace on an empty box steps back, and pasting a whole
 * code fills every box — a shopkeeper copying a code out of an SMS should not
 * have to type it one digit at a time. Arrow keys move between boxes, so the
 * control is fully keyboard-operable (UI-05, UI-42).
 */
const props = withDefaults(
  defineProps<{ modelValue: string; disabled?: boolean; length?: number; mask?: boolean }>(),
  { disabled: false, length: 6, mask: false },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  complete: [];
}>();

/**
 * Narrowed to plain values — `exactOptionalPropertyTypes` rejects an optional
 * prop bound straight onto an element attribute.
 */
const isDisabled = computed<boolean>(() => props.disabled);
const size = computed<number>(() => props.length);
/** A PIN is masked; a signup code is not — you want to read what you typed. */
const boxType = computed<"text" | "password">(() => (props.mask ? "password" : "text"));

const boxes = ref<HTMLInputElement[]>([]);
const digits = ref<string[]>(Array.from({ length: props.length }, () => ''));

/** Vue's template ref callback hands back the element or a component instance. */
function setBoxRef(el: unknown, index: number): void {
  if (el instanceof HTMLInputElement) boxes.value[index] = el;
}

// Keep the boxes in step when the parent resets the value — a resend clears it,
// and a failed PIN attempt blanks it.
watch(
  () => props.modelValue,
  (value) => {
    if (value === digits.value.join('')) return;
    digits.value = Array.from({ length: size.value }, (_, i) => value[i] ?? '');
  },
);

watch(size, (next) => {
  digits.value = Array.from({ length: next }, (_, i) => digits.value[i] ?? '');
});

function publish(): void {
  const value = digits.value.join('');
  emit('update:modelValue', value);
  if (value.length === size.value) emit('complete');
}

function focusBox(index: number): void {
  void nextTick(() => boxes.value[index]?.focus());
}

function onInput(index: number, event: Event): void {
  const input = event.target as HTMLInputElement;
  // Keep only the last digit typed, so overwriting a filled box works.
  const digit = input.value.replace(/\D/g, '').slice(-1);
  digits.value[index] = digit;
  input.value = digit;

  if (digit !== '' && index < size.value - 1) focusBox(index + 1);
  publish();
}

function onKeydown(index: number, event: KeyboardEvent): void {
  if (event.key === 'Backspace' && digits.value[index] === '' && index > 0) {
    event.preventDefault();
    digits.value[index - 1] = '';
    focusBox(index - 1);
    publish();
    return;
  }
  if (event.key === 'ArrowLeft' && index > 0) {
    event.preventDefault();
    focusBox(index - 1);
  }
  if (event.key === 'ArrowRight' && index < size.value - 1) {
    event.preventDefault();
    focusBox(index + 1);
  }
}

function onPaste(event: ClipboardEvent): void {
  const pasted = (event.clipboardData?.getData('text') ?? '')
    .replace(/\D/g, '')
    .slice(0, size.value);
  if (pasted === '') return;
  event.preventDefault();

  digits.value = Array.from({ length: size.value }, (_, i) => pasted[i] ?? '');
  focusBox(Math.min(pasted.length, size.value - 1));
  publish();
}
</script>

<template>
  <div class="otp" @paste="onPaste">
    <input
      v-for="(digit, index) in digits"
      :key="index"
      :ref="(el) => setBoxRef(el, index)"
      :value="digit"
      :type="boxType"
      inputmode="numeric"
      maxlength="1"
      autocomplete="one-time-code"
      :disabled="isDisabled"
      :aria-label="`Digit ${String(index + 1)} of ${String(size)}`"
      @input="onInput(index, $event)"
      @keydown="onKeydown(index, $event)"
      @focus="($event.target as HTMLInputElement).select()"
    />
  </div>
</template>

<style scoped>
.otp {
  display: flex;
  gap: 6px;
}

input {
  width: 100%;
  height: 40px;
  min-width: 0;
  padding: 0;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface-3);
  text-align: center;
  font: inherit;
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--sher-text);
  transition: border-color var(--sher-transition);
}

input:focus {
  outline: 2px solid var(--sher-primary);
  outline-offset: 1px;
  border-color: var(--sher-primary);
}

input:disabled {
  background: var(--sher-surface);
}
</style>
