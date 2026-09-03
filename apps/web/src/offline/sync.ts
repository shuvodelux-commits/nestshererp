import {
  applyChange,
  markSent,
  pendingOperations,
  readLocalState,
  recordCursor,
  settleOperation,
} from '@sher/adapter-sqlite-wasm';
import { SYNC_WIRE_VERSION } from '@sher/core-contracts';
import { parseInstant, SystemClock } from '@sher/shared-utils';
import type { SyncOperation } from '@sher/core-contracts';
import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';

import { pullChanges, pushOperations } from '../api/sync';
import { useSession } from '../auth/session';
import { markDataChanged } from '../state/data-freshness';
import { useConnectivity } from './connectivity';
import { deviceKey } from './identity';
import { pendingSummary } from './local-writer';
import { useOfflineStatus } from './status';

/**
 * Sending up what the shop did, and catching up on what it missed (§14, §5.23).
 *
 * **Automatic, visible, and interruptible** (owner decision 2026-09-02). The
 * moment the line is steady the machine starts pushing, in the order the shop
 * typed things, with the count on screen the whole time — because a queue that
 * only moves when somebody remembers to press a button is a queue that is still
 * full on the day the shopkeeper needs it empty.
 *
 * **A network failure retries; a refusal does not.** The difference matters: a
 * dropped connection is a reason to try again in a moment, and a closed period
 * is a reason to stop and ask a person. Retrying a refusal forever would hide
 * it, and the whole point of Sync Issues is that nothing is hidden.
 */

/** Time comes from the Clock port, here as everywhere else (B-clock). */
const clock = new SystemClock();

const BATCH = 50;
/** Long enough not to hammer a flapping line; short enough to feel automatic. */
const RETRY_MS = 30 * 1000;

export type SyncPhase = 'IDLE' | 'PUSHING' | 'PULLING' | 'BLOCKED';

const phase = ref<SyncPhase>('IDLE');
const pending = ref(0);
const refused = ref(0);
const oldestPendingAt = ref<string | null>(null);
const lastError = ref<string | null>(null);
let running = false;
let timer: number | null = null;

/** Re-reads the counters the bar and the badge show. */
export async function refreshPendingCounts(): Promise<void> {
  const counts = await pendingSummary();
  pending.value = counts.pending;
  refused.value = counts.refused;
  oldestPendingAt.value = counts.oldestPendingAt;
}

/**
 * One pass: everything queued, then everything changed since we last looked.
 *
 * Never two at once — a second pass over the same queue would push operations
 * the first is still waiting on and get `DUPLICATE` for its trouble, which is
 * harmless and confusing in equal measure.
 */
export async function syncNow(): Promise<void> {
  if (running) return;
  const session = useSession();
  const token = session.accessToken.value;
  const key = await deviceKey();
  if (token === null || key === null) return;

  running = true;
  lastError.value = null;
  try {
    await push(token, key);
    await pull(token, key);
  } catch (cause) {
    lastError.value = cause instanceof Error ? cause.message : 'Could not reach the shop’s books';
  } finally {
    running = false;
    phase.value = 'IDLE';
    await refreshPendingCounts();
  }
}

/**
 * The empty batch a machine on its way out still has to send.
 *
 * `DRAINING` holds the shop's single writer slot until the device itself says it
 * is holding nothing, and the server can only finish that on a request which
 * says so — no operations and `queueEmpty` true, which the wire contract allows
 * for exactly this. A pass that simply returned on an empty queue would leave
 * the slot occupied forever, and the replacement machine could never be approved
 * without the owner forcing the old one off.
 *
 * Only while draining. On every other machine this would be a request per pass
 * asking the server to do nothing.
 */
async function announceDrained(token: string, key: string): Promise<void> {
  if (useOfflineStatus().status.value?.device?.status !== 'DRAINING') return;
  await pushOperations(token, key, {
    wireVersion: SYNC_WIRE_VERSION,
    deviceKey: key,
    operations: [],
    queueEmpty: true,
  });
}

async function push(token: string, key: string): Promise<void> {
  for (;;) {
    /*
     * One more than the batch is asked for, and only the batch is sent. That
     * extra row is what makes `queueEmpty` below a reading of the queue rather
     * than a guess: a queue holding exactly `BATCH` operations sends a full
     * batch, empties, and would otherwise never say so.
     */
    const waiting = await pendingOperations(BATCH + 1);
    const queued = waiting.slice(0, BATCH);
    if (queued.length === 0) {
      await announceDrained(token, key);
      return;
    }

    phase.value = 'PUSHING';
    const operations: SyncOperation[] = queued.map((row) => ({
      operationId: row.operationId,
      localSeq: row.localSeq,
      type: row.type as SyncOperation['type'],
      payload: row.payload,
      context: row.context,
      dependsOn: [...row.dependsOn],
      ...(row.digest === null ? {} : { clientResultDigest: row.digest }),
      ...(row.documentNumber === null ? {} : { documentNumber: row.documentNumber }),
    }));

    const at = clock.now().toISOString();
    await markSent(operations.map((op) => op.operationId), at);

    const response = await pushOperations(token, key, {
      wireVersion: SYNC_WIRE_VERSION,
      deviceKey: key,
      operations,
      // Whether this batch empties the queue. A machine being handed over
      // finishes draining on this, so it is read from the queue itself — the
      // row beyond the batch — rather than assumed from the batch being short.
      queueEmpty: waiting.length <= BATCH,
    });

    let progressed = false;
    for (const result of response.results) {
      switch (result.outcome) {
        case 'APPLIED':
        case 'DUPLICATE':
          /*
           * Both clear the queue. `DUPLICATE` is what a resumed push gets for
           * everything the server already took, and treating it as anything
           * else is how a machine ends up sending a day twice (SY-02, SY-03).
           */
          await settleOperation({
            operationId: result.operationId,
            status: 'ACCEPTED',
            serverId: result.documentId,
            serverNumber: result.documentNumber,
            at,
          });
          progressed = true;
          break;
        case 'BLOCKED':
          await settleOperation({
            operationId: result.operationId,
            status: 'SETTLED',
            reasonCode: result.reasonCode,
            reason: result.message,
            at,
          });
          progressed = true;
          break;
        case 'SCHEMA_INCOMPATIBLE':
          /*
           * Nothing was written on the server, and nothing is written here. The
           * machine needs updating, and until it is, the queue waits — which is
           * exactly right: the day is safe, and the shop is told why.
           */
          phase.value = 'BLOCKED';
          lastError.value =
            'This computer is running an older version than the shop’s books. Update it, then send again.';
          await settleOperation({ operationId: result.operationId, status: 'PENDING', at });
          return;
        default:
          // QUARANTINED, AUTHORITY_REVOKED, IDEMPOTENCY_MISMATCH — a person
          // decides on the Sync Issues screen. It stays in the queue with the
          // reason on it, and is never retried by itself.
          await settleOperation({
            operationId: result.operationId,
            status: 'REFUSED',
            reasonCode: result.reasonCode,
            reason: result.message,
            at,
          });
          break;
      }
    }

    await recordCursor(null, at, true);
    await refreshPendingCounts();
    markDataChanged();

    // Nothing moved: everything left is refused and waiting for a person, so
    // pushing again would ask the same question and get the same answer.
    if (!progressed) return;
  }
}

async function pull(token: string, key: string): Promise<void> {
  phase.value = 'PULLING';
  const state = await readLocalState();
  let cursor = state?.syncCursor ?? null;

  for (let page = 0; page < 50; page += 1) {
    const response = await pullChanges(token, key, cursor);
    for (const change of response.changes) {
      await applyChange({
        entity: change.entity,
        id: change.id,
        kind: change.kind,
        payload: change.payload,
      });
    }
    cursor = response.nextCursor;
    await recordCursor(cursor, clock.now().toISOString(), false);
    if (!response.hasMore) return;
  }
}

/**
 * Start watching. Called once from the shell.
 *
 * The line coming back is the signal, and a slow timer is the safety net —
 * `online` fires when the machine gets a network, not when the shop's broadband
 * starts working again, which is the same reason 12.3's connectivity watch
 * keeps a timer of its own.
 */
export function startSyncWatch(): void {
  void refreshPendingCounts();
  if (timer !== null) return;

  const { isOffline } = useConnectivity();
  timer = window.setInterval(() => {
    if (!isOffline.value && pending.value > 0 && document.visibilityState === 'visible') {
      void syncNow();
    }
  }, RETRY_MS);

  window.addEventListener('online', () => {
    void syncNow();
  });
}

export function stopSyncWatch(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

/**
 * How loudly the bar should speak about a queue that has not gone up.
 *
 * Time alone never blocks the shop from trading (§19, owner decision
 * 2026-09-02) — it only raises its voice. Trading through a long outage is the
 * whole point; the escalation is so nobody discovers a fortnight later that the
 * books have not seen a fortnight of sales.
 */
export type SyncUrgency = 'NONE' | 'NORMAL' | 'WARNING' | 'OVERDUE' | 'CRITICAL';

function urgencyOf(oldest: string | null, count: number): SyncUrgency {
  if (count === 0) return 'NONE';
  if (oldest === null) return 'NORMAL';
  const since = parseInstant(oldest);
  if (since === null) return 'NORMAL';
  const days = (clock.now().getTime() - since.getTime()) / 86_400_000;
  if (days >= 14 || count >= 500) return 'CRITICAL';
  if (days >= 7 || count >= 200) return 'OVERDUE';
  if (days >= 3) return 'WARNING';
  return 'NORMAL';
}

export function useSync(): {
  phase: Readonly<Ref<SyncPhase>>;
  pending: Readonly<Ref<number>>;
  refused: Readonly<Ref<number>>;
  lastError: Readonly<Ref<string | null>>;
  urgency: ComputedRef<SyncUrgency>;
  syncNow: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  return {
    phase,
    pending,
    refused,
    lastError,
    urgency: computed(() => urgencyOf(oldestPendingAt.value, pending.value)),
    syncNow,
    refresh: refreshPendingCounts,
  };
}
