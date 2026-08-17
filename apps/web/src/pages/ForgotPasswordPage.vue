<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { requestPasswordResetOtp, resetPassword } from '../api/auth';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import OtpInput from '../components/OtpInput.vue';

/**
 * Forgot password (D-07): enter email or phone → 6-digit OTP to that channel →
 * verify → set a new password.
 *
 * One card that changes what it asks for, matching the signup flow — the same
 * three beats, so someone who has registered once already recognises this.
 *
 * The code is verified and spent in the **same** submit as the new password.
 * Signup can afford a separate "check my code" step because it has three more
 * fields to collect afterwards; here there is only the password, and a second
 * round trip would buy nothing but another chance to lose the code.
 *
 * UI-27: loading and error states are explicit.
 * UI-35: submits disable in flight.
 * UI-36: nothing is optimistic — the router moves only after the server answers.
 */
const router = useRouter();
const session = useSession();

type Step = 'IDENTIFIER' | 'RESET' | 'DONE';

const step = ref<Step>('IDENTIFIER');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

const identifier = ref('');
const channel = ref<'EMAIL' | 'PHONE'>('PHONE');
/** Development transport only — never populated in production (D-33, slice 1.7). */
const devCode = ref<string | null>(null);

const otpCode = ref('');
const password = ref('');

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

const channelLabel = computed(() => (channel.value === 'EMAIL' ? 'email' : 'mobile'));

function fail(cause: unknown): void {
  error.value =
    cause instanceof ApiError
      ? { code: cause.code, message: cause.message }
      : {
          code: 'UNEXPECTED',
          message: cause instanceof Error ? cause.message : String(cause),
        };
}

/** A dead code cannot be fixed on this step — send them back to the start. */
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
    const result = await requestPasswordResetOtp(identifier.value);
    channel.value = result.channel;
    devCode.value = result.devCode ?? null;
    otpCode.value = '';
    startCountdown();
    step.value = 'RESET';
  } catch (cause) {
    fail(cause);
  } finally {
    busy.value = false;
  }
}

async function setNewPassword(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await resetPassword(identifier.value, otpCode.value, password.value);
    // Every session was revoked server-side, including any this browser held —
    // so forget them here too rather than leave a dead token offering PIN entry.
    session.clear();
    password.value = '';
    otpCode.value = '';
    step.value = 'DONE';
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

async function goToLogin(): Promise<void> {
  await router.push('/login');
}
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
        <!--
          One screen serves two people: someone who forgot a password, and
          someone who was just added to a business and has never had one. The
          server cannot tell them apart before the code is verified — and must
          not, or this page would report which numbers hold an account.
        -->
        <h1>Set or reset your password</h1>
        <p class="lede">
          Enter the mobile number or email your business is registered under —
          or the one your owner added you with. We will send a 6-digit code to it.
        </p>

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
            <p class="sher-bn">যে নম্বর বা ইমেইলে অ্যাকাউন্ট খুলেছিলেন সেটাই দিন</p>
          </div>

          <button type="submit" class="btn btn-primary" :disabled="busy || identifier.length === 0">
            {{ busy ? 'Sending code…' : 'Send code' }}
          </button>
          <RouterLink to="/login" class="btn btn-ghost">Back to sign in</RouterLink>
        </form>

        <p class="fine">
          The answer is the same whether or not that number has an account — so
          this page can never be used to find out who is registered here.
        </p>
      </template>

      <!-- --------------------------------------- step 2: code + new password -->
      <template v-else-if="step === 'RESET'">
        <h1>Enter the code and a new password</h1>
        <p class="sent-to">
          Code sent to your {{ channelLabel }}: <strong>{{ identifier.trim() }}</strong>
        </p>

        <p v-if="devCode !== null" class="dev-code">
          Development mode — your code is <strong>{{ devCode }}</strong
          >. A real SMS or email is sent once a provider is configured.
        </p>

        <form @submit.prevent="setNewPassword">
          <p v-if="error !== null" class="error" role="alert">
            <span class="error-code">{{ error.code }}</span>
            {{ error.message }}
          </p>

          <OtpInput v-model="otpCode" :disabled="busy" />

          <p class="help">
            <template v-if="remaining > 0">Expires in {{ countdown }}</template>
            <template v-else>This code has expired.</template>
            ·
            <button type="button" class="linkish" :disabled="busy" @click="sendCode">
              Send a new code
            </button>
          </p>

          <div class="field">
            <label for="password">New password</label>
            <input
              id="password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              required
              :disabled="busy"
            />
            <p class="sher-bn">অন্তত ৮ অক্ষর, একটি অক্ষর আর একটি সংখ্যা থাকতে হবে</p>
          </div>

          <button
            type="submit"
            class="btn btn-primary"
            :disabled="busy || otpCode.length !== 6 || password.length === 0"
          >
            {{ busy ? 'Saving…' : 'Set new password' }}
          </button>
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="step = 'IDENTIFIER'">
            Use a different number or email
          </button>
        </form>

        <p class="fine">
          Five-minute expiry, single use, maximum five attempts. Setting a new
          password signs out every device, including this one.
        </p>
      </template>

      <!-- ---------------------------------------------------- step 3: done -->
      <template v-else>
        <h1>Password changed</h1>
        <p class="lede">
          Every device that was signed in has been signed out. Sign in again with
          your new password.
        </p>

        <button type="button" class="btn btn-primary" @click="goToLogin">Go to sign in</button>

        <p class="fine">
          Your PIN is unchanged. You can set a new one from Settings → Security
          once you are signed in.
        </p>
      </template>
    </main>
  </div>
</template>

<style scoped>
@import '../design/auth-card.css';

/* A router link styled as the secondary action, so it matches the button above it. */
a.btn {
  display: grid;
  place-items: center;
  text-decoration: none;
}
</style>
