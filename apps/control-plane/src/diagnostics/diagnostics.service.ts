import { Inject, Injectable } from '@nestjs/common';
import type { DiagnosticEvent } from '@sher/control-contracts';
import { FORBIDDEN_DIAGNOSTIC_FIELDS } from '@sher/control-contracts';
import type pg from 'pg';

import { ControlError, ControlErrorCode } from '../common/errors';
import { CONTROL_POOL } from '../db/tokens';

/**
 * Sanitized diagnostics (§7, §22).
 *
 * The schema in `control-contracts` already has nowhere for a message, a stack
 * or a body to go — `.strict()` refuses an unknown key. This service adds a
 * second check anyway, against `FORBIDDEN_DIAGNOSTIC_FIELDS`, and the reason is
 * the future: the day somebody adds a genuinely useful field to the schema, the
 * name they pick had better not be `message`. Failing loudly at the boundary is
 * cheaper than discovering a year of customer error text on the vendor's disk.
 */
@Injectable()
export class DiagnosticsService {
  constructor(@Inject(CONTROL_POOL) private readonly pool: pg.Pool) {}

  async record(installationId: string, events: readonly DiagnosticEvent[]): Promise<void> {
    for (const event of events) {
      for (const field of Object.keys(event)) {
        if (FORBIDDEN_DIAGNOSTIC_FIELDS.includes(field)) {
          throw new ControlError(
            ControlErrorCode.VALIDATION_FAILED,
            `Diagnostics may not carry "${field}"`,
          );
        }
      }
    }
    for (const event of events) {
      await this.pool.query(
        `INSERT INTO diagnostics
           (installation_id, code, module, route, http_status, correlation_id,
            app_version, schema_version, occurred_at, count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          installationId,
          event.code,
          event.module,
          event.route,
          event.http_status,
          event.correlation_id,
          event.app_version,
          event.schema_version,
          event.occurred_at,
          event.count,
        ],
      );
    }
  }

  async listFor(installationId: string, limit = 200): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT code, module, route, http_status AS "httpStatus", correlation_id AS "correlationId",
              app_version AS "appVersion", schema_version AS "schemaVersion",
              occurred_at AS "occurredAt", count
         FROM diagnostics WHERE installation_id=$1
        ORDER BY occurred_at DESC LIMIT $2`,
      [installationId, limit],
    );
    return result.rows;
  }

  /** Error codes across the fleet, for the overview's "what is going wrong" panel. */
  async fleetSummary(sinceHours = 24): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT code, SUM(count)::int AS total, COUNT(DISTINCT installation_id)::int AS installations
         FROM diagnostics
        WHERE occurred_at > now() - ($1 || ' hours')::interval
        GROUP BY code ORDER BY total DESC LIMIT 25`,
      [String(sinceHours)],
    );
    return result.rows;
  }
}
