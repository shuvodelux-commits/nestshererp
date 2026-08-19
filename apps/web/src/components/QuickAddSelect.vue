<script setup lang="ts">
import { ref } from 'vue';

import HelpTip from './HelpTip.vue';
import ManageListDialog from './ManageListDialog.vue';
import Tooltip from './Tooltip.vue';

/**
 * A picker that also owns the list it picks from (D-39, UI-45, UI-51).
 *
 * **One control, three zones** — the value, a chevron that opens the list, and a
 * grid button that opens the panel where the list is added to, renamed and
 * tidied. Set by the owner 2026-08-19 after the previous layout put a `+ New`
 * button and a `Manage` button beside every picker: three controls per field,
 * across three fields, crushed the selects to nothing and made a simple row look
 * like a toolbar. Two buttons for "change this list" were also two places to
 * look for one job.
 *
 * **Why a native `<select>` underneath.** On Android it opens the system picker
 * — a full-screen list with large rows and the phone's own scrolling — which is
 * better than anything drawn here, and is the control this audience already
 * knows. Its appearance is stripped so the chevron can sit in its own zone, but
 * the element is still a real select, so the keyboard, the screen reader and the
 * form all behave normally.
 *
 * **No business rule lives here** (B8). The parent supplies `create`, `rename`
 * and `remove`, each calling the same use case the full screen calls, so there
 * is one write path, one set of validations and one audit trail (R-D, DRY).
 *
 * Permissions decide what the panel offers, never whether it lies: without the
 * manage permission the grid button is **absent**, not disabled (UI-09).
 */
const props = defineProps<{
  modelValue: string;
  /** DOM id for the select, so the label points at it (UI-42). */
  fieldId: string;
  label: string;
  /** The Bangla name of the field, beside the label (UI-15…UI-17). */
  labelBn?: string | undefined;
  options: readonly { readonly id: string; readonly name: string }[];
  /** The "nothing chosen" option, e.g. "Select category…". */
  emptyLabel?: string | undefined;
  /** The caller's create permission for this record. */
  canAdd: boolean;
  /** The caller's manage permission — rename and remove. */
  canManage?: boolean | undefined;
  addPlaceholder?: string | undefined;
  /** A longer explanation of the field itself, behind an `i` beside it (UI-49). */
  help?: string | undefined;
  helpBn?: string | undefined;
  disabled?: boolean;
  required?: boolean;
  /** All three are the parent's; each calls the same use case the full screen does. */
  create: (name: string) => Promise<string>;
  rename?: ((id: string, name: string) => Promise<void>) | undefined;
  remove?: ((id: string) => Promise<string>) | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const managing = ref(false);

/**
 * Whether the panel is worth offering at all.
 *
 * A caller who can neither add nor manage would open an empty read-only list,
 * so the button is absent rather than opening something with nothing in it.
 */
const canOpenPanel = () => props.canAdd || props.canManage === true;

/** UI-36: select what the server actually created, by the id it returned. */
function onCreated(id: string): void {
  emit('update:modelValue', id);
}

async function noopRename(): Promise<void> {
  // Never reached: the panel hides row actions unless `canManage` is true, and
  // a caller passing that also passes the handlers.
}

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

    <!--
      The border belongs to this wrapper, not to the select — that is what makes
      the three zones read as one control rather than a field with buttons stuck
      to its side.
    -->
    <div
      class="picker"
      :class="{ 'is-disabled': disabled === true, 'has-manage': canOpenPanel() }"
    >
      <select
        :id="fieldId"
        class="picker-select"
        :value="modelValue"
        :disabled="disabled === true"
        :required="required === true"
        @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
      >
        <option v-if="emptyLabel !== undefined" value="">{{ emptyLabel }}</option>
        <option v-for="option in options" :key="option.id" :value="option.id">
          {{ option.name }}
        </option>
      </select>

      <!--
        Decoration, laid **over** the select rather than beside it. As a sibling
        it took layout width, so the select was narrower than the field looked
        and the browser drew the open list only as wide as the select — stopping
        short of the arrow. Overlaying it lets the select span the whole value
        area, so the list matches the control that opened it.
      -->
      <span class="picker-chevron" aria-hidden="true">
        <i class="pi pi-chevron-down" />
      </span>

      <Tooltip v-if="canOpenPanel()" text="Add and manage" text-bn="নতুন যোগ করুন বা ঠিক করুন">
        <button
          type="button"
          class="picker-manage"
          :aria-label="`Add or manage ${label}`"
          :disabled="disabled === true"
          @click="managing = true"
        >
          <i class="pi pi-th-large" aria-hidden="true" />
        </button>
      </Tooltip>
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
/*
 * One rounded box holding all three zones. The focus ring is drawn here via
 * `:focus-within` rather than on the select, so tabbing to the field highlights
 * the whole control — otherwise the ring appears around an invisible element.
 */
.picker {
  position: relative;
  display: flex;
  align-items: stretch;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-raised);
  overflow: hidden;
}

.picker:focus-within {
  border-color: var(--sher-primary);
  box-shadow: 0 0 0 3px var(--sher-primary-soft);
}

.picker.is-disabled {
  background: var(--sher-sunken, #f8fafc);
  opacity: 0.7;
}

/*
 * `appearance: none` removes the browser's own arrow so the chevron can have its
 * own zone. The element stays a real `<select>`: on Android it still opens the
 * system picker, which is a better list than anything drawn here.
 */
.picker-select {
  flex: 1;
  min-width: 0;
  appearance: none;
  /* Room on the right for the overlaid chevron, which no longer takes width. */
  padding: 0 40px 0 var(--sher-space-3);
  min-height: 44px;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.picker-select:focus {
  outline: none;
}

.picker.has-manage .picker-chevron {
  right: 44px;
}

.picker-chevron {
  /*
   * Overlaid on the select's right edge rather than sitting beside it, so the
   * select spans the whole value area and the browser draws its open list that
   * wide — the list used to stop short of the arrow.
   *
   * `right` clears the grid button, which is still a real flex item.
   */
  position: absolute;
  top: 0;
  bottom: 0;
  /* No grid button on this picker, so the arrow sits at the edge. */
  right: 0;
  display: grid;
  place-items: center;
  width: 40px;
  color: var(--sher-primary);
  font-size: 12px;
  /* The select underneath is the control; this is only a marker. */
  pointer-events: none;
  /*
   * No divider here. The value and its arrow are one thing to tap, and a line
   * between them made the arrow look like a separate control. The grid button
   * keeps its divider, because it genuinely is a different action.
   */
}

/*
 * 44px of tap target, separated by its own divider so it is visibly a different
 * action from opening the list — not a second arrow.
 */
.picker-manage {
  display: grid;
  place-items: center;
  width: 44px;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-left: 1px solid var(--sher-line);
  background: transparent;
  color: var(--sher-text-muted);
  font-size: 14px;
  cursor: pointer;
}

.picker-manage:hover:not(:disabled) {
  background: var(--sher-primary-soft);
  color: var(--sher-primary);
}

.picker-manage:focus-visible {
  outline: 2px solid var(--sher-primary);
  outline-offset: -2px;
}
</style>
