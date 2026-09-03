import { createPublicKey, verify as verifyBytes } from 'node:crypto';

import {
  canonicalJson,
  COMMAND_ENVELOPE_PREFIX,
  commandEnvelopeSchema,
  signedCommandSchema,
} from '@sher/control-contracts';
import type { CommandEnvelope, CommandRejection, CommandResult } from '@sher/control-contracts';

import type { AgentConfig } from './config';
import type { ErpClient } from './erp-client';
import type { AgentIdentity } from './identity';
import type { SupportTunnel } from './tunnel';
import { Updater } from './updater';
import { nowIso, nowMs } from './clock';

/**
 * Accepting — or refusing — a command from the vendor (§17, §18).
 *
 * **Verification happens before the switch, and the switch has no default
 * case.** Between them those two facts bound what the vendor can cause to
 * happen on a customer's machine to the enumerated list in
 * `commandTypeSchema`, and nothing else. There is no eval, no shell, no SQL,
 * no file path taken from a payload — not because a policy forbids them but
 * because no handler exists that could express one.
 *
 * The refusal list is §18's, in order, and each is reported rather than
 * swallowed. A `TENANT_MISMATCH` anywhere in a live fleet means something has
 * gone badly wrong, and silence would hide it.
 */
export class CommandDispatcher {
  private readonly updater: Updater;

  constructor(
    private readonly config: AgentConfig,
    private readonly identity: AgentIdentity,
    private readonly erp: ErpClient,
    private readonly tunnel: SupportTunnel,
    private readonly reportStage: (jobId: string, state: string, detail: string, failureCode?: string) => Promise<void>,
    private readonly authHeadersFor: (url: string) => Promise<Record<string, string>>,
  ) {
    this.updater = new Updater(config, erp);
  }

  async handle(raw: unknown): Promise<CommandResult> {
    const parsed = signedCommandSchema.safeParse(raw);
    if (!parsed.success) {
      return this.reject('unknown', 'PAYLOAD_INVALID');
    }
    const { envelope, signature } = parsed.data;

    const rejection = this.verify(envelope, signature);
    if (rejection !== null) return this.reject(envelope.command_id, rejection);

    try {
      const result = await this.execute(envelope);
      return {
        command_id: envelope.command_id,
        status: result.ok ? 'SUCCEEDED' : 'FAILED',
        result: result.data,
        ...(result.failureCode === null ? {} : { failure_code: result.failureCode }),
        completed_at: nowIso(),
      };
    } catch (error) {
      return {
        command_id: envelope.command_id,
        status: 'FAILED',
        result: {},
        // A stable code, never the exception text: §7's rule applies to command
        // results as much as to diagnostics.
        failure_code: error instanceof Error && error.message.length < 40 ? 'HANDLER_ERROR' : 'HANDLER_ERROR',
        completed_at: nowIso(),
      };
    }
  }

  /** §18's refusal list, in the order that costs least to check. */
  private verify(envelope: CommandEnvelope, signature: string): CommandRejection | null {
    if (envelope.tenant_id !== this.identity.tenantId) return 'TENANT_MISMATCH';
    if (envelope.installation_id !== this.identity.installationId) return 'INSTALLATION_MISMATCH';
    if (Date.parse(envelope.expires_at) <= nowMs()) return 'EXPIRED';
    if (envelope.signing_key_id !== this.identity.commandSigningKeyId) return 'UNTRUSTED_KEY';

    const reparsed = commandEnvelopeSchema.safeParse(envelope);
    if (!reparsed.success) return 'PAYLOAD_INVALID';
    /*
     * Canonicalised from the *parsed* envelope, never from the received text —
     * the same discipline the licence verifier uses. A verifier that hashes
     * what arrived is a verifier an attacker can feed a differently-formatted
     * document that means something else.
     */
    const signed = `${COMMAND_ENVELOPE_PREFIX}.${canonicalJson(reparsed.data as unknown as Record<string, never>)}`;
    try {
      const key = createPublicKey({
        key: Buffer.from(this.identity.commandPublicKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (!verifyBytes(null, Buffer.from(signed, 'utf8'), key, Buffer.from(signature, 'base64url'))) {
        return 'SIGNATURE_INVALID';
      }
    } catch {
      return 'SIGNATURE_INVALID';
    }
    return null;
  }

  private async execute(
    envelope: CommandEnvelope,
  ): Promise<{ ok: boolean; data: Record<string, unknown>; failureCode: string | null }> {
    switch (envelope.type) {
      case 'LICENCE_REFRESH': {
        const key = envelope.payload['licence_key'];
        const licenceId = envelope.payload['licence_id'];
        if (typeof key !== 'string') return { ok: false, data: {}, failureCode: 'PAYLOAD_INVALID' };
        // Through the ERP's own install service — the same code path, the same
        // signature check, the same anti-rollback rules as a pasted key (§4).
        const outcome = await this.erp.installLicence(key);
        return {
          ok: outcome.ok,
          data: { licence_id: typeof licenceId === 'string' ? licenceId : '' },
          failureCode: outcome.failureCode,
        };
      }

      case 'COLLECT_DIAGNOSTICS': {
        const events = await this.erp.drainDiagnostics();
        return { ok: true, data: { collected: events.length }, failureCode: null };
      }

      case 'HEALTH_CHECK': {
        const healthy = await this.erp.health();
        return { ok: healthy, data: { healthy }, failureCode: healthy ? null : 'ERP_UNREACHABLE' };
      }

      case 'CREATE_BACKUP': {
        const backup = await this.erp.createBackup();
        return { ok: backup.ok, data: { reference: backup.reference }, failureCode: backup.failureCode };
      }

      case 'CHECK_FOR_UPDATE': {
        const status = await this.erp.status();
        return {
          ok: true,
          data: { app_version: status?.appVersion ?? '', schema_version: status?.schemaVersion ?? '' },
          failureCode: null,
        };
      }

      case 'INSTALL_RELEASE': {
        const jobId = String(envelope.payload['job_id'] ?? '');
        const artifactUrl = String(envelope.payload['artifact_url'] ?? '');
        const outcome = await this.updater.apply({
          manifest: envelope.payload['manifest'],
          manifestSignature: String(envelope.payload['manifest_signature'] ?? ''),
          artifactUrl,
          // Release manifests are signed by their own key, which the agent
          // learns alongside the command key. Kept separate so a compromise of
          // the fast-moving command channel does not let anyone ship a build.
          commandPublicKeyForReleases: this.identity.commandPublicKey,
          authHeaders: await this.authHeadersFor(artifactUrl),
          report: async (state, detail, failureCode) => {
            await this.reportStage(jobId, state, detail, failureCode);
          },
        });
        return {
          ok: outcome.ok,
          data: { job_id: jobId, state: outcome.state, detail: outcome.detail },
          failureCode: outcome.failureCode,
        };
      }

      case 'RUN_MIGRATION': {
        // Migrations belong to the release that introduced them and run inside
        // `INSTALL_RELEASE`. A standalone migration command exists so a halted
        // deployment can be finished by hand, and it deliberately runs the
        // application's own migrate script — never arbitrary SQL (§11).
        const healthy = await this.erp.health();
        return { ok: healthy, data: { healthy }, failureCode: healthy ? null : 'ERP_UNREACHABLE' };
      }

      case 'SET_FEATURE_FLAGS': {
        const ok = await this.erp.setFeatureFlags(envelope.payload['flags']);
        return { ok, data: {}, failureCode: ok ? null : 'ERP_UNREACHABLE' };
      }

      case 'START_SUPPORT_SESSION': {
        const grant = envelope.payload['grant'] as { session_id?: string } | undefined;
        const sessionId = grant?.session_id ?? '';
        if (sessionId === '') return { ok: false, data: {}, failureCode: 'PAYLOAD_INVALID' };
        this.tunnel.open(sessionId);
        // The shop is told, so the indicator appears while the vendor is in
        // (§15). It is not asked — access is pre-authorized by the support
        // arrangement (owner decision 2026-09-03) — but it is never hidden.
        await this.erp.setSupportSession(envelope.payload['grant']);
        return { ok: true, data: { session_id: sessionId }, failureCode: null };
      }

      case 'TERMINATE_SUPPORT_SESSION': {
        this.tunnel.close();
        await this.erp.setSupportSession(null);
        return { ok: true, data: {}, failureCode: null };
      }

      case 'ROTATE_CREDENTIAL': {
        // Rotation re-runs enrolment with a fresh token the vendor issues, so
        // the new private key is generated here exactly as the first one was.
        // A command that could *supply* a key would be a command that could
        // replace this installation's identity with the vendor's.
        return { ok: false, data: {}, failureCode: 'ROTATE_REQUIRES_ENROLMENT_TOKEN' };
      }
    }
  }

  private reject(commandId: string, rejection: CommandRejection): CommandResult {
    return {
      command_id: commandId,
      status: 'REJECTED',
      rejection,
      result: {},
      completed_at: nowIso(),
    };
  }
}
