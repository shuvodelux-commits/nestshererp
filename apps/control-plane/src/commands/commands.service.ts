import { Inject, Injectable } from '@nestjs/common';
import type { CommandEnvelope, CommandResult, CommandType, SignedCommand } from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import { addSeconds, Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';
import type { SignerClient } from '../signer/signer-client';
import { AUDIT_SERVICE, SIGNER_CLIENT } from '../tokens';

/**
 * How long a queued command stays valid.
 *
 * Twenty-four hours. A shop that has been offline for a day gets its licence
 * refresh when it comes back; a shop that has been offline for a week gets a
 * fresh command rather than a stale one, and the operator is told the old one
 * expired rather than discovering weeks later that a machine quietly applied
 * something decided in a different world.
 */
const COMMAND_TTL_SECONDS = 24 * 60 * 60;

export interface QueuedCommand {
  readonly id: string;
  readonly installationId: string;
  readonly type: CommandType;
  readonly status: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly result: Record<string, unknown>;
  readonly failureCode: string | null;
  readonly rejection: string | null;
}

/**
 * The command queue (§17, §18).
 *
 * **Signed here, verified there, and bound to one installation.** Every
 * envelope names its tenant and its installation inside the signed bytes, so a
 * command captured from one shop is refused by every other — which is §3's
 * requirement, and it holds even if an attacker can deliver the message,
 * because delivery is not what establishes who it was for.
 *
 * **Idempotency is a unique index, not a convention.** `commands_idempotent`
 * makes a second attempt to queue the same logical command collide in the
 * database; this service catches that and returns the first command's row. §18
 * asks that a replayed completed command not act twice, and the guarantee is at
 * the storage layer where a retry, a double click and a crashed handler all
 * meet the same wall.
 */
@Injectable()
export class CommandsService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(SIGNER_CLIENT) private readonly signer: SignerClient,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  /**
   * Queues one command, signed, or returns the existing one for this key.
   *
   * `idempotencyKey` is the caller's statement of what makes two requests "the
   * same command". A deployment uses the job and installation; a licence
   * delivery uses the licence id. Choosing it well is what makes a retry safe.
   */
  async enqueue(input: {
    tenantId: string;
    installationId: string;
    type: CommandType;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    createdBy: string;
  }): Promise<{ commandId: string; reused: boolean }> {
    const existing = await this.pool.query<{ id: string }>(
      'SELECT id FROM commands WHERE installation_id=$1 AND idempotency_key=$2',
      [input.installationId, input.idempotencyKey],
    );
    const already = existing.rows[0];
    if (already !== undefined) return { commandId: already.id, reused: true };

    const now = this.clock.now();
    const commandId = Ulid.generate(this.clock);
    const envelope: CommandEnvelope = {
      command_id: commandId,
      tenant_id: input.tenantId,
      installation_id: input.installationId,
      type: input.type,
      payload: input.payload,
      issued_at: now.toISOString(),
      expires_at: addSeconds(now, COMMAND_TTL_SECONDS).toISOString(),
      idempotency_key: input.idempotencyKey,
      // Filled in from the signer's answer below; the placeholder never
      // reaches the signed bytes because the envelope is rebuilt with the real
      // id before signing.
      signing_key_id: '',
    };

    const keys = await this.signer.publicKeys();
    const commandKey = keys['command'];
    if (commandKey === null || commandKey === undefined) {
      throw new ControlError(ControlErrorCode.SIGNER_UNAVAILABLE, 'No command signing key available');
    }
    const finalEnvelope: CommandEnvelope = { ...envelope, signing_key_id: commandKey.keyId };
    const { signature } = await this.signer.signCommand(
      finalEnvelope as unknown as Record<string, never>,
      `command ${input.type} for ${input.installationId}`,
    );

    try {
      await this.pool.query(
        `INSERT INTO commands
           (id, tenant_id, installation_id, type, payload, envelope, signature,
            idempotency_key, status, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10)`,
        [
          commandId,
          input.tenantId,
          input.installationId,
          input.type,
          JSON.stringify(input.payload),
          JSON.stringify(finalEnvelope),
          signature,
          input.idempotencyKey,
          input.createdBy,
          finalEnvelope.expires_at,
        ],
      );
    } catch {
      // Lost the race against a concurrent identical enqueue: the index did its
      // job, and the winner's command is the one that stands.
      const raced = await this.pool.query<{ id: string }>(
        'SELECT id FROM commands WHERE installation_id=$1 AND idempotency_key=$2',
        [input.installationId, input.idempotencyKey],
      );
      const winner = raced.rows[0];
      if (winner === undefined) throw new ControlError(ControlErrorCode.CONFLICT, 'Could not queue that command');
      return { commandId: winner.id, reused: true };
    }

    return { commandId, reused: false };
  }

  /**
   * What is waiting for this machine, marked dispatched as it goes out.
   *
   * Expired commands are retired here rather than handed over: an agent should
   * never have to reason about whether an instruction is still meant.
   */
  async pendingFor(installationId: string): Promise<SignedCommand[]> {
    await this.pool.query(
      `UPDATE commands SET status='EXPIRED', completed_at=now()
        WHERE installation_id=$1 AND status='PENDING' AND expires_at <= now()`,
      [installationId],
    );
    const result = await this.pool.query<{ id: string; envelope: CommandEnvelope; signature: string }>(
      `SELECT id, envelope, signature FROM commands
        WHERE installation_id=$1 AND status='PENDING'
        ORDER BY created_at LIMIT 20`,
      [installationId],
    );
    if (result.rows.length > 0) {
      await this.pool.query(
        `UPDATE commands SET status='DISPATCHED', dispatched_at=now() WHERE id = ANY($1::text[])`,
        [result.rows.map((row) => row.id)],
      );
    }
    return result.rows.map((row) => ({ envelope: row.envelope, signature: row.signature }));
  }

  /**
   * Records what became of a command.
   *
   * Refuses to overwrite a terminal status. §18's replay rule cuts both ways:
   * an agent that reports the same result twice — because its own reply was
   * lost — must not be able to turn a success into a failure, or re-trigger
   * whatever the control plane does when a deployment stage lands.
   */
  async recordResult(installationId: string, report: CommandResult): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE commands
          SET status=$3, rejection=$4, failure_code=$5, result=$6, completed_at=now()
        WHERE id=$1 AND installation_id=$2
          AND status NOT IN ('SUCCEEDED','FAILED','REJECTED','EXPIRED')`,
      [
        report.command_id,
        installationId,
        report.status,
        report.rejection ?? null,
        report.failure_code ?? null,
        JSON.stringify(report.result),
      ],
    );
    if (updated.rowCount === 0) return;

    if (report.status === 'REJECTED') {
      // A rejection is a fact the vendor needs, not noise to swallow: a
      // TENANT_MISMATCH anywhere in a live fleet means something is badly wrong.
      await this.audit.append({
        operatorId: null,
        operatorName: 'agent',
        action: 'command.rejected',
        installationId,
        subject: report.command_id,
        after: { rejection: report.rejection },
      });
    }
  }

  async listFor(installationId: string, limit = 50): Promise<QueuedCommand[]> {
    const result = await this.pool.query<QueuedCommand>(
      `SELECT id, installation_id AS "installationId", type, status,
              created_at AS "createdAt", completed_at AS "completedAt",
              result, failure_code AS "failureCode", rejection
         FROM commands WHERE installation_id=$1
        ORDER BY created_at DESC LIMIT $2`,
      [installationId, limit],
    );
    return result.rows;
  }

  async get(commandId: string): Promise<QueuedCommand | null> {
    const result = await this.pool.query<QueuedCommand>(
      `SELECT id, installation_id AS "installationId", type, status,
              created_at AS "createdAt", completed_at AS "completedAt",
              result, failure_code AS "failureCode", rejection
         FROM commands WHERE id=$1`,
      [commandId],
    );
    return result.rows[0] ?? null;
  }
}
