import type { PeriodRepository, PeriodRow, TenantContext, Tx } from '@sher/core-application';
import { parseInstant } from '@sher/shared-utils';
import { sql } from 'drizzle-orm';

import { txOf } from './unit-of-work';

/**
 * Which months are shut, and what each one holds (§5.19, D-25).
 *
 * The list is **months that exist**, not a calendar: every month with a journal
 * entry, unioned with every month already closed. A shop that opened in June is
 * not asked about May, and a list of empty months is a list nobody reads.
 *
 * The entry count is read from `journal_entries` rather than stored on the
 * lock, for the same reason nothing else here is stored: it is the answer to
 * "what would closing freeze", and it must be true when it is asked.
 */
/**
 * `closed_at` comes back as a string from a raw statement and as a `Date` from
 * the query builder. Reading a closed month crashed on the difference, so every
 * instant is normalised in one place, through `shared-utils` — the only file
 * allowed to touch `Date` (R-C8).
 */
function instant(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  return parseInstant(typeof value === 'string' ? value : null);
}

export class PostgresPeriodRepository implements PeriodRepository {
  async listPeriods(tx: Tx, ctx: TenantContext, limit: number): Promise<readonly PeriodRow[]> {
    const rows = await txOf(tx).execute<{
      period_year: number;
      period_month: number;
      status: string | null;
      entry_count: string;
      closed_at: Date | null;
      closed_by_name: string | null;
    }>(sql`
      WITH months AS (
        SELECT EXTRACT(YEAR FROM business_date)::int AS period_year,
               EXTRACT(MONTH FROM business_date)::int AS period_month,
               COUNT(*)::bigint AS entry_count
          FROM journal_entries
         WHERE tenant_id = ${ctx.tenantId}
         GROUP BY 1, 2
        UNION
        SELECT period_year, period_month, 0::bigint
          FROM period_locks
         WHERE tenant_id = ${ctx.tenantId}
      )
      SELECT m.period_year, m.period_month,
             MAX(m.entry_count)::bigint AS entry_count,
             pl.status, pl.updated_at AS closed_at, u.display_name AS closed_by_name
        FROM months m
        LEFT JOIN period_locks pl
               ON pl.tenant_id = ${ctx.tenantId}
              AND pl.period_year = m.period_year
              AND pl.period_month = m.period_month
        LEFT JOIN users u ON u.id = pl.updated_by
       GROUP BY m.period_year, m.period_month, pl.status, pl.updated_at, u.display_name
       ORDER BY m.period_year DESC, m.period_month DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((row) => ({
      year: Number(row.period_year),
      month: Number(row.period_month),
      status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
      entryCount: Number(row.entry_count),
      closedAt: row.status === 'CLOSED' ? instant(row.closed_at) : null,
      closedByName: row.status === 'CLOSED' ? row.closed_by_name : null,
    }));
  }

  async findPeriod(
    tx: Tx,
    ctx: TenantContext,
    year: number,
    month: number,
  ): Promise<PeriodRow | null> {
    const rows = await txOf(tx).execute<{
      status: string | null;
      entry_count: string;
      closed_at: Date | null;
      closed_by_name: string | null;
    }>(sql`
      SELECT pl.status,
             (SELECT COUNT(*)::bigint FROM journal_entries je
               WHERE je.tenant_id = ${ctx.tenantId}
                 AND EXTRACT(YEAR FROM je.business_date)::int = ${year}
                 AND EXTRACT(MONTH FROM je.business_date)::int = ${month}) AS entry_count,
             pl.updated_at AS closed_at, u.display_name AS closed_by_name
        FROM (SELECT 1) AS one
        LEFT JOIN period_locks pl
               ON pl.tenant_id = ${ctx.tenantId}
              AND pl.period_year = ${year}
              AND pl.period_month = ${month}
        LEFT JOIN users u ON u.id = pl.updated_by
       LIMIT 1
    `);

    const row = rows.rows[0];
    if (row === undefined) return null;
    return {
      year,
      month,
      status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
      entryCount: Number(row.entry_count),
      closedAt: row.status === 'CLOSED' ? instant(row.closed_at) : null,
      closedByName: row.status === 'CLOSED' ? row.closed_by_name : null,
    };
  }

  /**
   * Shut the month.
   *
   * Written as an upsert on (tenant, year, month) because a period row may
   * already exist from an earlier state; there is no path back to OPEN, so the
   * only transition this can make is the one the owner asked for.
   */
  async close(
    tx: Tx,
    ctx: TenantContext,
    lock: {
      readonly id: string;
      readonly year: number;
      readonly month: number;
      readonly note: string | null;
    },
  ): Promise<void> {
    await txOf(tx).execute(sql`
      INSERT INTO period_locks
        (id, tenant_id, period_year, period_month, status, reason,
         created_at, updated_at, created_by, updated_by, version)
      VALUES
        (${lock.id}, ${ctx.tenantId}, ${lock.year}, ${lock.month}, 'CLOSED', ${lock.note},
         NOW(), NOW(), ${ctx.userId}, ${ctx.userId}, 1)
      ON CONFLICT (tenant_id, period_year, period_month)
      DO UPDATE SET status = 'CLOSED', reason = ${lock.note},
                    updated_at = NOW(), updated_by = ${ctx.userId},
                    version = period_locks.version + 1
    `);
  }
}
