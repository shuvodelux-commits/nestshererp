import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * The browser's terms for talking to this API.
 *
 * The Vue app is served from its own origin — the Vite dev server locally,
 * nginx in §6.5 — so the browser **preflights** every mutating call and sends
 * only the headers named here. A header missing from this list is not rejected
 * with a status a person could read: the request is never sent at all, and the
 * screen shows a dead network.
 *
 * `idempotency-key` is on the list because it is not optional decoration. It is
 * the transport for `operation_id` (§5.26, R-D3, UI-34), so **every** create
 * that must survive a retry sends it. Leaving it out silently disabled saving a
 * product from the real UI while every integration test passed — supertest
 * speaks HTTP directly and never preflights anything, which is exactly the gap
 * S2 exists to close: "a module is not complete because the backend compiles".
 *
 * Exported rather than written inline in `main.ts` so the regression test can
 * assert the **same** object production uses. A test against a second copy of
 * this list would prove nothing.
 */
export function corsOptions(webOrigin: string): CorsOptions {
  return {
    origin: webOrigin,
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
  };
}
