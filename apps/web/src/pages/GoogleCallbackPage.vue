<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { loginWithGoogle, registerWithGoogle } from '../api/auth';
import { ApiError } from '../api/client';
import { readGoogleCallback } from '../auth/google';
import { useSession } from '../auth/session';

/**
 * Where Google sends the browser back after sign-in (D-07).
 *
 * The ID token arrives in the URL fragment. Nothing here trusts it: it is handed
 * to the server, which checks the signature against Google's keys, the issuer,
 * the audience and the expiry before it becomes a session.
 *
 * Two outcomes. A **known** email signs straight in. An **unknown** one comes
 * back as `GOOGLE_ACCOUNT_UNKNOWN`, and this page asks for the one field a
 * business cannot be created without — its name (§5.3, D-07 revised
 * 2026-08-17). Nothing is stored until that form is submitted, so closing the
 * tab here leaves no half-made tenant behind.
 *
 * The token is **kept in memory** for that second call and never written to
 * storage: it is a bearer credential, and the whole point of stripping it from
 * the address bar below is that it should not outlive this page.
 */
const router = useRouter();
const session = useSession();

type State = 'CHECKING' | 'NEEDS_BUSINESS' | 'CREATING' | 'FAILED';

const state = ref<State>('CHECKING');
const error = ref<{ code: string; message: string } | null>(null);
const businessName = ref('');

/** In memory only, for the lifetime of this page. */
let verifiedToken: string | null = null;

function fail(cause: unknown): void {
  error.value =
    cause instanceof ApiError
      ? { code: cause.code, message: cause.message }
      : {
          code: 'UNEXPECTED',
          message: cause instanceof Error ? cause.message : String(cause),
        };
  state.value = 'FAILED';
}

onMounted(async () => {
  const { idToken, error: callbackError } = readGoogleCallback();

  // Strip the token out of the address bar before anything else — it should not
  // survive in history or be copied out of a shared screen.
  history.replaceState(null, '', window.location.pathname);

  if (idToken === null) {
    error.value = { code: 'GOOGLE_SIGN_IN_FAILED', message: callbackError ?? 'Sign-in failed.' };
    state.value = 'FAILED';
    return;
  }

  try {
    const result = await loginWithGoogle(idToken);
    session.signIn(result, result.user.username);
    await router.replace('/dashboard');
  } catch (cause) {
    // No account for this verified email yet — offer to create one.
    if (cause instanceof ApiError && cause.code === 'GOOGLE_ACCOUNT_UNKNOWN') {
      verifiedToken = idToken;
      state.value = 'NEEDS_BUSINESS';
      return;
    }
    fail(cause);
  }
});

async function createBusiness(): Promise<void> {
  if (verifiedToken === null) return;

  state.value = 'CREATING';
  error.value = null;
  try {
    const result = await registerWithGoogle(verifiedToken, businessName.value);
    session.signIn(result, result.user.username);
    session.setBusinessName(result.tenant.name);
    await router.replace('/dashboard');
  } catch (cause) {
    fail(cause);
  }
}
</script>

<template>
  <div class="page">
    <main class="card">
      <div class="brand">
        <span class="brand-mark">S</span>
        <span class="brand-text">SherERP</span>
      </div>

      <!-- ------------------------------------------------------- signing in -->
      <template v-if="state === 'CHECKING'">
        <h1>Signing you in…</h1>
        <p class="lede">One moment while we check your Google account.</p>
      </template>

      <!-- ------------------------------------------- new account: one field -->
      <template v-else-if="state === 'NEEDS_BUSINESS' || state === 'CREATING'">
        <h1>Name your business</h1>
        <p class="lede">
          Your Google account is verified. This is the last thing we need — it
          appears on your invoices and reports.
        </p>

        <form @submit.prevent="createBusiness">
          <p v-if="error !== null" class="error" role="alert">
            <span class="error-code">{{ error.code }}</span>
            {{ error.message }}
          </p>

          <div class="field">
            <label for="businessName">Business name</label>
            <input
              id="businessName"
              v-model="businessName"
              type="text"
              placeholder="Karim Traders"
              required
              :disabled="state === 'CREATING'"
            />
            <p class="sher-bn">দোকানের নাম — ইনভয়েস আর রিপোর্টে এটাই দেখা যাবে</p>
          </div>

          <button
            type="submit"
            class="btn btn-primary"
            :disabled="state === 'CREATING' || businessName.trim().length === 0"
          >
            {{ state === 'CREATING' ? 'Creating…' : 'Create my business' }}
          </button>
          <RouterLink to="/login" class="btn btn-ghost">Cancel</RouterLink>
        </form>

        <p class="fine">
          You will sign in with Google from now on. There is no password or PIN
          on this account yet — set a password any time from
          <strong>Forgot your password?</strong> on the sign-in screen, and a PIN
          from Settings once you have one.
        </p>
      </template>

      <!-- ----------------------------------------------------------- failed -->
      <template v-else>
        <h1>Could not sign you in</h1>
        <p class="error" role="alert">
          <span class="error-code">{{ error?.code }}</span>
          {{ error?.message }}
        </p>
        <RouterLink to="/login" class="btn btn-ghost">Back to sign in</RouterLink>
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
