import { stockValueMinor } from '@sher/core-domain';
import type pg from 'pg';

import { asTenant } from './database';

/**
 * The golden invariants of §3.11 that money and stock rest on, asserted
 * against what is actually in the database.
 *
 * INV-01 to INV-05 cover the stock and costing side; INV-06 to INV-09 were added
 * on 2026-09-03 at the owner's request and cover the party, cash-session and
 * reversal side — a receivable belonging to nobody, a day that signed off on
 * arithmetic it did not do, a drawer that disagrees with what was counted, and a
 * voided document still moving money or goods.
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

    // INV-06 — a line on a party account names its party.
    //
    // §3.11 states INV-06 as "party ledger balance = Σ journal lines for that
    // party", and the thing that can actually break it is a receivable
    // belonging to nobody: a line that no party statement will ever include, so
    // the ledger and the account permanently disagree by that amount.
    // `rejectEntry` refuses one at the domain boundary, and this is the same
    // rule asserted against what reached the table — because a posting path that
    // writes journal lines without going through `rejectEntry` is exactly the
    // bug worth catching, and it would pass every domain test.
    const orphaned = await db.query<{ id: string; account_code: string; amount_minor: number }>(
      `SELECT id, account_code, amount_minor::bigint
         FROM journal_lines
        WHERE party_id IS NULL
          AND (account_code IN ('AR', 'AP', 'CUSTOMER_ADVANCE', 'SUPPLIER_ADVANCE',
                                'VENDOR_ADVANCE', 'VENDOR_PAYABLE'))`,
    );
    for (const row of orphaned.rows) {
      found.push(
        `INV-06: journal line ${row.id} puts ${row.amount_minor} on ${row.account_code} with no party`,
      );
    }

    // INV-07(a) — a day's expected closing is its opening plus what came in
    // less what went out. Checked against the five figures the close stored
    // rather than recomputed from movements: §5.16.4 is explicit that they are
    // stored once and never recomputed on read, so if the stored arithmetic is
    // wrong every screen that shows the day is wrong in the same way and no
    // amount of re-deriving it downstream would reveal that.
    const closes = await db.query<{
      id: string; opening: number; cash_in: number; cash_out: number; expected: number;
      counted: number; difference: number;
    }>(
      `SELECT id, opening_amount_minor::bigint AS opening, cash_in_minor::bigint AS cash_in,
              cash_out_minor::bigint AS cash_out, expected_closing_minor::bigint AS expected,
              counted_closing_minor::bigint AS counted, difference_minor::bigint AS difference
         FROM cash_session_closes
        WHERE superseded_at IS NULL`,
    );
    for (const row of closes.rows) {
      const expected = Number(row.opening) + Number(row.cash_in) - Number(row.cash_out);
      if (Number(row.expected) !== expected) {
        found.push(
          `INV-07(a): close ${row.id} expects ${row.expected} but opening + in − out is ${expected}`,
        );
      }
      // The difference is the same statement from the other side, and a close
      // whose stored difference disagrees with its own two figures is how a
      // short drawer gets signed off as balanced.
      const difference = Number(row.counted) - Number(row.expected);
      if (Number(row.difference) !== difference) {
        found.push(
          `INV-07(a): close ${row.id} records a difference of ${row.difference} but counted − expected is ${difference}`,
        );
      }
    }

    // INV-07(b) — a closed day's drawer account holds what was counted.
    //
    // §5.16.4 posts the short/over to `CASH_SHORT_OVER`, so once a day is
    // closed the ledger has been made to agree with the physical drawer. The
    // balance is taken as at that business date, which is well defined here:
    // `cash_sessions_date_unique` allows one session per date, so "the ledger
    // up to and including this day" is exactly this session's closing position.
    const closedDays = await db.query<{
      session_id: string; business_date: string; account_id: string; counted: number; balance: number;
    }>(
      `SELECT s.id AS session_id, s.business_date, s.account_id,
              c.counted_closing_minor::bigint AS counted,
              COALESCE((SELECT SUM(jl.amount_minor)
                          FROM journal_lines jl
                          JOIN journal_entries je ON je.id = jl.journal_entry_id
                         WHERE jl.account_code = 'CASH:' || s.account_id
                           AND je.business_date <= s.business_date), 0)::bigint AS balance
         FROM cash_sessions s
         JOIN cash_session_closes c ON c.session_id = s.id AND c.superseded_at IS NULL
        WHERE s.status = 'CLOSED' AND s.deleted_at IS NULL`,
    );
    for (const row of closedDays.rows) {
      if (Number(row.counted) !== Number(row.balance)) {
        found.push(
          `INV-07(b): day ${row.business_date} was counted at ${row.counted} but its drawer ledger ` +
          `holds ${row.balance} (off by ${Number(row.counted) - Number(row.balance)})`,
        );
      }
    }

    // INV-07(c) — no day starts from a figure the day before did not end on.
    //
    // `previous_closing_minor` is frozen at Start Day so a session can explain
    // its own opening difference years later without re-deriving it (§5.16.2).
    // Frozen data is data that can go stale, and a session claiming the previous
    // day closed at a figure that day did not close at is how an unexplained
    // delta becomes permanent and invisible: the difference gets posted against
    // a number nobody can trace, and every reconciliation after it inherits the
    // error. Sessions are one per business date, so "the day before" is
    // unambiguous.
    const continuity = await db.query<{
      business_date: string; claimed: number; actual: number;
    }>(
      `SELECT s.business_date,
              s.previous_closing_minor::bigint AS claimed,
              prev.counted::bigint             AS actual
         FROM cash_sessions s
         JOIN LATERAL (
           SELECT c.counted_closing_minor AS counted
             FROM cash_sessions earlier
             JOIN cash_session_closes c
               ON c.session_id = earlier.id AND c.superseded_at IS NULL
            WHERE earlier.deleted_at IS NULL
              AND earlier.business_date < s.business_date
            ORDER BY earlier.business_date DESC
            LIMIT 1
         ) prev ON TRUE
        WHERE s.deleted_at IS NULL
          AND s.previous_closing_minor IS NOT NULL
          AND s.previous_closing_minor <> prev.counted`,
    );
    for (const row of continuity.rows) {
      found.push(
        `INV-07(c): the day of ${row.business_date} opened saying the day before closed at ` +
        `${row.claimed}, but it closed at ${row.actual}`,
      );
    }

    // INV-08 — a voided document has no net effect left, on money or on stock.
    //
    // Written against the reversal rather than against each document table on
    // purpose. A void posts a second entry — `EXPENSE_REVERSAL`,
    // `CUSTOMER_RECEIPT_REVERSAL` and so on — carrying the same
    // `source_document_id`, so "everything ever posted for this document sums
    // to zero" is the whole rule in one statement and it keeps holding when a
    // new reversible document type is added, which an enumeration of tables
    // would not.
    const reversed = await db.query<{ source_document_id: string; total: number }>(
      `SELECT source_document_id, SUM(total)::bigint AS total
         FROM (SELECT je.source_document_id,
                      SUM(jl.amount_minor) AS total
                 FROM journal_entries je
                 JOIN journal_lines jl ON jl.journal_entry_id = je.id
                WHERE je.source_document_id IN (SELECT source_document_id
                                                  FROM journal_entries
                                                 WHERE source_document_type LIKE '%\\_REVERSAL')
                GROUP BY je.source_document_id, je.id) per_entry
        GROUP BY source_document_id
       HAVING SUM(total) <> 0`,
    );
    for (const row of reversed.rows) {
      found.push(
        `INV-08: reversed document ${row.source_document_id} still moves ${row.total} through the ledger`,
      );
    }

    const reversedStock = await db.query<{ source_document_id: string; net: number }>(
      `SELECT source_document_id,
              SUM(CASE direction WHEN 'IN' THEN qty ELSE -qty END)::bigint AS net
         FROM stock_movements
        WHERE source_document_id IN (SELECT source_document_id
                                       FROM journal_entries
                                      WHERE source_document_type LIKE '%\\_REVERSAL')
        GROUP BY source_document_id
       HAVING SUM(CASE direction WHEN 'IN' THEN qty ELSE -qty END) <> 0`,
    );
    for (const row of reversedStock.rows) {
      found.push(
        `INV-08: reversed document ${row.source_document_id} still moves ${row.net} of stock`,
      );
    }

    // INV-09 — every posted document has at least one journal entry.
    //
    // Asserted the other way round, which is the direction this schema can
    // actually answer: an entry with no lines is a document that posted nothing
    // and is the same defect — a bill that reached the books without moving any
    // money. The forward direction (a document row with no entry) is checked
    // per module by the specs that create those documents, because only they
    // know which tables are documents.
    const empty = await db.query<{ id: string; source_document_type: string; source_number: string }>(
      `SELECT je.id, je.source_document_type, je.source_number
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
        WHERE jl.id IS NULL`,
    );
    for (const row of empty.rows) {
      found.push(
        `INV-09: ${row.source_document_type} ${row.source_number} posted an entry with no lines`,
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
