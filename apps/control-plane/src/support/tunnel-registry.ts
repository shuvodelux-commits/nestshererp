import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';

import { Inject, Injectable } from '@nestjs/common';
import {
  AGENT_CLOCK_SKEW_SECONDS,
  AGENT_HEADER_INSTALLATION,
  AGENT_HEADER_ISSUED_AT,
  AGENT_HEADER_NONCE,
  AGENT_HEADER_SIGNATURE,
  AGENT_REQUEST_PREFIX,
  canonicalJson,
} from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import type pg from 'pg';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { ControlError, ControlErrorCode } from '../common/errors';
import { verifyEd25519 } from '../crypto/ed25519';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';

/**
 * The reverse tunnel (§16).
 *
 * **The customer never opens a port.** The sidecar dials *out* to this server
 * over WSS and holds the socket; requests then travel down that existing
 * connection. That is the whole answer to "some ERP installations have no
 * public URL": their router does not need a forwarding rule, their firewall
 * does not need a hole, and their database is never exposed to anything. The
 * shape is
 *
 *   vendor browser → support gateway → existing outbound agent socket → ERP
 *
 * and every arrow but the last crosses the internet in the direction the
 * customer's network already permits.
 *
 * **The socket is raised only while it is needed.** A sidecar connects when it
 * accepts a `START_SUPPORT_SESSION` and drops the connection when the session
 * ends. Two hundred shops do not hold two hundred idle sockets, and — more to
 * the point — an installation with no live support session has no channel into
 * it at all, which is a much easier property to reason about than a permanent
 * connection nobody is watching.
 *
 * The connection is authenticated with the same signed document as every other
 * agent request, over the handshake headers. A tunnel is a far more powerful
 * thing than a check-in, so it gets no weaker a check.
 */
@Injectable()
export class TunnelRegistry {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, (frame: TunnelResponse) => void>();

  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Mounts the WebSocket server on the HTTP server Nest already created.
   *
   * `noServer` plus a manual upgrade check, rather than letting `ws` accept on
   * its own path: authentication has to happen *before* the socket exists, so a
   * failed check closes the connection at the handshake rather than after.
   */
  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/agent-tunnel') return;

      void this.authenticate(request)
        .then((installationId) => {
          wss.handleUpgrade(request, socket, head, (ws) => {
            this.register(installationId, ws);
          });
        })
        .catch(() => {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
        });
    });
  }

  /** Whether this installation currently has a live tunnel. */
  isConnected(installationId: string): boolean {
    return this.sockets.get(installationId)?.readyState === 1;
  }

  /**
   * Sends one HTTP request down the tunnel and waits for its answer.
   *
   * A hard timeout, because the far end is a shop's computer on a domestic
   * line: a hung request that never resolves would hold a control-plane
   * connection open until the process restarted.
   */
  async request(installationId: string, frame: Omit<TunnelRequest, 'id' | 'kind'>): Promise<TunnelResponse> {
    const socket = this.sockets.get(installationId);
    if (socket === undefined || socket.readyState !== 1) {
      throw new ControlError(
        ControlErrorCode.SUPPORT_SESSION_INACTIVE,
        'That installation is not connected for support right now',
      );
    }
    const id = randomUUID();
    const payload: TunnelRequest = { ...frame, id, kind: 'request' };

    return new Promise<TunnelResponse>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ControlError(ControlErrorCode.SUPPORT_SESSION_INACTIVE, 'The shop did not answer in time'),
        );
      }, TUNNEL_TIMEOUT_MS);

      this.pending.set(id, (response) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolvePromise(response);
      });
      socket.send(JSON.stringify(payload));
    });
  }

  /** Drops the tunnel for one installation — what revocation calls. */
  disconnect(installationId: string): void {
    const socket = this.sockets.get(installationId);
    if (socket !== undefined) {
      socket.close(1000, 'support session ended');
      this.sockets.delete(installationId);
    }
  }

  private register(installationId: string, socket: WebSocket): void {
    // One tunnel per installation. A second connection replaces the first
    // rather than joining it: two sockets claiming one shop is ambiguous, and
    // ambiguity in a support path is the wrong kind of surprise.
    this.disconnect(installationId);
    this.sockets.set(installationId, socket);

    socket.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as TunnelResponse;
        if (frame.kind !== 'response') return;
        this.pending.get(frame.id)?.(frame);
      } catch {
        // A frame that does not parse is discarded. The pending request will
        // time out, which is the honest outcome.
      }
    });
    socket.on('close', () => {
      if (this.sockets.get(installationId) === socket) this.sockets.delete(installationId);
    });
    socket.on('error', () => {
      if (this.sockets.get(installationId) === socket) this.sockets.delete(installationId);
    });
  }

  /** The same signed-document check the HTTP guard applies, over headers. */
  private async authenticate(request: IncomingMessage): Promise<string> {
    const installationId = String(request.headers[AGENT_HEADER_INSTALLATION] ?? '');
    const issuedAt = String(request.headers[AGENT_HEADER_ISSUED_AT] ?? '');
    const nonce = String(request.headers[AGENT_HEADER_NONCE] ?? '');
    const signature = String(request.headers[AGENT_HEADER_SIGNATURE] ?? '');
    if (installationId === '' || issuedAt === '' || nonce === '' || signature === '') {
      throw new Error('unsigned');
    }

    const found = await this.pool.query<{ revoked_at: Date | null; public_key: string | null }>(
      `SELECT i.revoked_at,
              (SELECT k.public_key FROM installation_keys k
                WHERE k.installation_id = i.id AND k.retired_at IS NULL
                ORDER BY k.created_at DESC LIMIT 1) AS public_key
         FROM installations i WHERE i.id = $1`,
      [installationId],
    );
    const row = found.rows[0];
    if (row === undefined || row.public_key === null || row.revoked_at !== null) throw new Error('unknown');

    const issued = Date.parse(issuedAt);
    if (
      Number.isNaN(issued) ||
      Math.abs(this.clock.now().getTime() - issued) > AGENT_CLOCK_SKEW_SECONDS * 1000
    ) {
      throw new Error('skew');
    }

    const document = {
      installation_id: installationId,
      method: 'GET',
      path: '/agent-tunnel',
      body_sha256: '',
      issued_at: issuedAt,
      nonce,
    };
    if (!verifyEd25519(`${AGENT_REQUEST_PREFIX}.${canonicalJson(document)}`, signature, row.public_key)) {
      throw new Error('signature');
    }
    try {
      await this.pool.query('INSERT INTO agent_nonces (installation_id, nonce) VALUES ($1,$2)', [
        installationId,
        nonce,
      ]);
    } catch {
      throw new Error('replay');
    }
    return installationId;
  }
}

/**
 * Thirty seconds.
 *
 * A support request is a person waiting at a screen; anything slower than this
 * on a shop's own machine is a problem to report, not a request to keep holding.
 */
const TUNNEL_TIMEOUT_MS = 30_000;

export interface TunnelRequest {
  readonly kind: 'request';
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  /** base64, empty for a bodyless request. */
  readonly body: string;
}

export interface TunnelResponse {
  readonly kind: 'response';
  readonly id: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Short, stable reference for the audit trail without storing a body. */
export function documentRefOf(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16);
}
