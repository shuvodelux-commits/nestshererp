<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { completeEnrolment, session, signIn } from '../api/session';

/**
 * Sign in, and — the first time — finish enrolling a second factor.
 *
 * **TOTP is not optional here** (§23). This console can revoke a licence,
 * deploy to every shop in the fleet and open any customer's books; an account
 * that has not enrolled can reach nothing but this screen. There is no
 * configuration that turns it off, which is why the flow has an enrolment step
 * rather than a setting.
 */
const router = useRouter();
const email = ref('');
const password = ref('');
const code = ref('');
const enrolCode = ref('');
const error = ref('');
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await signIn(email.value, password.value, code.value);
    if (session.enrolmentUri === '') await router.push('/');
  } catch {
    // One message for every failure: a wrong address and a wrong password must
    // be indistinguishable, or this form becomes a way to enumerate the
    // vendor's staff.
    error.value = 'Those details are not right.';
  } finally {
    busy.value = false;
  }
}

async function finishEnrolment(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await completeEnrolment(enrolCode.value);
    await router.push('/');
  } catch {
    error.value = 'That code is not right. Try the next one.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div style="display: grid; place-items: center; min-height: 100vh; padding: 24px">
    <div class="ctl-card" style="width: 24rem">
      <h2>SherERP Control</h2>

      <template v-if="session.enrolmentUri === ''">
        <p class="lede">Vendor operations console.</p>
        <label class="ctl" for="email">Email</label>
        <input id="email" v-model="email" class="ctl" autocomplete="username" />
        <label class="ctl" for="password">Password</label>
        <input
          id="password"
          v-model="password"
          class="ctl"
          type="password"
          autocomplete="current-password"
        />
        <label class="ctl" for="code">Authenticator code</label>
        <input
          id="code"
          v-model="code"
          class="ctl mono"
          inputmode="numeric"
          maxlength="6"
          autocomplete="one-time-code"
          @keyup.enter="submit"
        />
        <p v-if="error" class="ctl-error">{{ error }}</p>
        <footer style="display: flex; justify-content: flex-end; margin-top: 16px">
          <button class="ctl primary" :disabled="busy" @click="submit">Sign in</button>
        </footer>
      </template>

      <template v-else>
        <p class="lede">Set up your authenticator before you can use the console.</p>
        <p class="ctl-note">
          Add this to an authenticator app, then type the code it shows. It is displayed once.
        </p>
        <p class="mono" style="word-break: break-all; margin: 12px 0">{{ session.enrolmentUri }}</p>
        <label class="ctl" for="enrol-code">Code from the app</label>
        <input
          id="enrol-code"
          v-model="enrolCode"
          class="ctl mono"
          inputmode="numeric"
          maxlength="6"
          @keyup.enter="finishEnrolment"
        />
        <p v-if="error" class="ctl-error">{{ error }}</p>
        <footer style="display: flex; justify-content: flex-end; margin-top: 16px">
          <button class="ctl primary" :disabled="busy" @click="finishEnrolment">Finish setup</button>
        </footer>
      </template>
    </div>
  </div>
</template>
