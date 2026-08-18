<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { changePassword, changePin, fetchSecuritySettings } from '../api/auth';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import OtpInput from '../components/OtpInput.vue';

/**
 * Settings → Security (§5.3): set or change your password and your PIN.
 *
 * Two independent forms on one screen, because they are two independent
 * credentials with two different consequences — changing the password signs out
 * every other device, changing the PIN signs out nothing. Merging them into one
 * "update credentials" form would hide that difference at the moment it matters.
 *
 * Each card is in one of two states, decided by what the account actually holds:
 *
 *   **Set** — no credential yet. An account created through Google has neither
 *   (D-07: Google is the credential), so there is nothing to prove and no
 *   "current" field is shown. Being signed in is the authority.
 *
 *   **Change** — a credential exists, so the current one is required.
 *
 * The screen only *asks* for the right thing; the server decides what was
 * actually required, from what is stored rather than from what was sent.
 *
 * UI-27: loading, success and error states are explicit per form.
 * UI-35: submits disable in flight.
 */
const router = useRouter();
const session = useSession();

/* --- which credentials exist --------------------------------------------- */
const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const hasPassword = ref(false);
const hasPin = ref(false);

async function loadSettings(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const settings = await fetchSecuritySettings(session.accessToken.value ?? '');
    hasPassword.value = settings.hasPassword;
    hasPin.value = settings.hasPin;
  } catch (cause) {
    loadError.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    loading.value = false;
  }
}

onMounted(loadSettings);

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
  const wasSetting = !hasPassword.value;
  try {
    await changePassword(
      session.accessToken.value ?? '',
      // This device's session is the one the server spares.
      session.refreshToken.value ?? '',
      wasSetting ? null : currentPassword.value,
      newPassword.value,
    );
    currentPassword.value = '';
    newPassword.value = '';
    // The card flips to "Change" from here on, so the next edit asks for the
    // current password — the same rule a password user has always had.
    hasPassword.value = true;
    passwordOutcome.value = {
      kind: 'OK',
      message: wasSetting
        ? 'Password set. You can now sign in with your mobile number or email as well as Google.'
        : 'Password changed. Every other signed-in device has been signed out.',
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
  const wasSetting = !hasPin.value;
  try {
    await changePin(
      session.accessToken.value ?? '',
      wasSetting ? null : currentPin.value,
      newPin.value,
    );
    currentPin.value = '';
    newPin.value = '';
    hasPin.value = true;
    pinOutcome.value = {
      kind: 'OK',
      message: wasSetting
        ? 'PIN set. Use it to unlock this device next time.'
        : 'PIN changed. Use it next time you unlock this device.',
    };
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
  <AppShell
    title="Security"
    :breadcrumb="['Dashboard', 'Settings']"
    help-bn="পাসওয়ার্ড আর পিন এখান থেকে ঠিক করুন"
  >
    <!-- Loading: a skeleton, not a bare spinner (UI-27). -->
    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading security settings">
      <div class="skeleton" />
      <div class="skeleton" />
    </div>

    <!-- Error: the server's own code and message, plus a retry (UI-28). -->
    <AppCard v-else-if="loadError !== null" title="Could not load your security settings">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="loadSettings">Try again</button>
    </AppCard>

    <template v-else>
      <!-- Two cards side by side on a wide screen: both are short forms, and a
           420px column of fields inside a full-width card is mostly empty. -->
      <div class="settings-grid">
        <!-- ------------------------------------------------------- password -->
        <AppCard
          :title="hasPassword ? 'Password' : 'Set a password'"
          :subtitle="
            hasPassword
              ? 'Changing your password signs out every other device. This one stays signed in.'
              : 'You signed in with Google, so this account has no password yet. Add one to sign in with your mobile number or email too.'
          "
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

            <!-- Absent when there is no password to prove — a Google account. -->
            <div v-if="hasPassword" class="field">
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
              <label for="new-password">{{ hasPassword ? 'New password' : 'Password' }}</label>
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
              :disabled="
                passwordBusy ||
                newPassword.length === 0 ||
                (hasPassword && currentPassword.length === 0)
              "
            >
              {{ passwordBusy ? 'Saving…' : hasPassword ? 'Change password' : 'Set password' }}
            </button>
          </form>
        </AppCard>

        <!-- ------------------------------------------------------------ PIN -->
        <AppCard
          :title="hasPin ? 'PIN' : 'Set a PIN'"
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
            <div v-if="hasPin" class="pin-field">
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
              <span class="pin-label">{{ hasPin ? 'New PIN' : 'PIN' }}</span>
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
              :disabled="pinBusy || newPin.length !== 4 || (hasPin && currentPin.length !== 4)"
            >
              {{ pinBusy ? 'Saving…' : hasPin ? 'Change PIN' : 'Set PIN' }}
            </button>
          </form>
        </AppCard>
      </div>
    </template>
  </AppShell>
</template>

<style scoped>
/*
 * Fields, buttons, notices and skeletons come from `design/components.css`.
 * What is left is this screen's own: a single-column form narrow enough to
 * read (UI-22's Form pattern) and the PIN group's label.
 */
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
  max-width: 420px;
}

.form .btn {
  align-self: flex-start;
}

.skeletons,
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: var(--sher-space-5);
  align-items: start;
}

.retry {
  margin-top: var(--sher-space-4);
}

.skeleton {
  height: 230px;
}

/* Two four-box groups on one screen: the group carries its own label, which is
   what tells a screen reader which "Digit 1 of 4" belongs to which. */
.pin-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.pin-label {
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.notice .linkish {
  margin-left: auto;
}
</style>
