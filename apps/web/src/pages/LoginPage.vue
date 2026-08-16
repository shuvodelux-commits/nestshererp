<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { loginWithPassword, loginWithPin } from '../api/auth';
import { ApiError } from '../api/client';
import { startGoogleSignIn } from '../auth/google';
import { useSession } from '../auth/session';
import GoogleButton from '../components/GoogleButton.vue';
import OtpInput from '../components/OtpInput.vue';

/**
 * Daily login (D-07): email + password, phone + password, PIN on a returning
 * session, or Google. **OTP is never a daily-login method** — it verifies
 * identity at signup and at password recovery only, which keeps SMS cost
 * proportional to new accounts rather than to daily usage.
 *
 * The server answers every failure identically, so this screen never says
 * "no such user" — it cannot, and must not, distinguish them.
 */
const router = useRouter();
const session = useSession();

/** PIN is offered first when this browser has signed in before (§5.3). */
const mode = ref<'PASSWORD' | 'PIN'>(session.canUsePin() ? 'PIN' : 'PASSWORD');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

const identifier = ref('');
const password = ref('');
const pin = ref('');

/** Records the failure and hands back its code, so callers can react to it. */
function fail(cause: unknown): string {
  const failure =
    cause instanceof ApiError
      ? { code: cause.code, message: cause.message }
      : {
          code: 'UNEXPECTED',
          message: cause instanceof Error ? cause.message : String(cause),
        };
  error.value = failure;
  return failure.code;
}

async function signInWithPassword(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const result = await loginWithPassword(identifier.value, password.value);
    session.signIn(result, result.user.username);
    await router.push('/dashboard');
  } catch (cause) {
    fail(cause);
  } finally {
    busy.value = false;
  }
}

async function signInWithPin(): Promise<void> {
  const refreshToken = session.refreshToken.value;
  if (refreshToken === null) {
    mode.value = 'PASSWORD';
    return;
  }

  busy.value = true;
  error.value = null;
  try {
    const result = await loginWithPin(refreshToken, pin.value);
    session.signIn(result, result.user.username);
    await router.push('/dashboard');
  } catch (cause) {
    const code = fail(cause);
    pin.value = '';
    // A revoked or expired device session cannot be recovered with a PIN —
    // only a password can start a new one.
    if (code === 'UNAUTHENTICATED') mode.value = 'PASSWORD';
  } finally {
    busy.value = false;
  }
}

async function signInWithGoogle(): Promise<void> {
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

function useAnotherAccount(): void {
  session.clear();
  mode.value = 'PASSWORD';
  pin.value = '';
  error.value = null;
}
</script>

<template>
  <div class="page">
    <main class="card">
      <div class="brand">
        <span class="brand-mark">S</span>
        <span class="brand-text">SherERP</span>
      </div>

      <!-- ------------------------------------------------------- PIN unlock -->
      <template v-if="mode === 'PIN'">
        <h1>Welcome back</h1>
        <p class="lede">Signed in as <strong>{{ session.username.value }}</strong></p>

        <form @submit.prevent="signInWithPin">
          <p v-if="error !== null" class="error" role="alert">
            <span class="error-code">{{ error.code }}</span>
            {{ error.message }}
          </p>

          <p class="pin-label">Enter your PIN</p>
          <OtpInput v-model="pin" :length="4" mask :disabled="busy" @complete="signInWithPin" />
          <p class="sher-bn">এই ডিভাইসে দ্রুত লগইন — নতুন ডিভাইসে পাসওয়ার্ড লাগবে</p>

          <button type="submit" class="btn btn-primary" :disabled="busy || pin.length !== 4">
            {{ busy ? 'Checking…' : 'Unlock' }}
          </button>
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="mode = 'PASSWORD'">
            Use password instead
          </button>
        </form>

        <p class="fine">
          <button type="button" class="linkish" @click="useAnotherAccount">
            Sign in to a different account
          </button>
          · <RouterLink to="/forgot-password">Forgot your password?</RouterLink>
        </p>
      </template>

      <!-- --------------------------------------------------- password login -->
      <template v-else>
        <h1>Sign in</h1>
        <p class="lede">Use the mobile number or email you registered with.</p>

        <form @submit.prevent="signInWithPassword">
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
          </div>

          <div class="field">
            <label for="password">Password</label>
            <input
              id="password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
          </div>

          <button
            type="submit"
            class="btn btn-primary"
            :disabled="busy || identifier.length === 0 || password.length === 0"
          >
            {{ busy ? 'Signing in…' : 'Sign in' }}
          </button>

          <button
            v-if="session.canUsePin()"
            type="button"
            class="btn btn-ghost"
            :disabled="busy"
            @click="mode = 'PIN'"
          >
            Use PIN instead
          </button>

          <p class="help">
            <RouterLink to="/forgot-password">Forgot your password?</RouterLink>
          </p>
        </form>

        <div class="divider"><span>or</span></div>

        <GoogleButton :disabled="busy" @click="signInWithGoogle" />

        <p class="fine">
          New here? <RouterLink to="/register">Create your business account</RouterLink>. A Google
          account signs you in to an account that already exists — it never
          creates one.
        </p>
      </template>
    </main>
  </div>
</template>

<style scoped>
@import '../design/auth-card.css';

.pin-label {
  margin: 0;
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.lede strong {
  color: var(--sher-text);
  font-weight: 600;
}
</style>
