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
 * screen reader announces, and the panel it opens says what it is at the top.
 *
 * Not a `title` attribute: `title` cannot be styled, cannot carry the Bangla
 * line, and is announced inconsistently.
 */
defineProps<{
  /** The English label — what this control does, in two or three words. */
  text: string;
  textBn?: string | undefined;
  /** Where the bubble sits relative to the control. */
  placement?: 'top' | 'bottom' | undefined;
}>();

const shown = ref(false);

/**
 * Hover, but only from a real mouse. Touch browsers synthesise `mouseenter` on
 * tap, which would flash the label over the panel the tap just opened.
 */
function onEnter(event: PointerEvent): void {
  if (event.pointerType === 'mouse') shown.value = true;
}

function onLeave(): void {
  shown.value = false;
}
</script>

<template>
  <span
    class="tip-wrap"
    @pointerenter="onEnter"
    @pointerleave="onLeave"
    @focusin="shown = true"
    @focusout="shown = false"
  >
    <slot />
    <span
      v-if="shown"
      class="tip-bubble"
      :class="placement === 'bottom' ? 'is-bottom' : 'is-top'"
      role="tooltip"
    >
      {{ text }}
      <span v-if="textBn" class="sher-bn tip-bn">{{ textBn }}</span>
    </span>
  </span>
</template>

<style scoped>
.tip-wrap {
  position: relative;
  display: inline-flex;
}

.tip-bubble {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: max-content;
  max-width: 14rem;
  padding: 5px 9px;
  border-radius: var(--sher-radius);
  background: var(--sher-text, #0f172a);
  color: #fff;
  font-size: var(--sher-text-xs);
  font-weight: 500;
  line-height: 1.4;
  text-align: center;
  white-space: normal;
  pointer-events: none;
  box-shadow: var(--sher-shadow-card);
}

.tip-bubble.is-top {
  bottom: calc(100% + 6px);
}

.tip-bubble.is-bottom {
  top: calc(100% + 6px);
}

.tip-bn {
  font-family: var(--sher-font-bn);
  opacity: 0.85;
}
</style>
