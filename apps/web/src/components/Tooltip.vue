<script setup lang="ts">
import { ref } from 'vue';

/**
 * A label that appears when a control is pointed at or focused (UI-49).
 *
 * **For icon-only controls.** A grid square, a `⋯`, an `×` — each is obvious
 * once you know it and opaque until then, and this audience has not met most of
 * them. UI-05 already bans an icon-only *action button*; this covers the small
 * secondary controls where a word beside the icon would not fit, by putting the
 * word one hover away and in the accessible name always.
 *
 * **Different from `HelpTip`.** That one explains a *field* and opens on tap,
 * because its content is the point. This one labels a *control* whose tap does
 * something else — tapping the grid button must open the panel, not explain
 * itself — so it shows on hover and keyboard focus only. On a touch screen the
 * label is still reachable: it is the button's `aria-label`, which is what a
 * screen reader announces.
 *
 * **The bubble is teleported to `<body>` and positioned fixed.** An absolutely
 * positioned bubble is clipped by any ancestor with `overflow: hidden` — and the
 * picker this labels has exactly that, to keep its rounded corners — so the
 * label appeared sliced off inside the field. Teleporting escapes every such
 * ancestor at once, rather than each container having to remember not to clip.
 *
 * Not a `title` attribute: `title` cannot be styled, cannot carry the Bangla
 * line, and is announced inconsistently.
 */
defineProps<{
  /** The English label — what this control does, in two or three words. */
  text: string;
  textBn?: string | undefined;
}>();

const shown = ref(false);
const anchor = ref<HTMLElement | null>(null);
/** Viewport coordinates, so the bubble needs no positioned ancestor. */
const at = ref({ top: 0, left: 0 });

function place(): void {
  const el = anchor.value;
  if (el === null) return;

  const box = el.getBoundingClientRect();
  at.value = { top: box.top, left: box.left + box.width / 2 };
}

function show(): void {
  place();
  shown.value = true;
}

/**
 * Hover, but only from a real mouse. Touch browsers synthesise `mouseenter` on
 * tap, which would flash the label over the panel the tap just opened.
 */
function onEnter(event: PointerEvent): void {
  if (event.pointerType === 'mouse') show();
}
</script>

<template>
  <span
    ref="anchor"
    class="tip-wrap"
    @pointerenter="onEnter"
    @pointerleave="shown = false"
    @focusin="show"
    @focusout="shown = false"
  >
    <slot />
  </span>

  <Teleport to="body">
    <span
      v-if="shown"
      class="tip-bubble"
      role="tooltip"
      :style="{ top: `${at.top}px`, left: `${at.left}px` }"
    >
      {{ text }}
      <span v-if="textBn" class="sher-bn tip-bn">{{ textBn }}</span>
    </span>
  </Teleport>
</template>

<style scoped>
.tip-wrap {
  display: inline-flex;
}
</style>

<style>
/*
 * Unscoped: the bubble lives on `<body>` after the teleport, so a scoped rule
 * would not reach it.
 */
.tip-bubble {
  position: fixed;
  z-index: 80;
  /* Sits above the control, centred on it — hence the half-width shift. */
  transform: translate(-50%, calc(-100% - 8px));
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: max-content;
  max-width: 14rem;
  padding: 5px 9px;
  border-radius: 8px;
  background: #0f172a;
  color: #fff;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.4;
  text-align: center;
  white-space: normal;
  /* Never intercepts the click meant for the control it describes. */
  pointer-events: none;
  box-shadow: 0 4px 12px rgb(15 23 42 / 25%);
}

.tip-bubble .tip-bn {
  font-family: var(--sher-font-bn);
  opacity: 0.85;
}
</style>
