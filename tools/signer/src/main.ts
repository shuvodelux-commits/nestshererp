import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  COMMAND_ENVELOPE_PREFIX,
  RELEASE_MANIFEST_PREFIX,
  SUPPORT_GRANT_PREFIX,
} from '@sher/control-contracts';
import type { CanonicalValue } from '@sher/control-contracts';
import { LICENSE_PREFIX } from '@sher/core-contracts';
import { SystemClock } from '@sher/shared-utils';

import { readKey } from './keys';
import type { KeyPurpose } from './keys';
import { signDocument, signLicence } from './sign';

/**
 * The signing service (§5) — small, loopback-only, and deliberately dull.
 *
 * **Why a whole process for four functions.** The licence signing key is the
 * one secret in this system that cannot be rotated quietly: losing it means no
 * existing customer can ever be renewed, and leaking it means anyone can mint a
 * perpetual licence for any shop. Keeping it out of the control plane means an
 * SQL injection, a dependency compromise or a stray `console.log` in that much
 * larger, internet-facing application cannot reach it. The blast radius of this
 * file is this file.
 *
 * It binds to loopback and refuses to start otherwise. It authenticates with a
 * shared bearer so that another process on the same box cannot simply ask it to
 * sign. It writes every signature to an append-only log beside the keys. And it
 * exposes no route that returns key material — only public halves, which are
 * meant to be published.
 *
 * Written on `node:http` rather than Nest: the fewer moving parts between a
 * request and a signature, the fewer places for a surprise.
 */
const PORT = Number(process.env['SIGNER_PORT'] ?? '3200');
const HOST = process.env['SIGNER_HOST'] ?? '127.0.0.1';
const TOKEN = process.env['SIGNER_TOKEN'] ?? '';

const PREFIXES: Record<Exclude<KeyPurpose, 'licence'>, string> = {
  command: COMMAND_ENVELOPE_PREFIX,
  support: SUPPORT_GRANT_PREFIX,
  release: RELEASE_MANIFEST_PREFIX,
};

function authorised(req: IncomingMessage): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(TOKEN, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (!authorised(req)) {
        send(res, 401, { error: 'unauthorised' });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${HOST}`);
      const now = new SystemClock().now().toISOString();

      /**
       * The public halves, and only ever the public halves.
       *
       * The agent pins the command key at enrolment from here, and a customer
       * installation verifies licences against the licence public key. Both are
       * meant to be widely known — publishing them costs nothing and is what
       * makes the private halves never need to move.
       */
      if (req.method === 'GET' && url.pathname === '/public-keys') {
        const purposes: KeyPurpose[] = ['licence', 'command', 'support', 'release'];
        const keys: Record<string, { keyId: string; publicKeyBase64: string } | null> = {};
        for (const purpose of purposes) {
          try {
            const key = readKey(purpose);
            keys[purpose] = { keyId: key.keyId, publicKeyBase64: key.publicKeyBase64 };
          } catch {
            keys[purpose] = null;
          }
        }
        send(res, 200, { keys });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, { status: 'ok' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/sign/licence') {
        const body = (await readBody(req)) as { canonicalPayload?: unknown; subject?: unknown };
        if (typeof body.canonicalPayload !== 'string') {
          send(res, 400, { error: 'canonicalPayload required' });
          return;
        }
        const subject = typeof body.subject === 'string' ? body.subject : '';
        send(res, 200, signLicence(body.canonicalPayload, LICENSE_PREFIX, subject, now));
        return;
      }

      const match = /^\/sign\/(command|support|release)$/u.exec(url.pathname);
      if (req.method === 'POST' && match !== null) {
        const purpose = match[1] as Exclude<KeyPurpose, 'licence'>;
        const body = (await readBody(req)) as { document?: unknown; subject?: unknown };
        if (typeof body.document !== 'object' || body.document === null) {
          send(res, 400, { error: 'document required' });
          return;
        }
        const subject = typeof body.subject === 'string' ? body.subject : '';
        send(
          res,
          200,
          signDocument(purpose, PREFIXES[purpose], body.document as CanonicalValue, subject, now),
        );
        return;
      }

      send(res, 404, { error: 'no such endpoint' });
    } catch (error) {
      // The reason stays in this process's log. A signer that explains its
      // failures over the wire explains its key layout with them.
      process.stderr.write(
        `[signer] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      send(res, 500, { error: 'signing failed' });
    }
  })();
});

if (TOKEN.length < 24) {
  process.stderr.write('SIGNER_TOKEN must be set to at least 24 characters.\n');
  process.exit(1);
}
if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  // A signer reachable from the network is a signing key reachable from the
  // network. There is no configuration in which that is acceptable.
  process.stderr.write('SIGNER_HOST must be loopback. Refusing to start.\n');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`Signer listening on http://${HOST}:${String(PORT)} (loopback only)\n`);
});
