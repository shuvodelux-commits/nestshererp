import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, DeploymentState } from '@sher/control-contracts';
import { deploymentStateSchema, TERMINAL_DEPLOYMENT_STATES } from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import { z } from 'zod';

import type { AuditService } from '../audit/audit.service';
import type { CommandsService } from '../commands/commands.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';
import type { InstallationsService } from '../installations/installations.service';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { ReleasesService } from '../releases/releases.service';
import { AUDIT_SERVICE, COMMANDS_SERVICE, INSTALLATIONS_SERVICE, RELEASES_SERVICE } from '../tokens';

const stageReportSchema = z
  .object({
    job_id: z.string().min(1).max(64),
    state: deploymentStateSchema,
    failure_code: z.string().max(64).optional(),
    /** Short and structured — never a log dump (§7, §22). */
    detail: z.string().max(500).default(''),
  })
  .strict();

/**
 * Rollouts (§10, §11).
 *
 * Two rules shape everything here, and both are about stopping rather than
 * going:
 *
 * **A migration failure halts the job.** Not "marks this target failed and
 * carries on" — halts. §11 says a failed migration must stop further rollout,
 * and the reason is that the second installation to run a broken migration
 * teaches you nothing the first did not, at the cost of a second broken shop.
 * Once halted, no queued target is dispatched until an operator clears it
 * deliberately, having looked.
 *
 * **The order of pre-flight checks is not arbitrary.** Identity, then version
 * compatibility, then a valid backup. Checking the backup first would mean
 * taking backups on machines that were never eligible; checking compatibility
 * last would mean discovering the mismatch after the shop is in maintenance.
 * The cheap, refusable checks come before anything that touches the machine.
 *
 * The control plane does not perform an update. It queues a signed command; the
 * sidecar does the work and reports each stage. Everything below is bookkeeping
 * about that conversation — which is why a control-plane outage mid-rollout
 * leaves a shop with a finished update and a stale row, rather than a broken
 * installation.
 */
@Injectable()
export class DeploymentsService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(RELEASES_SERVICE) private readonly releases: ReleasesService,
    @Inject(INSTALLATIONS_SERVICE) private readonly installations: InstallationsService,
    @Inject(COMMANDS_SERVICE) private readonly commands: CommandsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  /**
   * Creates a job and dispatches to the first wave.
   *
   * `strategy` records the operator's intent — one, selected, staged or all —
   * so the audit trail says what was meant, not merely what happened. A staged
   * rollout dispatches its pilot targets and leaves the rest QUEUED; the
   * operator advances it once the pilot is healthy, which is §10's
   * `internal → pilot → wider → all` made explicit rather than assumed.
   */
  async createJob(
    input: {
      releaseId: string;
      installationIds: readonly string[];
      strategy: 'SINGLE' | 'SELECTED' | 'STAGED' | 'ALL_ELIGIBLE';
      pilotCount: number;
      reason: string;
    },
    operator: OperatorPrincipal,
  ): Promise<{ jobId: string; targets: { installationId: string; eligible: boolean; reason: string }[] }> {
    const release = await this.releases.get(input.releaseId);

    const candidates =
      input.strategy === 'ALL_ELIGIBLE'
        ? (await this.installations.list()).map((row) => row.id)
        : input.installationIds;
    if (candidates.length === 0) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Choose at least one installation');
    }

    const assessed: { installationId: string; eligible: boolean; reason: string }[] = [];
    for (const installationId of candidates) {
      const installation = await this.installations.get(installationId);
      if (installation.revokedAt !== null) {
        assessed.push({ installationId, eligible: false, reason: 'Installation is revoked' });
        continue;
      }
      const check = this.releases.eligibility(release, installation.appVersion);
      assessed.push({ installationId, eligible: check.ok, reason: check.reason });
    }
    const eligible = assessed.filter((row) => row.eligible);
    if (eligible.length === 0) {
      throw new ControlError(
        ControlErrorCode.PRECONDITION_FAILED,
        'No chosen installation is eligible for that release',
      );
    }

    const jobId = Ulid.generate(this.clock);
    await this.pool.query(
      `INSERT INTO deployment_jobs (id, release_id, strategy, reason, state, created_by)
       VALUES ($1,$2,$3,$4,'QUEUED',$5)`,
      [jobId, input.releaseId, input.strategy, input.reason, operator.id],
    );
    for (const target of eligible) {
      await this.pool.query(
        `INSERT INTO deployment_targets (id, job_id, installation_id, state)
         VALUES ($1,$2,$3,'QUEUED')`,
        [Ulid.generate(this.clock), jobId, target.installationId],
      );
    }

    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'deployment.run',
      reason: input.reason,
      subject: `${release.version} → ${String(eligible.length)} installation(s)`,
      after: { jobId, releaseId: input.releaseId, strategy: input.strategy },
      ip: operator.ip,
      userAgent: operator.userAgent,
    });

    const wave =
      input.strategy === 'STAGED'
        ? eligible.slice(0, Math.max(1, input.pilotCount))
        : eligible;
    for (const target of wave) await this.dispatch(jobId, target.installationId, operator.id);

    return { jobId, targets: assessed };
  }

  /** Sends the next wave of a staged rollout. Refuses while the job is halted. */
  async advance(jobId: string, count: number, operator: OperatorPrincipal): Promise<number> {
    const job = await this.job(jobId);
    if (job.haltedAt !== null) {
      throw new ControlError(
        ControlErrorCode.DEPLOYMENT_HALTED,
        `This rollout is halted: ${job.haltReason}. Clear it before continuing.`,
      );
    }
    const queued = await this.pool.query<{ installation_id: string }>(
      `SELECT installation_id FROM deployment_targets
        WHERE job_id=$1 AND state='QUEUED' ORDER BY id LIMIT $2`,
      [jobId, Math.max(1, count)],
    );
    for (const row of queued.rows) await this.dispatch(jobId, row.installation_id, operator.id);
    return queued.rows.length;
  }

  /**
   * Clears a halt, deliberately and with a reason.
   *
   * Deliberately not automatic and deliberately audited: the halt exists
   * because something went wrong on a real customer's machine, and the only
   * safe way past it is a person saying they have looked.
   */
  async clearHalt(jobId: string, reason: string, operator: OperatorPrincipal): Promise<void> {
    await this.pool.query('UPDATE deployment_jobs SET halted_at=NULL, halt_reason=$2 WHERE id=$1', [
      jobId,
      `cleared: ${reason}`,
    ]);
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'deployment.halt_cleared',
      reason,
      subject: jobId,
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
  }

  /** A stage transition from a sidecar mid-update (§10). */
  async recordStage(installationId: string, body: unknown): Promise<void> {
    const parsed = stageReportSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'That stage report is not valid');
    }
    const report = parsed.data;
    const target = await this.pool.query<{ id: string; stages: unknown[]; state: DeploymentState }>(
      'SELECT id, stages, state FROM deployment_targets WHERE job_id=$1 AND installation_id=$2',
      [report.job_id, installationId],
    );
    const row = target.rows[0];
    if (row === undefined) return;
    // A target that has already finished does not move again: a duplicated or
    // late report must not turn a success into a failure (§18).
    if (TERMINAL_DEPLOYMENT_STATES.includes(row.state)) return;

    const stages = [...row.stages, { at: this.clock.now().toISOString(), state: report.state, detail: report.detail }];
    await this.pool.query(
      `UPDATE deployment_targets
          SET state=$2, stages=$3, failure_code=$4, detail=$5,
              started_at=COALESCE(started_at, now()),
              finished_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED','ROLLED_BACK') THEN now() ELSE finished_at END
        WHERE id=$1`,
      [row.id, report.state, JSON.stringify(stages), report.failure_code ?? null, report.detail],
    );

    if (report.state === 'FAILED' || report.state === 'ROLLED_BACK') {
      await this.haltJob(report.job_id, installationId, report.failure_code ?? 'DEPLOY_FAILED');
    }
    if (report.state === 'MIGRATING') {
      await this.pool.query(`UPDATE installations SET state='UPDATE_RUNNING' WHERE id=$1`, [installationId]);
    }
    if (report.state === 'SUCCEEDED') {
      await this.pool.query(`UPDATE installations SET state='ONLINE', migration_state='' WHERE id=$1`, [
        installationId,
      ]);
      await this.finishIfDone(report.job_id);
    }
  }

  /**
   * A command result that happens to be an install.
   *
   * The sidecar reports stages as it goes and a final command result at the
   * end; this catches the case where the command failed before any stage was
   * reported at all — a rejected signature, an expired envelope, a machine that
   * refused the release. Without it, such a target would sit at QUEUED forever.
   */
  async onCommandResult(installationId: string, result: CommandResult): Promise<void> {
    if (result.status === 'SUCCEEDED') return;
    const jobId = typeof result.result['job_id'] === 'string' ? result.result['job_id'] : null;
    if (jobId === null) return;
    await this.pool.query(
      `UPDATE deployment_targets
          SET state='FAILED', failure_code=$3, finished_at=now()
        WHERE job_id=$1 AND installation_id=$2 AND state NOT IN ('SUCCEEDED','FAILED','ROLLED_BACK')`,
      [jobId, installationId, result.failure_code ?? result.rejection ?? 'COMMAND_FAILED'],
    );
    await this.haltJob(jobId, installationId, result.failure_code ?? 'COMMAND_FAILED');
  }

  async job(jobId: string): Promise<DeploymentJobRow> {
    const result = await this.pool.query<DeploymentJobRow>(
      `SELECT j.id, j.release_id AS "releaseId", r.version, j.strategy, j.reason, j.state,
              j.halted_at AS "haltedAt", j.halt_reason AS "haltReason",
              j.created_at AS "createdAt", j.finished_at AS "finishedAt"
         FROM deployment_jobs j JOIN releases r ON r.id = j.release_id
        WHERE j.id=$1`,
      [jobId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlError(ControlErrorCode.NOT_FOUND, 'No such rollout');
    return row;
  }

  async listJobs(): Promise<DeploymentJobRow[]> {
    const result = await this.pool.query<DeploymentJobRow>(
      `SELECT j.id, j.release_id AS "releaseId", r.version, j.strategy, j.reason, j.state,
              j.halted_at AS "haltedAt", j.halt_reason AS "haltReason",
              j.created_at AS "createdAt", j.finished_at AS "finishedAt"
         FROM deployment_jobs j JOIN releases r ON r.id = j.release_id
        ORDER BY j.created_at DESC LIMIT 100`,
    );
    return result.rows;
  }

  async targetsOf(jobId: string): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT d.installation_id AS "installationId", i.label, t.name AS "tenantName",
              d.state, d.failure_code AS "failureCode", d.detail, d.stages,
              d.started_at AS "startedAt", d.finished_at AS "finishedAt"
         FROM deployment_targets d
         JOIN installations i ON i.id = d.installation_id
         JOIN tenants t ON t.id = i.tenant_id
        WHERE d.job_id=$1 ORDER BY t.name`,
      [jobId],
    );
    return result.rows;
  }

  private async dispatch(jobId: string, installationId: string, operatorId: string): Promise<void> {
    const job = await this.job(jobId);
    if (job.haltedAt !== null) return;
    const installation = await this.installations.get(installationId);
    const manifest = await this.releases.manifestFor(job.releaseId);

    const { commandId } = await this.commands.enqueue({
      tenantId: installation.tenantId,
      installationId,
      type: 'INSTALL_RELEASE',
      payload: {
        job_id: jobId,
        release_id: job.releaseId,
        manifest: manifest.manifest,
        manifest_signature: manifest.signature,
        artifact_url: manifest.url,
      },
      // One install of one release on one machine, however many times the
      // operator clicks (§18).
      idempotencyKey: `deploy:${jobId}:${installationId}`,
      createdBy: operatorId,
    });
    await this.pool.query(
      `UPDATE deployment_targets SET state='QUEUED', command_id=$3, started_at=now()
        WHERE job_id=$1 AND installation_id=$2`,
      [jobId, installationId, commandId],
    );
    await this.pool.query(`UPDATE deployment_jobs SET state='QUEUED' WHERE id=$1 AND state='QUEUED'`, [jobId]);
  }

  private async haltJob(jobId: string, installationId: string, failureCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE deployment_jobs
          SET halted_at=now(), state='FAILED',
              halt_reason=$2
        WHERE id=$1 AND halted_at IS NULL`,
      [jobId, `${failureCode} on ${installationId}`],
    );
    await this.audit.append({
      operatorId: null,
      operatorName: 'control-plane',
      action: 'deployment.halted',
      installationId,
      subject: jobId,
      after: { failureCode },
    });
  }

  private async finishIfDone(jobId: string): Promise<void> {
    const remaining = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM deployment_targets
        WHERE job_id=$1 AND state NOT IN ('SUCCEEDED','FAILED','ROLLED_BACK')`,
      [jobId],
    );
    if (Number(remaining.rows[0]?.count ?? '1') === 0) {
      await this.pool.query(
        `UPDATE deployment_jobs SET state='SUCCEEDED', finished_at=now()
          WHERE id=$1 AND halted_at IS NULL`,
        [jobId],
      );
    }
  }
}

export interface DeploymentJobRow {
  readonly id: string;
  readonly releaseId: string;
  readonly version: string;
  readonly strategy: string;
  readonly reason: string;
  readonly state: string;
  readonly haltedAt: Date | null;
  readonly haltReason: string;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}
