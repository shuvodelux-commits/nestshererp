import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { CONTROL_POOL } from '../db/tokens';

/**
 * The vendor-side audit trail (§15, §24).
 *
 * **Every security-sensitive thing an operator does passes through here**, and
 * the table it writes to refuses UPDATE and DELETE at the database level. That
 * trigger is not belt-and-braces; it is the property that makes the trail worth
 * having. A vendor who can reach into a customer's ERP and then tidy the record
 * of having done so has not been audited, they have been logged.
 *
 * `reason` is required for the actions §24 names. The service does not decide
 * which those are — `REAUTH_ACTIONS` in the contracts package does — so the
 * list an auditor reads is the same list the guard enforces.
 */
export interface AuditEntry {
  readonly operatorId: string | null;
  readonly operatorName: string;
  readonly action: string;
  readonly tenantId?: string | null;
  readonly installationId?: string | null;
  readonly reason?: string;
  readonly subject?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string;
  readonly userAgent?: string;
}

@Injectable()
export class AuditService {
  constructor(@Inject(CONTROL_POOL) private readonly pool: pg.Pool) {}

  /**
   * Writes one row.
   *
   * Takes an optional client so an audit entry can join the transaction of the
   * thing it describes — a licence issued and the record of issuing it commit
   * together or not at all. Where that is not possible (a refusal, which by
   * definition rolls its own work back) the caller passes no client and the row
   * lands on its own, which is the same pattern the ERP's denial auditing uses.
   */
  async append(entry: AuditEntry, client?: pg.PoolClient): Promise<void> {
    const runner = client ?? this.pool;
    await runner.query(
      `INSERT INTO vendor_audit
         (operator_id, operator_name, action, tenant_id, installation_id,
          reason, subject, before_value, after_value, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        entry.operatorId,
        entry.operatorName,
        entry.action,
        entry.tenantId ?? null,
        entry.installationId ?? null,
        entry.reason ?? '',
        entry.subject ?? '',
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.ip ?? '',
        entry.userAgent ?? '',
      ],
    );
  }

  async list(filter: {
    tenantId?: string;
    operatorId?: string;
    action?: string;
    limit: number;
  }): Promise<AuditRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.tenantId !== undefined) {
      params.push(filter.tenantId);
      where.push(`tenant_id = $${String(params.length)}`);
    }
    if (filter.operatorId !== undefined) {
      params.push(filter.operatorId);
      where.push(`operator_id = $${String(params.length)}`);
    }
    if (filter.action !== undefined) {
      params.push(filter.action);
      where.push(`action = $${String(params.length)}`);
    }
    params.push(Math.min(filter.limit, 500));
    const result = await this.pool.query<AuditRow>(
      `SELECT id, at, operator_id AS "operatorId", operator_name AS "operatorName",
              action, tenant_id AS "tenantId", installation_id AS "installationId",
              reason, subject, before_value AS "before", after_value AS "after", ip
         FROM vendor_audit
        ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY at DESC
        LIMIT $${String(params.length)}`,
      params,
    );
    return result.rows;
  }
}

export interface AuditRow {
  readonly id: string;
  readonly at: Date;
  readonly operatorId: string | null;
  readonly operatorName: string;
  readonly action: string;
  readonly tenantId: string | null;
  readonly installationId: string | null;
  readonly reason: string;
  readonly subject: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string;
}
