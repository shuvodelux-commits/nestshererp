<script setup lang="ts">
/**
 * A row of large preset buttons (UI-75).
 *
 * Where the answer comes from a known set — who the money went to, why the day
 * is being reopened — the cashier taps it instead of picking from a dropdown or
 * writing a sentence. A dropdown hides its options behind a tap and needs a
 * second tap to choose; free text produces `sindhuk`, `সিন্দুক` and `safe` for
 * one thing, none of which a report can group.
 *
 * Where the choice is also one side of a journal entry — §5.16.5's source or
 * destination — this is the only control offered, because a sentence cannot be
 * posted against an account.
 */
export interface CounterOption {
  readonly value: string;
  readonly labelBn: string;
  readonly labelEn: string;
  readonly icon: string;
}

defineProps<{ options: readonly CounterOption[]; modelValue: string | null }>();
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>();
</script>

<template>
  <div class="choices" role="radiogroup">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      class="choice"
      :class="{ picked: modelValue === option.value }"
      :aria-checked="modelValue === option.value"
      @click="emit('update:modelValue', option.value)"
    >
      <i :class="`pi ${option.icon}`" aria-hidden="true" />
      <span class="choice-en">{{ option.labelEn }}</span>
      <span class="choice-bn sher-bn">{{ option.labelBn }}</span>
    </button>
  </div>
</template>

<style scoped>
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.choice {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  /* Comfortably past the 40px touch target UI-59 protects. */
  min-height: 88px;
  padding: 12px 8px;
  border: 2px solid var(--sher-line);
  border-radius: var(--sher-radius-md, 8px);
  background: var(--sher-surface);
  color: inherit;
  cursor: pointer;
}

.choice:hover {
  border-color: var(--sher-primary);
}

.choice.picked {
  border-color: var(--sher-primary);
  background: color-mix(in srgb, var(--sher-primary) 10%, transparent);
}

.choice i {
  font-size: 20px;
  color: var(--sher-primary);
}

/*
 * English on top, Bangla under it (owner decision 2026-08-31): the counter
 * workflow reads in one register from the launcher through to Save. The option
 * fields keep their names — which language is which has not changed.
 */
.choice-en {
  font-size: 15px;
  font-weight: 600;
  text-align: center;
}

.choice-bn {
  font-size: 11px;
  color: var(--sher-text-muted);
  text-align: center;
}
</style>
