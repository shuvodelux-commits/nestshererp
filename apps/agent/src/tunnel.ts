import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

import type { AgentConfig } from './config';
import { signRequest } from './identity';
import type { AgentIdentity } from './identity';
import { nowIso } from './clock';

/**
 * The shop's end of the support tunnel (§16).
 *
 * It **dials out**. The control plane never connects to a customer's network,
 * which is what makes support work for a shop behind NAT with no public URL and
 * no forwarding rule — and what means there is nothing listening on the shop's
 * side for anyone else to find.
 *
 * The socket exists only while a support session is live. Opened when a signed
 * `START_SUPPORT_SESSION` arrives, closed when the session ends or expires. An
 * installation with no live session has no channel into it at all, which is a
 * far easier thing to be confident about than a permanent connection nobody is
 * watching.
 *
 * Everything that arrives is forwarded to the ERP **over loopback HTTP**, with
 * the vendor's signed grant attached. The ERP then applies its own permissions,
 * its own domain rules and its own audit writer — so a correction made from the
 * vendor's browser takes exactly the path a correction made at the counter
 * takes (§14). This class forwards bytes; it decides nothing.
 */
export class SupportTunnel {
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly identity: AgentIdentity,
  ) {}

  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  open(sessionId: string): void {
    this.close();
    this.sessionId = sessionId;

    const issuedAt = nowIso();
    const nonce = randomUUID();
    const signature = signRequest(this.identity, {
      method: 'GET',
      path: '/agent-tunnel',
      bodySha256: '',
      issuedAt,
      nonce,
    });

    const url = new URL(this.config.controlPlaneUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/agent-tunnel';

    const socket = new WebSocket(url.toString(), {
      headers: {
        'x-sher-installation': this.identity.installationId,
        'x-sher-issued-at': issuedAt,
        'x-sher-nonce': nonce,
        'x-sher-signature': signature,
      },
    });
    this.socket = socket;

    socket.on('message', (data) => {
      /*
       * The rejection is caught here rather than left to float. An unhandled
       * rejection ends a Node process by default, and this callback runs on
       * every proxied request — one malformed frame must not take the shop's
       * management agent down with it.
       */
      void this.forward(String(data), socket).catch(() => undefined);
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.sessionId = null;
      }
    });
    socket.on('error', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.sessionId = null;
      }
    });
  }

  close(): void {
    this.socket?.close(1000, 'session ended');
    this.socket = null;
    this.sessionId = null;
  }

  /**
   * Sends a frame, and treats a dead socket as ordinary.
   *
   * The control plane going away mid-request is the normal case on a domestic
   * line, not an exception: `send` on a closing socket raises, and an
   * unhandled raise inside an event callback ends the process. A sidecar that
   * dies when the vendor's server hiccups is exactly what §21 forbids — the
   * shop would lose its management channel until somebody noticed and
   * restarted it by hand.
   */
  private safeSend(socket: WebSocket, frame: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The far end went away between the check and the send. Nothing to do:
      // the operator's request times out at the gateway, which is honest.
    }
  }

  private async forward(raw: string, socket: WebSocket): Promise<void> {
    let frame: { kind?: string; id?: string; method?: string; path?: string; headers?: Record<string, string>; body?: string };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (frame.kind !== 'request' || typeof frame.id !== 'string') return;

    try {
      const hasBody = typeof frame.body === 'string' && frame.body !== '';
      const response = await fetch(`${this.config.erpUrl}${frame.path ?? '/'}`, {
        method: frame.method ?? 'GET',
        headers: frame.headers ?? {},
        ...(hasBody ? { body: Buffer.from(frame.body ?? '', 'base64') } : {}),
        signal: AbortSignal.timeout(25_000),
      });
      const body = Buffer.from(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      this.safeSend(socket, {
        kind: 'response',
        id: frame.id,
        status: response.status,
        headers,
        body: body.toString('base64'),
      });
    } catch {
      // The ERP being unreachable is reported as a gateway error rather than
      // silence: the operator needs to know it was the shop's ERP that did not
      // answer, not the tunnel.
      this.safeSend(socket, {
        kind: 'response',
        id: frame.id,
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: 'the local ERP did not answer' })).toString('base64'),
      });
    }
  }
}
