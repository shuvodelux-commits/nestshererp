/**
 * The D-24 gate: what has to be true before this browser may hold offline work
 * (§5.23, owner decisions 2026-08-31).
 *
 * ```
 * PWA installed
 *   → navigator.storage.persist() granted
 *   → navigator.storage.estimate() ≥ snapshot size + headroom
 *   → profile registered and holds OFFLINE_RW
 *   → OFFLINE_SETUP_READY
 * ```
 *
 * The order is the specification's and is not negotiable: each step is the
 * precondition of the one under it, and a shop told "not enough space" when the
 * real problem is that the app was never installed goes and buys a disk.
 *
 * **`OFFLINE_SETUP_READY` is not `OFFLINE_READY`.** This module builds the
 * door, not the room behind it. A machine that passes every check here has
 * proved it *could* hold offline work; it still cannot trade offline, because
 * the local database, the snapshot and the sync engine do not exist yet.
 * `OFFLINE_READY` is reserved for the phase where all three genuinely work, and
 * nothing in this file, this API or this UI may claim it early — a shopkeeper
 * who believes the till works without internet and finds out at the counter has
 * been lied to by us.
 *
 * Pure (R-C8). The browser measures; this decides.
 */
export type OfflineGateStep =
  | 'PWA_INSTALLED'
  | 'STORAGE_PERSISTED'
  | 'STORAGE_SPACE'
  | 'DEVICE_AUTHORIZED';

export type OfflineGateState = 'OFFLINE_SETUP_READY' | 'BLOCKED';

/** What the browser actually measured, and what the server says it may do. */
export interface OfflineGateReport {
  /** Running as an installed app (display-mode standalone), not a browser tab. */
  readonly installed: boolean;
  /** `navigator.storage.persist()` came back true — the box will not be evicted. */
  readonly persisted: boolean;
  /** Free bytes from `navigator.storage.estimate()`, or null when unreadable. */
  readonly availableBytes: number | null;
  /** What this tenant's snapshot is expected to need, headroom included. */
  readonly requiredBytes: number;
  /** The server's answer to "does this profile hold OFFLINE_RW right now?" */
  readonly authorized: boolean;
}

export interface OfflineGateResult {
  readonly state: OfflineGateState;
  /** The first step that failed, in the order above. Null when all four pass. */
  readonly blockedAt: OfflineGateStep | null;
  /** Every step with its own answer, so the screen can tick them off. */
  readonly steps: readonly { readonly step: OfflineGateStep; readonly passed: boolean }[];
}

/** The gate's order, evaluated top to bottom. */
export const OFFLINE_GATE_ORDER: readonly OfflineGateStep[] = [
  'PWA_INSTALLED',
  'STORAGE_PERSISTED',
  'STORAGE_SPACE',
  'DEVICE_AUTHORIZED',
];

export function evaluateOfflineGate(report: OfflineGateReport): OfflineGateResult {
  const passed: Record<OfflineGateStep, boolean> = {
    PWA_INSTALLED: report.installed,
    STORAGE_PERSISTED: report.persisted,
    /*
     * Unreadable is failed, not passed. A browser that will not say how much
     * room it has is not evidence that there is room, and the whole rule of
     * D-24 is that the app never accepts a write into storage it has not been
     * told is safe.
     */
    STORAGE_SPACE: report.availableBytes !== null && report.availableBytes >= report.requiredBytes,
    DEVICE_AUTHORIZED: report.authorized,
  };

  const steps = OFFLINE_GATE_ORDER.map((step) => ({ step, passed: passed[step] }));
  const blocked = steps.find((entry) => !entry.passed);

  return {
    state: blocked === undefined ? 'OFFLINE_SETUP_READY' : 'BLOCKED',
    blockedAt: blocked?.step ?? null,
    steps,
  };
}
