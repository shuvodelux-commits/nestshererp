import {
  eraseLocalCopy,
  localDbBytes,
  localStorageWorks,
  readStoredSnapshot,
} from '@sher/adapter-sqlite-wasm';
import type { StoredSnapshot } from '@sher/adapter-sqlite-wasm';
import { storeSnapshot } from '@sher/adapter-sqlite-wasm';
import { SystemClock } from '@sher/shared-utils';
import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';

import { fetchSnapshot, reportSnapshot } from '../api/devices';
import { useSession } from '../auth/session';
import { availableBytes } from './gate';
import { deviceKey } from './identity';

/**
 * The shop's copy on this machine — downloading it, keeping it fresh, and
 * throwing it away (§5.23, Phase 12.3, owner decisions 2026-08-31).
 *
 * Four rules from the owner's round, and every one of them is visible here:
 *
 * 1. **It downloads itself once approved**, and a Refresh Now button forces it.
 *    Nobody has to know the feature exists for the shop to have a copy on the
 *    day the line goes down.
 * 2. **It refreshes once per business day** while the shop is online, so the
 *    copy does not age from the day it was taken — otherwise the three-day
 *    warning would fire on nearly every outage and teach the shop to ignore it.
 * 3. **A failed refresh keeps the old copy.** The swap is atomic inside the
 *    adapter; this file only has to not panic.
 * 4. **Authority gone means the copy goes.** Immediately, in this slice,
 *    because there is nothing unsent to lose.
 *
 * The version below must match `SNAPSHOT_SCHEMA_VERSION` in core-application. A
 * copy written by an older build is discarded rather than read into columns
 * that have moved since.
 */
const SCHEMA_VERSION = 1;

/**
 * The tenant this browser last belonged to.
 *
 * In `localStorage` beside the session tokens, and for the same reason: on a
 * cold start with no internet there is no way to ask the server which shop this
 * is, and reading a stored copy without knowing would be the one mistake that
 * shows one business another's customers. Written on every successful status
 * call, which is what makes it true.
 */
const TENANT_KEY = 'sher.tenantId';
/** The business date the last automatic refresh ran on. */
const REFRESHED_ON_KEY = 'sher.snapshotRefreshedOn';

/**
 * Whether this machine has ever stored a copy.
 *
 * A cheap flag, and it earns its place: without it the "authority is gone, so
 * erase" path runs on every ordinary online computer in the shop at every
 * status pass, and erasing means opening the pool, which means loading the
 * SQLite WASM runtime on five machines that will never hold a row. With it,
 * the machines that were never the offline computer never touch OPFS at all.
 */
const HAS_COPY_KEY = 'sher.snapshotStored';

const clock = new SystemClock();

const stored = ref<StoredSnapshot | null>(null);
const bytes = ref<number | null>(null);
const downloading = ref(false);
const failure = ref<string | null>(null);
let inFlight: Promise<boolean> | null = null;

export function rememberTenant(tenantId: string): void {
  localStorage.setItem(TENANT_KEY, tenantId);
}

function currentTenant(): string | null {
  return localStorage.getItem(TENANT_KEY);
}

/**
 * Which shop this machine's copy belongs to (Phase 12.4).
 *
 * Read by the backup card, which must stamp the archive with it and refuse to
 * restore a file belonging to another business — the one check that stops a
 * shop opening somebody else's day by mistake.
 */
export function storedTenantId(): string | null {
  return currentTenant();
}

/**
 * The shop's own calendar day, as this machine sees it.
 *
 * The machine's timezone rather than the tenant's, deliberately: this decides
 * only when to re-download, the shop PC stands in the shop, and asking the
 * server for its timezone first would make the refresh depend on the very
 * connection it is trying to get ahead of.
 */
function today(): string {
  return clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** What is on this machine right now. Safe to call at any time. */
export async function loadStoredSnapshot(): Promise<void> {
  const tenantId = currentTenant();
  // Same reason as in `discardLocalCopy`: a machine that never stored a copy
  // must not pay for the WASM runtime to be told so.
  if (tenantId === null || localStorage.getItem(HAS_COPY_KEY) === null) {
    stored.value = null;
    return;
  }
  stored.value = await readStoredSnapshot(tenantId, SCHEMA_VERSION);
  bytes.value = stored.value === null ? null : await localDbBytes();
}

/**
 * Downloads the shop's data and makes it the live copy.
 *
 * Returns whether a new copy was stored. A `false` is never a crash: the
 * previous copy is still there and `failure` says what went wrong, which is
 * what the Offline & Devices card prints beside Retry.
 */
export function refreshSnapshot(): Promise<boolean> {
  inFlight ??= download().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function download(): Promise<boolean> {
  const session = useSession();
  const token = session.accessToken.value;
  const tenantId = currentTenant();
  if (token === null || tenantId === null) return false;

  downloading.value = true;
  failure.value = null;
  const started = performance.now();

  try {
    if (!(await localStorageWorks())) {
      failure.value = 'This browser will not let the app store the shop’s data.';
      return false;
    }

    const key = await deviceKey();
    if (key === null) {
      failure.value = 'This browser cannot identify itself, so it cannot hold a copy.';
      return false;
    }

    const snapshot = await fetchSnapshot(token, key);
    const storedBytes = await storeSnapshot(snapshot, tenantId);

    localStorage.setItem(REFRESHED_ON_KEY, today());
    localStorage.setItem(HAS_COPY_KEY, '1');
    await loadStoredSnapshot();

    /*
     * The O-6 numbers, sent home after the copy is safely stored (owner
     * direction 2026-08-31). Never allowed to fail the refresh: the shop has
     * its data either way, and a report that could undo a successful download
     * would be a gate wearing a report's clothes.
     */
    const usage = await estimate();
    await reportSnapshot(token, key, {
      storedBytes,
      usageBytes: usage.usage,
      quotaBytes: usage.quota,
      elapsedMs: Math.round(performance.now() - started),
    }).catch(() => undefined);

    return true;
  } catch (cause) {
    failure.value =
      cause instanceof Error
        ? cause.message
        : 'The shop’s data could not be copied to this computer.';
    return false;
  } finally {
    downloading.value = false;
  }
}

async function estimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const measured = await navigator.storage.estimate();
    return { usage: measured.usage ?? null, quota: measured.quota ?? null };
  } catch {
    return { usage: null, quota: await availableBytes() };
  }
}

/**
 * The once-a-day background refresh, and the first download after approval.
 *
 * Called from the shell whenever the offline state is known. It does nothing at
 * all on the five machines in a shop that are not the offline computer, which
 * is the common case and must stay free.
 */
export async function maintainSnapshot(options: {
  readonly isOfflineDevice: boolean;
  readonly online: boolean;
}): Promise<void> {
  if (!options.isOfflineDevice) return;

  await loadStoredSnapshot();
  if (!options.online) return;

  // No copy yet: this is the download that follows approval, and it is the one
  // the owner asked to happen on its own.
  if (stored.value === null) {
    await refreshSnapshot();
    return;
  }

  if (localStorage.getItem(REFRESHED_ON_KEY) !== today()) await refreshSnapshot();
}

/**
 * Throws the copy away, because this machine is no longer allowed to hold it.
 *
 * In this slice the erase is immediate and total. When offline writing exists,
 * the drain and quarantine of anything unsent come first and this stays the
 * last step (owner decision 2026-08-31).
 */
export async function discardLocalCopy(): Promise<void> {
  // Nothing was ever stored here, so there is nothing to erase — and asking
  // OPFS would load the SQLite runtime on a machine that has no use for it.
  if (localStorage.getItem(HAS_COPY_KEY) === null) return;

  await eraseLocalCopy();
  localStorage.removeItem(HAS_COPY_KEY);
  localStorage.removeItem(REFRESHED_ON_KEY);
  stored.value = null;
  bytes.value = null;
}

/** How many whole days old the copy is, or null when there is none. */
const ageInDays: ComputedRef<number | null> = computed(() => {
  const takenAt = stored.value?.takenAt;
  if (takenAt === undefined) return null;
  const taken = Date.parse(takenAt);
  if (Number.isNaN(taken)) return null;
  return Math.floor((clock.now().getTime() - taken) / 86_400_000);
});

/**
 * Whether the copy is old enough to warn about — three days (owner decision
 * 2026-08-31).
 *
 * Three and not one: a shop is rarely off the internet for three days by
 * accident, so by then something is genuinely wrong. A warning that fired after
 * every overnight gap would be read by nobody within a week.
 */
const WARN_AFTER_DAYS = 3;
const isStale: ComputedRef<boolean> = computed(
  () => ageInDays.value !== null && ageInDays.value >= WARN_AFTER_DAYS,
);

export function useSnapshot(): {
  stored: Readonly<Ref<StoredSnapshot | null>>;
  bytes: Readonly<Ref<number | null>>;
  downloading: Readonly<Ref<boolean>>;
  failure: Readonly<Ref<string | null>>;
  ageInDays: ComputedRef<number | null>;
  isStale: ComputedRef<boolean>;
  refresh: () => Promise<boolean>;
  reload: () => Promise<void>;
} {
  return {
    stored,
    bytes,
    downloading,
    failure,
    ageInDays,
    isStale,
    refresh: refreshSnapshot,
    reload: loadStoredSnapshot,
  };
}
