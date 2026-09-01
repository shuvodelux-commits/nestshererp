<script setup lang="ts">
import type { DeviceResponse } from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import { computed, ref } from 'vue';

import ErrorNotice from '../ErrorNotice.vue';

/**
 * Replace Writer — moving the shop's offline permission from one computer to
 * another, as one act (owner decision 2026-08-31).
 *
 * This is the ordinary path, not an exotic one. Clearing site data on the
 * counter PC gives that browser a new identity, so the same physical machine
 * comes back as a *new* computer while the old record still holds the shop's
 * only offline slot. Two separate steps would leave a shopkeeper working out
 * why the machine in front of them is blocked by one that no longer exists.
 *
 * One question decides everything else: **can the old computer still be used?**
 *
 * - Yes → it hands over. It sends up anything it is still holding first, and
 *   nothing is lost. Owner or manager, no password.
 * - No → the old machine is cut off. Owner only, password re-entered, reason
 *   required, and anything it sends later is held aside for review.
 */
const props = defineProps<{
  incoming: DeviceResponse;
  current: DeviceResponse;
  /** False for a manager: the force route is the owner's alone. */
  canForce: boolean;
  busy?: boolean;
  error?: { readonly code: string; readonly message: string } | null | undefined;
}>();

const emit = defineEmits<{
  close: [];
  submit: [
    payload: { name: string; forceOldDevice: boolean; password?: string; reason?: string },
  ];
}>();

const name = ref(props.incoming.name);
const oldMachineWorks = ref(true);
const password = ref('');
const reason = ref('');

const forcing = computed(() => !oldMachineWorks.value);
const valid = computed(() => {
  if (name.value.trim().length < 2) return false;
  if (!forcing.value) return true;
  return props.canForce && password.value.length > 0 && reason.value.trim().length >= 3;
});

function submit(): void {
  if (!valid.value) return;
  emit('submit', {
    name: name.value.trim(),
    forceOldDevice: forcing.value,
    ...(forcing.value ? { password: password.value, reason: reason.value.trim() } : {}),
  });
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    header="Replace the offline computer — অফলাইন কম্পিউটার বদলান"
    :style="{ width: 'min(38rem, 94vw)' }"
    @update:visible="emit('close')"
  >
    <form class="device-form" @submit.prevent="submit">
      <p class="lede">
        <strong>{{ current.name }}</strong> is the shop's offline computer today.
        <strong>{{ incoming.name }}</strong> will take over.
      </p>

      <ErrorNotice v-if="error" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="replace-name">
          Name for the new computer <span class="label-bn">নতুন কম্পিউটারের নাম</span>
        </label>
        <input
          id="replace-name"
          v-model="name"
          autocomplete="off"
          maxlength="60"
          placeholder="Counter PC — Chrome"
        />
      </div>

      <fieldset class="choice">
        <legend>Can the old computer still be used? <span class="label-bn">পুরোনো কম্পিউটারটি কি এখনো চলে?</span></legend>

        <label class="option">
          <input v-model="oldMachineWorks" type="radio" :value="true" />
          <span>
            <strong>Yes — it hands over</strong>
            <small>
              It sends up anything it is still holding, then goes read-only. Nothing is lost.
              <span class="label-bn">কিছুই হারাবে না।</span>
            </small>
          </span>
        </label>

        <label class="option" :class="{ disabled: !canForce }">
          <input v-model="oldMachineWorks" type="radio" :value="false" :disabled="!canForce" />
          <span>
            <strong>No — it is lost, stolen or dead</strong>
            <small v-if="canForce">
              It is cut off at once. Anything it sends afterwards is held aside for review.
              <span class="label-bn">পরে যা পাঠাবে তা যাচাইয়ের জন্য আলাদা রাখা হবে।</span>
            </small>
            <small v-else>Only the owner can cut a computer off. Ask the owner to do this one.</small>
          </span>
        </label>
      </fieldset>

      <div v-if="forcing && canForce" class="grid">
        <div class="field">
          <label for="replace-reason">Reason <span class="label-bn">কারণ — আবশ্যক</span></label>
          <input
            id="replace-reason"
            v-model="reason"
            autocomplete="off"
            maxlength="300"
            placeholder="Old counter PC was sold"
          />
        </div>
        <div class="field">
          <label for="replace-password">
            Your password <span class="label-bn">আপনার পাসওয়ার্ড</span>
          </label>
          <input
            id="replace-password"
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
        <button
          type="submit"
          class="btn"
          :class="forcing ? 'btn-danger' : 'btn-primary'"
          :disabled="busy === true || !valid"
        >
          {{ busy === true ? 'Moving…' : 'Move offline permission' }}
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

.choice {
  display: grid;
  gap: var(--sher-space-2);
  margin: 0;
  padding: var(--sher-space-3);
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius);
}

.choice legend {
  padding: 0 4px;
  font-weight: 600;
}

.option {
  display: flex;
  gap: var(--sher-space-2);
  align-items: flex-start;
  /* The 40px touch target UI-59 asks for, on a control a manager taps once. */
  min-height: 40px;
}

.option.disabled {
  opacity: 0.6;
}

.option small {
  display: block;
  color: var(--sher-text-muted);
}
</style>
