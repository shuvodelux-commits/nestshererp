import type {
  CustomerGroupEntry,
  NewParty,
  NewPartyOpening,
  PartyCounts,
  PartyEdit,
  PartyFilter,
  PartyLedgerFilter,
  PartyLedgerLineRow,
  PartyOpeningCorrection,
  PartyOpeningRow,
  PartyRepository,
  PartyRow,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { PartySort } from '@sher/core-contracts';
import type { PartyRole, PartyStatus } from '@sher/core-domain';
import { customerPhoneKey, PARTY_BALANCE_ACCOUNTS } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import type { SQL } from 'drizzle-orm';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { afterCursor, joinedName, orderBy, ownColumn, type SortableColumn } from './keyset-sort';
import {
  customerGroups,
  journalEntries,
  journalLines,
  parties,
  partyOpenings,
  partyRoles,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Parties and customer groups (migration 0009). No business rule here (R-B6) —
 * D-02's refusal, the walk-in party's immunity, feature gating and the
 * optimistic lock are all decided in `ManagePartiesService`.
 *
 * The one thing this file does own is deriving `customer_phone_key` from the
 * roles and phone it is handed. That is a property of the partial unique index
 * D-02 needs, not a decision about the business: the rule ("unique within the
 * CUSTOMER role") is stated in the migration and enforced by PostgreSQL, and the
 * refusal a person reads is raised in the use case.
 */
const ROLE_ORDER: readonly PartyRole[] = ['CUSTOMER', 'SUPPLIER', 'VENDOR'];

/**
 * The accounts a party's balance is made of, as a SQL list.
 *
 * Built from the domain's `PARTY_BALANCE_ACCOUNTS` rather than written out
 * here, so adding an account to the closed chart in `account.ts` cannot leave
 * this query summing an outdated set — which would show a balance that quietly
 * disagreed with the ledger.
 *
 * All of them are fixed accounts with no `:` segment, so plain equality is
 * enough; a parameterised account never belongs to a party.
 */
const BALANCE_ACCOUNTS = sql.join(
  PARTY_BALANCE_ACCOUNTS.map((account) => sql`${account}`),
  sql`, `,
);

/**
 * INV-06 as a scalar subquery: a party's balance *is* the sum of their journal
 * lines, so the list computes it rather than reading a cached column.
 *
 * Correlated per row, which sounds expensive and is not: migration 0015's
 * partial index on `(tenant_id, party_id, …)` makes each one an index-only
 * range scan, and a page is at most 200 rows.
 *
 * Parameterised by the table it reads, because the same expression has to be
 * computed twice: once against the row being ordered, and once against the
 * cursor's `anchor` row, which selects from `parties` alone.
 *
 * `COALESCE` to zero matters — a party who has never traded has no lines at
 * all, and a NULL here would render as an empty balance cell rather than the
 * "settled" the shopkeeper needs to see. It is also what keeps a never-traded
 * party from vanishing after the first page when the list is sorted by balance.
 */
function balanceNetMinorOf(tenantId: SQL, partyId: SQL): SQL<number> {
  return sql<number>`COALESCE((
  SELECT SUM(jl.amount_minor)
  FROM journal_lines jl
  WHERE jl.tenant_id = ${tenantId}
    AND jl.party_id = ${partyId}
    AND jl.account_code IN (${BALANCE_ACCOUNTS})
), 0)::bigint`;
}

const BALANCE_NET_MINOR = balanceNetMinorOf(sql`${parties.tenantId}`, sql`${parties.id}`);

/**
 * Whether anything has ever posted against this party (§3.6's "never used").
 *
 * `EXISTS` rather than a count or a sum: the delete guard and the row's `⋯`
 * menu only need to know *whether*, and migration 0015's partial index answers
 * it from the first matching row rather than reading them all.
 *
 * Deliberately every account, not just the six a balance is made of. A party
 * named on any posted line has history worth keeping, and a delete would orphan
 * that line just the same.
 */
const HAS_LEDGER_ENTRIES = sql<boolean>`EXISTS (
  SELECT 1
  FROM journal_lines jl
  WHERE jl.tenant_id = ${parties.tenantId}
    AND jl.party_id = ${parties.id}
)`;

/**
 * What each tappable header on the Customers / Suppliers / Vendors list orders
 * by (UI-46). This map is the allow-list at the database boundary: `PartySort` is
 * a closed enum, so no column name is ever built from a request.
 *
 * The group name is a scalar subquery, matching how the cursor's anchor lookup
 * sees it — the anchor selects from `parties` alone and has no join. Nullable
 * columns are coalesced, or the row-value comparison would go NULL and the row
 * would disappear from every page after the first: a customer with no phone
 * would stop existing the moment someone sorted by phone and paged.
 */
const PARTY_SORTS: Record<PartySort, SortableColumn> = {
  name: ownColumn(sql`${parties.name}`, sql`anchor.name`),
  phone: ownColumn(sql`${parties.phone}`, sql`anchor.phone`, sql`''`),
  groupName: joinedName(
    'customer_groups',
    'name',
    sql`${parties.customerGroupId}`,
    sql`anchor.customer_group_id`,
  ),
  // No limit is not a limit of zero, but it has to sort somewhere: -1 puts
  // 'unlimited' below every real limit ascending, and dropping the row is the
  // one option that is always wrong.
  creditLimit: ownColumn(sql`${parties.creditLimitMinor}`, sql`anchor.credit_limit_minor`, sql`-1`),
  status: ownColumn(sql`${parties.status}`, sql`anchor.status`),
  /**
   * "Current Due (High to Low)" — the INV-06 rollup, ordered by the very
   * expression the row displays, so the sort and the figure cannot disagree.
   *
   * Both sides are spelled out because the anchor row is `anchor`, not
   * `parties`: a keyset cursor looks the previous row's sort value up itself,
   * and computing it from the wrong table would page through a different
   * ordering than the one on screen. It is never NULL — `COALESCE(…, 0)` is
   * inside the expression — so no party vanishes after the first page.
   */
  balance: ownColumn(
    BALANCE_NET_MINOR,
    balanceNetMinorOf(sql`anchor.tenant_id`, sql`anchor.id`),
  ),
};

const PARTY_COLUMNS = {
  id: parties.id,
  name: parties.name,
  phone: parties.phone,
  address: parties.address,
  guardianName: parties.guardianName,
  nid: parties.nid,
  email: parties.email,
  notes: parties.notes,
  customerGroupId: parties.customerGroupId,
  customerGroupName: customerGroups.name,
  creditLimitMinor: parties.creditLimitMinor,
  status: parties.status,
  isSystemReserved: parties.isSystemReserved,
  version: parties.version,
  balanceNetMinor: BALANCE_NET_MINOR,
  hasLedgerEntries: HAS_LEDGER_ENTRIES,
};

interface RawParty {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly guardianName: string | null;
  readonly nid: string | null;
  readonly email: string | null;
  readonly notes: string | null;
  readonly customerGroupId: string | null;
  readonly customerGroupName: string | null;
  readonly creditLimitMinor: number | null;
  readonly status: string;
  readonly isSystemReserved: boolean;
  readonly version: number;
  readonly balanceNetMinor: number;
  readonly hasLedgerEntries: boolean;
}

export class PostgresPartyRepository implements PartyRepository {
  constructor(private readonly clock: Clock) {}

  async list(tx: Tx, ctx: TenantContext, filter: PartyFilter): Promise<readonly PartyRow[]> {
    const rows = await this.selectParties(tx)
      .where(and(this.liveInTenant(ctx), ...this.filters(ctx, filter), ...this.after(ctx, filter)))
      // Whichever header was tapped, then id in the same direction as the
      // tiebreak (§3.9, UI-46 — keyset only, `OFFSET` is banned).
      .orderBy(orderBy(PARTY_SORTS[filter.sort], filter.direction, sql`${parties.id}`))
      .limit(filter.limit);

    return this.withRoles(tx, ctx, rows);
  }

  /**
   * The tile figures, over the same filter as the rows but without paging, in one
   * round trip. Four counts taken at four moments could disagree with each other.
   */
  async count(tx: Tx, ctx: TenantContext, filter: PartyFilter): Promise<PartyCounts> {
    const rows = await txOf(tx)
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) FILTER (WHERE ${parties.status} = 'ACTIVE')::int`,
        inactive: sql<number>`count(*) FILTER (WHERE ${parties.status} = 'INACTIVE')::int`,
        ungrouped: sql<number>`count(*) FILTER (WHERE ${parties.customerGroupId} IS NULL)::int`,
        /*
         * The money tiles, from the same query and the same filter as the rows
         * (§2.7.I). Summed as two one-sided totals rather than one net, because
         * netting would hide a shop carrying large receivables *and* large
         * advances behind a small-looking difference.
         */
        totalOutstandingMinor: sql<number>`COALESCE(SUM(GREATEST(${BALANCE_NET_MINOR}, 0)), 0)::bigint`,
        totalAdvanceMinor: sql<number>`COALESCE(SUM(GREATEST(-${BALANCE_NET_MINOR}, 0)), 0)::bigint`,
        /*
         * `exceedsCreditLimit` in SQL. A NULL limit is no limit, not zero, so
         * the FILTER's NULL comparison correctly excludes those rows; `>` and
         * not `>=` lets a customer sit exactly on their limit, matching the
         * domain function the sale path will call.
         */
        overCreditLimit: sql<number>`count(*) FILTER (
          WHERE ${parties.creditLimitMinor} IS NOT NULL
            AND GREATEST(${BALANCE_NET_MINOR}, 0) > ${parties.creditLimitMinor}
        )::int`,
      })
      .from(parties)
      .where(and(this.liveInTenant(ctx), ...this.filters(ctx, filter)));

    const counts = rows[0];
    return {
      total: counts?.total ?? 0,
      active: counts?.active ?? 0,
      inactive: counts?.inactive ?? 0,
      ungrouped: counts?.ungrouped ?? 0,
      totalOutstandingMinor: counts?.totalOutstandingMinor ?? 0,
      totalAdvanceMinor: counts?.totalAdvanceMinor ?? 0,
      overCreditLimit: counts?.overCreditLimit ?? 0,
    };
  }

  async findById(tx: Tx, ctx: TenantContext, id: string): Promise<PartyRow | null> {
    const rows = await this.selectParties(tx)
      .where(and(this.liveInTenant(ctx), eq(parties.id, id)))
      .limit(1);

    const withRoles = await this.withRoles(tx, ctx, rows);
    return withRoles[0] ?? null;
  }

  /** The seeded walk-in customer every fully paid guest sale posts against. */
  async findWalkInCustomer(tx: Tx, ctx: TenantContext): Promise<PartyRow | null> {
    const rows = await this.selectParties(tx)
      .where(and(this.liveInTenant(ctx), eq(parties.isSystemReserved, true)))
      .limit(1);

    const withRoles = await this.withRoles(tx, ctx, rows);
    return withRoles[0] ?? null;
  }

  /** D-02: the party already holding this phone **as a customer**, if any. */
  async findCustomerIdByPhone(
    tx: Tx,
    ctx: TenantContext,
    phone: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: parties.id })
      .from(parties)
      .where(and(this.liveInTenant(ctx), eq(parties.customerPhoneKey, customerPhoneKey(phone))))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async insert(tx: Tx, ctx: TenantContext, party: NewParty): Promise<void> {
    const now = this.clock.now();
    const { roles, ...columns } = party;

    await txOf(tx)
      .insert(parties)
      .values({
        ...columns,
        status: 'ACTIVE',
        customerPhoneKey: phoneKeyFor(roles, party.phone),
        tenantId: ctx.tenantId,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });

    await this.writeRoles(tx, ctx, party.id, roles);
  }

  /**
   * D-32's optimistic lock lives in the `WHERE` clause: the update matches only
   * while the row is still at the version the editor read. `false` means someone
   * else saved first, and the use case turns that into `CONFLICT_STALE_VERSION`.
   *
   * The role set is rewritten inside the same statement's transaction, so a
   * party is never briefly stored with a phone key that contradicts its roles.
   */
  async update(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    expectedVersion: number,
    party: PartyEdit,
  ): Promise<boolean> {
    const { roles, ...columns } = party;

    const updated = await txOf(tx)
      .update(parties)
      .set({
        ...columns,
        customerPhoneKey: phoneKeyFor(roles, party.phone),
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${parties.version} + 1`,
      })
      .where(and(this.liveInTenant(ctx), eq(parties.id, id), eq(parties.version, expectedVersion)))
      .returning({ id: parties.id });

    if (updated.length === 0) return false;

    await this.writeRoles(tx, ctx, id, roles);
    return true;
  }

  async setStatus(tx: Tx, ctx: TenantContext, id: string, status: PartyStatus): Promise<void> {
    await txOf(tx)
      .update(parties)
      .set({
        status,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${parties.version} + 1`,
      })
      .where(and(this.liveInTenant(ctx), eq(parties.id, id)));
  }

  async deleteUnused(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .delete(partyRoles)
      .where(and(eq(partyRoles.tenantId, ctx.tenantId), eq(partyRoles.partyId, id)));
    await txOf(tx)
      .delete(parties)
      .where(and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, id)));
  }

  /* ------------------------------------------------------- customer groups */

  async listGroups(tx: Tx, ctx: TenantContext): Promise<readonly CustomerGroupEntry[]> {
    return txOf(tx)
      .select({ id: customerGroups.id, name: customerGroups.name })
      .from(customerGroups)
      .where(
        and(eq(customerGroups.tenantId, ctx.tenantId), isNull(customerGroups.deletedAt)),
      )
      .orderBy(asc(customerGroups.name));
  }

  async findGroup(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<CustomerGroupEntry | null> {
    const rows = await txOf(tx)
      .select({ id: customerGroups.id, name: customerGroups.name })
      .from(customerGroups)
      .where(
        and(
          eq(customerGroups.tenantId, ctx.tenantId),
          eq(customerGroups.id, id),
          isNull(customerGroups.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insertGroup(tx: Tx, ctx: TenantContext, group: CustomerGroupEntry): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .insert(customerGroups)
      .values({
        id: group.id,
        tenantId: ctx.tenantId,
        name: group.name,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });
  }

  async renameGroup(tx: Tx, ctx: TenantContext, id: string, name: string): Promise<void> {
    await txOf(tx)
      .update(customerGroups)
      .set({
        name,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${customerGroups.version} + 1`,
      })
      .where(
        and(
          eq(customerGroups.tenantId, ctx.tenantId),
          eq(customerGroups.id, id),
          isNull(customerGroups.deletedAt),
        ),
      );
  }

  async deleteGroup(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .delete(customerGroups)
      .where(and(eq(customerGroups.tenantId, ctx.tenantId), eq(customerGroups.id, id)));
  }

  async archiveGroup(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .update(customerGroups)
      .set({
        deletedAt: now,
        deletedBy: ctx.userId,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${customerGroups.version} + 1`,
      })
      .where(and(eq(customerGroups.tenantId, ctx.tenantId), eq(customerGroups.id, id)));
  }

  async countInGroup(tx: Tx, ctx: TenantContext, groupId: string): Promise<number> {
    const rows = await txOf(tx)
      .select({ total: sql<number>`count(*)::int` })
      .from(parties)
      .where(and(this.liveInTenant(ctx), eq(parties.customerGroupId, groupId)));
    return rows[0]?.total ?? 0;
  }

  /* --------------------------------------------------- openings and ledger */

  async insertOpening(tx: Tx, ctx: TenantContext, opening: NewPartyOpening): Promise<void> {
    const now = this.clock.now();
    const owner = {
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
    };

    await txOf(tx)
      .insert(partyOpenings)
      .values({
        id: opening.id,
        ...owner,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: 1,
        openingNumber: opening.number,
        partyId: opening.partyId,
        role: opening.role,
        direction: opening.direction,
        amountMinor: opening.amountMinor,
        businessDate: opening.businessDate,
        entryMode: opening.entryMode,
        status: 'POSTED',
        operationId: opening.operationId,
      });

    // The document and its posting in the same transaction. `OPENING_BALANCE`
    // is the source type a ledger row shows, and 0012's unique on
    // (tenant, source type, source id) makes a double-post impossible.
    await txOf(tx)
      .insert(journalEntries)
      .values({
        id: opening.journalEntryId,
        ...owner,
        businessDate: opening.businessDate,
        sourceDocumentType: 'OPENING_BALANCE',
        sourceDocumentId: opening.id,
        sourceNumber: opening.number,
        entryMode: opening.entryMode,
      });

    await txOf(tx)
      .insert(journalLines)
      .values(
        opening.journalLines.map((line) => ({
          id: line.id,
          ...owner,
          journalEntryId: opening.journalEntryId,
          accountCode: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
      );
  }

  async findOpening(
    tx: Tx,
    ctx: TenantContext,
    partyId: string,
    role: PartyRole,
  ): Promise<PartyOpeningRow | null> {
    const rows = await txOf(tx)
      .select({
        id: partyOpenings.id,
        number: partyOpenings.openingNumber,
        role: partyOpenings.role,
        direction: partyOpenings.direction,
        amountMinor: partyOpenings.amountMinor,
        businessDate: partyOpenings.businessDate,
        version: partyOpenings.version,
      })
      .from(partyOpenings)
      .where(
        and(
          eq(partyOpenings.tenantId, ctx.tenantId),
          isNull(partyOpenings.deletedAt),
          eq(partyOpenings.partyId, partyId),
          eq(partyOpenings.role, role),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id.trim(),
      number: row.number,
      role: row.role as PartyRole,
      direction: row.direction as 'RECEIVABLE' | 'PAYABLE',
      amountMinor: row.amountMinor,
      businessDate: row.businessDate,
      version: row.version,
    };
  }

  /**
   * A §2.5 correction: the document takes the new figure, one journal entry
   * carries the reversal and the repost, and the original posting is left
   * untouched.
   *
   * The `WHERE … AND version = ?` is D-32's lock in the statement itself, so
   * the loser of a simultaneous correction changes nothing and is told, rather
   * than reading a version, being overtaken, and writing anyway. Returning
   * early on a miss also matters: the journal must not gain a correction for a
   * document that was not the one being corrected.
   */
  async correctOpening(
    tx: Tx,
    ctx: TenantContext,
    correction: PartyOpeningCorrection,
  ): Promise<boolean> {
    const now = this.clock.now();

    const updated = await txOf(tx)
      .update(partyOpenings)
      .set({
        direction: correction.direction,
        amountMinor: correction.amountMinor,
        businessDate: correction.businessDate,
        entryMode: correction.entryMode,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${partyOpenings.version} + 1`,
      })
      .where(
        and(
          eq(partyOpenings.tenantId, ctx.tenantId),
          isNull(partyOpenings.deletedAt),
          eq(partyOpenings.id, correction.openingId),
          eq(partyOpenings.version, correction.expectedVersion),
        ),
      )
      .returning({ id: partyOpenings.id });

    if (updated.length === 0) return false;

    const owner = { tenantId: ctx.tenantId, createdAt: now, createdBy: ctx.userId };

    /*
     * Its own source type and id, because `journal_entries_source_unique` is on
     * (tenant, source type, source id) and the opening's own entry already
     * holds `OPENING_BALANCE` for this document. A correction is a second
     * document event over the same opening, and the statement shows it as one.
     */
    await txOf(tx)
      .insert(journalEntries)
      .values({
        id: correction.journalEntryId,
        ...owner,
        businessDate: correction.businessDate,
        sourceDocumentType: 'OPENING_BALANCE_CORRECTION',
        sourceDocumentId: correction.correctionId,
        sourceNumber: correction.correctionNumber,
        entryMode: correction.entryMode,
      });

    await txOf(tx)
      .insert(journalLines)
      .values(
        correction.journalLines.map((line) => ({
          id: line.id,
          ...owner,
          journalEntryId: correction.journalEntryId,
          accountCode: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
      );

    return true;
  }

  async listLedgerLines(
    tx: Tx,
    ctx: TenantContext,
    filter: PartyLedgerFilter,
  ): Promise<readonly PartyLedgerLineRow[]> {
    const rows = await txOf(tx)
      .select({
        journalEntryId: journalEntries.id,
        journalLineId: journalLines.id,
        businessDate: journalEntries.businessDate,
        sourceDocumentType: journalEntries.sourceDocumentType,
        sourceDocumentId: journalEntries.sourceDocumentId,
        sourceNumber: journalEntries.sourceNumber,
        account: journalLines.accountCode,
        amountMinor: journalLines.amountMinor,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(and(...this.ledgerFilters(ctx, filter), ...this.ledgerAfter(ctx, filter)))
      /*
       * Business date first, then the journal line's own creation order. Two
       * entries posted on the same business date have to break the tie the same
       * way every time, or a running balance would shuffle between page loads
       * and the closing figure of page one would not match the opening of
       * page two.
       */
      .orderBy(
        asc(journalEntries.businessDate),
        asc(journalLines.createdAt),
        asc(journalLines.id),
      )
      .limit(filter.limit);

    return rows.map((row) => ({
      ...row,
      journalEntryId: row.journalEntryId.trim(),
      journalLineId: row.journalLineId.trim(),
      sourceDocumentId: row.sourceDocumentId.trim(),
    }));
  }

  async sumLedgerBefore(
    tx: Tx,
    ctx: TenantContext,
    filter: PartyLedgerFilter,
  ): Promise<number> {
    /*
     * With neither a date floor nor a cursor there is nothing before the
     * window — the statement starts at the beginning of history, so it opens at
     * zero.
     *
     * This is not an optimisation. Without it the conditions below reduce to
     * "every line this party has", the opening balance comes back equal to the
     * closing one, and every running total on an unfiltered first page is
     * doubled — a statement that is wrong and still adds up internally.
     */
    if (filter.fromDate === null && filter.cursor === null) return 0;

    /*
     * Everything before the window, whatever "before" means for this request:
     * with a `fromDate`, every line dated earlier; with a cursor, every line
     * that sorts ahead of it. Both can apply at once on page two of a filtered
     * statement, which is why they are separate conditions rather than a
     * single one.
     */
    const conditions: (SQL<unknown> | undefined)[] = [
      eq(journalLines.tenantId, ctx.tenantId),
      eq(journalLines.partyId, filter.partyId),
      sql`${journalLines.accountCode} IN (${BALANCE_ACCOUNTS})`,
    ];

    if (filter.fromDate !== null) {
      conditions.push(sql`${journalEntries.businessDate} < ${filter.fromDate}`);
    }

    if (filter.cursor !== null) {
      conditions.push(
        sql`(${journalEntries.businessDate}, ${journalLines.createdAt}, ${journalLines.id}) <
            (SELECT e.business_date, l.created_at, l.id
             FROM journal_lines l
             JOIN journal_entries e ON e.id = l.journal_entry_id
             WHERE l.tenant_id = ${ctx.tenantId} AND l.id = ${filter.cursor})`,
      );
    }

    const rows = await txOf(tx)
      .select({ net: sql<number>`COALESCE(SUM(${journalLines.amountMinor}), 0)::bigint` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(and(...conditions));

    return rows[0]?.net ?? 0;
  }

  private ledgerFilters(ctx: TenantContext, filter: PartyLedgerFilter) {
    const conditions: (SQL<unknown> | undefined)[] = [
      eq(journalLines.tenantId, ctx.tenantId),
      eq(journalLines.partyId, filter.partyId),
      // The same account set the balance is summed over, so the rows on the
      // statement are exactly the rows behind the figure in its header.
      sql`${journalLines.accountCode} IN (${BALANCE_ACCOUNTS})`,
    ];

    // Inclusive both ends — what someone asking for "January" means.
    if (filter.fromDate !== null) {
      conditions.push(sql`${journalEntries.businessDate} >= ${filter.fromDate}`);
    }
    if (filter.toDate !== null) {
      conditions.push(sql`${journalEntries.businessDate} <= ${filter.toDate}`);
    }

    return conditions;
  }

  /** Keyset paging on the same triple the ordering uses (§3.9 — no `OFFSET`). */
  private ledgerAfter(ctx: TenantContext, filter: PartyLedgerFilter) {
    if (filter.cursor === null) return [];

    return [
      sql`(${journalEntries.businessDate}, ${journalLines.createdAt}, ${journalLines.id}) >
          (SELECT e.business_date, l.created_at, l.id
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
           WHERE l.tenant_id = ${ctx.tenantId} AND l.id = ${filter.cursor})`,
    ];
  }

  /* ------------------------------------------------------------- mechanics */

  private selectParties(tx: Tx) {
    return txOf(tx)
      .select(PARTY_COLUMNS)
      .from(parties)
      .leftJoin(customerGroups, eq(customerGroups.id, parties.customerGroupId));
  }

  private liveInTenant(ctx: TenantContext) {
    return and(eq(parties.tenantId, ctx.tenantId), isNull(parties.deletedAt));
  }

  private filters(ctx: TenantContext, filter: PartyFilter) {
    // Drizzle's `or` is typed as possibly undefined, and `and` accepts that.
    const conditions: (SQL<unknown> | undefined)[] = [this.holdsRole(ctx, filter.role)];

    if (filter.search !== null && filter.search !== '') {
      // What someone types at a counter: a name, or the number they were given.
      // `parties_name_trgm_idx` is what keeps the name half off a full scan.
      const pattern = `%${filter.search}%`;
      conditions.push(
        or(sql`${parties.name} ILIKE ${pattern}`, sql`${parties.phone} ILIKE ${pattern}`),
      );
    }

    if (filter.groupId !== null) conditions.push(eq(parties.customerGroupId, filter.groupId));
    if (filter.status !== null) conditions.push(eq(parties.status, filter.status));

    return conditions;
  }

  /**
   * §5.6: "Sales/POS shows customers by default; Purchase screens show suppliers
   * by default … never show every party type by default." The role is therefore
   * part of every list query rather than an optional filter.
   */
  private holdsRole(ctx: TenantContext, role: PartyRole) {
    return sql`EXISTS (
      SELECT 1 FROM party_roles pr
       WHERE pr.party_id = ${parties.id}
         AND pr.tenant_id = ${ctx.tenantId}
         AND pr.role = ${role}
         AND pr.deleted_at IS NULL
    )`;
  }

  /**
   * The keyset cursor (§3.9): everything ordered after the last row of the
   * previous page. The subquery is tenant-scoped, so a cursor from another shop
   * matches nothing instead of paging through this one.
   */
  private after(ctx: TenantContext, filter: PartyFilter) {
    if (filter.cursor === null) return [];

    return [
      afterCursor(
        PARTY_SORTS[filter.sort],
        filter.direction,
        sql`${parties.id}`,
        sql`anchor.id`,
        sql`parties anchor`,
        sql`anchor.id = ${filter.cursor} AND anchor.tenant_id = ${ctx.tenantId}`,
      ),
    ];
  }

  /** One extra query for the whole page's roles, not one per row. */
  private async withRoles(
    tx: Tx,
    ctx: TenantContext,
    rows: readonly RawParty[],
  ): Promise<readonly PartyRow[]> {
    if (rows.length === 0) return [];

    const held = await txOf(tx)
      .select({ partyId: partyRoles.partyId, role: partyRoles.role })
      .from(partyRoles)
      .where(
        and(
          eq(partyRoles.tenantId, ctx.tenantId),
          isNull(partyRoles.deletedAt),
          inArray(
            partyRoles.partyId,
            rows.map((row) => row.id),
          ),
        ),
      );

    const byParty = new Map<string, PartyRole[]>();
    for (const row of held) {
      const list = byParty.get(row.partyId) ?? [];
      list.push(row.role as PartyRole);
      byParty.set(row.partyId, list);
    }

    return rows.map((row) => ({
      ...row,
      status: row.status as PartyStatus,
      roles: ROLE_ORDER.filter((role) => (byParty.get(row.id) ?? []).includes(role)),
    }));
  }

  /**
   * Rewrites a party's role set: revive what is wanted, soft-delete what is not.
   *
   * Soft rather than hard, like `role_permissions` since Phase 0 — a role taken
   * away and given back should revive the row rather than collide with the
   * partial unique index, and the audit trail of who was what is worth keeping.
   */
  private async writeRoles(
    tx: Tx,
    ctx: TenantContext,
    partyId: string,
    roles: readonly PartyRole[],
  ): Promise<void> {
    const now = this.clock.now();

    const existing = await txOf(tx)
      .select({ id: partyRoles.id, role: partyRoles.role, deletedAt: partyRoles.deletedAt })
      .from(partyRoles)
      .where(and(eq(partyRoles.tenantId, ctx.tenantId), eq(partyRoles.partyId, partyId)));

    for (const row of existing) {
      const wanted = roles.includes(row.role as PartyRole);
      if (wanted && row.deletedAt !== null) {
        await txOf(tx)
          .update(partyRoles)
          .set({
            deletedAt: null,
            deletedBy: null,
            updatedAt: now,
            updatedBy: ctx.userId,
            version: sql`${partyRoles.version} + 1`,
          })
          .where(eq(partyRoles.id, row.id));
      } else if (!wanted && row.deletedAt === null) {
        await txOf(tx)
          .update(partyRoles)
          .set({
            deletedAt: now,
            deletedBy: ctx.userId,
            updatedAt: now,
            updatedBy: ctx.userId,
            version: sql`${partyRoles.version} + 1`,
          })
          .where(eq(partyRoles.id, row.id));
      }
    }

    const known = new Set(existing.map((row) => row.role));
    const missing = roles.filter((role) => !known.has(role));
    if (missing.length === 0) return;

    await txOf(tx)
      .insert(partyRoles)
      .values(
        missing.map((role) => ({
          id: Ulid.generate(this.clock),
          tenantId: ctx.tenantId,
          partyId,
          role,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
        })),
      );
  }
}

/**
 * D-02's uniqueness key: the customer's phone, or NULL for anyone who is not a
 * customer. NULL is what keeps the many suppliers without a phone from
 * colliding with each other in the partial unique index.
 */
function phoneKeyFor(roles: readonly PartyRole[], phone: string | null): string | null {
  if (!roles.includes('CUSTOMER') || phone === null || phone === '') return null;
  return customerPhoneKey(phone);
}
