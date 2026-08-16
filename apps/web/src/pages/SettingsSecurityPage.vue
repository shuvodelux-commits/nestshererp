<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { changePassword, changePin } from '../api/auth';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import AppShell from '../components/shell/AppShell.vue';
import OtpInput from '../components/OtpInput.vue';

/**
 * Settings → Security (§5.3): change your password or your PIN.
 *
 * Two independent forms on one screen, because they are two independent
 * credentials with two different consequences — changing the password signs out
 * every other device, changing the PIN signs out nothing. Merging them into one
 * "update credentials" form would hide that difference at the moment it matters.
 *
 * Each requires the current credential, which is checked server-side; this
 * screen never decides whether one is correct.
 *
 * UI-27: loading, success and error states are explicit per form.
 * UI-35: submits disable in flight.
 */
const router = useRouter();
const session = useSession();

type Outcome = { kind: 'OK'; message: string } | { kind: 'ERROR'; code: string; message: string };

function describe(cause: unknown): Outcome {
  return cause instanceof ApiError
    ? { kind: 'ERROR', code: cause.code, message: cause.message }
    : {
        kind: 'ERROR',
        code: 'UNEXPECTED',
        message: cause instanceof Error ? cause.message : String(cause),
      };
}

/* --- password ------------------------------------------------------------ */
const currentPassword = ref('');
const newPassword = ref('');
const passwordBusy = ref(false);
const passwordOutcome = ref<Outcome | null>(null);

async function submitPassword(): Promise<void> {
  passwordBusy.value = true;
  passwordOutcome.value = null;
  try {
    await changePassword(
      session.accessToken.value ?? '',
      // This device's session is the one the server spares.
      session.refreshToken.value ?? '',
      currentPassword.value,
      newPassword.value,
    );
    currentPassword.value = '';
    newPassword.value = '';
    passwordOutcome.value = {
      kind: 'OK',
      message: 'Password changed. Every other signed-in device has been signed out.',
    };
  } catch (cause) {
    passwordOutcome.value = describe(cause);
  } finally {
    passwordBusy.value = false;
  }
}

/* --- PIN ----------------------------------------------------------------- */
const currentPin = ref('');
const newPin = ref('');
const pinBusy = ref(false);
const pinOutcome = ref<Outcome | null>(null);

async function submitPin(): Promise<void> {
  pinBusy.value = true;
  pinOutcome.value = null;
  try {
    await changePin(session.accessToken.value ?? '', currentPin.value, newPin.value);
    currentPin.value = '';
    newPin.value = '';
    pinOutcome.value = { kind: 'OK', message: 'PIN changed. Use it next time you unlock this device.' };
  } catch (cause) {
    pinOutcome.value = describe(cause);
  } finally {
    pinBusy.value = false;
  }
}

/** An expired access token cannot be repaired here — sign in again. */
async function signInAgain(): Promise<void> {
  session.lock();
  await router.push('/login');
}
</script>

<template>
  <AppShell title="Security" help-bn="পাসওয়ার্ড আর পিন এখান থেকে বদলান">
    <!-- ------------------------------------------------------- password -->
    <AppCard
      title="Password"
      subtitle="Changing your password signs out every other device. This one stays signed in."
    >
      <form class="form" @submit.prevent="submitPassword">
        <p
          v-if="passwordOutcome !== null"
          class="notice"
          :class="passwordOutcome.kind === 'OK' ? 'is-ok' : 'is-bad'"
          role="status"
        >
          <span v-if="passwordOutcome.kind === 'ERROR'" class="code">{{ passwordOutcome.code }}</span>
          {{ passwordOutcome.message }}
          <button
            v-if="passwordOutcome.kind === 'ERROR' && passwordOutcome.code === 'UNAUTHENTICATED'"
            type="button"
            class="linkish"
            @click="signInAgain"
          >
            Sign in again
          </button>
        </p>

        <div class="field">
          <label for="current-password">Current password</label>
          <input
            id="current-password"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            :disabled="passwordBusy"
          />
        </div>

        <div class="field">
          <label for="new-password">New password</label>
          <input
            id="new-password"
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            required
            :disabled="passwordBusy"
          />
          <p class="sher-bn">অন্তত ৮ অক্ষর, একটি অক্ষর আর একটি সংখ্যা থাকতে হবে</p>
        </div>

        <button
          type="submit"
          class="btn btn-primary"
          :disabled="passwordBusy || currentPassword.length === 0 || newPassword.length === 0"
        >
          {{ passwordBusy ? 'Saving…' : 'Change password' }}
        </button>
      </form>
    </AppCard>

    <!-- ------------------------------------------------------------ PIN -->
    <AppCard
      title="PIN"
      subtitle="A 4-digit convenience credential for unlocking a device you have already signed in on. It never replaces your password on a new device."
    >
      <form class="form" @submit.prevent="submitPin">
        <p
          v-if="pinOutcome !== null"
          class="notice"
          :class="pinOutcome.kind === 'OK' ? 'is-ok' : 'is-bad'"
          role="status"
        >
          <span v-if="pinOutcome.kind === 'ERROR'" class="code">{{ pinOutcome.code }}</span>
          {{ pinOutcome.message }}
        </p>

        <!--
          Two four-box groups on one screen: `role="group"` with its own label
          is what tells a screen reader which "Digit 1 of 4" belongs to which.
        -->
        <div class="pin-field">
          <span class="pin-label">Current PIN</span>
          <OtpInput
            v-model="currentPin"
            :length="4"
            mask
            :disabled="pinBusy"
            role="group"
            aria-label="Current PIN"
          />
        </div>

        <div class="pin-field">
          <span class="pin-label">New PIN</span>
          <OtpInput
            v-model="newPin"
            :length="4"
            mask
            :disabled="pinBusy"
            role="group"
            aria-label="New PIN"
          />
        </div>

        <button
          type="submit"
          class="btn btn-primary"
          :disabled="pinBusy || currentPin.length !== 4 || newPin.length !== 4"
        >
          {{ pinBusy ? 'Saving…' : 'Change PIN' }}
        </button>
      </form>
    </AppCard>
  </AppShell>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
  max-width: 420px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field label,
.pin-label {
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.field input {
  height: var(--sher-control-h);
  padding: 0 11px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface);
  font: inherit;
  font-size: var(--sher-text-base);
}

.field input:focus {
  outline: 2px solid var(--sher-primary);
  outline-offset: -1px;
}

.field input:disabled {
  background: var(--sher-surface-2);
  color: var(--sher-text-muted);
}

.pin-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.btn {
  height: var(--sher-control-h);
  padding: 0 16px;
  border-radius: var(--sher-radius);
  border: 0;
  font: inherit;
  font-size: var(--sher-text-base);
  font-weight: 600;
  cursor: pointer;
  align-self: flex-start;
}

.btn-primary {
  background: var(--sher-primary);
  color: var(--sher-on-primary);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.notice {
  margin: 0;
  padding: 9px 11px;
  border-radius: var(--sher-radius);
  border: 1px solid;
  font-size: var(--sher-text-sm);
}

.is-ok {
  border-color: var(--sher-line);
  background: var(--sher-primary-soft);
  color: var(--sher-text);
}

.is-bad {
  border-color: var(--sher-bad);
  background: var(--sher-surface-2);
  color: var(--sher-text);
}

.code {
  display: block;
  font-family: var(--sher-font-mono);
  font-size: var(--sher-text-2xs);
  letter-spacing: 0.04em;
  color: var(--sher-bad);
  margin-bottom: 2px;
}

.linkish {
  display: block;
  margin-top: 5px;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  font-size: var(--sher-text-sm);
  color: var(--sher-primary-strong);
  text-decoration: underline;
  cursor: pointer;
}
</style>
