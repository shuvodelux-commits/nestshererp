/** Test-only localhost, one-use lost-ACK proxy. No fabricated financial response. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

interface CommittedResponse {
  readonly status: number;
  readonly body: string;
}
interface Proxy {
  readonly endpoint: string;
  readonly waitCommitted: Promise<CommittedResponse>;
  readonly close: () => Promise<void>;
}
export async function createRealNestLostAckProxy(
  input: { readonly target: string; readonly matchPath: string },
): Promise<Proxy> {
  const upstream = new URL(input.target);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' ||
      upstream.pathname !== '/' ||
      !/^\/api\/v1\/money\/day\/(?:start|[0-7][0-9A-HJKMNP-TV-Z]{25}\/(?:close|reopen))$/.test(input.matchPath)) {
    throw new Error('M5-05 proxy only forwards localhost cash-session POSTs');
  }
  let received = false;
  let resolveCommitted!: (result: CommittedResponse) => void;
  let rejectCommitted!: (error: unknown) => void;
  const waitCommitted = new Promise<CommittedResponse>((resolve, reject) => {
    resolveCommitted = resolve;
    rejectCommitted = reject;
  });
  // A test failure must not cause an unrelated unhandled rejection.
  void waitCommitted.catch(() => undefined);
  const server = createServer(async (request, response) => {
    if (received || request.method !== 'POST' || request.url !== input.matchPath) {
      response.writeHead(404);
      response.end();
      return;
    }
    received = true;
    try {
      const chunks: Buffer[] = [];
      for await (const part of request) chunks.push(Buffer.from(part));
      const upstreamResponse = await fetch(upstream.origin + input.matchPath, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': request.headers['content-type'] || 'application/json',
          ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}),
          ...(request.headers['idempotency-key']
            ? { 'Idempotency-Key': request.headers['idempotency-key'] } : {}),
        },
        body: Buffer.concat(chunks),
      });
      const body = await upstreamResponse.text();
      if (!upstreamResponse.ok) throw new Error('Real Nest returned ' + upstreamResponse.status);
      resolveCommitted({ status: upstreamResponse.status, body });
      // Only after a complete, successful real upstream HTTP reply do we
      // intentionally destroy the *client* socket without writing any ACK.
      request.socket.destroy();
    } catch (error) {
      rejectCommitted(error);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502);
        response.end();
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    endpoint: 'http://127.0.0.1:' + address.port,
    waitCommitted,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
