import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import { ControlError, ControlErrorCode } from '../common/errors';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';
import type { OperatorPrincipal } from '../operators/operator.guard';
import { AUDIT_SERVICE } from '../tokens';

export interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail: string;
  readonly notes: string;
  readonly createdAt: Date;
  readonly installationCount: number;
}

/**
 * Customers — the businesses the vendor sells to (§2).
 *
 * A tenant here is a *commercial* record: who the customer is, how to reach
 * them, what they are owed in support. It is not the ERP's `tenant_id`, which
 * lives in the shop's own database and identifies their data. The two are
 * connected at exactly one place — `installations.erp_tenant_id`, written once
 * at enrolment — and connected nowhere else on purpose, because a vendor
 * record and a data-isolation boundary are different things and merging them is
 * how a control plane becomes a data plane.
 */
@Injectable()
export class TenantsService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async list(): Promise<TenantRow[]> {
    const result = await this.pool.query<TenantRow>(
      `SELECT t.id, t.name, t.contact_name AS "contactName", t.contact_phone AS "contactPhone",
              t.contact_email AS "contactEmail", t.notes, t.created_at AS "createdAt",
              (SELECT COUNT(*)::int FROM installations i WHERE i.tenant_id = t.id) AS "installationCount"
         FROM tenants t
        WHERE t.archived_at IS NULL
        ORDER BY t.name`,
    );
    return result.rows;
  }

  async get(id: string): Promise<TenantRow> {
    const result = await this.pool.query<TenantRow>(
      `SELECT t.id, t.name, t.contact_name AS "contactName", t.contact_phone AS "contactPhone",
              t.contact_email AS "contactEmail", t.notes, t.created_at AS "createdAt",
              (SELECT COUNT(*)::int FROM installations i WHERE i.tenant_id = t.id) AS "installationCount"
         FROM tenants t WHERE t.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlError(ControlErrorCode.NOT_FOUND, 'No such customer');
    return row;
  }

  async create(
    input: { name: string; contactName: string; contactPhone: string; contactEmail: string; notes: string },
    operator: OperatorPrincipal,
  ): Promise<TenantRow> {
    const id = Ulid.generate(this.clock);
    await this.pool.query(
      `INSERT INTO tenants (id, name, contact_name, contact_phone, contact_email, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.name.trim(), input.contactName, input.contactPhone, input.contactEmail, input.notes],
    );
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'tenant.create',
      tenantId: id,
      subject: input.name,
      after: input,
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
    return this.get(id);
  }

  async update(
    id: string,
    input: { name: string; contactName: string; contactPhone: string; contactEmail: string; notes: string },
    operator: OperatorPrincipal,
  ): Promise<TenantRow> {
    const before = await this.get(id);
    await this.pool.query(
      `UPDATE tenants SET name=$2, contact_name=$3, contact_phone=$4, contact_email=$5, notes=$6
        WHERE id=$1`,
      [id, input.name.trim(), input.contactName, input.contactPhone, input.contactEmail, input.notes],
    );
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'tenant.update',
      tenantId: id,
      subject: input.name,
      before,
      after: input,
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
    return this.get(id);
  }
}
