<script setup lang="ts">
import AutoComplete from 'primevue/autocomplete';
import Button from 'primevue/button';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * **The Flow Rule field** (UI-76 … UI-79, owner decision 2026-08-25).
 *
 * One control for every piece of selectable data in SherERP — supplier,
 * product, category, brand, unit, account, customer. It is always the same
 * three things in the same order, so the shopkeeper learns it once:
 *
 *   1. **type to search** — the field is a search box, not a list to hunt in;
 *   2. **open the list** — the chevron shows everything when they would rather
 *      look than type;
 *   3. **`+` inside the same control** — what they typed is not there yet, so
 *      they add it without leaving the screen and without losing the form.
 *
 * A management action (rename, remove) gets a small cog in the same place,
 * never a second large button. Quick-add and manage live **inside the field
 * border** on purpose: a separate button beside the field reads as a different
 * step, and this is the same step.
 *
 * Enter selects the highlighted row. When nothing matched and quick-add is
 * allowed, Enter opens the add dialog with the typed text already in it — so
 * the fastest path for a name that does not exist yet is still typing.
 *
 * Two modes, one component: `options` for a list already loaded (suppliers,
 * accounts, categories) and `search` for one the server filters (products).
 * They look and behave identically, which is the point.
 */
interface ComboOption {
  readonly id: string;
  readonly label: string;
  /** The quieter second line: a phone number, a product code, a unit. */
  readonly sublabel?: string | undefined;
  readonly icon?: string | undefined;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    fieldId: string;
    label?: string | undefined;
    labelBn?: string | undefined;
    placeholder?: string | undefined;
    /** Local list. Ignored when `search` is given. */
    options?: readonly ComboOption[];
    /** Server-side search, for lists too long to hold in the browser. */
    search?: ((term: string) => Promise<readonly ComboOption[]>) | undefined;
    required?: boolean;
    disabled?: boolean;
    /** The magnifier the shopkeeper reads as "you can type here". */
    leadingIcon?: string | undefined;
    /** `+` inside the control. The typed text is handed over as the name. */
    onAdd?: ((typed: string) => void) | undefined;
    /** A small cog in the same place, for rename/remove lists. */
    onManage?: (() => void) | undefined;
    /** Product picking: the field empties itself so the next one can be typed. */
    clearOnSelect?: boolean;
  }>(),
  {
    options: () => [],
    required: false,
    disabled: false,
    clearOnSelect: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** The whole option, for a caller that needs more than the id. */
  selected: [option: ComboOption];
}>();

const typed = ref<ComboOption | string>('');
const suggestions = ref<ComboOption[]>([]);
const busy = ref(false);

const selected = computed(() => props.options.find((option) => option.id === props.modelValue));

/* Keep the box showing whatever the parent set, including a value chosen
 * somewhere else — a supplier created in the add dialog, an account defaulted
 * on load. */
watch(
  () => [props.modelValue, props.options] as const,
  () => {
    if (props.clearOnSelect) return;
    typed.value = selected.value ?? '';
  },
  { immediate: true },
);

const typedText = computed(() =>
  typeof typed.value === 'string' ? typed.value : typed.value.label,
);

async function complete(event: { query: string }): Promise<void> {
  const query = event.query.trim();
  if (props.search !== undefined) {
    busy.value = true;
    try {
      suggestions.value = [...(await props.search(query))];
    } finally {
      busy.value = false;
    }
    return;
  }

  const needle = query.toLowerCase();
  const showsSelection =
    selected.value !== undefined && needle === selected.value.label.toLowerCase();

  suggestions.value =
    needle === '' || showsSelection
      ? [...props.options]
      : props.options.filter(
          (option) =>
            option.label.toLowerCase().includes(needle) ||
            (option.sublabel ?? '').toLowerCase().includes(needle),
        );
}

/*
 * The list is exactly as wide as the field it drops from (owner, 2026-08-25).
 *
 * PrimeVue sizes the overlay to the **input**, and the input here is narrower
 * than the control it sits in — the leading magnifier, the divider and the `+`
 * are outside it — so the list came out short of the field's right edge and
 * read as a detached box. Measured from the input's left edge to the control's
 * right edge, it lines up under the whole field instead.
 */
const controlEl = ref<HTMLElement | null>(null);
const overlayWidth = ref(0);

function measure(): void {
  const control = controlEl.value;
  if (control === null) return;
  const input = control.querySelector('input');
  const box = control.getBoundingClientRect();
  overlayWidth.value =
    input === null ? box.width : Math.max(box.right - input.getBoundingClientRect().left, 0);
}

const overlayPt = computed(() => ({
  overlay: { style: overlayWidth.value > 0 ? { width: `${String(overlayWidth.value)}px` } : {} },
}));

let observer: ResizeObserver | null = null;

onMounted(() => {
  measure();
  if (typeof ResizeObserver === 'undefined' || controlEl.value === null) return;
  observer = new ResizeObserver(measure);
  observer.observe(controlEl.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

function onSelect(event: { value: ComboOption }): void {
  emit('update:modelValue', event.value.id);
  emit('selected', event.value);
  if (props.clearOnSelect) typed.value = '';
}

/**
 * Enter on a name nothing matched is not a dead end: it opens the add dialog
 * with that name, which is what the shopkeeper meant by typing it.
 */
function onEnter(): void {
  if (suggestions.value.length > 0 || props.onAdd === undefined) return;
  const text = typedText.value.trim();
  if (text !== '') props.onAdd(text);
}
</script>

<template>
  <div class="combo-field">
    <label v-if="label !== undefined" :for="fieldId">
      {{ label }}
      <span v-if="required" class="req" aria-hidden="true">*</span>
      <span v-if="labelBn !== undefined" class="label-bn">{{ labelBn }}</span>
      <slot name="labelExtra" />
    </label>

    <div ref="controlEl" class="control" :class="{ 'is-disabled': disabled }">
      <i v-if="leadingIcon !== undefined" :class="`pi ${leadingIcon} lead`" aria-hidden="true" />

      <AutoComplete
        v-model="typed"
        :input-id="fieldId"
        :suggestions="suggestions"
        option-label="label"
        :placeholder="placeholder"
        :disabled="disabled === true"
        :loading="busy"
        :aria-required="required"
        dropdown
        complete-on-focus
        append-to="body"
        :pt="overlayPt"
        empty-search-message="Nothing found — use + to add it"
        fluid
        @complete="complete"
        @option-select="onSelect"
        @keyup.enter="onEnter"
      >
        <template #option="{ option }">
          <div class="option">
            <i v-if="option.icon" :class="`pi ${option.icon}`" aria-hidden="true" />
            <span class="option-label">{{ option.label }}</span>
            <span v-if="option.sublabel" class="option-sub">{{ option.sublabel }}</span>
          </div>
        </template>
      </AutoComplete>

      <template v-if="onAdd !== undefined || onManage !== undefined">
        <span class="divider" aria-hidden="true" />
        <Button
          v-if="onAdd !== undefined"
          v-tooltip.top="{ value: `Add ${label ?? 'a new one'}`, showDelay: 250 }"
          class="inline-action"
          icon="pi pi-plus"
          text
          :disabled="disabled === true"
          :aria-label="`Add ${label ?? 'a new one'}`"
          @click="onAdd(typedText.trim())"
        />
        <Button
          v-if="onManage !== undefined"
          v-tooltip.top="{ value: `Manage ${label ?? 'this list'}`, showDelay: 250 }"
          class="inline-action"
          icon="pi pi-cog"
          text
          :disabled="disabled === true"
          :aria-label="`Manage ${label ?? 'this list'}`"
          @click="onManage()"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.combo-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.combo-field label {
  font-size: var(--sher-text-sm, 13px);
  font-weight: 600;
}

.req {
  margin-left: 2px;
  color: var(--sher-danger, #dc2626);
}

.label-bn {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

/*
 * One control, not a field plus buttons: the border belongs to the group, and
 * the AutoComplete inside gives its own away. That is what makes `+` read as
 * part of the same step (UI-77).
 */
.control {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px 0 8px;
  border: 1px solid var(--p-inputtext-border-color, var(--sher-border, #d5dbe3));
  border-radius: var(--sher-radius, 8px);
  background: var(--p-inputtext-background, var(--sher-surface, #fff));
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.control:focus-within {
  border-color: var(--p-primary-color, var(--sher-primary, #2563eb));
  box-shadow: 0 0 0 2px var(--p-primary-100, rgba(37, 99, 235, 0.15));
}

.control.is-disabled {
  opacity: 0.6;
}

.lead {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--sher-text-muted);
}

.control :deep(.p-autocomplete) {
  flex: 1;
  min-width: 0;
}

.control :deep(.p-autocomplete-input),
.control :deep(.p-autocomplete-dropdown) {
  border: 0;
  background: transparent;
  box-shadow: none;
}

.control :deep(.p-autocomplete-dropdown) {
  width: 2rem;
  color: var(--sher-text-muted);
}

.divider {
  width: 1px;
  align-self: stretch;
  margin: 6px 2px;
  background: var(--sher-border, #d5dbe3);
}

.inline-action {
  width: 2rem;
  height: 2rem;
  flex-shrink: 0;
}

.option {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.option-label {
  font-weight: 500;
}

.option-sub {
  font-size: 11px;
  color: var(--sher-text-muted);
}
</style>
