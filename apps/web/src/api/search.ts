import type { GlobalSearchResponse } from '@sher/core-contracts';

import { request } from './client';

/**
 * Global Search (Phase 18.1).
 *
 * One call, one box. The server decides which groups the signed-in person may
 * see; the palette draws whatever comes back and never asks for a group it
 * thinks it should have.
 *
 * **Not cancellable on purpose.** `request()` reports a failed `fetch` as
 * evidence the line is down (`markUnreachable`), and an aborted request looks
 * exactly like one — so cancelling a stale keystroke would put the whole
 * application into offline mode. The palette drops out-of-order answers by
 * sequence number instead, which costs one wasted response and never lies about
 * the network.
 */
export function globalSearch(token: string, query: string): Promise<GlobalSearchResponse> {
  return request(`/api/v1/search?${new URLSearchParams({ q: query }).toString()}`, {
    token,
    envelope: true,
  });
}
