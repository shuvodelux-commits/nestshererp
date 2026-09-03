import { Inject, Injectable } from '@nestjs/common';
import type { SupportGrant, SupportSessionState } from '@sher/control-contracts';
import {
  SUPPORT_ABSOLUTE_SECONDS,
  SUPPORT_IDLE_SECONDS,
  supportGrantSchema,
} from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import { addSeconds, Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import type { CommandsService } from '../commands/commands.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';
import type { InstallationsService } from '../installations/installations.service';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { SignerClient } from '../signer/signer-client';
import { AUDIT_SERVICE, COMMANDS_SERVICE, INSTALLATIONS_SERVICE, SIGNER_CLIENT } from '../tokens';

export interface SupportSessionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly installationId: string;
  readonly installationLabel: string;
  readonly operatorId: string;
  readonly operatorName: string;
  readonly reason: string;
  readonly state: SupportSessionState;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly lastActivityAt: Date;
  readonly closedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Vendor Super-Support sessions (§12, §15, owner decision 2026-09-03).
 *
 * **Access is pre-authorized by the support arrangement**, so a Platform Owner
 * opens a session without asking the shop. That is a deliberate commercial
 * decision, and it moves the entire weight of containment onto three things:
 * the signature, the expiry, and revocation. All three are therefore checked by
 * the *installation*, on every request, against the signed grant — never by
 * this service, which is on the other side of a network the shop cannot rely on.
 *
 * The consequence is worth stating plainly: because nobody at the shop approves
 * a visit, the lifetimes have to be genuinely short and revocation genuinely
 * immediate. Thirty minutes of inactivity, four hours absolute, and a
 * revocation that both drops the tunnel and queues a signed terminate command.
 *
 * **The grant is not a password and cannot become one.** It names one session,
 * one operator, one tenant, one installation and one reason, and it stops being
 * true at a moment fixed when it was issued. There is no long-lived credential
 * anywhere in this file, and no code path that creates one.
 */
@Injectable()
export class SupportService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(SIGNER_CLIENT) private readonly signer: SignerClient,
    @Inject(COMMANDS_SERVICE) private readonly commands: CommandsService,
    @Inject(INSTALLATIONS_SERVICE) private readonly installations: InstallationsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async open(
    input: { installationId: string; reason: string },
    operator: OperatorPrincipal,
  ): Promise<{ session: SupportSessionRow; grant: SupportGrant; signature: string }> {
    const installation = await this.installations.get(input.installationId);
    if (installation.revokedAt !== null) {
      throw new ControlError(ControlErrorCode.INSTALLATION_REVOKED, 'That installation is revoked');
    }
    if (installation.erpTenantId === '') {
      throw new ControlError(
        ControlErrorCode.PRECONDITION_FAILED,
        'That installation has not enrolled yet',
      );
    }

    const now = this.clock.now();
    const sessionId = Ulid.generate(this.clock);
    const keys = await this.signer.publicKeys();
    const supportKey = keys['support'];
    if (supportKey === null || supportKey === undefined) {
      throw new ControlError(ControlErrorCode.SIGNER_UNAVAILABLE, 'No support signing key is available');
    }

    const grant: SupportGrant = supportGrantSchema.parse({
      session_id: sessionId,
      operator_id: operator.id,
      operator_name: operator.name,
      tenant_id: installation.tenantId,
      // What the shop's own database calls itself, learned at enrolment and
      // never guessed from a domain name (§2).
      erp_tenant_id: installation.erpTenantId,
      installation_id: input.installationId,
      issued_at: now.toISOString(),
      expires_at: addSeconds(now, SUPPORT_IDLE_SECONDS).toISOString(),
      absolute_expires_at: addSeconds(now, SUPPORT_ABSOLUTE_SECONDS).toISOString(),
      reason: input.reason,
      scope: 'SUPER_SUPPORT',
      signing_key_id: supportKey.keyId,
    });
    const { signature } = await this.signer.signSupportGrant(
      grant as unknown as Record<string, never>,
      `support session ${sessionId} by ${operator.email}`,
    );

    await this.pool.query(
      `INSERT INTO support_sessions
         (id, tenant_id, installation_id, operator_id, operator_name, reason, state,
          grant_payload, signature, expires_at, absolute_expires_at, ip)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9,$10,$11)`,
      [
        sessionId,
        installation.tenantId,
        input.installationId,
        operator.id,
        operator.name,
        input.reason,
        JSON.stringify(grant),
        signature,
        grant.expires_at,
        grant.absolute_expires_at,
        operator.ip,
      ],
    );

    /*
     * The sidecar is told to expect this session and to raise its tunnel. The
     * command carries the grant so the installation can verify it against the
     * pinned support key without asking anybody — which is what makes the
     * session work even if the control plane goes down a second later.
     */
    await this.commands.enqueue({
      tenantId: installation.tenantId,
      installationId: input.installationId,
      type: 'START_SUPPORT_SESSION',
      payload: { grant, signature },
      idempotencyKey: `support:${sessionId}`,
      createdBy: operator.id,
    });

    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'support.open',
      tenantId: installation.tenantId,
      installationId: input.installationId,
      reason: input.reason,
      subject: sessionId,
      after: { expiresAt: grant.expires_at, absoluteExpiresAt: grant.absolute_expires_at },
      ip: operator.ip,
      userAgent: operator.userAgent,
    });

    return { session: await this.get(sessionId), grant, signature };
  }

  /**
   * Extends the sliding window — never past the absolute ceiling.
   *
   * Returns a re-signed grant, because the installation checks `expires_at`
   * inside the signed bytes rather than asking the control plane whether the
   * session is still live. A renewal that only updated this database would
   * leave the shop refusing requests it should accept, which is the correct
   * failure mode but not a useful one.
   */
  async renew(sessionId: string): Promise<{ grant: SupportGrant; signature: string } | null> {
    const session = await this.get(sessionId);
    const now = this.clock.now();
    if (session.state !== 'ACTIVE') return null;
    if (session.absoluteExpiresAt.getTime() <= now.getTime()) {
      await this.expire(sessionId);
      return null;
    }
    if (now.getTime() - session.lastActivityAt.getTime() > SUPPORT_IDLE_SECONDS * 1000) {
      await this.expire(sessionId);
      return null;
    }

    /*
     * The slide, clamped by the ceiling.
     *
     * `Math.min` is the whole of the four-hour guarantee: however many times a
     * busy operator renews, the new expiry can never be later than the absolute
     * one fixed when the session opened (owner decision 2026-09-03).
     */
    const slid = addSeconds(now, SUPPORT_IDLE_SECONDS);
    const nextExpiry =
      slid.getTime() < session.absoluteExpiresAt.getTime() ? slid : session.absoluteExpiresAt;
    const stored = await this.pool.query<{ grant_payload: SupportGrant }>(
      'SELECT grant_payload FROM support_sessions WHERE id=$1',
      [sessionId],
    );
    const previous = stored.rows[0]?.grant_payload;
    if (previous === undefined) return null;

    const grant: SupportGrant = supportGrantSchema.parse({
      ...previous,
      expires_at: nextExpiry.toISOString(),
    });
    const { signature } = await this.signer.signSupportGrant(
      grant as unknown as Record<string, never>,
      `support renewal ${sessionId}`,
    );
    await this.pool.query(
      `UPDATE support_sessions SET grant_payload=$2, signature=$3, expires_at=$4, last_activity_at=now()
        WHERE id=$1`,
      [sessionId, JSON.stringify(grant), signature, nextExpiry],
    );
    return { grant, signature };
  }

  async touch(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE support_sessions SET last_activity_at=now() WHERE id=$1 AND state='ACTIVE'`,
      [sessionId],
    );
  }

  /** The active session, if it is genuinely still active right now. */
  async activeSession(sessionId: string): Promise<SupportSessionRow | null> {
    const session = await this.getOrNull(sessionId);
    if (session === null || session.state !== 'ACTIVE') return null;
    const now = this.clock.now();
    if (
      session.absoluteExpiresAt.getTime() <= now.getTime() ||
      now.getTime() - session.lastActivityAt.getTime() > SUPPORT_IDLE_SECONDS * 1000
    ) {
      await this.expire(sessionId);
      return null;
    }
    return session;
  }

  async close(sessionId: string, operator: OperatorPrincipal): Promise<void> {
    await this.end(sessionId, 'CLOSED', '', operator);
  }

  async revoke(sessionId: string, reason: string, operator: OperatorPrincipal): Promise<void> {
    await this.end(sessionId, 'REVOKED', reason, operator);
  }

  async listActive(): Promise<SupportSessionRow[]> {
    const result = await this.pool.query<SupportSessionRow>(`${SELECT_SESSION} WHERE s.state='ACTIVE'
      ORDER BY s.created_at DESC`);
    return result.rows;
  }

  async listFor(installationId: string): Promise<SupportSessionRow[]> {
    const result = await this.pool.query<SupportSessionRow>(
      `${SELECT_SESSION} WHERE s.installation_id=$1 ORDER BY s.created_at DESC LIMIT 100`,
      [installationId],
    );
    return result.rows;
  }

  async get(sessionId: string): Promise<SupportSessionRow> {
    const session = await this.getOrNull(sessionId);
    if (session === null) throw new ControlError(ControlErrorCode.NOT_FOUND, 'No such support session');
    return session;
  }

  /** Everything a session did, for §15's "pages accessed, actions executed". */
  async actionsOf(sessionId: string): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT at, method, path, http_status AS "httpStatus", document_ref AS "documentRef"
         FROM support_actions WHERE session_id=$1 ORDER BY at`,
      [sessionId],
    );
    return result.rows;
  }

  async recordAction(input: {
    sessionId: string;
    method: string;
    path: string;
    status: number;
    documentRef: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO support_actions (session_id, method, path, http_status, document_ref)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.sessionId, input.method, input.path, input.status, input.documentRef],
    );
  }

  private async getOrNull(sessionId: string): Promise<SupportSessionRow | null> {
    const result = await this.pool.query<SupportSessionRow>(`${SELECT_SESSION} WHERE s.id=$1`, [sessionId]);
    return result.rows[0] ?? null;
  }

  private async expire(sessionId: string): Promise<void> {
    await this.pool.query(`UPDATE support_sessions SET state='EXPIRED' WHERE id=$1 AND state='ACTIVE'`, [
      sessionId,
    ]);
  }

  private async end(
    sessionId: string,
    state: 'CLOSED' | 'REVOKED',
    reason: string,
    operator: OperatorPrincipal,
  ): Promise<void> {
    const session = await this.get(sessionId);
    await this.pool.query(
      `UPDATE support_sessions
          SET state=$2,
              closed_at=CASE WHEN $2='CLOSED' THEN now() ELSE closed_at END,
              revoked_at=CASE WHEN $2='REVOKED' THEN now() ELSE revoked_at END,
              revoke_reason=$3
        WHERE id=$1 AND state='ACTIVE'`,
      [sessionId, state, reason],
    );
    /*
     * Ending the session here is not enough on its own: the installation is
     * holding a signed grant that is still inside its own validity window. The
     * terminate command is what makes revocation immediate rather than
     * eventual — and the grant's short expiry is what makes it safe even if the
     * shop is offline and never receives the command.
     */
    await this.commands.enqueue({
      tenantId: session.tenantId,
      installationId: session.installationId,
      type: 'TERMINATE_SUPPORT_SESSION',
      payload: { session_id: sessionId },
      idempotencyKey: `support-end:${sessionId}`,
      createdBy: operator.id,
    });
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: state === 'CLOSED' ? 'support.close' : 'support.revoke',
      tenantId: session.tenantId,
      installationId: session.installationId,
      reason: reason === '' ? session.reason : reason,
      subject: sessionId,
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
  }
}

const SELECT_SESSION = `
  SELECT s.id, s.tenant_id AS "tenantId", t.name AS "tenantName",
         s.installation_id AS "installationId", i.label AS "installationLabel",
         s.operator_id AS "operatorId", s.operator_name AS "operatorName",
         s.reason, s.state, s.created_at AS "createdAt", s.expires_at AS "expiresAt",
         s.absolute_expires_at AS "absoluteExpiresAt", s.last_activity_at AS "lastActivityAt",
         s.closed_at AS "closedAt", s.revoked_at AS "revokedAt"
    FROM support_sessions s
    JOIN tenants t ON t.id = s.tenant_id
    JOIN installations i ON i.id = s.installation_id
`;
