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
/**
 * Which side of the control the bubble sits on. Above by default — below is
 * where the field being labelled usually is — but a control near the top of the
 * window has nothing above it, and a bubble placed there is drawn off-screen.
 */
const below = ref(false);

/** Roughly how much room a two-line bubble needs, including its 8px offset. */
const CLEARANCE = 64;
/** Never let an edge of the bubble touch the edge of the window. */
const MARGIN = 8;
/** Matches `max-width` on `.tip-bubble`, so the clamp knows its half-width. */
const MAX_HALF_WIDTH = 112;

function place(): void {
  const el = anchor.value;
  if (el === null) return;

  const box = el.getBoundingClientRect();
  below.value = box.top < CLEARANCE;

  /*
   * Centred on the control, then pulled back inside the window. Without the
   * clamp a tip on a control near either edge — and every one of these sits at
   * the right-hand end of its field — is drawn half outside it.
   */
  const centre = box.left + box.width / 2;
  const lowest = MARGIN + MAX_HALF_WIDTH;
  const highest = window.innerWidth - MARGIN - MAX_HALF_WIDTH;
  const left = highest < lowest ? window.innerWidth / 2 : Math.min(Math.max(centre, lowest), highest);

  at.value = { top: below.value ? box.bottom : box.top, left };
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
      :class="{ 'is-below': below }"
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
  border: 1px solid var(--sher-tip-line);
  border-radius: 8px;
  /*
   * The same tokens `HelpTip` uses, so the two kinds of tip are one thing to the
   * eye, and so the dark theme gets a bubble that is visible against a near-black
   * page rather than sunk into it.
   */
  background: var(--sher-tip-bg);
  color: var(--sher-tip-fg);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.4;
  text-align: center;
  white-space: normal;
  /* Never intercepts the click meant for the control it describes. */
  pointer-events: none;
  box-shadow: 0 4px 12px rgb(15 23 42 / 25%);
}

/* Flipped under the control, for one sitting too near the top of the window. */
.tip-bubble.is-below {
  transform: translate(-50%, 8px);
}

.tip-bubble .tip-bn {
  font-family: var(--sher-font-bn);
  opacity: 0.85;
}
</style>
