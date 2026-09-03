import { Inject, Injectable } from '@nestjs/common';
import type { CanonicalValue } from '@sher/control-contracts';

import type { ControlPlaneConfig } from '../config';
import { ControlError, ControlErrorCode } from '../common/errors';
import { CONTROL_CONFIG } from '../db/tokens';

/**
 * The control plane's only way to obtain a signature (§5).
 *
 * There is no fallback path in this class — no "sign locally if the signer is
 * down", no cached key, no environment variable holding a private key for
 * development. If the signer is unavailable the operation fails with
 * `SIGNER_UNAVAILABLE` and the operator sees a plain refusal. That is the
 * correct behaviour: an outage that stops the vendor issuing a licence is an
 * inconvenience, whereas a convenience path that puts the key in this process
 * is the thing §5 exists to prevent, permanently, in every deployment that
 * copies the pattern.
 *
 * The `subject` argument is what the signer writes to its own audit log — a
 * human-readable "who and what", so the log beside the key can be compared with
 * the audit trail in the database and any signature without a matching request
 * stands out.
 */
@Injectable()
export class SignerClient {
  constructor(@Inject(CONTROL_CONFIG) private readonly config: ControlPlaneConfig) {}

  async signCommand(document: CanonicalValue, subject: string): Promise<SignatureResult> {
    return this.signDocument('command', document, subject);
  }

  async signSupportGrant(document: CanonicalValue, subject: string): Promise<SignatureResult> {
    return this.signDocument('support', document, subject);
  }

  async signRelease(document: CanonicalValue, subject: string): Promise<SignatureResult> {
    return this.signDocument('release', document, subject);
  }

  /** Signs an already-canonicalised licence payload; returns the pasteable key. */
  async signLicence(canonicalPayload: string, subject: string): Promise<{ key: string; signingKeyId: string }> {
    return this.post<{ key: string; signingKeyId: string }>('/sign/licence', {
      canonicalPayload,
      subject,
    });
  }

  /** The public halves, for pinning at enrolment and for the console to display. */
  async publicKeys(): Promise<Record<string, { keyId: string; publicKeyBase64: string } | null>> {
    const result = await this.post<{ keys: Record<string, { keyId: string; publicKeyBase64: string } | null> }>(
      '/public-keys',
      undefined,
    );
    return result.keys;
  }

  private async signDocument(
    purpose: 'command' | 'support' | 'release',
    document: CanonicalValue,
    subject: string,
  ): Promise<SignatureResult> {
    return this.post<SignatureResult>(`/sign/${purpose}`, { document, subject });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.signerUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.config.signerToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ControlError(
        ControlErrorCode.SIGNER_UNAVAILABLE,
        'The signing service is not answering. Nothing was signed.',
      );
    }
    if (!response.ok) {
      throw new ControlError(
        ControlErrorCode.SIGNER_UNAVAILABLE,
        `The signing service refused (${String(response.status)}). Nothing was signed.`,
      );
    }
    return (await response.json()) as T;
  }
}

export interface SignatureResult {
  readonly signature: string;
  readonly signingKeyId: string;
}
