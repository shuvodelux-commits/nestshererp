<script setup lang="ts">
import Dialog from 'primevue/dialog';
import { computed, ref } from 'vue';

import ErrorNotice from '../ErrorNotice.vue';

/**
 * Naming a computer — the one modal behind Register, Approve and Rename.
 *
 * The three acts differ in what they *do*, never in what the person has to
 * type: one field, one name, one primary button. The owner's rule is that every
 * one-task action looks the same everywhere in SherERP, so a manager who has
 * approved a machine once already knows how to rename one.
 */
const props = defineProps<{
  title: string;
  titleBn: string;
  /** The sentence above the field — what this act will actually do. */
  lede: string;
  confirmLabel: string;
  initialName: string;
  busy?: boolean;
  error?: { readonly code: string; readonly message: string } | null | undefined;
}>();

const emit = defineEmits<{ close: []; submit: [name: string] }>();

const name = ref(props.initialName);
const valid = computed(() => name.value.trim().length >= 2);
</script>

<template>
  <Dialog
    :visible="true"
    modal
    :header="`${title} — ${titleBn}`"
    :style="{ width: 'min(38rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <form class="device-form" @submit.prevent="valid && emit('submit', name.trim())">
      <p class="lede">{{ lede }}</p>

      <ErrorNotice v-if="error" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="device-name">
          Computer name <span class="label-bn">কম্পিউটারের নাম</span>
        </label>
        <input
          id="device-name"
          v-model="name"
          autocomplete="off"
          maxlength="60"
          placeholder="Counter PC — Chrome"
        />
        <small>A name the shop will recognise — where it sits, and whose it is.</small>
      </div>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy === true" @click="emit('close')">
          Cancel <span class="label-bn">বাতিল</span>
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy === true || !valid">
          {{ busy === true ? 'Saving…' : confirmLabel }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.device-form {
  display: grid;
  gap: var(--sher-space-3);
}

.lede {
  margin: 0;
  color: var(--sher-text-muted);
}

.field small {
  display: block;
  margin-top: 4px;
  color: var(--sher-text-muted);
  font-size: 11px;
}
</style>
