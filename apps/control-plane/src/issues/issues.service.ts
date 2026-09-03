import { Inject, Injectable } from '@nestjs/common';
import type { IssueSeverity, IssueStatus } from '@sher/control-contracts';
import { versionInRange } from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import type pg from 'pg';

import type { AuditService } from '../audit/audit.service';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';
import type { InstallationsService } from '../installations/installations.service';
import type { OperatorPrincipal } from '../operators/operator.guard';
import { AUDIT_SERVICE, INSTALLATIONS_SERVICE } from '../tokens';

export interface KnownIssueRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly affectedFromVersion: string;
  readonly affectedToVersion: string;
  readonly affectedSchemaVersion: string;
  readonly severity: IssueSeverity;
  readonly workaround: string;
  readonly fixedInVersion: string;
  readonly status: IssueStatus;
  readonly createdAt: Date;
}

/**
 * The known-issue registry (§8).
 *
 * It answers one question — *which installations are likely running a version
 * with this bug in it* — and stops there. §8 is explicit that a known issue is
 * never grounds for automatically mutating a customer's accounting data, and
 * this service has no path that could: it reads versions and reports counts. A
 * fix reaches a shop as a release, or as a correction made by a person in a
 * support session through the ERP's own reversal flows. Never as a background
 * job that rewrote some rows because a version string matched.
 *
 * "Likely" is the honest word. A version range is evidence that the buggy code
 * is present, not that the bug was ever hit — which is exactly why the count is
 * shown next to the diagnostics, where the error code says whether it actually
 * happened.
 */
@Injectable()
export class IssuesService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(INSTALLATIONS_SERVICE) private readonly installations: InstallationsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async list(): Promise<(KnownIssueRow & { affectedCount: number })[]> {
    const result = await this.pool.query<KnownIssueRow>(`${SELECT_ISSUE} ORDER BY created_at DESC`);
    const fleet = await this.installations.list();
    return result.rows.map((issue) => ({
      ...issue,
      affectedCount: fleet.filter((installation) => this.affects(issue, installation.appVersion)).length,
    }));
  }

  async affected(issueId: string): Promise<unknown[]> {
    const result = await this.pool.query<KnownIssueRow>(`${SELECT_ISSUE} WHERE id=$1`, [issueId]);
    const issue = result.rows[0];
    if (issue === undefined) return [];
    const fleet = await this.installations.list();
    return fleet.filter((installation) => this.affects(issue, installation.appVersion));
  }

  async create(
    input: Omit<KnownIssueRow, 'id' | 'createdAt'>,
    operator: OperatorPrincipal,
  ): Promise<KnownIssueRow> {
    const id = Ulid.generate(this.clock);
    await this.pool.query(
      `INSERT INTO known_issues
         (id, title, description, affected_from_version, affected_to_version,
          affected_schema_version, severity, workaround, fixed_in_version, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        input.title,
        input.description,
        input.affectedFromVersion,
        input.affectedToVersion,
        input.affectedSchemaVersion,
        input.severity,
        input.workaround,
        input.fixedInVersion,
        input.status,
        operator.id,
      ],
    );
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'issue.create',
      subject: input.title,
      after: input,
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
    const created = await this.pool.query<KnownIssueRow>(`${SELECT_ISSUE} WHERE id=$1`, [id]);
    return created.rows[0] as KnownIssueRow;
  }

  async update(id: string, input: Partial<KnownIssueRow>, operator: OperatorPrincipal): Promise<void> {
    await this.pool.query(
      `UPDATE known_issues
          SET status=COALESCE($2,status), fixed_in_version=COALESCE($3,fixed_in_version),
              workaround=COALESCE($4,workaround)
        WHERE id=$1`,
      [id, input.status ?? null, input.fixedInVersion ?? null, input.workaround ?? null],
    );
    await this.audit.append({
      operatorId: operator.id,
      operatorName: operator.name,
      action: 'issue.update',
      subject: id,
      after: input,
      ip: operator.ip,
      userAgent: operator.userAgent,
    });
  }

  private affects(issue: KnownIssueRow, appVersion: string): boolean {
    if (appVersion === '' || issue.status === 'WITHDRAWN') return false;
    return versionInRange(appVersion, issue.affectedFromVersion, issue.affectedToVersion);
  }
}

const SELECT_ISSUE = `
  SELECT id, title, description, affected_from_version AS "affectedFromVersion",
         affected_to_version AS "affectedToVersion", affected_schema_version AS "affectedSchemaVersion",
         severity, workaround, fixed_in_version AS "fixedInVersion", status, created_at AS "createdAt"
    FROM known_issues
`;
