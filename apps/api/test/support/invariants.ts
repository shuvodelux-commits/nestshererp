import { stockValueMinor } from '@sher/core-domain';
import type pg from 'pg';

import { asTenant } from './database';

/**
 * The five golden invariants of §3.11 that money and stock rest on, asserted
 * against what is actually in the database.
 *
 * This exists because a costing bug does not announce itself. Every individual
 * test asserts the numbers it happens to care about; none of them notices that
 * a lot quietly stopped agreeing with the movements behind it, or that the
 * valuation drifted a poisha from the `INVENTORY` account. §3.11 requires these
 * to hold on every commit that touches money or stock, so a spec that posts
 * either calls this at the end and the whole suite becomes the enforcement.
 *
 * It reads **through RLS**, as a tenant, exactly like the application: an
 * invariant proven with the owner's bypass would say nothing about what the
 * application can actually see.
 *
 * It recomputes from `stock_movements`, `inventory_lots`, `journal_lines` and
 * `product_cost_state` rather than asking the service for its own opinion —
 * `stockValueMinor` is the only thing borrowed, because rounding is the rule
 * being checked and reimplementing it in SQL would only prove that two
 * different roundings agree with each other.
 *
 * Every violation is collected before anything throws, so a broken commit shows
 * all of its damage at once instead of one invariant per run.
 */
export async function assertGoldenInvariants(pool: pg.Pool, tenantId: string): Promise<void> {
  const violations = await asTenant(pool, tenantId, async (db) => {
    const found: string[] = [];

    // INV-01 — every journal entry sums to zero.
    const unbalanced = await db.query<{ journal_entry_id: string; total: number }>(
      `SELECT journal_entry_id, SUM(amount_minor)::bigint AS total
         FROM journal_lines
        GROUP BY journal_entry_id
       HAVING SUM(amount_minor) <> 0`,
    );
    for (const row of unbalanced.rows) {
      found.push(`INV-01: journal entry ${row.journal_entry_id} sums to ${row.total}, not zero`);
    }

    // INV-02 — stock on hand equals the sum of its movements, per product and
    // location. A FULL JOIN, because a cost state with no movements behind it
    // and movements with no cost state in front of them are both the failure.
    const onHand = await db.query<{
      product_id: string; location_id: string; state_qty: number | null; movement_qty: number | null;
    }>(
      `SELECT COALESCE(state.product_id, moved.product_id)   AS product_id,
              COALESCE(state.location_id, moved.location_id) AS location_id,
              state.qty_on_hand::bigint                      AS state_qty,
              moved.net_qty::bigint                          AS movement_qty
         FROM (SELECT product_id, location_id, qty_on_hand
                 FROM product_cost_state
                WHERE deleted_at IS NULL) state
         FULL JOIN (SELECT product_id, location_id,
                           SUM(CASE direction WHEN 'IN' THEN qty ELSE -qty END) AS net_qty
                      FROM stock_movements
                     GROUP BY product_id, location_id) moved
                ON moved.product_id = state.product_id
               AND moved.location_id = state.location_id
        WHERE COALESCE(state.qty_on_hand, 0) <> COALESCE(moved.net_qty, 0)`,
    );
    for (const row of onHand.rows) {
      found.push(
        `INV-02: product ${row.product_id} at ${row.location_id} holds ${row.state_qty ?? 'no'} ` +
        `but its movements net to ${row.movement_qty ?? 0}`,
      );
    }

    // INV-03 — no lot has a negative remaining quantity (DR13.11). The table's
    // own CHECK forbids it; asserting it here as well is deliberate, because a
    // later migration relaxing that constraint must fail this, not pass quietly.
    const negative = await db.query<{ id: string; qty_remaining: number }>(
      'SELECT id, qty_remaining::bigint FROM inventory_lots WHERE deleted_at IS NULL AND qty_remaining < 0',
    );
    for (const row of negative.rows) {
      found.push(`INV-03: lot ${row.id} has ${row.qty_remaining} remaining`);
    }

    // INV-04 — the lots add up to the on-hand quantity. Vendor lots are counted:
    // consignment goods are physically on the shelf and DR13.10 excludes them
    // from *value*, never from quantity.
    const lotTotals = await db.query<{
      product_id: string; location_id: string; state_qty: number | null; lot_qty: number | null;
    }>(
      `SELECT COALESCE(state.product_id, lots.product_id)   AS product_id,
              COALESCE(state.location_id, lots.location_id) AS location_id,
              state.qty_on_hand::bigint                     AS state_qty,
              lots.remaining::bigint                        AS lot_qty
         FROM (SELECT product_id, location_id, qty_on_hand
                 FROM product_cost_state
                WHERE deleted_at IS NULL) state
         FULL JOIN (SELECT product_id, location_id, SUM(qty_remaining) AS remaining
                      FROM inventory_lots
                     WHERE deleted_at IS NULL
                     GROUP BY product_id, location_id) lots
                ON lots.product_id = state.product_id
               AND lots.location_id = state.location_id
        WHERE COALESCE(state.qty_on_hand, 0) <> COALESCE(lots.remaining, 0)`,
    );
    for (const row of lotTotals.rows) {
      found.push(
        `INV-04: product ${row.product_id} at ${row.location_id} holds ${row.state_qty ?? 'no'} ` +
        `but its lots have ${row.lot_qty ?? 0} remaining`,
      );
    }

    // INV-05 — valuation equals the INVENTORY account, computed the way the
    // tenant's own costing method says (D-05). This is the one that catches a
    // costing bug before a customer does.
    const method = await costingMethodOf(db);
    const account = await db.query<{ balance: number }>(
      "SELECT COALESCE(SUM(amount_minor), 0)::bigint AS balance FROM journal_lines WHERE account_code = 'INVENTORY'",
    );
    const valuation = method === 'FIFO'
      ? await fifoValuation(db)
      : await averageValuation(db);
    const balance = Number(account.rows[0]?.balance ?? 0);
    if (valuation !== balance) {
      found.push(
        `INV-05: ${method} valuation is ${valuation} but the INVENTORY account holds ${balance} ` +
        `(off by ${valuation - balance})`,
      );
    }

    return found;
  });

  if (violations.length > 0) {
    throw new Error(`Golden invariants broken (§3.11):\n  ${violations.join('\n  ')}`);
  }
}

/** What the tenant is actually costing on. An absent row is the shipped default. */
async function costingMethodOf(db: pg.PoolClient): Promise<'FIFO' | 'AVERAGE'> {
  const stored = await db.query<{ value: string }>(
    "SELECT value FROM settings WHERE setting_key = 'sale_costing_method' AND deleted_at IS NULL",
  );
  return stored.rows[0]?.value === 'AVERAGE' ? 'AVERAGE' : 'FIFO';
}

/** Σ (lot remaining × lot actual unit cost) over owned lots only (DR13.10). */
async function fifoValuation(db: pg.PoolClient): Promise<number> {
  const lots = await db.query<{ qty_remaining: number; actual_unit_cost: number }>(
    `SELECT qty_remaining::bigint, actual_unit_cost::bigint
       FROM inventory_lots
      WHERE deleted_at IS NULL AND owner_type = 'OWNED' AND qty_remaining > 0`,
  );
  return lots.rows.reduce(
    (total, lot) => total + stockValueMinor(Number(lot.qty_remaining), Number(lot.actual_unit_cost)),
    0,
  );
}

/** Σ (qty on hand × moving average). Lots carry no independent value here. */
async function averageValuation(db: pg.PoolClient): Promise<number> {
  const states = await db.query<{ qty_on_hand: number; avg_unit_cost: number }>(
    `SELECT qty_on_hand::bigint, avg_unit_cost::bigint
       FROM product_cost_state
      WHERE deleted_at IS NULL AND qty_on_hand > 0`,
  );
  return states.rows.reduce(
    (total, state) => total + stockValueMinor(Number(state.qty_on_hand), Number(state.avg_unit_cost)),
    0,
  );
}
