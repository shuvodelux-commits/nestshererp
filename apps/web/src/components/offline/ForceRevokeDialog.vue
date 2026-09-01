<script setup lang="ts">
import type { DeviceResponse } from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import { computed, ref } from 'vue';

import ErrorNotice from '../ErrorNotice.vue';

/**
 * Cutting a computer off immediately — the Owner's act alone (owner decision
 * 2026-08-31).
 *
 * Two boxes, and both are required: the **password** re-entered, and a
 * **reason** that goes into the audit trail permanently. The password rather
 * than the PIN, because the PIN is typed at the counter in front of customers
 * all day and this is the one action that can strand a day's takings.
 *
 * The sentence in the middle is the whole point of the dialog: this is not the
 * kind revoke. The machine is not asked to send up what it holds, and anything
 * it does send afterwards is held aside for review instead of going into the
 * books.
 */
defineProps<{
  device: DeviceResponse;
  busy?: boolean;
  error?: { readonly code: string; readonly message: string } | null | undefined;
}>();

const emit = defineEmits<{ close: []; submit: [payload: { password: string; reason: string }] }>();

const password = ref('');
const reason = ref('');
const valid = computed(() => password.value.length > 0 && reason.value.trim().length >= 3);
</script>

<template>
  <Dialog
    :visible="true"
    modal
    header="Cut this computer off — এখনই বিচ্ছিন্ন করুন"
    :style="{ width: 'min(38rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <form
      class="device-form"
      @submit.prevent="valid && emit('submit', { password, reason: reason.trim() })"
    >
      <p class="warn">
        <strong>{{ device.name }}</strong> loses offline permission at once, without being asked to
        send up anything it is still holding. Whatever it sends after this is held aside for review
        instead of going into the books.
        <span class="label-bn">
          এই কম্পিউটার সঙ্গে সঙ্গে অনুমতি হারাবে; পরে যা পাঠাবে তা সরাসরি হিসাবে যাবে না।
        </span>
      </p>

      <p class="lede">
        Use this only when the machine is lost, stolen or dead. If it still works, take the
        permission back the normal way and let it finish first.
      </p>

      <ErrorNotice v-if="error" :code="error.code" :message="error.message" />

      <div class="grid">
        <div class="field">
          <label for="force-reason">Reason <span class="label-bn">কারণ — আবশ্যক</span></label>
          <input
            id="force-reason"
            v-model="reason"
            autocomplete="off"
            maxlength="300"
            placeholder="Counter PC was stolen"
          />
        </div>

        <div class="field">
          <label for="force-password">
            Your password <span class="label-bn">আপনার পাসওয়ার্ড</span>
          </label>
          <input
            id="force-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
          />
        </div>
      </div>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy === true" @click="emit('close')">
          Cancel <span class="label-bn">বাতিল</span>
        </button>
        <button type="submit" class="btn btn-danger" :disabled="busy === true || !valid">
          {{ busy === true ? 'Cutting off…' : 'Cut off this computer' }}
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

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sher-space-3);
}

@media (max-width: 640px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.warn {
  margin: 0;
  padding: var(--sher-space-3);
  border: var(--sher-border-w) solid var(--sher-danger, #c0392b);
  border-radius: var(--sher-radius);
  background: var(--sher-danger-soft, rgb(192 57 43 / 8%));
}

.warn .label-bn {
  display: block;
  margin-top: 4px;
}

.lede {
  margin: 0;
  color: var(--sher-text-muted);
}
</style>
