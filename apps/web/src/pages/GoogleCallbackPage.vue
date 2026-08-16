<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { loginWithGoogle } from '../api/auth';
import { ApiError } from '../api/client';
import { readGoogleCallback } from '../auth/google';
import { useSession } from '../auth/session';

/**
 * Where Google sends the browser back after sign-in (D-07).
 *
 * The ID token arrives in the URL fragment. Nothing here trusts it: it is
 * handed straight to the server, which checks the signature against Google's
 * keys, the issuer, the audience and the expiry before it becomes a session.
 *
 * D-07 is explicit that **Google alone never creates a tenant** — if no account
 * holds the verified email, this ends in a message pointing at signup, not a
 * new business.
 */
const router = useRouter();
const session = useSession();

const error = ref<{ code: string; message: string } | null>(null);

onMounted(async () => {
  const { idToken, error: callbackError } = readGoogleCallback();

  // Strip the token out of the address bar before anything else — it should not
  // survive in history or be copied out of a shared screen.
  history.replaceState(null, '', window.location.pathname);

  if (idToken === null) {
    error.value = { code: 'GOOGLE_SIGN_IN_FAILED', message: callbackError ?? 'Sign-in failed.' };
    return;
  }

  try {
    const result = await loginWithGoogle(idToken);
    session.signIn(result, result.user.username);
    await router.replace('/dashboard');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : {
            code: 'UNEXPECTED',
            message: cause instanceof Error ? cause.message : String(cause),
          };
  }
});
</script>

<template>
  <div class="page">
    <main class="card">
      <div class="brand">
        <span class="brand-mark">S</span>
        <span class="brand-text">SherERP</span>
      </div>

      <template v-if="error === null">
        <h1>Signing you in…</h1>
        <p class="lede">One moment while we check your Google account.</p>
      </template>

      <template v-else>
        <h1>Could not sign you in</h1>
        <p class="error" role="alert">
          <span class="error-code">{{ error.code }}</span>
          {{ error.message }}
        </p>
        <p class="fine">
          If this Google account has never been used here, it has no business
          yet — <RouterLink to="/register">create one</RouterLink> first, then
          Google will sign you straight in.
        </p>
        <RouterLink to="/login" class="btn btn-ghost">Back to sign in</RouterLink>
      </template>
    </main>
  </div>
</template>

<style scoped>
@import '../design/auth-card.css';

.btn {
  text-decoration: none;
}
</style>
