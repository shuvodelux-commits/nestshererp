import type { OfflineStatusResponse } from '@sher/core-contracts';
import type { OfflineGateResult, OfflineGateStep } from '@sher/core-domain';
import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';

import { fetchOfflineStatus, reportGate } from '../api/devices';
import { useSession } from '../auth/session';
import { rememberDevice } from '@sher/adapter-sqlite-wasm';

import { deviceKey } from './identity';
import { judgeGate, measureGate } from './gate';
import { startConnectivityWatch } from './connectivity';
import { discardLocalCopy, maintainSnapshot, rememberTenant } from './snapshot';
import { pendingSummary } from './local-writer';
import { syncNow } from './sync';
import type { GateMeasurement } from './gate';

/**
 * What this browser may do about working offline, kept in one place so the pill
 * in the top bar and the Offline & Devices page can never disagree (§5.23,
 * D-24, owner decisions 2026-08-31).
 *
 * **Two states, and the difference is the whole module:**
 *
 * - `OFFLINE_SETUP_READY` — every gate step passes and this machine holds the
 *   shop's offline authority. It has proved it *could* hold offline work.
 * - `OFFLINE_READY` — reserved, and deliberately not producible here. It means
 *   the shop can genuinely trade through a power cut, and it waits for the
 *   local database, the snapshot and the sync engine. Nothing in this file may
 *   report it early: a shopkeeper who believes the till works without internet
 *   and finds out at the counter has been lied to by us.
 *
 * **When it re-checks** (owner decision 2026-08-31): on startup, when the app
 * comes back to the foreground, immediately before any operation that depends
 * on offline persistence, and quietly on a timer while the app is open. A step
 * that goes red disables offline writing here at once and names the reason —
 * and never touches the server-side authority, because re-granting storage is a
 * browser fix, not a re-approval.
 */
export type OfflineState =
  | 'UNKNOWN'
  | 'ONLINE_ONLY'
  | 'READ_ONLY'
  | 'OFFLINE_SETUP_READY';

const status = ref<OfflineStatusResponse | null>(null);
const measurement = ref<GateMeasurement | null>(null);
const gate = ref<OfflineGateResult | null>(null);
const loading = ref(false);
/** Set when the browser itself refuses to give this profile an identity. */
const identityBlocked = ref(false);

/** Every five minutes while the app is open — quiet, and never a poll storm. */
const PERIODIC_MS = 5 * 60 * 1000;
let timer: number | null = null;
let listening = false;
let inFlight: Promise<void> | null = null;

/**
 * The state this browser is in.
 *
 * `ONLINE_ONLY` is not a failure — it is what almost every machine in a shop
 * is, and always will be. Only one computer per shop can be the offline writer,
 * and the other five are perfectly healthy without it.
 */
const state: ComputedRef<OfflineState> = computed(() => {
  if (status.value === null || gate.value === null) return 'UNKNOWN';
  if (gate.value.state === 'OFFLINE_SETUP_READY') return 'OFFLINE_SETUP_READY';
  const device = status.value.device;
  // A machine that has never asked, or was never approved, is not "read-only"
  // in any meaningful sense — it is an ordinary online computer.
  if (device === null || device.status === 'REGISTERED' || device.status === 'PENDING') {
    return 'ONLINE_ONLY';
  }
  return 'READ_ONLY';
});

/** The first gate step that failed, which is the only one worth showing. */
const blockedAt: ComputedRef<OfflineGateStep | null> = computed(
  () => gate.value?.blockedAt ?? null,
);

/**
 * Whether offline writing may be accepted here **at this instant**.
 *
 * False in 12.1 for every machine, always, because the engine that would accept
 * a write does not exist yet. It is defined now, and used by the check below,
 * so that the first caller who does have something to write cannot forget to
 * ask.
 */
const offlineWriteEnabled = computed(() => false);

async function run(): Promise<void> {
  const session = useSession();
  const token = session.accessToken.value;
  if (token === null) return;

  loading.value = true;
  try {
    const key = await deviceKey();
    identityBlocked.value = key === null;

    const fresh = await fetchOfflineStatus(token, key);
    status.value = fresh;

    const measured = await measureGate();
    measurement.value = measured;
    gate.value = judgeGate(
      measured,
      fresh.requiredBytes,
      fresh.device !== null && fresh.device.status === 'ACTIVE',
    );


    /*
     * Phase 12.3 — the local copy follows the authority, in both directions.
     *
     * The tenant is remembered first: on a cold start with no internet there is
     * no way to ask which shop this browser belongs to, and reading a stored
     * copy without knowing is the one mistake that would show one business
     * another's customers.
     */
    rememberTenant(fresh.tenantId);

    const holdsAuthority =
      fresh.device !== null &&
      (fresh.device.status === 'ACTIVE' || fresh.device.status === 'DRAINING');

    if (holdsAuthority) {
      await maintainSnapshot({ isOfflineDevice: true, online: true });
      /*
       * Phase 12.4 — the machine learns its own short code, and can start
       * numbering. Until this runs the local copy knows nothing about which
       * machine it is, and `peekSaleNumber` correctly refuses to invent one.
       */
      if (fresh.device !== null && fresh.device.deviceCode !== null) {
        await rememberDevice(fresh.device.id, fresh.device.deviceCode).catch(() => undefined);
      }
    } else {
      /*
       * Revoked, force revoked, or the slot handed to another machine (owner
       * decision 2026-08-31): the shop's data leaves with the authority.
       *
       * **Phase 12.4 puts one thing ahead of that erase.** A machine may hold
       * work the books have never seen, and §5.23 is explicit that a revoked
       * device's outbox is imported into quarantine rather than lost — so the
       * queue is pushed first, and if anything is still queued afterwards the
       * copy stays where it is with a plain warning. Erasing a day's takings
       * to tidy up a revoked laptop is the one clean-up nobody can undo.
       */
      const held = await pendingSummary();
      if (held.pending > 0) {
        await syncNow();
      }
      const stillHeld = await pendingSummary();
      if (stillHeld.pending === 0) {
        await discardLocalCopy();
      }
    }

    // Tell the server what we measured, so the owner's device list shows the
    // same truth. Never allowed to fail loudly: it is a report, not a gate.
    if (key !== null && fresh.device !== null) {
      await reportGate(token, key, {
        installed: measured.installed,
        persisted: measured.persisted,
        availableBytes: measured.availableBytes,
      }).catch(() => undefined);
    }
  } catch {
    // A machine that cannot reach the server cannot know whether it is the
    // offline computer. It says nothing rather than guessing — and a guess in
    // the optimistic direction is the one that would matter.
    status.value = null;
    gate.value = null;
  } finally {
    loading.value = false;
  }
}

/** One refresh at a time; concurrent callers wait on the same pass. */
export function refreshOfflineStatus(): Promise<void> {
  inFlight ??= run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The check that must run **immediately before** anything depending on offline
 * persistence (owner decision 2026-08-31).
 *
 * It re-measures rather than trusting the last pass: storage permission can be
 * cleared, and free space can run out, between the app starting this morning
 * and this write this afternoon.
 */
export async function ensureOfflinePersistence(): Promise<boolean> {
  await refreshOfflineStatus();
  return state.value === 'OFFLINE_SETUP_READY' && offlineWriteEnabled.value;
}

/**
 * Start watching. Called once from the shell.
 *
 * Startup, foreground/resume and a quiet timer — the three the owner named,
 * plus `online`, because a machine that has just got its connection back is the
 * one most likely to be showing a stale answer.
 */
export function startOfflineWatch(): void {
  // Phase 12.3: whether the server is reachable is watched from the same place
  // and for the same reason — one answer, so the bar and the screens agree.
  startConnectivityWatch();
  void refreshOfflineStatus();
  if (listening) return;
  listening = true;

  const wake = (): void => {
    if (document.visibilityState === 'visible') void refreshOfflineStatus();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshOfflineStatus();
  }, PERIODIC_MS);
}

export function stopOfflineWatch(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

export function useOfflineStatus(): {
  status: Readonly<Ref<OfflineStatusResponse | null>>;
  measurement: Readonly<Ref<GateMeasurement | null>>;
  gate: Readonly<Ref<OfflineGateResult | null>>;
  state: ComputedRef<OfflineState>;
  blockedAt: ComputedRef<OfflineGateStep | null>;
  loading: Readonly<Ref<boolean>>;
  identityBlocked: Readonly<Ref<boolean>>;
  refresh: () => Promise<void>;
} {
  return {
    status,
    measurement,
    gate,
    state,
    blockedAt,
    loading,
    identityBlocked,
    refresh: refreshOfflineStatus,
  };
}
