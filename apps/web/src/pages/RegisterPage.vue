<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { completeRegistration, requestSignupOtp, verifySignupOtp } from '../api/auth';
import { ApiError } from '../api/client';
import { startGoogleSignIn } from '../auth/google';
import { useSession } from '../auth/session';
import GoogleButton from '../components/GoogleButton.vue';
import OtpInput from '../components/OtpInput.vue';

/**
 * Signup (D-07): one field accepting mobile OR email → 6-digit OTP to that
 * channel → business name, username, password and PIN → tenant created, and
 * that user signed in.
 *
 * One card that changes what it asks for, rather than three separate pages —
 * the person never loses the sense of being in one short flow.
 *
 * UI-27: loading and error states are explicit.
 * UI-35: submits disable in flight, so a double-click cannot create two shops
 *        by construction rather than by user discipline.
 * UI-36: nothing is optimistic — the router moves only after the server answers.
 */
const router = useRouter();
const session = useSession();

type Step = 'IDENTIFIER' | 'CODE' | 'DETAILS';

const step = ref<Step>('IDENTIFIER');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

const identifier = ref('');
const channel = ref<'EMAIL' | 'PHONE'>('PHONE');
/** Development transport only — never populated in production (D-33, slice 1.7). */
const devCode = ref<string | null>(null);

const otpCode = ref('');
const businessName = ref('');
const username = ref('');
const password = ref('');
const pin = ref('');

/**
 * Google is a complete alternative to this form (§5.3, D-07 revised
 * 2026-08-17): the redirect ends on the callback page, which signs in an
 * existing account or asks for a business name and creates one. It skips the
 * OTP entirely, because Google's `email_verified` claim is the same proof the
 * code would have provided.
 */
async function useGoogle(): Promise<void> {
  busy.value = true;
  error.value = null;
  const started = await startGoogleSignIn();
  if (!started) {
    busy.value = false;
    error.value = {
      code: 'GOOGLE_NOT_CONFIGURED',
      message: 'Google sign-in is not configured on this server yet.',
    };
  }
}

/* --- code expiry (§5.3: 5 minutes) --------------------------------------- */
const OTP_TTL_SECONDS = 300;
const remaining = ref(0);
let ticker: ReturnType<typeof setInterval> | undefined;

function startCountdown(): void {
  remaining.value = OTP_TTL_SECONDS;
  clearInterval(ticker);
  ticker = setInterval(() => {
    remaining.value = Math.max(0, remaining.value - 1);
    if (remaining.value === 0) clearInterval(ticker);
  }, 1000);
}

onUnmounted(() => clearInterval(ticker));

const countdown = computed(() => {
  const minutes = Math.floor(remaining.value / 60);
  const seconds = remaining.value % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
});

const maskedIdentifier = computed(() => identifier.value.trim());

function fail(cause: unknown): void {
  error.value =
    cause instanceof ApiError
      ? { code: cause.code, message: cause.message }
      : {
          code: 'UNEXPECTED',
          message: cause instanceof Error ? cause.message : String(cause),
        };
}

/** A dead code cannot be fixed on the code step — send them back to the start. */
function bounceIfCodeIsDead(): void {
  if (error.value?.code === 'OTP_EXPIRED' || error.value?.code === 'OTP_MAX_ATTEMPTS_EXCEEDED') {
    step.value = 'IDENTIFIER';
    otpCode.value = '';
    devCode.value = null;
  }
}

async function sendCode(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const result = await requestSignupOtp(identifier.value);
    channel.value = result.channel;
    devCode.value = result.devCode ?? null;
    otpCode.value = '';
    startCountdown();
    step.value = 'CODE';
  } catch (cause) {
    fail(cause);
  } finally {
    busy.value = false;
  }
}

async function verifyCode(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await verifySignupOtp(identifier.value, otpCode.value);
    step.value = 'DETAILS';
  } catch (cause) {
    fail(cause);
    bounceIfCodeIsDead();
  } finally {
    busy.value = false;
  }
}

async function createAccount(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const result = await completeRegistration({
      identifier: identifier.value,
      otpCode: otpCode.value,
      businessName: businessName.value,
      username: username.value,
      password: password.value,
      pin: pin.value,
    });
    session.signIn(result, result.user.username);
    session.setBusinessName(result.tenant.name);
    await router.push('/dashboard');
  } catch (cause) {
    fail(cause);
    bounceIfCodeIsDead();
  } finally {
    busy.value = false;
  }
}

// Typing a fresh code clears the previous complaint about it.
watch(otpCode, () => {
  if (error.value?.code === 'OTP_INCORRECT') error.value = null;
});
</script>

<template>
  <div class="page">
    <main class="card">
      <div class="brand">
        <span class="brand-mark">S</span>
        <span class="brand-text">SherERP</span>
      </div>

      <!-- ------------------------------------------------ step 1: identifier -->
      <template v-if="step === 'IDENTIFIER'">
        <h1>Create your business account</h1>
        <p class="lede">Sales, stock and accounts in one place.</p>

        <form @submit.prevent="sendCode">
          <p v-if="error !== null" class="error" role="alert">
            <span class="error-code">{{ error.code }}</span>
            {{ error.message }}
          </p>

          <div class="field">
            <label for="identifier">Mobile number or email</label>
            <input
              id="identifier"
              v-model="identifier"
              type="text"
              autocomplete="username"
              placeholder="01712345678"
              required
              :disabled="busy"
            />
            <p class="sher-bn">যেটা দেবেন সেখানেই ৬ সংখ্যার কোড যাবে</p>
          </div>

          <button type="submit" class="btn btn-primary" :disabled="busy || identifier.length === 0">
            {{ busy ? 'Sending code…' : 'Send code' }}
          </button>
        </form>

        <div class="divider"><span>or</span></div>

        <GoogleButton :disabled="busy" label="Continue with Google" @click="useGoogle" />

        <p class="fine">
          One field, classified as email or phone by format. Continuing with
          Google skips the code — the address is already verified — and asks only
          for your business name. That account signs in with Google until you set
          a password.
        </p>
      </template>

      <!-- ------------------------------------------------------ step 2: code -->
      <template v-else-if="step === 'CODE'">
        <h1>Enter the 6-digit code</h1>
        <p class="sent-to">
          Sent to <strong>{{ maskedIdentifier }}</strong>
        </p>

        <p v-if="devCode !== null" class="dev-code">
          Development mode — your code is <strong>{{ devCode }}</strong
          >. A real SMS or email is sent once a provider is configured.
        </p>

        <form @submit.prevent="verifyCode">
          <p v-if="error !== null" class="error" role="alert">
            <span class="error-code">{{ error.code }}</span>
            {{ error.message }}
          </p>

          <OtpInput v-model="otpCode" :disabled="busy" @complete="verifyCode" />

          <p class="help">
            <template v-if="remaining > 0">Expires in {{ countdown }}</template>
            <template v-else>This code has expired.</template>
            ·
            <button type="button" class="linkish" :disabled="busy" @click="sendCode">
              Send a new code
            </button>
          </p>

          <button type="submit" class="btn btn-primary" :disabled="busy || otpCode.length !== 6">
            {{ busy ? 'Checking…' : 'Verify' }}
          </button>
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="step = 'IDENTIFIER'">
            Use a different number or email
          </button>
        </form>

        <p class="fine">
          Five-minute expiry, single use, maximum five attempts. The code is
          stored hashed and never appears in a response body.
        </p>
      </template>

      <!-- --------------------------------------------------- step 3: details -->
      <template v-else>
        <h1>Set up your business</h1>
        <p class="lede">Last step — this is what your invoices and reports will show.</p>

        <form @submit.prevent="createAccount">
          <p v-if="error !== null" class="error" role="alert">
            <span class="error-code">{{ error.code }}</span>
            {{ error.message }}
          </p>

          <div class="field">
            <label for="business">Business name</label>
            <input
              id="business"
              v-model="businessName"
              type="text"
              autocomplete="organization"
              required
              :disabled="busy"
            />
            <p class="sher-bn">আপনার দোকান বা ব্যবসার নাম — ইনভয়েস ও রিপোর্টে এটাই দেখা যাবে</p>
          </div>

          <div class="field">
            <label for="username">Username</label>
            <input
              id="username"
              v-model="username"
              type="text"
              autocomplete="username"
              required
              :disabled="busy"
            />
          </div>

          <div class="row">
            <div class="field">
              <label for="password">Password</label>
              <input
                id="password"
                v-model="password"
                type="password"
                autocomplete="new-password"
                required
                :disabled="busy"
              />
              <p class="help">8+ characters, with a letter and a number.</p>
            </div>

            <div class="field field-pin">
              <label for="pin">PIN</label>
              <input
                id="pin"
                v-model="pin"
                type="password"
                inputmode="numeric"
                maxlength="4"
                autocomplete="off"
                required
                :disabled="busy"
              />
              <p class="help">4 digits.</p>
            </div>
          </div>

          <p class="sher-bn pin-help">
            পিন এই ডিভাইসে দ্রুত লগইন করার জন্য — পাসওয়ার্ডের বিকল্প নয়
          </p>

          <button type="submit" class="btn btn-primary" :disabled="busy">
            {{ busy ? 'Creating your business…' : 'Create account' }}
          </button>
        </form>

        <p class="fine">
          Username is a display and audit identity only — you sign in with your
          mobile number or email.
        </p>
      </template>
    </main>
  </div>
</template>

<style scoped>
@import '../design/auth-card.css';

.pin-help {
  margin: -6px 0 0;
}

.sent-to strong {
  word-break: break-all;
}
</style>
