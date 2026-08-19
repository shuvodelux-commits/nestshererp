<script setup lang="ts">
import InputOtp from 'primevue/inputotp';
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{ modelValue: string; disabled?: boolean; length?: number; mask?: boolean }>(),
  { disabled: false, length: 6, mask: false },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  complete: [];
}>();

const completedValue = ref<string | null>(null);

function update(value: string): void {
  emit('update:modelValue', value);
  if (value.length === props.length && completedValue.value !== value) {
    completedValue.value = value;
    emit('complete');
  } else if (value.length !== props.length) {
    completedValue.value = null;
  }
}

watch(
  () => props.modelValue,
  (value) => {
    if (value.length !== props.length) completedValue.value = null;
  },
);
</script>

<template>
  <InputOtp
    class="otp"
    :model-value="modelValue"
    :disabled="disabled"
    :length="length"
    :mask="mask"
    integer-only
    aria-label="Security code"
    @update:model-value="update"
  />
</template>

<style scoped>
:deep(.p-inputotp) {
  display: flex;
  gap: 6px;
}

:deep(.p-inputotp-input) {
  width: 100%;
  min-width: 0;
  height: 46px;
  padding: 0;
  text-align: center;
  font-size: var(--sher-text-lg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
