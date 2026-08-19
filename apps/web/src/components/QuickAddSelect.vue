<script setup lang="ts">
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed, ref } from 'vue';

import HelpTip from './HelpTip.vue';
import ManageListDialog from './ManageListDialog.vue';

const props = defineProps<{
  modelValue: string;
  fieldId: string;
  label: string;
  labelBn?: string | undefined;
  options: readonly { readonly id: string; readonly name: string }[];
  emptyLabel?: string | undefined;
  canAdd: boolean;
  canManage?: boolean | undefined;
  addPlaceholder?: string | undefined;
  help?: string | undefined;
  helpBn?: string | undefined;
  disabled?: boolean;
  required?: boolean;
  create: (name: string) => Promise<string>;
  rename?: ((id: string, name: string) => Promise<void>) | undefined;
  remove?: ((id: string) => Promise<string>) | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const managing = ref(false);
const canOpenPanel = computed(() => props.canAdd || props.canManage === true);
const selectOptions = computed(() => [...props.options]);

function onCreated(id: string): void {
  emit('update:modelValue', id);
}

async function noopRename(): Promise<void> {}
async function noopRemove(): Promise<string> {
  return '';
}
</script>

<template>
  <div class="field quick-add">
    <label :for="fieldId">
      {{ label }}
      <span v-if="labelBn !== undefined" class="label-bn">{{ labelBn }}</span>
      <HelpTip v-if="help !== undefined" :label="label" :text="help" :text-bn="helpBn" />
    </label>

    <div class="picker" :class="{ 'is-disabled': disabled === true }">
      <Select
        :input-id="fieldId"
        class="picker-select"
        :model-value="modelValue"
        :options="selectOptions"
        option-label="name"
        option-value="id"
        :placeholder="emptyLabel"
        :disabled="disabled === true"
        :aria-required="required === true"
        :filter="options.length > 8"
        filter-placeholder="Search"
        empty-filter-message="No matching option"
        append-to="body"
        auto-option-focus
        focus-on-hover
        fluid
        @update:model-value="emit('update:modelValue', $event as string)"
      />

      <Button
        v-if="canOpenPanel"
        v-tooltip.top="{
          value: `Add or manage ${label}`,
          showDelay: 250,
          hideDelay: 100,
        }"
        class="picker-manage"
        icon="pi pi-cog"
        text
        severity="secondary"
        :aria-label="`Add or manage ${label}`"
        :disabled="disabled === true"
        @click.stop="managing = true"
      />
    </div>

    <ManageListDialog
      v-if="managing"
      :title="label.toLowerCase()"
      :title-bn="labelBn"
      :entries="options"
      :can-add="canAdd"
      :can-edit="canManage === true && rename !== undefined && remove !== undefined"
      :add-placeholder="addPlaceholder"
      :create="create"
      :rename="rename ?? noopRename"
      :remove="remove ?? noopRemove"
      @created="onCreated"
      @close="managing = false"
    />
  </div>
</template>

<style scoped>
.picker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--sher-control-h);
  align-items: stretch;
  min-height: var(--sher-control-h);
  overflow: hidden;
  border: var(--sher-border-w) solid var(--sher-line-strong);
  border-radius: var(--sher-radius);
  background: var(--sher-raised);
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease;
}

.picker:hover:not(.is-disabled) {
  border-color: var(--sher-primary);
}

.picker:focus-within {
  border-color: var(--sher-primary);
  box-shadow: 0 0 0 3px var(--sher-primary-soft);
}

.picker.is-disabled {
  background: var(--sher-sunken);
}

.picker.is-disabled :deep(.picker-manage) {
  color: var(--sher-text-faint);
}

:deep(.picker-select) {
  width: 100%;
  min-width: 0;
  min-height: var(--sher-control-h);
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

:deep(.picker-select.p-focus) {
  border-color: transparent;
  box-shadow: none;
}

:deep(.picker-manage) {
  width: var(--sher-control-h);
  min-width: var(--sher-control-h);
  min-height: var(--sher-control-h);
  padding: 0;
  border: 0;
  border-left: var(--sher-border-w) solid var(--sher-line);
  border-radius: 0;
  background: transparent;
  color: var(--sher-text-muted);
}

:deep(.picker-manage:hover:not(:disabled)) {
  background: var(--sher-hover);
  color: var(--sher-primary);
}
</style>
