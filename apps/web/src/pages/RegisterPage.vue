<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { completeRegistration, requestSignupOtp, verifySignupOtp } from '../api/auth';
import { ApiError, loadConfig } from '../api/client';
import { useSession } from '../auth/session';
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
const { signIn } = useSession();

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

/* --- Google (D-07) ---------------------------------------------------------
 * The client id is read at runtime from /config.json like every other setting
 * (UI-07). Until a deployment supplies one, the button explains that it is not
 * configured instead of failing silently — UI-05 forbids a control whose
 * behaviour is invisible, and a button that quietly does nothing is worse than
 * one that says why.
 */
const googleClientId = ref<string | null>(null);
void loadConfig().then((config) => {
  googleClientId.value = config.googleClientId ?? null;
});

function useGoogle(): void {
  error.value = {
    code: 'GOOGLE_NOT_CONFIGURED',
    message:
      googleClientId.value === null
        ? 'Google sign-in is not configured on this server yet.'
        : 'Google sign-in arrives with the login screen. Use your mobile number or email for now.',
  };
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
    signIn(result.accessToken, result.tenant.name);
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

        <button type="button" class="btn btn-ghost btn-google" :disabled="busy" @click="useGoogle">
          <svg viewBox="0 0 18 18" aria-hidden="true" class="g-mark">
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
            />
            <path
              fill="#FBBC05"
              d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
            />
          </svg>
          Continue with Google
        </button>

        <p class="fine">
          One field, classified as email or phone by format. A Google account can
          only be linked to an account that already exists — signing up always
          verifies a number or email first.
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
.page {
  display: grid;
  place-items: center;
  min-height: 100%;
  padding: 40px 16px;
  background: var(--sher-surface);
}

.card {
  width: 100%;
  max-width: 400px;
  background: var(--sher-surface-3);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  box-shadow: var(--sher-shadow-raised);
  padding: 26px 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 4px;
}

.brand-mark {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--sher-radius);
  background: var(--sher-primary);
  color: var(--sher-on-primary);
  font-weight: 700;
  font-size: 13px;
}

.brand-text {
  font-size: 14px;
  font-weight: 600;
}

h1 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.lede,
.sent-to {
  margin: -6px 0 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}

.sent-to strong {
  color: var(--sher-text);
  font-variant-numeric: tabular-nums;
}

form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 2px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.field label {
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.field input {
  height: var(--sher-control-h);
  padding: 0 10px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface-3);
  font: inherit;
  font-size: var(--sher-text-base);
  color: var(--sher-text);
  transition: border-color var(--sher-transition);
}

.field input:focus {
  outline: 2px solid var(--sher-primary);
  outline-offset: 1px;
  border-color: var(--sher-primary);
}

.field input:disabled {
  background: var(--sher-surface);
}

.row {
  display: flex;
  gap: 12px;
}

.row .field {
  flex: 1;
}

.field-pin {
  max-width: 110px;
}

.pin-help {
  margin: -6px 0 0;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: var(--sher-control-h);
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: var(--sher-radius);
  font: inherit;
  font-size: var(--sher-text-base);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--sher-transition);
}

.btn-primary {
  background: var(--sher-primary);
  color: var(--sher-on-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--sher-primary-strong);
}

.btn-ghost {
  background: var(--sher-surface-3);
  color: var(--sher-text);
  border-color: var(--sher-line);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--sher-surface-2);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.g-mark {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.divider {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--sher-text-muted);
  font-size: var(--sher-text-xs);
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--sher-line-soft);
}

.help {
  margin: 0;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
  line-height: 1.5;
}

.linkish {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: var(--sher-text-xs);
  color: var(--sher-primary-strong);
  text-decoration: underline;
  cursor: pointer;
}

.linkish:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.error {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 9px 11px;
  border: 1px solid rgba(168, 32, 24, 0.3);
  border-radius: var(--sher-radius);
  background: var(--sher-bad-bg);
  color: var(--sher-bad);
  font-size: var(--sher-text-sm);
}

.error-code {
  font-family: var(--sher-font-mono);
  font-size: var(--sher-text-2xs);
  letter-spacing: 0.04em;
  opacity: 0.85;
}

.dev-code {
  margin: 0;
  padding: 9px 11px;
  border: 1px dashed rgba(138, 93, 0, 0.45);
  border-radius: var(--sher-radius);
  background: var(--sher-warn-bg);
  color: var(--sher-warn);
  font-size: var(--sher-text-sm);
}

.dev-code strong {
  font-family: var(--sher-font-mono);
  font-size: 15px;
  letter-spacing: 0.08em;
}

.fine {
  margin: 6px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--sher-line-soft);
  font-size: 11px;
  line-height: 1.5;
  color: var(--sher-text-muted);
}
</style>
