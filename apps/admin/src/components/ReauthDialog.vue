<script setup lang="ts">
import { ref, watch } from 'vue';

import { reauthenticate } from '../api/session';

/**
 * The authenticator prompt in front of every sensitive action (§24).
 *
 * One dialog, shown by `AppShell` whenever any call anywhere in the console
 * comes back `REAUTH_REQUIRED`. Centralised deliberately: an operator who is
 * asked for a code in a different way on each screen learns to type it without
 * reading, which is exactly the habit this is supposed to interrupt.
 */
const props = defineProps<{ open: boolean; permission: string }>();
const emit = defineEmits<{ (event: 'done'): void; (event: 'cancel'): void }>();

const code = ref('');
const error = ref('');
const busy = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) {
      code.value = '';
      error.value = '';
    }
  },
);

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await reauthenticate(code.value);
    emit('done');
  } catch {
    error.value = 'That code is not right. Try the next one.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="ctl-backdrop">
    <div class="ctl-modal" style="width: 26rem">
      <h3>Confirm it is you</h3>
      <p class="ctl-note">
        This action reaches into a customer's installation or changes what they may run, so it needs
        a fresh code from your authenticator — being signed in is not the same as being present.
      </p>
      <label class="ctl" for="reauth-code">6-digit code</label>
      <input
        id="reauth-code"
        v-model="code"
        class="ctl mono"
        inputmode="numeric"
        maxlength="6"
        autocomplete="one-time-code"
        @keyup.enter="confirm"
      />
      <p v-if="error" class="ctl-error">{{ error }}</p>
      <footer>
        <button class="ctl" @click="emit('cancel')">Cancel</button>
        <button class="ctl primary" :disabled="busy || code.length < 6" @click="confirm">
          Confirm
        </button>
      </footer>
    </div>
  </div>
</template>
