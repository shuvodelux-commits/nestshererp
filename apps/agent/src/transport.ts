import { createHash, randomUUID } from 'node:crypto';

import type { AgentConfig } from './config';
import { signRequest } from './identity';
import type { AgentIdentity } from './identity';
import { nowIso } from './clock';

/**
 * Every outbound call the sidecar makes, signed.
 *
 * One function, because the alternative is several call sites each remembering
 * to sign — and the one that forgets is the one that matters. The signature
 * covers the method, the path and a hash of the body; the nonce and timestamp
 * are what make a captured request worthless within five minutes.
 *
 * **Outbound only, always** (§1, §16). There is no server in this process
 * listening for the control plane to call in. That single property is what
 * removes port forwarding, inbound firewall rules and a public URL from every
 * customer's installation requirements.
 */
export async function callControlPlane<T>(
  config: AgentConfig,
  identity: AgentIdentity,
  path: string,
  body: unknown,
): Promise<T> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const issuedAt = nowIso();
  const nonce = randomUUID();
  const signature = signRequest(identity, {
    method: 'POST',
    path,
    bodySha256: raw === '' ? '' : createHash('sha256').update(raw, 'utf8').digest('hex'),
    issuedAt,
    nonce,
  });

  const response = await fetch(`${config.controlPlaneUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sher-installation': identity.installationId,
      'x-sher-issued-at': issuedAt,
      'x-sher-nonce': nonce,
      'x-sher-signature': signature,
    },
    body: raw,
  });
  if (!response.ok) {
    throw new Error(`control plane refused ${path}: ${String(response.status)}`);
  }
  return (await response.json()) as T;
}
