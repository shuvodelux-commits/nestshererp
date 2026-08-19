<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * The longer explanation behind a small `i` (UI-49).
 *
 * UI-16 puts a short Bangla phrase under every label. Some things need more than
 * a phrase — what a reorder level is *for*, why deactivating is not deleting,
 * why a credit limit is not a balance — and putting all of that on the form
 * turns a six-field screen back into a wall of text. So the sentence lives here,
 * one tap away, and the form stays clean.
 *
 * **It opens on tap, not hover alone.** The shops this is built for run on
 * Android phones, where there is no hover: a hover-only tip is invisible to the
 * entire intended audience. Hover is the *extra* for whoever happens to be on a
 * desktop, never the way in.
 *
 * It is a real `button` with an accessible name rather than a `title` attribute.
 * `title` never appears on touch at all, cannot be styled, and is announced
 * inconsistently by screen readers — three reasons it is the wrong tool for the
 * one thing it looks like it is for.
 */
const props = defineProps<{
  /** The explanation, in the words used across a counter. */
  text: string;
  /** Its Bangla sibling — the half most of these readers will actually read. */
  textBn?: string | undefined;
  /** Names the button for a screen reader: "More about Reorder at". */
  label: string;
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

function toggle(): void {
  open.value = !open.value;
}

/**
 * Hover opens it too, but only on a device that genuinely has a pointer.
 * Touch browsers synthesise hover events on tap, and without this guard the tap
 * would open the tip and the synthetic `mouseenter` would fight the toggle.
 */
function onPointerEnter(event: PointerEvent): void {
  if (event.pointerType === 'mouse') open.value = true;
}

function onPointerLeave(event: PointerEvent): void {
  if (event.pointerType === 'mouse') open.value = false;
}

/** A tap anywhere else dismisses it — the gesture people already expect. */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const el = root.value;
  if (el !== null && !el.contains(event.target as Node)) open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <span ref="root" class="help" @pointerenter="onPointerEnter" @pointerleave="onPointerLeave">
    <button
      type="button"
      class="help-trigger"
      :aria-label="`More about ${props.label}`"
      :aria-expanded="open"
      @click="toggle"
      @focus="open = true"
      @blur="open = false"
    >
      <i class="pi pi-info-circle" aria-hidden="true" />
    </button>

    <!--
      `role="tooltip"` with `v-if`, so the text is announced when it appears and
      is not read out as part of the label the rest of the time.
    -->
    <span v-if="open" class="help-bubble" role="tooltip">
      <span class="help-text">{{ text }}</span>
      <span v-if="textBn" class="sher-bn help-bn">{{ textBn }}</span>
    </span>
  </span>
</template>

<style scoped>
.help {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}

/*
 * 32px of tappable area around a 14px glyph. Smaller than the 44px a primary
 * control gets — this sits inline in a label and a full-size button there would
 * push the label around — but large enough that a thumb does not miss it and hit
 * the input beneath.
 */
.help-trigger {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin: -8px 0 -8px 2px;
  padding: 0;
  background: none;
  border: 0;
  border-radius: 50%;
  color: var(--sher-text-muted);
  font-size: 14px;
  cursor: pointer;
}

.help-trigger:hover {
  color: var(--sher-primary);
  background: var(--sher-primary-soft);
}

.help-trigger:focus-visible {
  outline: 2px solid var(--sher-primary);
  outline-offset: 1px;
}

/*
 * Above the trigger rather than below it: below is where the input it explains
 * sits, and covering the field while explaining the field is its own small joke.
 */
.help-bubble {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  max-width: min(18rem, 70vw);
  padding: var(--sher-space-2) var(--sher-space-3);
  border-radius: var(--sher-radius);
  background: var(--sher-text, #0f172a);
  color: #fff;
  font-size: var(--sher-text-sm);
  font-weight: 400;
  line-height: 1.5;
  text-align: left;
  white-space: normal;
  box-shadow: var(--sher-shadow-card);
}

.help-text {
  font-family: var(--sher-font);
}

.help-bn {
  font-family: var(--sher-font-bn);
  font-size: var(--sher-text-xs);
  opacity: 0.85;
}
</style>
