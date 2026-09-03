<script setup lang="ts">
import { computed } from 'vue';

/**
 * The search box for every list in SherERP.
 *
 * The magnifier lives **inside** the field and there is no Search button beside
 * it. The button was a second thing to find and a second tap to make, and it
 * taught the wrong idea — that typing alone does nothing — on a screen where
 * the list is the whole point. Typing now filters as you type; Enter still
 * submits, because a keyboard user expects it to and a Bangla IME user needs a
 * way to say "I have finished this word".
 *
 * A search that has text in it offers a clear ✕ — the fastest way back to the
 * full list, and one the audience already knows from their phone's contacts app.
 */
const props = defineProps<{
  modelValue: string;
  /** The accessible name; not drawn, because the placeholder says the same. */
  label: string;
  placeholder: string;
  fieldId: string;
  /** Milliseconds of quiet before the list is asked again. */
  debounceMs?: number | undefined;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** The caller reloads its list. Fired on quiet typing, on Enter, and on clear. */
  search: [];
}>();

const hasText = computed(() => props.modelValue !== '');

let timer: ReturnType<typeof setTimeout> | undefined;

function stopTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
  stopTimer();
  timer = setTimeout(() => emit('search'), props.debounceMs ?? 350);
}

/** Enter means "now", so the pending debounce is dropped rather than fired twice. */
function onSubmit(): void {
  stopTimer();
  emit('search');
}

function clear(): void {
  stopTimer();
  emit('update:modelValue', '');
  emit('search');
}
</script>

<template>
  <div class="search-field">
    <i class="pi pi-search" aria-hidden="true" />
    <!--
      Phase 18.4. `inputmode` and `enterkeyhint` are what a phone reads to
      decide which keyboard to draw and what to write on its big blue key. With
      neither, every list in the application opened the ordinary keyboard with
      a `return` key on it, and a shopkeeper searching for a customer had to
      guess that pressing it would search. The POS scan bar already said this;
      it says it here now for the other seven screens too.
    -->
    <input
      :id="fieldId"
      type="search"
      inputmode="search"
      enterkeyhint="search"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      :value="modelValue"
      :aria-label="label"
      :placeholder="placeholder"
      @input="onInput"
      @keydown.enter.prevent="onSubmit"
    />
    <button
      v-if="hasText"
      type="button"
      class="search-clear"
      :aria-label="`Clear ${label.toLowerCase()}`"
      @click="clear"
    >
      <i class="pi pi-times" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.search-field {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}

.search-field > .pi-search {
  position: absolute;
  left: 12px;
  font-size: 15px;
  color: var(--sher-text-muted);
  pointer-events: none;
}

.search-field input {
  width: 100%;
  min-width: 0;
  height: var(--sher-control-h);
  padding: 0 38px 0 36px;
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius);
  background: var(--sher-raised);
  font: inherit;
  font-size: var(--sher-text-base);
  color: var(--sher-text);
  transition:
    border-color var(--sher-transition),
    box-shadow var(--sher-transition);
}

.search-field input::placeholder {
  color: var(--sher-text-muted);
}

.search-field input:focus {
  outline: none;
  border-color: var(--sher-primary);
  box-shadow: 0 0 0 3px var(--sher-primary-soft);
}

/* The browser's own ✕ would sit on top of ours, and it cannot be styled. */
.search-field input::-webkit-search-cancel-button {
  appearance: none;
}

.search-clear {
  position: absolute;
  right: 6px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--sher-radius-sm);
  background: transparent;
  color: var(--sher-text-muted);
  font-size: 12px;
  cursor: pointer;
}

.search-clear:hover {
  background: var(--sher-hover);
  color: var(--sher-text);
}
</style>
