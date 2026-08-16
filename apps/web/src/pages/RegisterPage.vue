<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { completeRegistration, requestSignupOtp } from '../api/auth';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';

/**
 * Signup (D-07): one field accepting mobile OR email → 6-digit OTP → set
 * business name, username, password and PIN → tenant created, logged in.
 *
 * UI-27: loading, error and (here) success states are all explicit.
 * UI-35: the submit button disables while in flight, so a double-click cannot
 * create two shops by construction rather than by user discipline.
 * UI-36: nothing is optimistic — the router only moves after the server answers.
 */
const router = useRouter();
const { signIn } = useSession();

type Step = 'IDENTIFIER' | 'CODE' | 'DETAILS';

const step = ref<Step>('IDENTIFIER');
const busy = ref(false);
const error = ref<string | null>(null);
const errorCode = ref<string | null>(null);

const identifier = ref('');
const channel = ref<'EMAIL' | 'PHONE'>('PHONE');
/** Development transport only — never populated in production (D-33, slice 1.7). */
const devCode = ref<string | null>(null);

const otpCode = ref('');
const businessName = ref('');
const username = ref('');
const password = ref('');
const pin = ref('');

function fail(cause: unknown): void {
  if (cause instanceof ApiError) {
    error.value = cause.message;
    errorCode.value = cause.code;
    return;
  }
  // Never swallow an unexpected failure into a generic message (UI-28).
  error.value = cause instanceof Error ? cause.message : String(cause);
  errorCode.value = 'UNEXPECTED';
}

async function sendCode(): Promise<void> {
  busy.value = true;
  error.value = null;
  errorCode.value = null;
  try {
    const result = await requestSignupOtp(identifier.value);
    channel.value = result.channel;
    devCode.value = result.devCode ?? null;
    step.value = 'CODE';
  } catch (cause) {
    fail(cause);
  } finally {
    busy.value = false;
  }
}

function confirmCode(): void {
  // The code is checked by the server when the account is created — there is no
  // separate verify endpoint, so a wrong code surfaces on the final submit.
  error.value = null;
  errorCode.value = null;
  step.value = 'DETAILS';
}

async function createAccount(): Promise<void> {
  busy.value = true;
  error.value = null;
  errorCode.value = null;
  try {
    const result = await completeRegistration({
      identifier: identifier.value,
      otpCode: otpCode.value,
      businessName: businessName.value,
      username: username.value,
      password: password.value,
      pin: pin.value,
    });
    signIn(result.accessToken, result.tenant.name);
    await router.push('/dashboard');
  } catch (cause) {
    fail(cause);
    // A dead or wrong code cannot be fixed on this step — send them back.
    if (
      errorCode.value === 'OTP_EXPIRED' ||
      errorCode.value === 'OTP_MAX_ATTEMPTS_EXCEEDED'
    ) {
      step.value = 'IDENTIFIER';
      otpCode.value = '';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <section class="panel">
      <header class="head">
        <span class="mark">S</span>
        <h1>Create your business</h1>
        <p class="lead">
          SherERP keeps your sales, stock and accounts in one place.
        </p>
      </header>

      <ol class="steps" aria-label="Signup progress">
        <li :class="{ done: step !== 'IDENTIFIER', current: step === 'IDENTIFIER' }">Verify</li>
        <li :class="{ done: step === 'DETAILS', current: step === 'CODE' }">Code</li>
        <li :class="{ current: step === 'DETAILS' }">Details</li>
      </ol>

      <p v-if="error !== null" class="error" role="alert">
        <strong>{{ errorCode }}</strong>
        {{ error }}
      </p>

      <!-- Step 1 — one field, mobile or email (D-07) -->
      <form v-if="step === 'IDENTIFIER'" @submit.prevent="sendCode">
        <label class="field">
          <span class="label">Mobile number or email</span>
          <input
            v-model="identifier"
            type="text"
            autocomplete="username"
            placeholder="01712345678"
            required
            :disabled="busy"
          />
          <span class="sher-help-bn">
            যে নম্বর বা ইমেইলে আপনি কোড পাবেন — পরে এটি দিয়েই লগইন করবেন
          </span>
        </label>

        <button type="submit" class="primary" :disabled="busy || identifier.length === 0">
          {{ busy ? 'Sending code…' : 'Send verification code' }}
        </button>
      </form>

      <!-- Step 2 — the 6-digit code -->
      <form v-else-if="step === 'CODE'" @submit.prevent="confirmCode">
        <p class="sent">
          We sent a 6-digit code to your
          {{ channel === 'PHONE' ? 'mobile number' : 'email address' }}.
        </p>

        <p v-if="devCode !== null" class="dev-code">
          Development mode — your code is <strong>{{ devCode }}</strong
          >. A real SMS or email is sent once a provider is configured.
        </p>

        <label class="field">
          <span class="label">Verification code</span>
          <input
            v-model="otpCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            required
            :disabled="busy"
          />
          <span class="sher-help-bn">কোডটি ৫ মিনিট পর্যন্ত কাজ করবে</span>
        </label>

        <button type="submit" class="primary" :disabled="otpCode.length !== 6">Continue</button>
        <button type="button" class="ghost" :disabled="busy" @click="step = 'IDENTIFIER'">
          Use a different number or email
        </button>
      </form>

      <!-- Step 3 — business name, username, password, PIN -->
      <form v-else @submit.prevent="createAccount">
        <label class="field">
          <span class="label">Business name</span>
          <input v-model="businessName" type="text" required :disabled="busy" />
          <span class="sher-help-bn">
            আপনার দোকান বা ব্যবসার নাম — ইনভয়েস ও রিপোর্টে এটাই দেখা যাবে
          </span>
        </label>

        <label class="field">
          <span class="label">Username</span>
          <input v-model="username" type="text" autocomplete="username" required :disabled="busy" />
        </label>

        <label class="field">
          <span class="label">Password</span>
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            required
            :disabled="busy"
          />
          <span class="hint">At least 8 characters, with a letter and a number.</span>
        </label>

        <label class="field">
          <span class="label">PIN</span>
          <input
            v-model="pin"
            type="password"
            inputmode="numeric"
            maxlength="4"
            autocomplete="off"
            required
            :disabled="busy"
          />
          <span class="sher-help-bn">
            ৪ সংখ্যার পিন — এই ডিভাইসে দ্রুত লগইন করার জন্য, পাসওয়ার্ডের বিকল্প নয়
          </span>
        </label>

        <button type="submit" class="primary" :disabled="busy">
          {{ busy ? 'Creating your business…' : 'Create business' }}
        </button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  place-items: center;
  min-height: 100%;
  padding: var(--sher-space-6) var(--sher-space-4);
}

.panel {
  width: 100%;
  max-width: 440px;
  padding: var(--sher-space-6);
  background: var(--sher-glass-bg-strong);
  backdrop-filter: blur(var(--sher-glass-blur));
  -webkit-backdrop-filter: blur(var(--sher-glass-blur));
  border: 1px solid var(--sher-border-glass);
  box-shadow: var(--sher-shadow-raised);
  border-radius: var(--sher-radius-lg);
}

.head {
  text-align: center;
  margin-bottom: var(--sher-space-5);
}

.mark {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: var(--sher-space-3);
  border-radius: var(--sher-radius-sm);
  background: linear-gradient(135deg, var(--sher-primary), var(--sher-primary-dark));
  color: var(--sher-text-inverse);
  font-size: var(--sher-text-xl);
  font-weight: 700;
}

h1 {
  margin: 0;
  font-size: var(--sher-text-2xl);
  font-weight: 680;
  letter-spacing: -0.02em;
}

.lead {
  margin: var(--sher-space-2) 0 0;
  color: var(--sher-text-muted);
}

.steps {
  display: flex;
  gap: var(--sher-space-2);
  list-style: none;
  margin: 0 0 var(--sher-space-5);
  padding: 0;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.steps li {
  flex: 1;
  padding-top: var(--sher-space-2);
  border-top: 2px solid var(--sher-border);
  transition: border-color var(--sher-transition), color var(--sher-transition);
}

.steps li.current,
.steps li.done {
  border-top-color: var(--sher-primary);
  color: var(--sher-primary-dark);
  font-weight: 600;
}

.field {
  display: block;
  margin-bottom: var(--sher-space-4);
}

.label {
  display: block;
  margin-bottom: var(--sher-space-2);
  font-weight: 550;
}

input {
  width: 100%;
  padding: 10px var(--sher-space-3);
  border: 1px solid var(--sher-border);
  border-radius: var(--sher-radius-sm);
  background: #ffffff;
  font: inherit;
  color: var(--sher-text);
  transition: border-color var(--sher-transition), box-shadow var(--sher-transition);
}

input:focus {
  outline: none;
  border-color: var(--sher-primary);
  box-shadow: 0 0 0 3px var(--sher-primary-soft);
}

input:disabled {
  background: #f8fafc;
}

.hint {
  display: block;
  margin-top: var(--sher-space-1);
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

button {
  width: 100%;
  padding: 11px var(--sher-space-4);
  border-radius: var(--sher-radius-sm);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--sher-transition), opacity var(--sher-transition);
}

.primary {
  border: none;
  background: var(--sher-primary);
  color: var(--sher-text-inverse);
}

.primary:hover:not(:disabled) {
  background: var(--sher-primary-dark);
}

.primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ghost {
  margin-top: var(--sher-space-2);
  border: 1px solid var(--sher-border);
  background: transparent;
  color: var(--sher-text-muted);
  font-weight: 500;
}

.error {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 var(--sher-space-4);
  padding: var(--sher-space-3);
  border: 1px solid rgba(220, 38, 38, 0.3);
  border-radius: var(--sher-radius-sm);
  background: rgba(220, 38, 38, 0.07);
  color: var(--sher-danger);
  font-size: var(--sher-text-sm);
}

.error strong {
  font-size: var(--sher-text-xs);
  letter-spacing: 0.04em;
  opacity: 0.8;
}

.sent {
  margin: 0 0 var(--sher-space-4);
  color: var(--sher-text-muted);
}

.dev-code {
  margin: 0 0 var(--sher-space-4);
  padding: var(--sher-space-3);
  border: 1px dashed var(--sher-warning);
  border-radius: var(--sher-radius-sm);
  background: rgba(217, 119, 6, 0.07);
  color: var(--sher-warning);
  font-size: var(--sher-text-sm);
}
</style>
