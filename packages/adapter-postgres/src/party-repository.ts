import type {
  CustomerGroupEntry,
  NewParty,
  PartyCounts,
  PartyEdit,
  PartyFilter,
  PartyRepository,
  PartyRow,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { PartyRole, PartyStatus } from '@sher/core-domain';
import { customerPhoneKey } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import type { SQL } from 'drizzle-orm';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { customerGroups, parties, partyRoles } from './schema';
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
}

export class PostgresPartyRepository implements PartyRepository {
  constructor(private readonly clock: Clock) {}

  async list(tx: Tx, ctx: TenantContext, filter: PartyFilter): Promise<readonly PartyRow[]> {
    const rows = await this.selectParties(tx)
      .where(and(this.liveInTenant(ctx), ...this.filters(ctx, filter), ...this.after(ctx, filter)))
      // The fixed order the cursor walks: name, then id as the tiebreak for two
      // parties with the same name (§3.9 — keyset only, `OFFSET` is banned).
      .orderBy(asc(parties.name), asc(parties.id))
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
      })
      .from(parties)
      .where(and(this.liveInTenant(ctx), ...this.filters(ctx, filter)));

    const counts = rows[0];
    return {
      total: counts?.total ?? 0,
      active: counts?.active ?? 0,
      inactive: counts?.inactive ?? 0,
      ungrouped: counts?.ungrouped ?? 0,
    };
  }

  async findById(tx: Tx, ctx: TenantContext, id: string): Promise<PartyRow | null> {
    const rows = await this.selectParties(tx)
      .where(and(this.liveInTenant(ctx), eq(parties.id, id)))
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
      sql`(${parties.name}, ${parties.id}) > (
        SELECT anchor.name, anchor.id FROM parties anchor
         WHERE anchor.id = ${filter.cursor} AND anchor.tenant_id = ${ctx.tenantId}
      )`,
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
