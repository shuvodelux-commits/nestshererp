import { sql, type SQL } from 'drizzle-orm';

/**
 * Keyset paging over a caller-chosen sort column (§3.9, UI-46).
 *
 * Every list in SherERP lets the shopkeeper tap a header to reorder it, so the
 * sort column is chosen at request time — but paging is still keyset, never
 * `OFFSET`. This file is the one implementation of that combination, because
 * getting it subtly wrong loses rows silently and every list would have to be
 * wrong in the same way for anyone to notice.
 *
 * **Three things make it correct, and all three are easy to omit:**
 *
 * 1. **`id` is the last term of the sort, in the same direction.** The chosen
 *    column is rarely unique — twenty products can share a reorder level — and
 *    without a unique final term the database is free to return ties in a
 *    different order on each page. A shopkeeper paging through low stock would
 *    then see one product twice and never see another.
 * 2. **The comparison is a row value, not a chain of ANDs.** `(sort, id) > (a, b)`
 *    is one comparison Postgres can drive from an index; the hand-written
 *    `sort > a OR (sort = a AND id > b)` expansion is where off-by-one bugs live.
 * 3. **A sortable expression is never NULL.** Row-value comparison against a
 *    NULL yields NULL, the row fails the `WHERE`, and it vanishes from every
 *    page after the first — a product with no category would simply stop
 *    existing once you paged past it. Nullable columns are coalesced to a
 *    sentinel here rather than left to each caller to remember.
 *
 * The cursor stays **the id of the last row seen**, exactly as it was before
 * sorting became selectable: the query looks that row's sort value up itself,
 * so the client never carries an encoded key it could tamper with or mis-encode,
 * and a cursor from another shop matches nothing because the lookup is
 * tenant-scoped.
 */

export type Direction = 'ASC' | 'DESC';

/**
 * One sortable column: how to order by it, and how to read the same value back
 * for the cursor's anchor row.
 *
 * `expression` is evaluated against the row being ordered; `anchorExpression`
 * against the single anchor row inside the cursor subquery. They must compute
 * the same thing — which is why a joined name is expressed as a scalar subquery
 * on both sides rather than relying on a join that only one of them has.
 */
export interface SortableColumn {
  readonly expression: SQL;
  readonly anchorExpression: SQL;
}

/**
 * A joined display name — a category, a unit, a customer group — as a scalar
 * subquery, so ordering and the cursor anchor agree by construction.
 *
 * Coalesced to the empty string: a product with no category must still sort
 * somewhere rather than disappearing once the reader pages past it. Empty
 * sorts first ascending, which puts "not filed yet" at the top — where a
 * shopkeeper tapping `Category` to tidy up wants it.
 */
export function joinedName(
  table: string,
  nameColumn: string,
  foreignKey: SQL,
  anchorForeignKey: SQL,
): SortableColumn {
  const lookup = (fk: SQL): SQL =>
    sql`COALESCE((SELECT lookup.${sql.raw(nameColumn)} FROM ${sql.raw(table)} lookup WHERE lookup.id = ${fk}), '')`;

  return { expression: lookup(foreignKey), anchorExpression: lookup(anchorForeignKey) };
}

/**
 * A column on the row's own table.
 *
 * `nullSentinel` is required for a nullable column and must sort where a person
 * expects: a customer with no credit limit is not a customer with a limit of
 * zero, but for ordering purposes it has to be *somewhere*, and silently
 * dropping the row is the one option that is always wrong.
 */
export function ownColumn(
  column: SQL,
  anchorColumn: SQL,
  nullSentinel?: SQL,
): SortableColumn {
  if (nullSentinel === undefined) {
    return { expression: column, anchorExpression: anchorColumn };
  }
  return {
    expression: sql`COALESCE(${column}, ${nullSentinel})`,
    anchorExpression: sql`COALESCE(${anchorColumn}, ${nullSentinel})`,
  };
}

/**
 * `ORDER BY <chosen>, id` — both terms in the same direction.
 *
 * Same direction is not a style choice: it is what keeps the keyset predicate a
 * single row-value comparison. Mixing them (`price DESC, id ASC`) has no
 * row-value form, and the hand-expanded equivalent is where the off-by-one bugs
 * this file exists to prevent come from.
 */
export function orderBy(column: SortableColumn, direction: Direction, idColumn: SQL): SQL {
  const order = direction === 'ASC' ? sql`ASC` : sql`DESC`;
  return sql`${column.expression} ${order}, ${idColumn} ${order}`;
}

/**
 * The keyset predicate: everything ordered strictly after the cursor row.
 *
 * `tenantScope` is the anchor subquery's own tenant filter. It is a parameter
 * rather than an assumption because a cursor is a client-supplied id, and an
 * anchor lookup that forgot to scope by tenant would let one shop page through
 * another shop's ordering — a cross-tenant read that returns rows rather than
 * the 404 §3.9 requires.
 */
export function afterCursor(
  column: SortableColumn,
  direction: Direction,
  idColumn: SQL,
  anchorIdColumn: SQL,
  anchorFrom: SQL,
  tenantScope: SQL,
): SQL {
  const comparison = direction === 'ASC' ? sql`>` : sql`<`;

  return sql`(${column.expression}, ${idColumn}) ${comparison} (
    SELECT ${column.anchorExpression}, ${anchorIdColumn}
      FROM ${anchorFrom}
     WHERE ${tenantScope}
  )`;
}
