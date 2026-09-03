import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { CheckInRequest, EnrolmentRequest, HealthState, InstallationState } from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import { addSeconds, Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import type { ControlPlaneConfig } from '../config';
import { CONTROL_CLOCK, CONTROL_CONFIG, CONTROL_POOL } from '../db/tokens';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { SignerClient } from '../signer/signer-client';
import { AUDIT_SERVICE, SIGNER_CLIENT } from '../tokens';

export interface InstallationRow {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly label: string;
  readonly erpTenantId: string;
  readonly businessId: string;
  readonly deploymentUrl: string;
  readonly localUrl: string;
  readonly state: InstallationState;
  readonly agentVersion: string;
  readonly appVersion: string;
  readonly releaseId: string;
  readonly schemaVersion: string;
  readonly runtime: string;
  readonly licenceFingerprint: string;
  readonly licenceState: string;
  readonly licenceValidUntil: string;
  readonly lastSeenAt: Date | null;
  readonly lastBackupAt: string;
  readonly lastBackupOk: boolean;
  readonly diskUsedPercent: number;
  readonly syncPending: number;
  readonly syncConflictsOpen: number;
  readonly migrationState: string;
  readonly health: HealthState;
  readonly revokedAt: Date | null;
}

/**
 * How long an enrolment token is good for.
 *
 * Seventy-two hours: long enough to post a machine to a shop and have somebody
 * type it in on Monday, short enough that a token left in a chat thread has
 * stopped meaning anything by the time anybody scrolls back to it.
 */
const ENROLMENT_TOKEN_SECONDS = 72 * 60 * 60;

/**
 * The fleet: who is enrolled, what they are running, and whether they are up.
 *
 * **Enrolment is the whole of trust establishment** (§3). The dashboard creates
 * a row and mints a single-use token; the shop's agent generates its own
 * keypair locally and presents the token with its public half; the control
 * plane binds the key and burns the token. The vendor never possesses a
 * customer's private key, at any moment, which is why no backup, log or laptop
 * of theirs can be used to impersonate an installation.
 *
 * **Online/offline is inferred, never reported.** A machine that can tell you
 * it is offline is not offline. `stateOf` derives it from the last check-in
 * against a configured window, which is also what makes a shop on a bad line
 * look like a shop on a bad line rather than an incident.
 */
@Injectable()
export class InstallationsService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(CONTROL_CONFIG) private readonly config: ControlPlaneConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SIGNER_CLIENT) private readonly signer: SignerClient,
  ) {}

  async list(tenantId?: string): Promise<InstallationRow[]> {
    const result = await this.pool.query<InstallationRow>(
      `${SELECT_INSTALLATION}
        ${tenantId === undefined ? '' : 'WHERE i.tenant_id = $1'}
        ORDER BY t.name, i.label`,
      tenantId === undefined ? [] : [tenantId],
    );
    return result.rows.map((row) => this.withDerivedState(row));
  }

  async get(id: string): Promise<InstallationRow> {
    const result = await this.pool.query<InstallationRow>(`${SELECT_INSTALLATION} WHERE i.id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) throw new ControlError(ControlErrorCode.NOT_FOUND, 'No such installation');
    return this.withDerivedState(row);
  }

  /** Creates the record. It has no identity until an agent enrols against it. */
  async create(
    input: { tenantId: string; label: string; deploymentUrl: string },
    operator: OperatorPrincipal,
  ): Promise<InstallationRow> {
    const id = Ulid.generate(this.clock);
    await this.pool.query(
      `INSERT INTO installations (id, tenant_id, label, deployment_url, state)
       VALUES ($1,$2,$3,$4,'PENDING_ENROLMENT')`,
      [id, input.tenantId, input.label, input.deploymentUrl],
    );
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'installation.create',
      tenantId: input.tenantId,
      installationId: id,
      subject: input.label,
      after: input,
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
    return this.get(id);
  }

  /**
   * Mints the one-time token the shop's agent will present.
   *
   * Only the hash is stored. If this table leaked, the hashes would not let
   * anybody enrol — the same reasoning that keeps a password out of a database,
   * applied to the one credential in this system that a human copies by hand.
   */
  async issueEnrolmentToken(
    installationId: string,
    operator: OperatorPrincipal,
  ): Promise<{ token: string; expiresAt: Date }> {
    const installation = await this.get(installationId);
    if (installation.revokedAt !== null) {
      throw new ControlError(ControlErrorCode.INSTALLATION_REVOKED, 'That installation is revoked');
    }
    const token = randomBytes(24).toString('base64url');
    const expiresAt = addSeconds(this.clock.now(), ENROLMENT_TOKEN_SECONDS);
    await this.pool.query(
      `INSERT INTO enrolment_tokens (token_hash, tenant_id, installation_id, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [hashToken(token), installation.tenantId, installationId, operator.id, expiresAt],
    );
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'installation.enrolment_token.issue',
      tenantId: installation.tenantId,
      installationId,
      subject: installation.label,
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
    return { token, expiresAt };
  }

  /**
   * The agent's first and only unauthenticated call.
   *
   * Unauthenticated in the sense that no key is trusted yet — but not open: it
   * requires a token the vendor minted for one installation, unused, unexpired.
   * Everything after this point in the installation's life is signed.
   *
   * The whole thing is one transaction. A token burned without a key stored
   * would leave a shop unable to enrol and the vendor unable to tell why.
   */
  async enrol(
    request: EnrolmentRequest,
    ip: string,
  ): Promise<{
    tenantId: string;
    installationId: string;
    commandPublicKey: string;
    commandSigningKeyId: string;
    checkinIntervalSeconds: number;
  }> {
    const keys = await this.signer.publicKeys();
    const commandKey = keys['command'];
    if (commandKey === null || commandKey === undefined) {
      throw new ControlError(
        ControlErrorCode.SIGNER_UNAVAILABLE,
        'No command signing key is available; enrolment cannot complete',
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tokenRow = await client.query<{ installation_id: string; tenant_id: string }>(
        `SELECT installation_id, tenant_id FROM enrolment_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [hashToken(request.token)],
      );
      const found = tokenRow.rows[0];
      if (found === undefined) {
        await client.query('ROLLBACK');
        throw new ControlError(
          ControlErrorCode.ENROLMENT_TOKEN_INVALID,
          'That enrolment token is not valid, has expired, or has already been used',
        );
      }

      const installation = await client.query<{ revoked_at: Date | null; erp_tenant_id: string }>(
        'SELECT revoked_at, erp_tenant_id FROM installations WHERE id = $1 FOR UPDATE',
        [found.installation_id],
      );
      const current = installation.rows[0];
      if (current === undefined || current.revoked_at !== null) {
        await client.query('ROLLBACK');
        throw new ControlError(ControlErrorCode.INSTALLATION_REVOKED, 'That installation is revoked');
      }

      /*
       * Re-enrolment onto a *different* ERP tenant is refused. An installation
       * record names one shop; a second shop arriving on the same record is
       * either a restored backup pointed at the wrong machine or an attempt to
       * inherit somebody else's licence, and neither should be resolved
       * silently by whichever agent called last.
       */
      if (current.erp_tenant_id !== '' && current.erp_tenant_id !== request.erp_tenant_id) {
        await client.query('ROLLBACK');
        throw new ControlError(
          ControlErrorCode.CONFLICT,
          'This installation record is already bound to a different business',
        );
      }

      await client.query('UPDATE enrolment_tokens SET used_at = now(), used_from_ip = $2 WHERE token_hash = $1', [
        hashToken(request.token),
        ip,
      ]);

      // Any previous key is retired rather than deleted: the history is how a
      // rotation or a compromise is reconstructed afterwards.
      await client.query(
        `UPDATE installation_keys SET retired_at = now(), retire_reason = 're-enrolled'
          WHERE installation_id = $1 AND retired_at IS NULL`,
        [found.installation_id],
      );
      await client.query(
        `INSERT INTO installation_keys (id, installation_id, key_id, public_key)
         VALUES ($1,$2,$3,$4)`,
        [Ulid.generate(this.clock), found.installation_id, `inst-${String(Date.parse(this.clock.now().toISOString()))}`, request.public_key],
      );
      await client.query(
        `UPDATE installations
            SET erp_tenant_id = $2, business_id = $2, agent_version = $3, app_version = $4,
                schema_version = $5, local_url = $6, state = 'ONLINE', last_seen_at = now()
          WHERE id = $1`,
        [
          found.installation_id,
          request.erp_tenant_id,
          request.agent_version,
          request.app_version,
          request.schema_version,
          request.local_url,
        ],
      );
      await this.audit.append(
        {
          operatorId: null,
          operatorName: 'agent',
          action: 'installation.enrolled',
          tenantId: found.tenant_id,
          installationId: found.installation_id,
          subject: request.business_name,
          after: { erpTenantId: request.erp_tenant_id, appVersion: request.app_version },
          ip,
        },
        client,
      );
      await client.query('COMMIT');

      return {
        tenantId: found.tenant_id,
        installationId: found.installation_id,
        commandPublicKey: commandKey.publicKeyBase64,
        commandSigningKeyId: commandKey.keyId,
        checkinIntervalSeconds: 180,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Writes what the heartbeat reported. Overwrites the summary, keeps the history. */
  async recordCheckIn(installationId: string, report: CheckInRequest): Promise<void> {
    await this.pool.query(
      `UPDATE installations
          SET agent_version=$2, app_version=$3, release_id=$4, schema_version=$5, runtime=$6,
              licence_fingerprint=$7, licence_state=$8, licence_valid_until=$9,
              last_backup_at=$10, last_backup_ok=$11, disk_used_percent=$12,
              sync_pending=$13, sync_conflicts_open=$14, migration_state=$15,
              health=$16, uptime_seconds=$17, last_seen_at=now(),
              state = CASE WHEN state = 'REVOKED' THEN 'REVOKED' ELSE $18 END
        WHERE id=$1`,
      [
        installationId,
        report.agent_version,
        report.app_version,
        report.release_id,
        report.schema_version,
        report.runtime,
        report.licence_fingerprint,
        report.licence_state,
        report.licence_valid_until,
        report.last_backup_at,
        report.last_backup_ok,
        report.disk_used_percent,
        report.sync_pending,
        report.sync_conflicts_open,
        report.migration_state,
        report.health,
        report.uptime_seconds,
        reportedState(report),
      ],
    );
    await this.pool.query('INSERT INTO checkins (installation_id, payload) VALUES ($1,$2)', [
      installationId,
      JSON.stringify(report),
    ]);
  }

  /**
   * Revocation (§24, §18).
   *
   * It stops the vendor's channel: no further command is accepted, and the next
   * check-in is answered with `revoked`. It does **not** stop the shop trading —
   * §20 is absolute, and the installed licence remains locally valid until its
   * own expiry. A control plane that could switch off a paid-up shop would be
   * exactly the mandatory-internet dependency the owner ruled out.
   */
  async revoke(installationId: string, reason: string, operator: OperatorPrincipal): Promise<void> {
    const before = await this.get(installationId);
    await this.pool.query(
      `UPDATE installations SET state='REVOKED', revoked_at=now(), revoke_reason=$2 WHERE id=$1`,
      [installationId, reason],
    );
    await this.pool.query(
      `UPDATE installation_keys SET retired_at=now(), retire_reason='installation revoked'
        WHERE installation_id=$1 AND retired_at IS NULL`,
      [installationId],
    );
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'installation.revoke',
      tenantId: before.tenantId,
      installationId,
      reason,
      subject: before.label,
      before: { state: before.state },
      after: { state: 'REVOKED' },
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
  }

  /**
   * Whether the vendor has revoked this installation.
   *
   * Read on every check-in rather than cached: revocation has to bite at the
   * next contact, not at the next restart of the control plane.
   */
  async isRevoked(installationId: string): Promise<boolean> {
    const result = await this.pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM installations WHERE id = $1',
      [installationId],
    );
    return result.rows[0]?.revoked_at !== null && result.rows[0]?.revoked_at !== undefined;
  }

  /** How long this machine should wait before its next check-in. */
  async checkInIntervalOf(installationId: string): Promise<number> {
    const result = await this.pool.query<{ checkin_interval_seconds: number }>(
      'SELECT checkin_interval_seconds FROM installations WHERE id = $1',
      [installationId],
    );
    return result.rows[0]?.checkin_interval_seconds ?? 180;
  }

  /** The active public key, or null when the installation has never enrolled. */
  async activeKey(installationId: string): Promise<string | null> {
    const result = await this.pool.query<{ public_key: string }>(
      `SELECT public_key FROM installation_keys
        WHERE installation_id=$1 AND retired_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [installationId],
    );
    return result.rows[0]?.public_key ?? null;
  }

  /**
   * Online or not, decided here rather than trusted from the wire.
   *
   * A stored `state` of ONLINE means "the last thing it told us was fine"; it
   * says nothing about now. Anything past the configured window is OFFLINE
   * whatever the column says, and the stored value only survives when it
   * carries information a heartbeat cannot — REVOKED, MIGRATION_FAILED,
   * UPDATE_RUNNING.
   */
  private withDerivedState(row: InstallationRow): InstallationRow {
    if (row.state === 'REVOKED' || row.state === 'PENDING_ENROLMENT') return row;
    if (row.lastSeenAt === null) return { ...row, state: 'OFFLINE' };
    const ageMinutes = (this.clock.now().getTime() - row.lastSeenAt.getTime()) / 60000;
    if (ageMinutes > this.config.offlineAfterMinutes) return { ...row, state: 'OFFLINE' };
    if (row.state === 'MIGRATION_FAILED' || row.state === 'UPDATE_RUNNING') return row;
    return row;
  }
}

/**
 * The state a heartbeat implies about a healthy machine.
 *
 * Only ever ONLINE or DEGRADED — a check-in cannot claim to be mid-update or
 * to have failed a migration, because those are facts the deployment pipeline
 * owns and a compromised agent should not be able to assert.
 */
function reportedState(report: CheckInRequest): InstallationState {
  return report.health === 'CRITICAL' || report.health === 'WARNING' ? 'DEGRADED' : 'ONLINE';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const SELECT_INSTALLATION = `
  SELECT i.id, i.tenant_id AS "tenantId", t.name AS "tenantName", i.label,
         i.erp_tenant_id AS "erpTenantId", i.business_id AS "businessId",
         i.deployment_url AS "deploymentUrl", i.local_url AS "localUrl", i.state,
         i.agent_version AS "agentVersion", i.app_version AS "appVersion",
         i.release_id AS "releaseId", i.schema_version AS "schemaVersion", i.runtime,
         i.licence_fingerprint AS "licenceFingerprint", i.licence_state AS "licenceState",
         i.licence_valid_until AS "licenceValidUntil", i.last_seen_at AS "lastSeenAt",
         i.last_backup_at AS "lastBackupAt", i.last_backup_ok AS "lastBackupOk",
         i.disk_used_percent AS "diskUsedPercent", i.sync_pending AS "syncPending",
         i.sync_conflicts_open AS "syncConflictsOpen", i.migration_state AS "migrationState",
         i.health, i.revoked_at AS "revokedAt"
    FROM installations i
    JOIN tenants t ON t.id = i.tenant_id
`;
