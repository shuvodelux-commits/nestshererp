import { ref } from 'vue';
import type { Ref } from 'vue';

import { appIsBusy } from './app-busy';

/**
 * Installing the app, and updating it without throwing away a half-typed bill
 * (§5.23's PWA precondition; owner decision 2026-08-31).
 *
 * Two things a service worker makes possible and one it must never do:
 *
 * - the browser will offer **Install SherERP**, which is the first rung of the
 *   D-24 ladder;
 * - the app shell opens from cache, so a bad line does not mean a blank screen;
 * - and it never swaps a running screen out from under whoever is using it. A
 *   new build waits, the page offers "Update available — reload", and on the
 *   POS it holds that offer back until the cart is empty.
 */
const updateWaiting = ref(false);
const installAvailable = ref(false);

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: InstallPromptEvent | null = null;
let waitingWorker: ServiceWorker | null = null;
let reloading = false;

export function registerServiceWorker(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Held rather than shown: the browser's own bar interrupts whatever is on
    // screen, and Settings → Offline & Devices is where installing belongs.
    event.preventDefault();
    deferredInstall = event as InstallPromptEvent;
    installAvailable.value = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    installAvailable.value = false;
  });

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        if (registration.waiting !== null) note(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (installing === null) return;
          installing.addEventListener('statechange', () => {
            // "installed" with a controller already present means a *new*
            // version is waiting behind the one currently running.
            if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
              note(installing);
            }
          });
        });
      })
      .catch(() => undefined);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloading) return;
      reloading = false;
      window.location.reload();
    });
  });
}

function note(worker: ServiceWorker): void {
  waitingWorker = worker;
  updateWaiting.value = true;
}

/**
 * Take the update now.
 *
 * Refuses while a screen says it is busy — the caller draws no button in that
 * state, and this is the second lock, because "the button was hidden" is not
 * the same guarantee as "the reload cannot happen".
 */
export function applyUpdate(): void {
  if (appIsBusy.value || waitingWorker === null) return;
  reloading = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

/** Ask the browser to install the app. Only possible after it has offered. */
export async function promptInstall(): Promise<boolean> {
  if (deferredInstall === null) return false;
  await deferredInstall.prompt();
  const choice = await deferredInstall.userChoice;
  if (choice.outcome === 'accepted') {
    deferredInstall = null;
    installAvailable.value = false;
    return true;
  }
  return false;
}

export function useAppUpdates(): {
  updateWaiting: Readonly<Ref<boolean>>;
  installAvailable: Readonly<Ref<boolean>>;
} {
  return { updateWaiting, installAvailable };
}
