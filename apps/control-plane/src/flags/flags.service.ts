import { Inject, Injectable } from '@nestjs/common';
import { KNOWN_FEATURE_FLAGS } from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import type { CommandsService } from '../commands/commands.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';
import type { InstallationsService } from '../installations/installations.service';
import type { OperatorPrincipal } from '../operators/operator.guard';
import { AUDIT_SERVICE, COMMANDS_SERVICE, INSTALLATIONS_SERVICE } from '../tokens';

/**
 * Emergency feature control (§19).
 *
 * Narrow by construction. A flag may only be one of `KNOWN_FEATURE_FLAGS` —
 * names somebody deliberately made switchable — so this cannot become a general
 * remote-configuration channel by accretion. And the ERP resolves an unknown or
 * unreachable flag to *enabled*, which means a vendor outage cannot switch a
 * customer's features off (§20, §21).
 *
 * What it deliberately cannot touch: costing method, journal behaviour, VAT
 * rules, period rules, anything the ledger depends on. Not because a rule
 * forbids reading a flag there, but because those code paths contain no flag
 * lookup at all. A switch that does not exist cannot be thrown by mistake, and
 * two audits of the same month cannot disagree because of one.
 */
@Injectable()
export class FlagsService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(COMMANDS_SERVICE) private readonly commands: CommandsService,
    @Inject(INSTALLATIONS_SERVICE) private readonly installations: InstallationsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async list(installationId: string | null): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT key, enabled, reason, installation_id AS "installationId", updated_at AS "updatedAt"
         FROM feature_flags
        WHERE installation_id IS NULL OR installation_id = $1
        ORDER BY key`,
      [installationId],
    );
    return result.rows;
  }

  async set(
    input: { installationId: string | null; key: string; enabled: boolean; reason: string },
    operator: OperatorPrincipal,
  ): Promise<void> {
    if (!KNOWN_FEATURE_FLAGS.includes(input.key)) {
      throw new ControlError(
        ControlErrorCode.VALIDATION_FAILED,
        `"${input.key}" is not a feature this build can switch. Only optional features and screens can be flagged.`,
      );
    }
    if (!input.enabled && input.reason.trim().length < 3) {
      // §24: disabling a feature on a customer's machine is a sensitive action
      // and needs a reason somebody can read next year.
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Say why this is being disabled');
    }

    await this.pool.query(
      `INSERT INTO feature_flags (id, installation_id, key, enabled, reason, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (${input.installationId === null ? 'key) WHERE installation_id IS NULL' : 'installation_id, key) WHERE installation_id IS NOT NULL'}
       DO UPDATE SET enabled=EXCLUDED.enabled, reason=EXCLUDED.reason,
                     updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [Ulid.generate(this.clock), input.installationId, input.key, input.enabled, input.reason, operator.id],
    );

    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'flags.manage',
      installationId: input.installationId,
      reason: input.reason,
      subject: input.key,
      after: { enabled: input.enabled },
      ip: operator.ip,
      userAgent: operator.userAgent,
    });

    await this.push(input.installationId, operator);
  }

  /** Sends the resolved flag set to one installation, or to all of them. */
  private async push(installationId: string | null, operator: OperatorPrincipal): Promise<void> {
    const targets =
      installationId === null
        ? (await this.installations.list()).filter((row) => row.revokedAt === null)
        : [await this.installations.get(installationId)];

    for (const target of targets) {
      const flags = await this.list(target.id);
      await this.commands.enqueue({
        tenantId: target.tenantId,
        installationId: target.id,
        type: 'SET_FEATURE_FLAGS',
        payload: { flags, issued_at: this.clock.now().toISOString() },
        // One push per installation per minute: a burst of edits collapses into
        // one delivery rather than a queue of near-identical commands.
        idempotencyKey: `flags:${this.clock.now().toISOString().slice(0, 16)}`,
        createdBy: operator.id,
      });
    }
  }
}
