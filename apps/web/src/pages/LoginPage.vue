<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { loginWithPassword, loginWithPin } from '../api/auth';
import { ApiError } from '../api/client';
import { startGoogleSignIn } from '../auth/google';
import { useSession } from '../auth/session';
import GoogleButton from '../components/GoogleButton.vue';
import OtpInput from '../components/OtpInput.vue';
import {
  lockedForSeconds,
  offlineSignInOptions,
  signInOffline,
} from '../offline/offline-session';
import type { OfflineCandidate, OfflineSignInBlock } from '../offline/offline-session';

/**
 * Daily login (D-07): email + password, phone + password, PIN on a returning
 * session, or Google. **OTP is never a daily-login method** — it verifies
 * identity at signup and at password recovery only, which keeps SMS cost
 * proportional to new accounts rather than to daily usage.
 *
 * The server answers every failure identically, so this screen never says
 * "no such user" — it cannot, and must not, distinguish them.
 *
 * Phase 12.4 adds a fourth door, and only when the other three are shut: a
 * machine that cannot reach the server, holding a snapshot that names who may
 * open this counter, offers those people and a PIN (§5.23, §9). It is offered
 * rather than chosen — the moment the line is up the real sign-in is the one
 * on screen, because an offline session cannot send the day's work anywhere.
 */
const router = useRouter();
const route = useRoute();
const session = useSession();

/** PIN is offered first when this browser has signed in before (§5.3). */
const mode = ref<'PASSWORD' | 'PIN' | 'OFFLINE'>(session.canUsePin() ? 'PIN' : 'PASSWORD');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

const identifier = ref('');
const password = ref('');
const pin = ref('');

/**
 * The line came back while somebody was trading offline, and the shell sent
 * them here (§5.23). Their work is still on this machine and goes up as soon as
 * they are signed in for real.
 */
const reconnected = computed(() => route.query['reconnected'] === '1');

/* ------------------------------------------------------- offline sign-in --- */

const offlineUsers = ref<readonly OfflineCandidate[]>([]);
const offlineUserId = ref<string | null>(null);
const offlinePin = ref('');
const lockSeconds = ref(0);
let lockTimer: number | null = null;

const offlineAvailable = computed(() => offlineUsers.value.length > 0);

/**
 * Why this machine cannot open itself, when it cannot.
 *
 * `ONLINE` is never shown: the shop's internet working is not a problem, and
 * saying so beside a working sign-in form would only puzzle people. The other
 * two are worth one plain sentence, because both are fixed while the line is up
 * and neither can be fixed once it is down.
 */
const offlineBlocked = ref<OfflineSignInBlock | null>(null);

const offlineBlockedSays = computed(() =>
  offlineBlocked.value === 'NO_COPY'
    ? {
        en: 'This computer has no copy of the shop’s books yet, so it cannot open without internet.',
        bn: 'এই কম্পিউটারে দোকানের কপি নেই — ইন্টারনেট ছাড়া খোলা যাবে না',
      }
    : {
        en: 'Nobody on this computer’s copy has a PIN, so it cannot be opened without internet. Set one while the line is up.',
        bn: 'কারও পিন নেই — লাইন থাকতে পিন সেট করুন',
      },
);

const chosenUser = computed(
  () => offlineUsers.value.find((user) => user.id === offlineUserId.value) ?? null,
);

function chooseOfflineUser(id: string): void {
  offlineUserId.value = id;
  offlinePin.value = '';
  error.value = null;
}

function tickLock(): void {
  lockSeconds.value = lockedForSeconds();
  if (lockTimer !== null || lockSeconds.value === 0) return;
  lockTimer = window.setInterval(() => {
    lockSeconds.value = lockedForSeconds();
    if (lockSeconds.value === 0 && lockTimer !== null) {
      window.clearInterval(lockTimer);
      lockTimer = null;
    }
  }, 1000);
}

/**
 * Ask, once, whether this machine can open itself without the server.
 *
 * `offlineSignInOptions` probes the connection first and refuses while it is
 * up, so a shop with working internet never sees this door at all.
 *
 * The probe can take a few seconds, and the screen must not change under
 * somebody's hands while it runs: on load the door only takes over an untouched
 * form, while a sign-in that has just failed on the network switches to it
 * outright, because that is the answer to what they were trying to do.
 */
async function checkOfflineDoor(takeOver: boolean): Promise<void> {
  const options = await offlineSignInOptions();
  if (!('users' in options)) {
    // The reason is the whole point of asking: a shopkeeper standing in front of
    // a dead line needs to know whether this computer could ever have opened,
    // and both answers are things only somebody with internet can put right.
    offlineBlocked.value = options.blocked === 'ONLINE' ? null : options.blocked;
    return;
  }
  offlineBlocked.value = null;
  offlineUsers.value = options.users;
  offlineUserId.value ??= options.users[0]?.id ?? null;
  if (takeOver || (identifier.value === '' && password.value === '' && pin.value === '')) {
    mode.value = 'OFFLINE';
  }
  tickLock();
}

onMounted(() => {
  void checkOfflineDoor(false);
});

onBeforeUnmount(() => {
  if (lockTimer !== null) window.clearInterval(lockTimer);
});

/**
 * Lets the "Checking…" state paint before the key derivation starts.
 *
 * scrypt at the shop's parameters holds the main thread for about a second —
 * that cost is the protection — and without this the button would simply freeze
 * on the old label, which reads as a dead screen.
 */
async function paint(): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

async function unlockOffline(): Promise<void> {
  const userId = offlineUserId.value;
  if (userId === null || lockSeconds.value > 0) return;

  busy.value = true;
  error.value = null;
  await paint();
  try {
    const result = await signInOffline(userId, offlinePin.value);
    if (result.ok) {
      await router.push('/dashboard');
      return;
    }
    offlinePin.value = '';
    if (result.reason === 'LOCKED') {
      tickLock();
      error.value = {
        code: 'PIN_LOCKED',
        message: `Too many wrong PINs. Try again in ${String(Math.ceil(result.seconds / 60))} minutes.`,
      };
    } else if (result.reason === 'WRONG_PIN') {
      error.value = {
        code: 'WRONG_PIN',
        message: `That PIN is not right. ${String(result.attemptsLeft)} ${
          result.attemptsLeft === 1 ? 'try' : 'tries'
        } left before this computer locks for five minutes.`,
      };
    } else {
      error.value = {
        code: 'NO_SUCH_USER',
        message: 'This computer’s copy no longer lists that person.',
      };
      await checkOfflineDoor(true);
    }
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------- online sign-in ---- */

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
    // A sign-in that could not reach the server is the moment to say that this
    // computer can still open its own copy — rather than leaving a shopkeeper
    // pressing a dead button.
    if (fail(cause) === 'NETWORK_UNREACHABLE') void checkOfflineDoor(true);
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
    if (code === 'NETWORK_UNREACHABLE') void checkOfflineDoor(true);
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

      <!--
        Phase 12.4: the shell ended an offline session because the line came
        back. Said here rather than as a toast, because it is the reason this
        screen appeared and the queue is still waiting on a real sign-in.
      -->
      <p v-if="reconnected" class="notice" role="status">
        The internet is back. Sign in to send this computer’s work to the shop’s
        books.
        <span class="sher-bn">ইন্টারনেট ফিরেছে — কাজ পাঠাতে সাইন ইন করুন</span>
      </p>

      <!--
        Phase 12.4 — the counter opened cold during an outage (§5.23, §9).

        Who, then four digits. The list is the people the snapshot said may work
        on this machine; a person the shop added since is not on it, and cannot
        be, because nothing has reached this computer since the line went down.
      -->
      <template v-if="mode === 'OFFLINE'">
        <h1>Open without internet</h1>
        <p class="lede">
          This computer cannot reach the shop’s books. It can still open its own
          copy and keep selling — everything is sent up when the line is back.
        </p>
        <p class="sher-bn">
          ইন্টারনেট নেই — এই কম্পিউটারের নিজের কপি দিয়ে কাজ চালান, লাইন ফিরলে
          সব পাঠানো হবে
        </p>

        <form @submit.prevent="unlockOffline">
          <p v-if="error !== null" class="error" role="alert">
            <span class="error-code">{{ error.code }}</span>
            {{ error.message }}
          </p>

          <p class="pin-label">Who is at the counter</p>
          <div class="who" role="group" aria-label="Who is at the counter">
            <button
              v-for="candidate in offlineUsers"
              :key="candidate.id"
              type="button"
              class="who-row"
              :class="{ 'who-row--on': candidate.id === offlineUserId }"
              :aria-pressed="candidate.id === offlineUserId"
              :disabled="busy"
              @click="chooseOfflineUser(candidate.id)"
            >
              <span class="who-name">{{ candidate.displayName }}</span>
              <span v-if="candidate.username !== null" class="who-id">{{ candidate.username }}</span>
            </button>
          </div>

          <p class="pin-label">Enter {{ chosenUser?.displayName ?? 'your' }}’s PIN</p>
          <OtpInput
            v-model="offlinePin"
            :length="4"
            mask
            :disabled="busy || lockSeconds > 0"
            @complete="unlockOffline"
          />

          <p v-if="lockSeconds > 0" class="error" role="alert">
            <span class="error-code">PIN_LOCKED</span>
            Locked for {{ lockSeconds }} more seconds.
          </p>

          <button
            type="submit"
            class="btn btn-primary"
            :disabled="busy || lockSeconds > 0 || offlineUserId === null || offlinePin.length !== 4"
          >
            {{ busy ? 'Checking…' : 'Open the counter' }}
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="busy"
            @click="mode = session.canUsePin() ? 'PIN' : 'PASSWORD'"
          >
            Try signing in instead
          </button>
        </form>

        <p class="fine">
          Working offline records sales, purchases and payments on this computer
          only. Profit, stock cost and the shop’s books stay as they were until
          the line comes back.
        </p>
      </template>

      <!-- ------------------------------------------------------- PIN unlock -->
      <template v-else-if="mode === 'PIN'">
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
          <template v-if="offlineAvailable">
            ·
            <button type="button" class="linkish" @click="mode = 'OFFLINE'">
              Work without internet
            </button>
          </template>
        </p>

        <p v-if="offlineBlocked !== null" class="fine">
          {{ offlineBlockedSays.en }}
          <span class="sher-bn">{{ offlineBlockedSays.bn }}</span>
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

          <!--
            Both links go to the same screen. Someone who has just been added by
            their owner has never had a password, so "Forgot your password?"
            reads as none of their business and they never click it — the
            mechanism was there, the wording hid it.
          -->
          <p class="help">
            <RouterLink to="/forgot-password">Forgot your password?</RouterLink>
            <br />
            <RouterLink to="/forgot-password">
              First time here? Set your password
            </RouterLink>
          </p>
        </form>

        <div class="divider"><span>or</span></div>

        <GoogleButton :disabled="busy" @click="signInWithGoogle" />

        <!--
          Phase 12.4: the offline door is shut, and the screen says why rather
          than simply not being there. Quietly, as a note under the form — it is
          not an error, and both reasons are only fixable while the line is up.
        -->
        <p v-if="offlineBlocked !== null" class="fine">
          {{ offlineBlockedSays.en }}
          <span class="sher-bn">{{ offlineBlockedSays.bn }}</span>
        </p>

        <p v-if="offlineAvailable" class="fine">
          No internet?
          <button type="button" class="linkish" @click="mode = 'OFFLINE'">
            Open this computer’s own copy
          </button>
        </p>

        <p class="fine">
          New here? <RouterLink to="/register">Create your business account</RouterLink>, or
          continue with Google — if that address has no business yet, we will ask
          for a name and set one up.
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

/*
 * Phase 12.4's offline door. Rows rather than a dropdown: a shop has a handful
 * of people, the list is short enough to read at a glance, and one tap is
 * fewer than opening a select and choosing from it at a counter.
 */
.notice {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 11px 13px;
  border: 1px solid var(--sher-ok-line);
  border-radius: var(--sher-radius);
  background: var(--sher-ok-bg);
  color: var(--sher-text);
  font-size: var(--sher-text-sm);
}

.who {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.who-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface);
  color: var(--sher-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.who-row:hover:not(:disabled) {
  border-color: var(--sher-line-strong);
}

.who-row--on {
  border-color: var(--sher-primary);
  background: var(--sher-primary-softer);
}

.who-row:disabled {
  cursor: default;
  opacity: 0.6;
}

.who-name {
  font-weight: 600;
}

.who-id {
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}
</style>
