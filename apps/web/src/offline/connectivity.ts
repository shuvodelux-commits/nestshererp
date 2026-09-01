import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';

import { loadConfig } from '../api/client';

/**
 * Whether the server can actually be reached (owner decision 2026-08-31: the
 * browser flag, confirmed by a quick health check).
 *
 * **The browser's own flag is not enough on its own, and it is not useless
 * either.** `navigator.onLine` is false only when the machine has no network at
 * all, so it is a fast and trustworthy signal in *that* direction — but a shop
 * whose router is up and whose broadband is down reads as online, and the app
 * would sit waiting on calls that never answer. So the flag flips the state
 * immediately and a short call to the health endpoint decides whether it was
 * telling the truth.
 *
 * A real failed API call is the third input, and the most reliable of all,
 * because it is evidence rather than a probe: `markUnreachable()` is called
 * from the API client the moment a request cannot reach the server.
 */
export type Connectivity = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

const state = ref<Connectivity>('UNKNOWN');
/** Set while a check is running, so ten screens do not launch ten probes. */
let checking: Promise<boolean> | null = null;
let watching = false;

/** How often to re-check while the app believes it is offline. */
const RETRY_MS = 20 * 1000;
/** A probe that has not answered by now is a connection nobody can work on. */
const PROBE_TIMEOUT_MS = 4000;

let timer: number | null = null;

/**
 * Ask the server whether it is there.
 *
 * Deliberately not routed through `request()`: the API client's job is to carry
 * a session and renew tokens, and this call has neither. It also must not be
 * retried — a probe that retries is a probe that answers slowly, and a slow
 * answer to "are we offline?" is the wrong answer.
 */
async function probe(): Promise<boolean> {
  const controller = new AbortController();
  const abort = window.setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);

  try {
    const { apiBaseUrl } = await loadConfig();
    const response = await fetch(`${apiBaseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(abort);
  }
}

/** One probe at a time; everyone waiting gets the same answer. */
export function checkConnectivity(): Promise<boolean> {
  if (!navigator.onLine) {
    // The one case the flag settles on its own: no network at all.
    state.value = 'OFFLINE';
    return Promise.resolve(false);
  }

  checking ??= probe()
    .then((reachable) => {
      state.value = reachable ? 'ONLINE' : 'OFFLINE';
      return reachable;
    })
    .finally(() => {
      checking = null;
    });

  return checking;
}

/**
 * Called by the API client when a request could not reach the server.
 *
 * This is evidence, not a guess, so it is believed at once — the screen that
 * just failed switches to the local copy without waiting for a probe to agree.
 */
export function markUnreachable(): void {
  state.value = 'OFFLINE';
}

/** Called by the API client after any successful response. */
export function markReachable(): void {
  state.value = 'ONLINE';
}

/**
 * Start watching. Called once from the shell.
 *
 * While offline the app re-checks on a slow timer, because nothing else will
 * tell it the line came back: `online` fires when the machine gets a network,
 * not when the shop's broadband starts working again.
 */
export function startConnectivityWatch(): void {
  void checkConnectivity();
  if (watching) return;
  watching = true;

  window.addEventListener('online', () => {
    void checkConnectivity();
  });
  window.addEventListener('offline', () => {
    state.value = 'OFFLINE';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkConnectivity();
  });

  timer = window.setInterval(() => {
    if (state.value === 'OFFLINE' && document.visibilityState === 'visible') {
      void checkConnectivity();
    }
  }, RETRY_MS);
}

export function stopConnectivityWatch(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

/**
 * True only when the app is *sure* it cannot reach the server.
 *
 * `UNKNOWN` reads as online on purpose: a screen that has not yet checked must
 * try the server rather than quietly serve an old copy, because the copy is the
 * fallback and never the default in this slice.
 */
const isOffline: ComputedRef<boolean> = computed(() => state.value === 'OFFLINE');

export function useConnectivity(): {
  state: Readonly<Ref<Connectivity>>;
  isOffline: ComputedRef<boolean>;
  check: () => Promise<boolean>;
} {
  return { state, isOffline, check: checkConnectivity };
}
