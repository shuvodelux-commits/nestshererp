<script setup lang="ts">
import Button from 'primevue/button';
import Popover from 'primevue/popover';
import { ref } from 'vue';

defineProps<{
  text: string;
  textBn?: string | undefined;
  label: string;
}>();

const popover = ref<InstanceType<typeof Popover> | null>(null);
const open = ref(false);
const pointerInteraction = ref(false);

function onPointerDown(): void {
  pointerInteraction.value = true;
}

function toggle(event: Event): void {
  popover.value?.toggle(event);
  pointerInteraction.value = false;
}

function show(event: Event): void {
  if (!pointerInteraction.value) popover.value?.show(event);
}

function onPointerEnter(event: PointerEvent): void {
  if (event.pointerType === 'mouse') popover.value?.show(event);
}

function onPointerLeave(event: PointerEvent): void {
  if (event.pointerType === 'mouse') popover.value?.hide();
}
</script>

<template>
  <span class="help" @pointerenter="onPointerEnter" @pointerleave="onPointerLeave">
    <Button
      class="help-trigger"
      icon="pi pi-info-circle"
      text
      rounded
      :aria-label="`More about ${label}`"
      :aria-expanded="open"
      @pointerdown="onPointerDown"
      @click="toggle"
      @focus="show"
    />

    <Popover
      ref="popover"
      append-to="body"
      class="help-popover"
      :pt="{ root: { role: 'tooltip' } }"
      @show="open = true"
      @hide="open = false"
    >
      <span class="help-copy">
        <span>{{ text }}</span>
        <span v-if="textBn" class="sher-bn help-bn">{{ textBn }}</span>
      </span>
    </Popover>
  </span>
</template>

<style scoped>
.help {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}

:deep(.help-trigger) {
  width: 32px;
  height: 32px;
  margin: -8px 0 -8px 2px;
  padding: 0;
  color: var(--sher-text-muted);
}

.help-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: min(18rem, 70vw);
  font-size: var(--sher-text-sm);
  line-height: 1.5;
}

.help-bn {
  font-family: var(--sher-font-bn);
  font-size: var(--sher-text-xs);
  opacity: 0.85;
}
</style>
