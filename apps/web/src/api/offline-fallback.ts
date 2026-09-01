import { ApiError } from './client';
import { useConnectivity } from '../offline/connectivity';

/**
 * Serve a read from the local copy when the server cannot be reached (§5.23,
 * Phase 12.3, owner decision 2026-08-31: the normal screens, reading locally
 * when offline).
 *
 * **The fallback lives in the API layer, not in the pages.** Products and
 * Parties are long screens with filters, sorting, paging and summary tiles;
 * teaching each of them to hold two data sources would double the branches in
 * the part of the app a shopkeeper uses most, and the offline branch is the one
 * nobody exercises until the day it matters. Down here there is one rule in one
 * place: ask the server, and if the server is not there, ask the disk for the
 * same answer in the same shape.
 *
 * Three properties this depends on, all of them deliberate:
 *
 * - The local read returns the **same response type**. A page cannot tell which
 *   one it got, so there is no second rendering path to keep correct.
 * - Only `NETWORK_UNREACHABLE` falls back. A 403, a 409 or a 500 is the server
 *   answering, and answering *no* — serving cached rows over a refusal would
 *   turn "you may not see this" into "here it is".
 * - A failure of the local read is reported as the original network failure.
 *   The shopkeeper's problem is that the line is down; that this machine also
 *   has no copy is a second sentence, and the Offline & Devices page is where
 *   it belongs.
 */
export async function offlineFallback<T>(
  fromServer: () => Promise<T>,
  fromLocalCopy: () => Promise<T>,
): Promise<T> {
  try {
    return await fromServer();
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.code !== 'NETWORK_UNREACHABLE') throw cause;

    try {
      return await fromLocalCopy();
    } catch {
      throw cause;
    }
  }
}

/** Whether the app is sure it is offline — for the bar, not for the fallback. */
export function offlineNow(): boolean {
  return useConnectivity().isOffline.value;
}
