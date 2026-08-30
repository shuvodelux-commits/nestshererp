import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { BackupService, TenantContext } from '@sher/core-application';
import { SYSTEM_ACTOR_ID } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import type pg from 'pg';

import { API_CONFIG, CLOCK, DATABASE_POOL } from '../infrastructure/tokens';
import type { ApiConfig } from '../config';
import { BACKUP_SERVICE } from './tokens';

/**
 * The nightly backup (Phase 10, owner decision 2026-08-30).
 *
 * **In the API process, not in cron.** A single-business installation is a
 * computer in a shop; there is no guarantee anybody ever configured a cron
 * entry, and a backup that depends on a step nobody performed is a backup that
 * does not exist. The API is already running — it is what the shop uses all
 * day — so the schedule lives where the software is.
 *
 * It wakes every quarter of an hour and asks one question: has the configured
 * hour arrived, and has today's backup not run? A wall-clock timer set for
 * "in 24 hours" drifts, sleeps through a suspended laptop, and never fires at
 * all if the machine was off at the moment it was due. Polling a cheap
 * condition survives all three.
 *
 * A failure is **recorded and swallowed**, never rethrown: an unhandled
 * rejection in a background timer would take down an API that a shop is in the
 * middle of selling through, and the failure is already visible where it
 * matters — `backup_runs`, and the dashboard warning that reads it.
 */
@Injectable()
export class BackupScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackupScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunDay = '';

  constructor(
    @Inject(BACKUP_SERVICE) private readonly backups: BackupService,
    @Inject(DATABASE_POOL) private readonly pool: pg.Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MILLISECONDS);
    // Never hold the process open on this alone: a CLI or a test that imported
    // the module should still be able to exit.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;

    const now = this.clock.now();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() !== this.config.backupHour || this.lastRunDay === day) return;

    this.running = true;
    this.lastRunDay = day;
    try {
      for (const ctx of await this.businesses()) {
        try {
          const archive = await this.backups.runAutomatic(ctx);
          this.logger.log(`Nightly backup written: ${archive.fileName}`);
        } catch (error) {
          // Recorded as a FAILED run by the service itself; the dashboard is
          // what tells the shop, and it reads the row rather than this log.
          this.logger.error(
            `Nightly backup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Who to back up.
   *
   * V1 is a single-business installation, so this is one row — but it is read
   * rather than assumed. `tenant_id` stays on every table and in every query in
   * both modes (D-34), and a scheduler that hard-coded "the only tenant" would
   * be the first thing to break the day that stops being true.
   *
   * **It reads `user_identifiers`, not `tenants`, and that is not an
   * accident.** There is no request here and therefore no `app.tenant_id`, and
   * `tenants` is under FORCE row-level security — a query with no tenant set
   * correctly returns nothing at all. `user_identifiers` is the pre-auth index
   * that is deliberately *not* RLS-scoped (§3.2, migration 0002), every business
   * has at least one from the moment it is provisioned, and reading a tenant id
   * from it is exactly the lookup `runWithoutTenant` sanctions before a tenant
   * is known. The timezone is then read inside that tenant's own context, where
   * the policy is satisfied.
   */
  private async businesses(): Promise<readonly TenantContext[]> {
    const found = await this.pool.query<{ tenant_id: string }>(
      'SELECT DISTINCT tenant_id FROM user_identifiers ORDER BY tenant_id',
    );

    const contexts: TenantContext[] = [];
    for (const row of found.rows) {
      contexts.push({
        tenantId: row.tenant_id,
        userId: SYSTEM_ACTOR_ID,
        timezone: await this.timezoneOf(row.tenant_id),
      });
    }
    return contexts;
  }

  /**
   * The tenant's own timezone, read on a connection that has adopted it.
   *
   * `set_config(..., true)` is transaction-local, so the read has to sit inside
   * a transaction on one checked-out client — otherwise the pool could hand the
   * SELECT to a different connection that has no tenant set, and RLS would
   * correctly return nothing.
   */
  private async timezoneOf(tenantId: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query<{ timezone: string }>(
        'SELECT timezone FROM tenants WHERE id = $1',
        [tenantId],
      );
      await client.query('COMMIT');
      return result.rows[0]?.timezone ?? DEFAULT_TIMEZONE;
    } finally {
      client.release();
    }
  }
}

/** Quarter-hourly. Cheap enough to be invisible, fine enough to hit the hour. */
const TICK_MILLISECONDS = 15 * 60 * 1000;

/** Only reached if the tenant row vanished between the two reads. */
const DEFAULT_TIMEZONE = 'Asia/Dhaka';
