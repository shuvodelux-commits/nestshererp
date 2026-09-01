import { evaluateOfflineGate } from '@sher/core-domain';
import type { OfflineGateResult } from '@sher/core-domain';

/**
 * Measuring the D-24 gate in the browser (§5.23).
 *
 * This file only measures and asks; `@sher/core-domain` decides. That split
 * matters because the decision — the order of the steps, and what counts as
 * passing — is a business rule the server, the tests and a future offline
 * runtime all have to agree on, while "is this window standalone?" is a browser
 * question with a different answer in every one of them.
 */
export interface GateMeasurement {
  readonly installed: boolean;
  readonly persisted: boolean;
  readonly availableBytes: number | null;
}

/**
 * Whether the app is running installed rather than in a browser tab.
 *
 * `display-mode: standalone` is the honest signal — it says how this window was
 * opened, which is exactly the question. On iOS the equivalent is
 * `navigator.standalone`.
 */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}

/** Whether the browser has already promised not to evict our storage. */
export async function isPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) === true;
  } catch {
    return false;
  }
}

/**
 * Ask for permanent storage.
 *
 * Chrome grants it silently to an installed app it considers engaged, and
 * refuses just as silently otherwise — there is no dialog to wait for and no
 * reason given. A refusal is a state the screen explains (SY-13), not an error:
 * the app simply never enables offline writing, which is the whole of D-24.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) === true;
  } catch {
    return false;
  }
}

/**
 * Free bytes, or null when the browser will not say.
 *
 * Null is treated as a failure by the domain, not as a pass — a browser that
 * will not tell us how much room it has is not evidence that there is room.
 */
export async function availableBytes(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate === undefined) return null;
    const quota = estimate.quota ?? 0;
    const usage = estimate.usage ?? 0;
    return Math.max(0, quota - usage);
  } catch {
    return null;
  }
}

export async function measureGate(): Promise<GateMeasurement> {
  return {
    installed: isInstalled(),
    persisted: await isPersisted(),
    availableBytes: await availableBytes(),
  };
}

/** The measurement plus the server's two numbers, run through the domain. */
export function judgeGate(
  measurement: GateMeasurement,
  requiredBytes: number,
  authorized: boolean,
): OfflineGateResult {
  return evaluateOfflineGate({
    installed: measurement.installed,
    persisted: measurement.persisted,
    availableBytes: measurement.availableBytes,
    requiredBytes,
    authorized,
  });
}
