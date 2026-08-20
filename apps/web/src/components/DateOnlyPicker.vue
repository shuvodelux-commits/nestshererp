<script setup lang="ts">
import DatePicker from 'primevue/datepicker';
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: string;
  inputId: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}>(), {
  disabled: false,
  required: false,
  placeholder: 'YYYY-MM-DD',
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const date = computed<Date | null>(() => {
  if (props.modelValue === '') return null;
  const [year, month, day] = props.modelValue.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  return new Date(year, month - 1, day, 12);
});

function update(value: Date | Date[] | (Date | null)[] | null | undefined): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    emit('update:modelValue', '');
    return;
  }
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  emit('update:modelValue', `${year}-${month}-${day}`);
}
</script>

<template>
  <DatePicker
    :input-id="inputId"
    :model-value="date"
    :disabled="disabled"
    :required="required"
    :placeholder="placeholder"
    date-format="yy-mm-dd"
    show-icon
    icon-display="input"
    :manual-input="false"
    fluid
    @update:model-value="update"
  />
</template>
