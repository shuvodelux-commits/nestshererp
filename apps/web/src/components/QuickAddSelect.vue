<script setup lang="ts">
import { nextTick, ref } from 'vue';

import { ApiError } from '../api/client';
import ErrorNotice from './ErrorNotice.vue';
import HelpTip from './HelpTip.vue';

/**
 * A picker that can also create what it is picking (D-39, UI-45).
 *
 * **Why this exists.** A shopkeeper entering a delivery has the goods in front
 * of them and the supplier is new. Sending them to another screen to create it —
 * losing the half-typed purchase — is how entry stops happening at all. The same
 * is true of the unit a new product comes in, the brand nobody has filed yet,
 * and the customer standing at the counter.
 *
 * **What it is not.** It creates a real record through the same use case the
 * full form uses, so there is one write path, one set of rules and one audit
 * trail (D-39, R-D). It never invents a placeholder or a draft. It asks only for
 * what the record cannot exist without; everything else is filled in later on
 * that record's own screen.
 *
 * **No business rule lives here** (B8). The parent supplies `create`, which
 * calls the API and returns the new id; this component only handles the
 * interaction — open the field, submit once, show the server's own refusal
 * (UI-28), select what was created.
 *
 * `canAdd` is the caller's create permission for that record. When it is false
 * the control is **absent**, not disabled (UI-09) — a disabled button still
 * advertises something the person cannot do.
 */
const props = defineProps<{
  modelValue: string;
  /** DOM id for the select, so the label points at it (UI-42). */
  fieldId: string;
  label: string;
  /** The Bangla name of the field, beside the label (UI-15…UI-17). */
  labelBn?: string | undefined;
  options: readonly { readonly id: string; readonly name: string }[];
  /** The "nothing chosen" option, e.g. "No brand". Omit to require a choice. */
  emptyLabel?: string | undefined;
  canAdd: boolean;
  /** The button's words, e.g. "New unit". Said in full — UI-05 bans icon-only actions. */
  addLabel: string;
  addPlaceholder?: string | undefined;
  /** Explains what the shopkeeper is creating, when the name alone is not enough. */
  addHint?: string | undefined;
  /** A longer explanation of the field itself, behind an `i` beside it (UI-49). */
  help?: string | undefined;
  helpBn?: string | undefined;
  /**
   * Offers `Manage` beside the picker (UI-51), so an existing entry is renamed
   * or removed from the point of use rather than on a settings screen. Absent,
   * not disabled, without the permission (UI-09).
   */
  manage?: boolean | undefined;
  disabled?: boolean;
  required?: boolean;
  /** Creates the record and resolves with its id. Owned by the parent. */
  create: (name: string) => Promise<string>;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** UI-51: the caller opens its own Manage panel for this kind of record. */
  manage: [];
}>();

const adding = ref(false);
const draft = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const input = ref<HTMLInputElement | null>(null);

async function open(): Promise<void> {
  adding.value = true;
  error.value = null;
  draft.value = '';
  // The point of quick add is not having to reach for the mouse again.
  await nextTick();
  input.value?.focus();
}

function cancel(): void {
  adding.value = false;
  draft.value = '';
  error.value = null;
}

async function submit(): Promise<void> {
  const name = draft.value.trim();
  if (name === '' || busy.value) return;

  busy.value = true;
  error.value = null;
  try {
    // UI-36: what gets selected is what the server actually stored, never an
    // optimistic row this component made up.
    const id = await props.create(name);
    emit('update:modelValue', id);
    adding.value = false;
    draft.value = '';
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="field quick-add">
    <label :for="fieldId">
      {{ label }}
      <span v-if="labelBn !== undefined" class="label-bn">{{ labelBn }}</span>
      <HelpTip v-if="help !== undefined" :label="label" :text="help" :text-bn="helpBn" />
    </label>

    <div class="row">
      <select
        :id="fieldId"
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

      <button
        v-if="canAdd && !adding"
        type="button"
        class="btn btn-ghost add"
        :disabled="disabled === true"
        @click="open"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        {{ addLabel }}
      </button>

      <!--
        UI-51: fixing or removing an existing entry belongs here too, not only on
        a settings screen. The caller owns the panel, because it knows which kind
        of record this picker holds.
      -->
      <button
        v-if="manage === true && !adding"
        type="button"
        class="btn btn-ghost add"
        :disabled="disabled === true"
        @click="emit('manage')"
      >
        Manage
      </button>
    </div>

    <!--
      An inline row rather than a dialog: the form behind it stays visible and
      nothing typed into it is at risk, which is the whole point (D-39).
    -->
    <div v-if="adding" class="adder">
      <input
        ref="input"
        v-model="draft"
        type="text"
        :placeholder="addPlaceholder ?? addLabel"
        :aria-label="addLabel"
        :disabled="busy"
        @keydown.enter.prevent="submit"
        @keydown.esc.prevent="cancel"
      />
      <button type="button" class="btn btn-primary" :disabled="busy || draft.trim() === ''" @click="submit">
        {{ busy ? 'Saving…' : 'Add' }}
      </button>
      <button type="button" class="btn btn-ghost" :disabled="busy" @click="cancel">Cancel</button>
    </div>

    <p v-if="adding && addHint !== undefined" class="fine">{{ addHint }}</p>

    <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />
  </div>
</template>

<style scoped>
/* Fields, buttons and the error notice come from `design/components.css`. */
.row {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
}

.row select {
  flex: 1;
  min-width: 0;
}

.add {
  flex-shrink: 0;
  white-space: nowrap;
}

.adder {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
  margin-top: var(--sher-space-2);
}

.adder input {
  flex: 1;
  min-width: 0;
}
</style>
