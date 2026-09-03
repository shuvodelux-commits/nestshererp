import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@sher/shared-utils';
import { addSeconds, parseInstant, Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import type { CommandsService } from '../commands/commands.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';
import type { InstallationsService } from '../installations/installations.service';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { SignerClient } from '../signer/signer-client';
import {
  canonicalLicencePayload,
  LICENCE_SCHEMA_VERSION,
  LICENSABLE_MODULES,
} from './licence-payload';
import { AUDIT_SERVICE, COMMANDS_SERVICE, INSTALLATIONS_SERVICE, SIGNER_CLIENT } from '../tokens';

export interface LicenceRow {
  readonly id: string;
  readonly tenantId: string;
  readonly installationId: string | null;
  readonly licenceId: string;
  readonly businessId: string;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  readonly modules: string[];
  readonly replacementOf: string | null;
  readonly deliveryState: string;
  readonly deliveredAt: Date | null;
  readonly installedAt: Date | null;
  readonly failureCode: string | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string;
  readonly createdBy: string;
  readonly keyText: string;
}

/**
 * Licence lifecycle (§4), built on the signing model that already exists.
 *
 * **Nothing about verification changes.** The shop still holds a signed
 * `SHERLIC1` string, still verifies it locally against an embedded public key,
 * still judges expiry against its own monotonic clock mark, and still walks the
 * `ACTIVE → GRACE → READ_ONLY` ladder without asking anybody. §4 is explicit
 * that central availability must not be required for licence verification, and
 * the way to honour that was not to add a fallback but to leave the existing
 * mechanism completely alone and put this on top of it.
 *
 * What this adds is issuance at a keyboard instead of at a command line, and
 * delivery over a channel the shop already has. The manual path — `pnpm
 * licence:issue`, and the paste box in Settings → Licence — is untouched and
 * remains the way a shop with no internet at all is renewed.
 *
 * **Revocation here is a vendor-side fact, not a kill switch.** It stops
 * renewal and marks the fleet view. It does not reach into a paid-up shop and
 * switch anything off, because §20 forbids the control plane from being able to
 * stop a valid installation trading.
 */
@Injectable()
export class LicencesService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(SIGNER_CLIENT) private readonly signer: SignerClient,
    @Inject(COMMANDS_SERVICE) private readonly commands: CommandsService,
    @Inject(INSTALLATIONS_SERVICE) private readonly installations: InstallationsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async listFor(tenantId: string): Promise<LicenceRow[]> {
    const result = await this.pool.query<LicenceRow>(`${SELECT_LICENCE} WHERE tenant_id=$1 ORDER BY issued_at DESC`, [
      tenantId,
    ]);
    return result.rows;
  }

  async get(id: string): Promise<LicenceRow> {
    const result = await this.pool.query<LicenceRow>(`${SELECT_LICENCE} WHERE id=$1`, [id]);
    const row = result.rows[0];
    if (row === undefined) throw new ControlError(ControlErrorCode.NOT_FOUND, 'No such licence');
    return row;
  }

  /**
   * Signs a licence and, when the installation is enrolled, queues its delivery.
   *
   * `replacementOf` is the only signed way to issue something *smaller* — a
   * shorter term or fewer modules. The install refuses a backwards step without
   * it, which is what stops last year's key, pasted out of an old message, from
   * shortening a shop's term. Naming the licence being replaced is the vendor
   * deliberately saying "yes, smaller", with their signing key.
   */
  async issue(
    input: {
      tenantId: string;
      installationId: string | null;
      validUntil: string;
      modules: readonly string[];
      replacementOf: string | null;
      reason: string;
    },
    operator: OperatorPrincipal,
  ): Promise<LicenceRow> {
    const businessId = await this.businessIdFor(input.tenantId, input.installationId);
    const modules = input.modules.filter((code) => LICENSABLE_MODULES.includes(code));
    if (modules.length !== input.modules.length) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Unknown module in that licence');
    }

    const validUntil = parseInstant(input.validUntil);
    const now = this.clock.now();
    if (validUntil === null) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, "That expiry date cannot be read");
    }
    if (validUntil.getTime() <= now.getTime()) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'That licence would already have expired');
    }

    const licenceId = Ulid.generate(this.clock);
    const keys = await this.signer.publicKeys();
    const licenceKey = keys['licence'];
    if (licenceKey === null || licenceKey === undefined) {
      throw new ControlError(ControlErrorCode.SIGNER_UNAVAILABLE, 'No licence signing key is available');
    }

    const canonical = canonicalLicencePayload({
      schema_version: LICENCE_SCHEMA_VERSION,
      licence_id: licenceId,
      signing_key_id: licenceKey.keyId,
      business_id: businessId,
      issued_at: now.toISOString(),
      valid_until: validUntil.toISOString(),
      modules,
      ...(input.replacementOf === null ? {} : { replacement_of: input.replacementOf }),
    });
    const signed = await this.signer.signLicence(canonical, `licence ${licenceId} for ${businessId}`);

    const id = Ulid.generate(this.clock);
    await this.pool.query(
      `INSERT INTO licences
         (id, tenant_id, installation_id, licence_id, business_id, issued_at, valid_until,
          modules, replacement_of, key_text, fingerprint, delivery_state, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ISSUED',$12)`,
      [
        id,
        input.tenantId,
        input.installationId,
        licenceId,
        businessId,
        now,
        validUntil,
        JSON.stringify(modules),
        input.replacementOf,
        signed.key,
        fingerprintOf(signed.key),
        operator.id,
      ],
    );

    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'licence.issue',
      tenantId: input.tenantId,
      installationId: input.installationId,
      reason: input.reason,
      subject: licenceId,
      after: { businessId, validUntil: validUntil.toISOString(), modules, replacementOf: input.replacementOf },
      ip: operator.ip,
      userAgent: operator.userAgent,
    });

    if (input.installationId !== null) await this.deliver(id, input.installationId, operator);
    return this.get(id);
  }

  /**
   * Queues a `LICENCE_REFRESH` for the shop's agent.
   *
   * The idempotency key is the licence's own id, so a retry after a lost
   * response delivers the same licence once rather than queuing a second
   * command. Delivery is best-effort by design: a shop that is offline gets it
   * on the next check-in, and one that is offline for a month gets an expired
   * command and the operator is told, rather than a month-old instruction being
   * applied silently.
   */
  async deliver(licenceRowId: string, installationId: string, operator: OperatorPrincipal): Promise<void> {
    const licence = await this.get(licenceRowId);
    const installation = await this.installations.get(installationId);
    if (installation.erpTenantId === '') {
      throw new ControlError(
        ControlErrorCode.PRECONDITION_FAILED,
        'That installation has not enrolled yet, so nothing can be delivered to it',
      );
    }
    if (installation.businessId !== licence.businessId) {
      // §3: a command must never be accepted by an installation it was not
      // meant for. Refusing here means it is never even signed.
      throw new ControlError(
        ControlErrorCode.PRECONDITION_FAILED,
        'That licence names a different business from this installation',
      );
    }

    await this.commands.enqueue({
      tenantId: installation.tenantId,
      installationId,
      type: 'LICENCE_REFRESH',
      payload: { licence_key: licence.keyText, licence_id: licence.licenceId },
      idempotencyKey: `licence:${licence.licenceId}`,
      createdBy: operator.id,
    });
    await this.pool.query(
      `UPDATE licences SET delivery_state='DELIVERED', delivered_at=now(), installation_id=$2
        WHERE id=$1 AND delivery_state='ISSUED'`,
      [licenceRowId, installationId],
    );
  }

  /** The agent reporting that the ERP accepted — or refused — the licence. */
  async recordInstallOutcome(licenceId: string, ok: boolean, failureCode: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE licences
          SET delivery_state=$2, installed_at=CASE WHEN $2='INSTALLED' THEN now() ELSE installed_at END,
              failure_code=$3
        WHERE licence_id=$1`,
      [licenceId, ok ? 'INSTALLED' : 'FAILED', failureCode],
    );
  }

  async revoke(id: string, reason: string, operator: OperatorPrincipal): Promise<void> {
    const before = await this.get(id);
    await this.pool.query('UPDATE licences SET revoked_at=now(), revoke_reason=$2 WHERE id=$1', [id, reason]);
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'licence.revoke',
      tenantId: before.tenantId,
      installationId: before.installationId,
      reason,
      subject: before.licenceId,
      before: { revokedAt: null },
      after: { revokedAt: this.clock.now().toISOString() },
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
  }

  /**
   * Which licences are running out, for the overview.
   *
   * Thirty days ahead, because that is the width of the grace period the ERP
   * already applies (D-36) — the vendor wants to know before the shop starts
   * seeing a warning, not at the same time.
   */
  async expiringSoon(days = 30): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (l.tenant_id) l.id, l.tenant_id AS "tenantId", t.name AS "tenantName",
              l.valid_until AS "validUntil", l.installation_id AS "installationId"
         FROM licences l JOIN tenants t ON t.id = l.tenant_id
        WHERE l.revoked_at IS NULL
        ORDER BY l.tenant_id, l.valid_until DESC`,
    );
    const cutoff = addSeconds(this.clock.now(), days * 24 * 60 * 60);
    return result.rows.filter((row) => (row as { validUntil: Date }).validUntil <= cutoff);
  }

  private async businessIdFor(tenantId: string, installationId: string | null): Promise<string> {
    if (installationId !== null) {
      const installation = await this.installations.get(installationId);
      if (installation.tenantId !== tenantId) {
        throw new ControlError(ControlErrorCode.NOT_FOUND, 'No such installation for that customer');
      }
      if (installation.businessId === '') {
        throw new ControlError(
          ControlErrorCode.PRECONDITION_FAILED,
          'That installation has not enrolled, so its Business ID is not known yet',
        );
      }
      return installation.businessId;
    }
    /*
     * A licence with no installation is the offline path: the operator will
     * copy the key and send it. It still has to name a business, so the tenant
     * must have at least one enrolled installation to take the id from — a
     * licence for a business nobody can name is a licence that verifies nowhere.
     */
    const enrolled = await this.installations.list(tenantId);
    const withBusiness = enrolled.find((row) => row.businessId !== '');
    if (withBusiness === undefined) {
      throw new ControlError(
        ControlErrorCode.PRECONDITION_FAILED,
        'This customer has no enrolled installation yet, so their Business ID is not known',
      );
    }
    return withBusiness.businessId;
  }
}

/**
 * A short, stable identifier for an issued licence.
 *
 * The agent reports this in every check-in so the console can tell at a glance
 * whether the machine is running the licence the vendor last issued. Hashing
 * rather than sending the key back saves nothing in secrecy — the key is not a
 * secret — but it keeps the heartbeat small and comparable.
 */
function fingerprintOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
}

const SELECT_LICENCE = `
  SELECT id, tenant_id AS "tenantId", installation_id AS "installationId", licence_id AS "licenceId",
         business_id AS "businessId", issued_at AS "issuedAt", valid_until AS "validUntil",
         modules, replacement_of AS "replacementOf", delivery_state AS "deliveryState",
         delivered_at AS "deliveredAt", installed_at AS "installedAt", failure_code AS "failureCode",
         revoked_at AS "revokedAt", revoke_reason AS "revokeReason", created_by AS "createdBy",
         key_text AS "keyText"
    FROM licences
`;
