import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { CONTROL_POOL } from '../db/tokens';
import type { DiagnosticsService } from '../diagnostics/diagnostics.service';
import type { InstallationsService } from '../installations/installations.service';
import type { LicencesService } from '../licences/licences.service';
import type { SupportService } from '../support/support.service';
import { DIAGNOSTICS_SERVICE, INSTALLATIONS_SERVICE, LICENCES_SERVICE, SUPPORT_SERVICE } from '../tokens';

/**
 * The first screen (§25).
 *
 * Everything here answers "what needs me today": shops that have gone quiet,
 * licences about to lapse, rollouts that stopped, sessions still open. It is
 * deliberately a set of counts and short lists rather than a chart — an
 * operator opening this at nine in the morning wants to know whether to close
 * the tab, and a dashboard that takes reading to interpret is a dashboard that
 * gets skimmed.
 */
@Injectable()
export class OverviewService {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(INSTALLATIONS_SERVICE) private readonly installations: InstallationsService,
    @Inject(LICENCES_SERVICE) private readonly licences: LicencesService,
    @Inject(SUPPORT_SERVICE) private readonly support: SupportService,
    @Inject(DIAGNOSTICS_SERVICE) private readonly diagnostics: DiagnosticsService,
  ) {}

  async summary(): Promise<unknown> {
    const fleet = await this.installations.list();
    const failedDeployments = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM deployment_jobs WHERE halted_at IS NOT NULL`,
    );
    const tenants = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM tenants WHERE archived_at IS NULL',
    );
    const newestRelease = await this.pool.query<{ version: string }>(
      'SELECT version FROM releases WHERE withdrawn_at IS NULL ORDER BY published_at DESC LIMIT 1',
    );
    const latest = newestRelease.rows[0]?.version ?? '';

    return {
      customers: Number(tenants.rows[0]?.count ?? '0'),
      installations: {
        total: fleet.length,
        online: fleet.filter((row) => row.state === 'ONLINE').length,
        offline: fleet.filter((row) => row.state === 'OFFLINE').length,
        degraded: fleet.filter((row) => row.state === 'DEGRADED').length,
        migrationFailed: fleet.filter((row) => row.state === 'MIGRATION_FAILED').length,
        revoked: fleet.filter((row) => row.state === 'REVOKED').length,
      },
      health: {
        healthy: fleet.filter((row) => row.health === 'HEALTHY').length,
        warning: fleet.filter((row) => row.health === 'WARNING').length,
        critical: fleet.filter((row) => row.health === 'CRITICAL').length,
        unknown: fleet.filter((row) => row.health === 'UNKNOWN').length,
      },
      // "Outdated" means behind the newest published release, which is a
      // different question from "unhealthy" and worth its own number: a shop can
      // be perfectly well and two versions behind.
      outdated: latest === '' ? 0 : fleet.filter((row) => row.appVersion !== '' && row.appVersion !== latest).length,
      licencesExpiringSoon: await this.licences.expiringSoon(30),
      failedDeployments: Number(failedDeployments.rows[0]?.count ?? '0'),
      activeSupportSessions: await this.support.listActive(),
      topErrors: await this.diagnostics.fleetSummary(24),
    };
  }
}
