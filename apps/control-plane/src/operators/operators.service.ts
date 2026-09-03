import { Inject, Injectable } from '@nestjs/common';
import type { OperatorRole } from '@sher/control-contracts';
import { operatorRoleSchema } from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import { addSeconds, Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import type { ControlPlaneConfig } from '../config';
import { open, seal } from '../crypto/secret-box';
import { OPERATOR_SESSION_SECONDS, signOperatorToken } from '../crypto/jwt';
import { hashPassword, verifyPassword } from '../crypto/scrypt';
import { generateTotpSecret, totpUri, verifyTotp } from '../crypto/totp';
import { CONTROL_CLOCK, CONTROL_CONFIG, CONTROL_POOL } from '../db/tokens';
import { AUDIT_SERVICE } from '../tokens';

export interface OperatorRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: OperatorRole;
  readonly totpEnrolled: boolean;
  readonly disabledAt: Date | null;
}

/**
 * Vendor operators — a table of the vendor's own people, and never a shop's
 * users (§23).
 *
 * The two are kept apart deliberately and completely. A shop's user database
 * lives in the shop's installation; an operator here has no row there and never
 * will, which is what makes "the vendor was in this shop" a statement about a
 * *support session* rather than about an account somebody might forget to
 * delete.
 *
 * **TOTP is mandatory and the enforcement is structural.** An operator created
 * without it exists in a state where `totp_enrolled` is false, and the guard
 * refuses every route but the enrolment pair. There is no configuration flag
 * that turns it off, because a console that can deploy to every shop in the
 * fleet and open any of their books is not somewhere to have one.
 */
@Injectable()
export class OperatorsService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CONFIG) private readonly config: ControlPlaneConfig,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async create(input: {
    email: string;
    name: string;
    password: string;
    role: string;
    actor: { id: string; name: string } | null;
  }): Promise<{ id: string; totpSecret: string; totpUri: string }> {
    const role = operatorRoleSchema.safeParse(input.role);
    if (!role.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Unknown operator role');
    }
    const id = Ulid.generate(this.clock);
    const secret = generateTotpSecret();
    try {
      await this.pool.query(
        `INSERT INTO operators (id, email, name, password_hash, totp_secret_sealed, totp_enrolled, role)
         VALUES ($1,$2,$3,$4,$5,FALSE,$6)`,
        [
          id,
          input.email.trim().toLowerCase(),
          input.name.trim(),
          await hashPassword(input.password),
          seal(secret, this.config.secretKey),
          role.data,
        ],
      );
    } catch {
      throw new ControlError(ControlErrorCode.CONFLICT, 'That email already has an operator');
    }
    await this.audit.append({
      operatorId: input.actor?.id ?? null,
      operatorName: input.actor?.name ?? 'bootstrap',
      action: 'operator.create',
      subject: input.email,
      after: { role: role.data },
    });
    // The secret is returned exactly once, at creation, so it can be scanned.
    // It is never readable again through any route.
    return { id, totpSecret: secret, totpUri: totpUri(secret, input.email) };
  }

  /**
   * Password, then TOTP, then a session row.
   *
   * The password check runs even when the email is unknown — against a hash
   * that cannot match — so a wrong address and a wrong password take the same
   * time. Without that, this endpoint is a way to enumerate the vendor's staff.
   */
  async login(input: {
    email: string;
    password: string;
    code: string;
    ip: string;
    userAgent: string;
  }): Promise<{ token: string; operator: OperatorRow; enrolmentRequired: boolean; totpUri?: string }> {
    const found = await this.pool.query<{
      id: string;
      email: string;
      name: string;
      role: OperatorRole;
      password_hash: string;
      totp_secret_sealed: string;
      totp_enrolled: boolean;
      disabled_at: Date | null;
    }>(
      `SELECT id, email, name, role, password_hash, totp_secret_sealed, totp_enrolled, disabled_at
         FROM operators WHERE email = $1`,
      [input.email.trim().toLowerCase()],
    );
    const row = found.rows[0];
    const passwordOk = await verifyPassword(
      input.password,
      row?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    if (row === undefined || !passwordOk || row.disabled_at !== null) {
      throw new ControlError(ControlErrorCode.UNAUTHENTICATED, 'Those details are not right');
    }

    const secret = open(row.totp_secret_sealed, this.config.secretKey);
    if (secret === null) {
      throw new ControlError(ControlErrorCode.INTERNAL_ERROR, 'Second factor unavailable');
    }

    /*
     * An operator who has not finished enrolling gets a session, but the guard
     * will let it reach nothing except the enrolment routes. Handing back a
     * token here rather than a special-case flow keeps one login path.
     */
    if (!row.totp_enrolled) {
      const token = await this.startSession(row.id, input.ip, input.userAgent, false);
      return {
        token,
        operator: toOperator(row),
        enrolmentRequired: true,
        totpUri: totpUri(secret, row.email),
      };
    }

    if (!verifyTotp(secret, input.code, this.clock.now())) {
      await this.audit.append({
        operatorId: row.id,
        operatorName: row.name,
        action: 'operator.login.totp_failed',
        ip: input.ip,
        userAgent: input.userAgent,
      });
      throw new ControlError(ControlErrorCode.UNAUTHENTICATED, 'Those details are not right');
    }

    const token = await this.startSession(row.id, input.ip, input.userAgent, true);
    await this.audit.append({
      operatorId: row.id,
      operatorName: row.name,
      action: 'operator.login',
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return { token, operator: toOperator(row), enrolmentRequired: false };
  }

  /** Confirms the operator's authenticator really holds the secret. */
  async completeEnrolment(operatorId: string, code: string): Promise<void> {
    const found = await this.pool.query<{ totp_secret_sealed: string; name: string }>(
      'SELECT totp_secret_sealed, name FROM operators WHERE id = $1',
      [operatorId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new ControlError(ControlErrorCode.NOT_FOUND, 'No such operator');
    const secret = open(row.totp_secret_sealed, this.config.secretKey);
    if (secret === null || !verifyTotp(secret, code, this.clock.now())) {
      throw new ControlError(ControlErrorCode.UNAUTHENTICATED, 'That code is not right');
    }
    await this.pool.query('UPDATE operators SET totp_enrolled = TRUE WHERE id = $1', [operatorId]);
    await this.audit.append({
      operatorId,
      operatorName: row.name,
      action: 'operator.totp.enrolled',
    });
  }

  /**
   * A fresh TOTP code, for the actions §24 marks sensitive.
   *
   * Stamps `reauth_at` on the session; the guard requires it to be recent
   * before any of `REAUTH_ACTIONS` proceeds. Being logged in is not the same as
   * being present, and a stolen session token should not be enough to revoke a
   * licence or walk into a customer's ERP.
   */
  async reauthenticate(operatorId: string, sessionId: string, code: string): Promise<void> {
    const found = await this.pool.query<{ totp_secret_sealed: string }>(
      'SELECT totp_secret_sealed FROM operators WHERE id = $1',
      [operatorId],
    );
    const row = found.rows[0];
    const secret = row === undefined ? null : open(row.totp_secret_sealed, this.config.secretKey);
    if (secret === null || !verifyTotp(secret, code, this.clock.now())) {
      throw new ControlError(ControlErrorCode.UNAUTHENTICATED, 'That code is not right');
    }
    await this.pool.query('UPDATE operator_sessions SET reauth_at = now() WHERE id = $1', [sessionId]);
  }

  async logout(sessionId: string): Promise<void> {
    await this.pool.query(
      'UPDATE operator_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
  }

  async list(): Promise<OperatorRow[]> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      name: string;
      role: OperatorRole;
      totp_enrolled: boolean;
      disabled_at: Date | null;
    }>('SELECT id, email, name, role, totp_enrolled, disabled_at FROM operators ORDER BY created_at'); 
    return result.rows.map(toOperator);
  }

  private async startSession(
    operatorId: string,
    ip: string,
    userAgent: string,
    reauthed: boolean,
  ): Promise<string> {
    const sessionId = Ulid.generate(this.clock);
    const expiresAt = addSeconds(this.clock.now(), OPERATOR_SESSION_SECONDS);
    await this.pool.query(
      `INSERT INTO operator_sessions (id, operator_id, expires_at, reauth_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sessionId, operatorId, expiresAt, reauthed ? this.clock.now() : null, ip, userAgent],
    );
    return signOperatorToken(
      { sub: operatorId, sid: sessionId, exp: Math.floor(expiresAt.getTime() / 1000) },
      this.config.jwtSecret,
    );
  }
}

function toOperator(row: {
  id: string;
  email: string;
  name: string;
  role: OperatorRole;
  totp_enrolled: boolean;
  disabled_at: Date | null;
}): OperatorRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    totpEnrolled: row.totp_enrolled,
    disabledAt: row.disabled_at,
  };
}
