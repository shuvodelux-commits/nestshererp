import type { PartyRole, PartyStatus } from '@sher/core-domain';
import type { PartySort, SortDirection } from '@sher/core-contracts';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * A party row as stored (migration 0009), plus its roles and its group's name —
 * a list showing group ids is a list nobody can read, and fetching the name per
 * row would be a query per party.
 */
export interface PartyRow {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly PartyRole[];
  readonly phone: string | null;
  readonly address: string | null;
  readonly guardianName: string | null;
  readonly nid: string | null;
  readonly email: string | null;
  readonly notes: string | null;
  readonly customerGroupId: string | null;
  readonly customerGroupName: string | null;
  readonly creditLimitMinor: number | null;
  readonly status: PartyStatus;
  readonly isSystemReserved: boolean;
  readonly version: number;
  /**
   * The INV-06 rollup of this party's journal lines, computed in the same query
   * as the row (§2.7.I) so a list column and the ledger under it cannot
   * disagree. Signed: positive means the party owes the shop.
   *
   * Not a stored column — see `migrations/0015_party_openings.sql` for why a
   * cached balance is refused.
   */
  readonly balanceNetMinor: number;
  /**
   * Whether any journal line has ever named this party (§3.6).
   *
   * The delete guard and the row's `⋯` menu both need it, and a settled
   * balance does not answer it: a customer who owed 500 and paid it nets to
   * zero and still has a statement. Deleting them would leave those lines
   * pointing at a party that no longer exists, which is INV-06 broken in the
   * one direction nothing would notice.
   */
  readonly hasLedgerEntries: boolean;
}

/**
 * An opening balance document as it stands, for the correction dialog and the
 * §2.5 correction path.
 */
export interface PartyOpeningRow {
  readonly id: string;
  readonly number: string;
  readonly role: PartyRole;
  readonly direction: 'RECEIVABLE' | 'PAYABLE';
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly version: number;
}

/**
 * Correcting a posted opening (§2.5): the document takes the new figure, and
 * **one** journal entry both reverses the old posting and posts the new one.
 *
 * A single entry rather than two, because `journal_entries_source_unique` is on
 * (tenant, source type, source id) and a correction is one document event. Its
 * four lines give the party two statement rows — the reversal and the repost —
 * so a shopkeeper reading the ledger sees what the figure was, that it was
 * corrected, and what it became. Nothing posted is ever edited or removed.
 */
export interface PartyOpeningCorrection {
  readonly openingId: string;
  /** D-32: the version the corrector was looking at. */
  readonly expectedVersion: number;
  readonly role: PartyRole;
  readonly direction: 'RECEIVABLE' | 'PAYABLE';
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly journalEntryId: string;
  /** The correction document's own id and number, for the journal's source. */
  readonly correctionId: string;
  readonly correctionNumber: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
}

/**
 * An opening balance document, as the repository stores it (migration 0015).
 *
 * The journal entry travels with it for the same reason `OpeningStockRecord`
 * carries its lines: the document and the posting it produced are written in
 * one transaction or neither, or a balance would exist with no document to
 * explain it (or worse, the reverse).
 */
export interface NewPartyOpening {
  readonly id: string;
  readonly number: string;
  readonly partyId: string;
  readonly role: PartyRole;
  readonly direction: 'RECEIVABLE' | 'PAYABLE';
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly operationId: string;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
}

/** One journal line of a party's statement, joined to its document. */
export interface PartyLedgerLineRow {
  readonly journalEntryId: string;
  readonly journalLineId: string;
  readonly businessDate: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly sourceNumber: string;
  readonly account: string;
  readonly amountMinor: number;
}

export interface PartyLedgerFilter {
  readonly partyId: string;
  /** Inclusive. `null` means unbounded on that end. */
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * What a write supplies. Ids are generated by the use case (R-C1).
 *
 * `roles` travels with the row rather than being written separately, because
 * `customer_phone_key` — the column D-02's unique index is built on — is derived
 * from the roles and the phone together. Splitting them would let a party exist
 * for one statement with a key that contradicts its roles.
 */
export interface NewParty {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly PartyRole[];
  readonly phone: string | null;
  readonly address: string | null;
  readonly guardianName: string | null;
  readonly nid: string | null;
  readonly email: string | null;
  readonly notes: string | null;
  readonly customerGroupId: string | null;
  readonly creditLimitMinor: number | null;
  /** True only for D-02's walk-in party, which the tenant is provisioned with. */
  readonly isSystemReserved: boolean;
}

export type PartyEdit = Omit<NewParty, 'id' | 'isSystemReserved'>;

export interface PartyFilter {
  /** Always set: §5.6 forbids showing every party type by default. */
  readonly role: PartyRole;
  readonly search: string | null;
  readonly groupId: string | null;
  readonly status: PartyStatus | null;
  /** Keyset cursor: the id of the last row of the previous page (§3.9). */
  readonly cursor: string | null;
  readonly limit: number;
  /** Which header the shopkeeper tapped (UI-46), already allow-list checked. */
  readonly sort: PartySort;
  readonly direction: SortDirection;
}

export interface PartyCounts {
  readonly total: number;
  readonly active: number;
  readonly inactive: number;
  readonly ungrouped: number;
  /** Unsigned money totals over the same filter — see `partySummarySchema`. */
  readonly totalOutstandingMinor: number;
  readonly totalAdvanceMinor: number;
  readonly overCreditLimit: number;
}

/** A customer group (§5.6). */
export interface CustomerGroupEntry {
  readonly id: string;
  readonly name: string;
}

/**
 * Parties and their groups (migration 0009). Business-specific, per D-14 —
 * shaped so a SQLite implementation can satisfy it in Phase 12 without changing
 * a use case.
 *
 * No business rule lives here (R-B6): D-02's uniqueness refusal, the walk-in
 * party's immunity, feature gating, hidden-field preservation and the optimistic
 * lock are all decided in `ManagePartiesService` before anything reaches this
 * file. What the repository does own is the mechanical derivation of
 * `customer_phone_key` from the roles and phone it is handed, because that is a
 * property of the unique index, not a decision about the business.
 */
export interface PartyRepository {
  list(tx: Tx, ctx: TenantContext, filter: PartyFilter): Promise<readonly PartyRow[]>;
  /** Counts over the same filter, minus paging, so a tile matches its table. */
  count(tx: Tx, ctx: TenantContext, filter: PartyFilter): Promise<PartyCounts>;

  findById(tx: Tx, ctx: TenantContext, id: string): Promise<PartyRow | null>;
  /**
   * The shop's system walk-in customer, seeded with the tenant (§5.6, §5.8).
   *
   * Every fully paid guest sale posts against it, so the POS asks for it on
   * each sale rather than caching an id that would be wrong for the next
   * tenant. Matched on `is_system_reserved` rather than on the name, because
   * the name is a display string and a shop that renames anything must not end
   * up with two walk-in parties.
   */
  findWalkInCustomer(tx: Tx, ctx: TenantContext): Promise<PartyRow | null>;
  /**
   * D-02's duplicate check: the id of the party that already holds this phone
   * **as a customer**, if any. A supplier with the same number is not a clash.
   */
  findCustomerIdByPhone(tx: Tx, ctx: TenantContext, phone: string): Promise<string | null>;

  insert(tx: Tx, ctx: TenantContext, party: NewParty): Promise<void>;
  /**
   * Updates only when `expectedVersion` still matches (D-32). Returns false when
   * it does not, so the use case can raise `CONFLICT_STALE_VERSION` rather than
   * quietly overwriting the other person's edit. Rewrites the role set in the
   * same call, for the reason `NewParty.roles` gives.
   */
  update(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    expectedVersion: number,
    party: PartyEdit,
  ): Promise<boolean>;
  setStatus(tx: Tx, ctx: TenantContext, id: string, status: PartyStatus): Promise<void>;
  /** Hard delete, only ever called for a party nothing refers to (§3.6). */
  deleteUnused(tx: Tx, ctx: TenantContext, id: string): Promise<void>;

  /**
   * Writes an opening balance document and its journal entry together.
   *
   * One call rather than a document write plus a posting write, because the two
   * must be atomic and a port that let them be issued separately would make the
   * non-atomic case expressible.
   */
  insertOpening(tx: Tx, ctx: TenantContext, opening: NewPartyOpening): Promise<void>;
  /** The opening already posted for this party and role, if any (0015's unique). */
  findOpening(
    tx: Tx,
    ctx: TenantContext,
    partyId: string,
    role: PartyRole,
  ): Promise<PartyOpeningRow | null>;
  /**
   * Applies a §2.5 correction: the document takes the new figure and one
   * journal entry reverses the old posting and posts the new one, atomically.
   *
   * Returns `false` when the version did not match, so the caller can raise
   * D-32's conflict rather than overwrite whoever got there first.
   */
  correctOpening(
    tx: Tx,
    ctx: TenantContext,
    correction: PartyOpeningCorrection,
  ): Promise<boolean>;

  /** One page of a party's statement, in business-date then created-at then id order. */
  listLedgerLines(
    tx: Tx,
    ctx: TenantContext,
    filter: PartyLedgerFilter,
  ): Promise<readonly PartyLedgerLineRow[]>;
  /**
   * The net of every line strictly before the page `filter` describes.
   *
   * Separate from `listLedgerLines` because a running balance must start from
   * the true earlier sum, not from zero — a date-filtered or second-page
   * statement that began at zero would be wrong and still look right.
   */
  sumLedgerBefore(tx: Tx, ctx: TenantContext, filter: PartyLedgerFilter): Promise<number>;

  listGroups(tx: Tx, ctx: TenantContext): Promise<readonly CustomerGroupEntry[]>;
  findGroup(tx: Tx, ctx: TenantContext, id: string): Promise<CustomerGroupEntry | null>;
  insertGroup(tx: Tx, ctx: TenantContext, group: CustomerGroupEntry): Promise<void>;
  renameGroup(tx: Tx, ctx: TenantContext, id: string, name: string): Promise<void>;
  /** §3.6: a group nothing is filed under goes; one in use is archived. */
  deleteGroup(tx: Tx, ctx: TenantContext, id: string): Promise<void>;
  archiveGroup(tx: Tx, ctx: TenantContext, id: string): Promise<void>;
  countInGroup(tx: Tx, ctx: TenantContext, groupId: string): Promise<number>;
}
