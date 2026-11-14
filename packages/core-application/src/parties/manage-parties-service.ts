import {
  blankToNull,
  customerPhoneKey,
  normalizePartyName,
  normalizePhone,
  openingBalancePosting,
  partyBalanceOf,
  rejectParty,
  rejectOpeningBalance,
} from '@sher/core-domain';
import type {
  OpeningBalanceDirection,
  OpeningBalanceRejection,
  PartyRejection,
  PartyRole,
  PartyStatus,
} from '@sher/core-domain';
import { AppError, defaultDirectionFor, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type {
  PartyListResponse,
  PartyOpeningResponse,
  PartyResponse,
  PartyReadV2,
  PartyReadV2ListResponse,
  PartySort,
  SortDirection,
} from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import { entryModeFor } from '../notes/create-note-service';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { PeriodGuard } from '../ports/period-guard';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { PartyEdit, PartyFilter, PartyRepository, PartyRow } from './party-repository';

/**
 * Parties — customers, suppliers and vendors (Phase 2, path 2.3, §5.6, D-02,
 * D-04).
 *
 * **WRITE CLASS: M** (R-D). Master data: tenant context → permission → feature
 * gate → idempotency → load → invariants and optimistic lock → persist → audit +
 * outbox → commit, in one transaction. No period guard, no journal entry and no
 * stock movement — a party is not a document.
 *
 * **An opening balance is a document, not a field.** §5.0 requires opening
 * receivables and payables and §5.6 imports them, and both arrive on this form —
 * but a party's balance is the sum of its journal lines (INV-06), so what the
 * form supplies is posted as a balanced entry against `OPENING_EQUITY` through
 * `openingBalancePosting`, exactly as opening stock is. That makes this one
 * write two classes at once: Class M for the party, Class B for the opening,
 * which is why the period guard and the numbering service appear below on a
 * path that is otherwise master data. A plain `openingBalanceMinor` column
 * would be a balance with nothing behind it, and INV-06 would be false the
 * moment it was saved.
 *
 * **Create-only.** An edit never carries an opening: §2.5 corrects a posted
 * document by reversing and reposting it, never by rewriting it in place.
 *
 * **Three role permissions over one table.** A cashier who may add a customer at
 * the counter has no business adding a supplier, so every role named on a write
 * must be one the caller may create or edit. This is why the checks below loop
 * over the roles rather than testing a single code.
 */
export interface ListPartiesCommand {
  readonly ctx: TenantContext;
  readonly role: PartyRole;
  readonly search?: string | undefined;
  readonly groupId?: string | undefined;
  readonly status?: PartyStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  /** Which header was tapped, and which way (UI-46). */
  readonly sort?: PartySort | undefined;
  readonly direction?: SortDirection | undefined;
}

export interface PartyIdCommand {
  readonly ctx: TenantContext;
  readonly partyId: string;
  /** Optional only for detail reads; multi-role identities must select a role. */
  readonly role?: PartyRole | undefined;
}

/** The fields §5.6 defines, as they arrive from the form or a CSV row. */
export interface PartyInput {
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
  /**
   * The opening receivable or payable this party starts with, if any.
   *
   * Optional and create-only. `null` and absent both mean "no opening", which
   * is the normal case for a party added after go-live.
   */
  readonly opening?: OpeningBalanceInput | null | undefined;
}

/** §5.6's opening balance, as the form or a CSV row supplies it. */
export interface OpeningBalanceInput {
  readonly role: PartyRole;
  readonly direction: OpeningBalanceDirection;
  /** Always positive; `direction` carries the sign. */
  readonly amountMinor: number;
  readonly businessDate: string;
}

export interface CreatePartyCommand {
  readonly ctx: TenantContext;
  /** Client-generated ULID, reused verbatim on retry (§5.26, UI-34). */
  readonly operationId: string;
  readonly input: PartyInput;
}

export interface UpdatePartyCommand {
  readonly ctx: TenantContext;
  readonly partyId: string;
  readonly version: number;
  readonly input: PartyInput;
}

export interface SetPartyStatusCommand {
  readonly ctx: TenantContext;
  readonly partyId: string;
  readonly status: PartyStatus;
}

/** Setting an opening balance on a party that was created without one. */
export interface SetPartyOpeningCommand {
  readonly ctx: TenantContext;
  readonly partyId: string;
  readonly operationId: string;
  readonly opening: OpeningBalanceInput;
}

/** Correcting an opening already posted (§2.5). */
export interface CorrectPartyOpeningCommand extends SetPartyOpeningCommand {
  /** D-32: the document version the corrector was looking at. */
  readonly version: number;
}

/** Reading back the posted opening, so a correction dialog opens on the truth. */
export interface GetPartyOpeningCommand {
  readonly ctx: TenantContext;
  readonly partyId: string;
  readonly role: PartyRole;
}

const ENTITY_TYPE = 'party';
const DEFAULT_LIMIT = 50;

/**
 * Which permission admits which role. Three separate trusts over one table
 * (§5.26), so the mapping is written once and every path reads it.
 */
const ROLE_PERMISSIONS: Record<
  PartyRole,
  { view: string; create: string; edit: string; deactivate: string }
> = {
  CUSTOMER: {
    view: Permission.CUSTOMER_VIEW,
    create: Permission.CUSTOMER_CREATE,
    edit: Permission.CUSTOMER_EDIT,
    deactivate: Permission.CUSTOMER_DEACTIVATE,
  },
  SUPPLIER: {
    view: Permission.SUPPLIER_VIEW,
    create: Permission.SUPPLIER_CREATE,
    edit: Permission.SUPPLIER_EDIT,
    deactivate: Permission.SUPPLIER_DEACTIVATE,
  },
  VENDOR: {
    view: Permission.VENDOR_VIEW,
    create: Permission.VENDOR_CREATE,
    edit: Permission.VENDOR_EDIT,
    deactivate: Permission.VENDOR_DEACTIVATE,
  },
};

const REJECTION_MESSAGES: Record<PartyRejection, string> = {
  NAME_REQUIRED: 'Enter a name',
  ROLE_REQUIRED: 'Choose whether this is a customer, a supplier or a vendor',
  CUSTOMER_PHONE_REQUIRED: 'A customer needs a phone number',
  PHONE_NOT_A_PHONE_NUMBER: 'That does not look like a phone number',
  CREDIT_LIMIT_NOT_A_WHOLE_MINOR_UNIT: 'Enter the credit limit as whole poisha',
  CREDIT_LIMIT_NEGATIVE: 'A credit limit cannot be less than zero',
  CREDIT_LIMIT_WITHOUT_CUSTOMER_ROLE: 'Only a customer can have a credit limit',
};

const OPENING_REJECTION_MESSAGES: Record<OpeningBalanceRejection, string> = {
  OPENING_AMOUNT_NOT_INTEGER_MINOR: 'Enter the opening balance as whole poisha',
  OPENING_AMOUNT_NOT_POSITIVE: 'An opening balance must be more than zero',
  OPENING_DIRECTION_NOT_VALID_FOR_ROLE: 'A vendor opening balance can only be money you owe',
};

export class ManagePartiesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly parties: PartyRepository,
    private readonly settings: SettingsRepository,
    private readonly idempotency: IdempotencyStore,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    /**
     * Only the opening-balance path uses these — a party itself is not a
     * document and needs neither. They are constructor dependencies rather
     * than a separate service because an opening is written in the same
     * transaction as the party it belongs to (see `createWithin`).
     */
    private readonly numbering: NumberingService,
    private readonly periods: PeriodGuard,
  ) {}

  /** V1 stays wire-compatible until both legacy clients are migrated. */
  async list(command: ListPartiesCommand): Promise<PartyListResponse> {
    return this.listFor(command, (row, role) => toResponse(row, role));
  }

  /** Additive, permission-projected read; never reuse a V1 response at the HTTP boundary. */
  async listV2(command: ListPartiesCommand): Promise<PartyReadV2ListResponse> {
    return this.listFor(command, (row, role, held) => toReadV2(row, role, held));
  }

  async get(command: PartyIdCommand): Promise<PartyResponse> {
    return this.getFor(command, (row, role) => toResponse(row, role));
  }

  async getV2(command: PartyIdCommand): Promise<PartyReadV2> {
    if (command.role === undefined) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose a relationship to view this party');
    }
    return this.getFor(command, (row, role, held) => toReadV2(row, role, held), 'SCOPED');
  }

  private async listFor<T>(
    command: ListPartiesCommand,
    project: (row: PartyRow, role: PartyRole, held: readonly string[]) => T,
  ): Promise<Omit<PartyListResponse, 'data'> & { data: T[] }> {
    const { ctx, role } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].view);
      if (role === 'VENDOR') await this.assertVendorsOn(tx, ctx);
      // Permission first, then deny Customer-only queries; neither group filters
      // nor group/credit-limit sort order can be an information side-channel.
      if (role !== 'CUSTOMER' && (command.groupId !== undefined ||
        command.sort === 'groupName' || command.sort === 'creditLimit')) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Customer-only filter or sort');
      }

      const limit = command.limit ?? DEFAULT_LIMIT;
      const filter: PartyFilter = {
        role,
        search: command.search ?? null,
        groupId: command.groupId ?? null,
        status: command.status ?? null,
        cursor: command.cursor ?? null,
        sort: command.sort ?? 'name',
        direction: command.direction ?? defaultDirectionFor(command.sort ?? 'name'),
        // One more than asked for, so "is there another page" is answered by the
        // same query rather than by a second count (§3.9 keyset paging).
        limit: limit + 1,
      };

      const [rows, counts] = await Promise.all([
        this.parties.list(tx, ctx, filter),
        this.parties.count(tx, ctx, filter),
      ]);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      // The row balance belongs to the selected tab; role badges also must not
      // reveal other trading relationships to a role-limited viewer.
      const held = await this.accessControl.permissionsOf(tx, ctx);
      return {
        data: page.map((row) => project({
          ...row,
          roles: row.roles.filter((itemRole) => held.includes(ROLE_PERMISSIONS[itemRole].view)),
        }, role, held)),
        page: { nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null, hasMore },
        summary: counts,
      };
    });
  }

  private async getFor<T>(
    command: PartyIdCommand,
    project: (row: PartyRow, role: PartyRole, held: readonly string[]) => T,
    mode: 'LEGACY' | 'SCOPED' = 'LEGACY',
  ): Promise<T> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      if (mode === 'SCOPED') {
        // Authorize the requested relationship *before* identity lookup.
        // Otherwise an unauthorized Supplier-only identity produces a 403
        // while a nonexistent identity yields 404, revealing hidden existence.
        const requestedRole = command.role;
        if (requestedRole === undefined) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose a relationship to view this party');
        }
        await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[requestedRole].view);
        // List and detail must enforce the same feature state.
        if (requestedRole === 'VENDOR') await this.assertVendorsOn(tx, ctx);
      }
      const party = await this.requireParty(tx, ctx, command.partyId);
      // Identity may be shared, but a Customer, Supplier and Vendor balance
      // is not one obligation. Require an unambiguous selected relationship.
      const held = await this.accessControl.permissionsOf(tx, ctx);
      const visibleRoles = party.roles.filter((role) => held.includes(ROLE_PERMISSIONS[role].view));
      if (mode === 'LEGACY' && visibleRoles.length === 0) {
        // Preserve the existing V1 contract. V2 must not distinguish an
        // existing Party with only hidden roles from an absent identity.
        await this.requireAnyRole(tx, ctx, party.roles, 'view');
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'No permission to view this party');
      }
      const role = command.role ?? (party.roles.length === 1 ? party.roles[0] : undefined);
      if (role === undefined) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose a relationship to view this party');
      }
      // Permission first, then relationship membership: avoid revealing private
      // supplier/vendor role membership to a Customer-only caller.
      if (!held.includes(ROLE_PERMISSIONS[role].view)) {
        await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].view);
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'No permission to view this relationship');
      }
      if (!party.roles.includes(role)) {
        // V2: hidden role and absent identity must have the *same* HTTP
        // error envelope, including message (not only status/code).
        // V1's established error text remains unchanged for compatibility.
        throw new AppError(
          ErrorCode.NOT_FOUND,
          mode === 'SCOPED' ? 'Record not found' : 'That relationship does not exist',
        );
      }
      const balanceNetMinor = await this.parties.getRoleBalance(tx, ctx, party.id, role);
      return project({ ...party, roles: visibleRoles, balanceNetMinor }, role, held);
    });
  }

  async create(command: CreatePartyCommand): Promise<PartyResponse> {
    const { ctx } = command;
    const fingerprint = JSON.stringify(command.input);

    return this.uow.run(ctx, async (tx) => {
      for (const role of unique(command.input.roles)) {
        await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].create);
      }

      /*
       * R-D3: a Class M creation is idempotent "when a retry could duplicate a
       * record". It could here — two suppliers may legitimately share a name and
       * neither needs a phone, so no unique index would catch the replay. A
       * customer is protected twice over, by this and by D-02's phone rule.
       */
      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used with a different record',
          );
        }
        return replayed.response as PartyResponse;
      }

      const response = await this.createWithin(tx, ctx, command.input, 'API');

      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }

  /**
   * Creating one party inside a transaction the **caller** owns.
   *
   * Split out for the guided CSV import (§5.6): a file posts all-or-nothing, and
   * one file is one transaction (R-D5), so the importer cannot call `create`
   * once per row. It calls this, and an imported customer passes exactly what a
   * typed-in one passes — the same role permissions, the same `validate` with
   * D-02's phone rule and the hidden-field rules, the same audit and outbox.
   * There is one party writer (A11, A14).
   */
  async createWithin(
    tx: Tx,
    ctx: TenantContext,
    input: PartyInput,
    source: string,
  ): Promise<PartyResponse> {
    for (const role of unique(input.roles)) {
      await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].create);
    }

    const clean = await this.validate(tx, ctx, input, null);
    const id = Ulid.generate(this.clock);

    await this.parties.insert(tx, ctx, { id, ...clean, isSystemReserved: false });

    // `null` and absent both mean "no opening", so both are named here: the
    // loose `!= null` that reads the same is what `eqeqeq` forbids.
    if (input.opening !== null && input.opening !== undefined) {
      await this.postOpening(tx, ctx, id, clean.roles, input.opening, source);
    }

    await this.audit.append(tx, ctx, {
      entityType: ENTITY_TYPE,
      entityId: id,
      action: 'CREATE',
      before: null,
      after: auditValues(clean),
      source,
    });
    await this.outbox.append(tx, ctx, {
      eventType: 'party.created',
      aggregateType: ENTITY_TYPE,
      aggregateId: id,
      payload: { name: clean.name, roles: clean.roles.join(',') },
    });

    return toResponse(await this.requireParty(tx, ctx, id));
  }

  /**
   * Posts a party's opening balance: the document, its journal entry, its
   * audit trail, in the caller's transaction.
   *
   * A Class B write (R-D), so unlike the party around it this one is period
   * guarded and numbered. The guard matters more here than the phrase "opening
   * balance" suggests — a shop that has closed its first month must not have
   * new opening entries appearing behind the lock and silently changing a
   * period that was already reported on.
   */
  private async postOpening(
    tx: Tx,
    ctx: TenantContext,
    partyId: string,
    roles: readonly PartyRole[],
    opening: OpeningBalanceInput,
    source: string,
  ): Promise<void> {
    // The role must be one this party actually holds. Otherwise an opening
    // could post to `AP` for someone who is not a supplier, and their balance
    // would appear on a report they belong to under no role.
    if (!roles.includes(opening.role)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'The opening balance is for a role this party does not have',
      );
    }

    const rejection = rejectOpeningBalance({
      partyId,
      role: opening.role,
      direction: opening.direction,
      amountMinor: opening.amountMinor,
    });
    if (rejection !== null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, OPENING_REJECTION_MESSAGES[rejection]);
    }

    const today = this.clock.businessDate(ctx.timezone);
    const { businessDate } = opening;

    // The same refusal opening stock makes: an opening dated in the future is a
    // typo, and posting it would put a balance on a list for money that is not
    // owed yet.
    if (businessDate > today) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'An opening balance cannot be dated in the future',
      );
    }

    await this.periods.assertOpen(tx, ctx, businessDate);

    // 0015's unique index would catch a second opening, but catching it here
    // gives the shopkeeper the reason instead of a constraint violation.
    const existing = await this.parties.findOpening(tx, ctx, partyId, opening.role);
    if (existing !== null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'This party already has an opening balance for that role',
      );
    }

    const posting = openingBalancePosting({
      partyId,
      role: opening.role,
      direction: opening.direction,
      amountMinor: opening.amountMinor,
    });

    const openingId = Ulid.generate(this.clock);

    await this.parties.insertOpening(tx, ctx, {
      id: openingId,
      number: await this.numbering.allocate(
        tx,
        ctx,
        'OPENING_BALANCE',
        Number(businessDate.slice(0, 4)),
      ),
      partyId,
      role: opening.role,
      direction: posting.direction,
      amountMinor: posting.amountMinor,
      businessDate,
      entryMode: entryModeFor(businessDate, today),
      operationId: openingId,
      journalEntryId: Ulid.generate(this.clock),
      journalLines: posting.journal.lines.map((line) => ({
        id: Ulid.generate(this.clock),
        account: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      })),
    });

    await this.audit.append(tx, ctx, {
      entityType: 'party_opening',
      entityId: openingId,
      action: 'CREATE',
      before: null,
      after: {
        partyId,
        role: opening.role,
        direction: posting.direction,
        amountMinor: String(posting.amountMinor),
        businessDate,
      },
      source,
    });
  }

  async update(command: UpdatePartyCommand): Promise<PartyResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const before = await this.requireParty(tx, ctx, command.partyId);
      this.assertNotSystemReserved(before, 'change');

      // Ordinary shared-directory corrections remain simple: one current
      // trading-role EDIT is sufficient for name/phone. Other relationships,
      // customer-only values and private fields are guarded by what CHANGED.
      await this.requireAnyRole(tx, ctx, before.roles, 'edit');
      for (const role of unique(command.input.roles)) {
        if (!before.roles.includes(role)) {
          await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].create);
        }
      }

      // V1 sends a complete form even when the reader cannot see private or
      // Customer-only fields. A withheld field often round-trips as null/blank.
      // Preserve its stored value for a role-limited editor, rather than
      // treating that placeholder as an authorized deletion (or denying an
      // otherwise ordinary name/phone correction). Non-empty replacements
      // still require the corresponding field permission below.
      const held = await this.accessControl.permissionsOf(tx, ctx);
      const canViewPrivate = held.includes(Permission.PARTY_PROFILE_VIEW);
      const customerMutationPermission = before.roles.includes('CUSTOMER')
        ? Permission.CUSTOMER_EDIT : Permission.CUSTOMER_CREATE;
      const canEditCustomerFields = held.includes(customerMutationPermission);
      const keepPrivate = (incoming: string | null, stored: string | null): string | null =>
        !canViewPrivate && blankToNull(incoming) === null ? stored : incoming;
      const safeInput: PartyInput = {
        ...command.input,
        address: keepPrivate(command.input.address, before.address),
        guardianName: keepPrivate(command.input.guardianName, before.guardianName),
        nid: keepPrivate(command.input.nid, before.nid),
        email: keepPrivate(command.input.email, before.email),
        notes: keepPrivate(command.input.notes, before.notes),
        customerGroupId: !canEditCustomerFields && command.input.customerGroupId === null
          ? before.customerGroupId : command.input.customerGroupId,
        creditLimitMinor: !canEditCustomerFields && command.input.creditLimitMinor === null
          ? before.creditLimitMinor : command.input.creditLimitMinor,
      };
      const clean = await this.validate(tx, ctx, safeInput, before);

      // No extra grant is required for a full-form PATCH that repeats stored
      // private fields. Validate first: hidden-by-Settings fields are preserved
      // by validate(), and must not be treated as effective modifications.
      const privateChanged = (
        clean.address !== before.address ||
        clean.guardianName !== before.guardianName ||
        clean.nid !== before.nid ||
        clean.email !== before.email ||
        clean.notes !== before.notes
      );
      if (privateChanged) {
        await this.accessControl.require(tx, ctx, Permission.PARTY_PROFILE_VIEW);
      }

      // A Supplier-only editor may correct the common name/phone but cannot
      // change the Customer's credit terms or group. Creating a NEW Customer
      // role already requires CUSTOMER_CREATE above and permits its initial
      // customer-specific values without a redundant EDIT grant.
      const customerFieldsChanged = (
        clean.customerGroupId !== before.customerGroupId ||
        clean.creditLimitMinor !== before.creditLimitMinor
      );
      if (customerFieldsChanged) {
        await this.accessControl.require(
          tx, ctx,
          before.roles.includes('CUSTOMER')
            ? Permission.CUSTOMER_EDIT
            : Permission.CUSTOMER_CREATE,
        );
      }

      // One role's EDIT never authorizes removing somebody else's trading
      // relationship. A Party that ever posted remains accounting-linked: do
      // not discard role metadata while its history is still in the journal.
      const removedRoles = before.roles.filter((role) => !clean.roles.includes(role));
      for (const role of removedRoles) {
        await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].deactivate);
      }
      if (removedRoles.length > 0 && before.hasLedgerEntries) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A party with posted history cannot have trading relationships removed',
        );
      }

      // D-32: the loser of a simultaneous edit is told, not silently overwritten.
      const saved = await this.parties.update(
        tx,
        ctx,
        command.partyId,
        command.version,
        clean,
      );
      if (!saved) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this record while you were editing it. Reopen it and try again.',
        );
      }

      /*
       * §5.6: "Historical invoice snapshots never change when the resulting party
       * is edited." Nothing here touches a document — a guest invoice keeps its
       * own immutable name and phone snapshot (D-02). This audit row is what
       * connects "the phone changed" to "the old invoices did not".
       */
      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: command.partyId,
        action: 'UPDATE',
        before: auditValues(before),
        after: auditValues(clean),
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'party.updated',
        aggregateType: ENTITY_TYPE,
        aggregateId: command.partyId,
        payload: { name: clean.name, roles: clean.roles.join(',') },
      });

      return toResponse(await this.requireParty(tx, ctx, command.partyId));
    });
  }

  /**
   * §5.6: an inactive party stops appearing in new sales and purchases while its
   * history and balance stay exactly as they are. Independent of any balance, for
   * the reason G2.3 gives about stock: a customer who owes nothing is not
   * thereby inactive, and an inactive customer's due does not disappear.
   */
  async setStatus(command: SetPartyStatusCommand): Promise<PartyResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const before = await this.requireParty(tx, ctx, command.partyId);
      this.assertNotSystemReserved(before, 'deactivate');
      // Status belongs to the identity, not to a single relationship: a
      // Customer-only deactivation grant cannot disable Supplier operations.
      // Single-role Parties still need only their familiar permission.
      for (const role of before.roles) {
        await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].deactivate);
      }

      await this.parties.setStatus(tx, ctx, command.partyId, command.status);

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: command.partyId,
        action: command.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE',
        before: { status: before.status },
        after: { status: command.status },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'party.status_changed',
        aggregateType: ENTITY_TYPE,
        aggregateId: command.partyId,
        payload: { status: command.status },
      });

      return toResponse(await this.requireParty(tx, ctx, command.partyId));
    });
  }

  /**
   * §3.6: master data is hard-deleted "only if never used", and soft-deleted once
   * something refers to it. Nothing refers to a party in Phase 2, so a party
   * entered by mistake is genuinely removable.
   *
   * **Every later module that references a party must add its count to
   * `assertNeverUsed`.** A customer with an invoice must be deactivated, not
   * deleted, and that check belongs in one named place rather than being left to
   * a foreign key to fail with a 500.
   */
  async deleteParty(command: PartyIdCommand): Promise<void> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const before = await this.requireParty(tx, ctx, command.partyId);
      this.assertNotSystemReserved(before, 'delete');
      // Deleting is the destructive end of deactivating, so it is gated on the
      // same code — §5.26 keeps destructive actions off the ordinary edit right.
      // Hard delete is identity-wide; require each affected relationship's
      // destructive authority, then retain the GLOBAL posted-history guard.
      for (const role of before.roles) {
        await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].deactivate);
      }
      this.assertNeverUsed(before);

      await this.parties.deleteUnused(tx, ctx, command.partyId);

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: command.partyId,
        action: 'DELETE',
        before: auditValues(before),
        after: null,
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'party.deleted',
        aggregateType: ENTITY_TYPE,
        aggregateId: command.partyId,
        payload: { name: before.name },
      });
    });
  }

  /* ------------------------------------------------------ opening balances */

  /** The opening posted for this party and role, or `null` if there is none. */
  async getOpening(command: GetPartyOpeningCommand): Promise<PartyOpeningResponse | null> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const party = await this.requireParty(tx, ctx, command.partyId);
      await this.requireOpeningRole(tx, ctx, party.roles, command.role, 'view');
      return this.parties.findOpening(tx, ctx, command.partyId, command.role);
    });
  }

  /**
   * Sets an opening balance on a party created without one.
   *
   * §5.6 puts the figure on the create form, and a shop onboarding a hundred
   * customers will miss it on some of them. The alternative was deleting the
   * party and re-adding it, which stops being possible the moment anything
   * else posts against them.
   *
   * Nothing new happens here: it is `postOpening` — the same document, journal
   * entry, period guard, numbering and audit the create form goes through —
   * reached from a second entry point. `postOpening` refuses a party that
   * already has an opening for the role, which is what makes this *set* and
   * not a silent second balance.
   */
  async setOpening(command: SetPartyOpeningCommand): Promise<PartyOpeningResponse> {
    const { ctx } = command;
    const fingerprint = JSON.stringify(command.opening);

    return this.uow.run(ctx, async (tx) => {
      const party = await this.requireParty(tx, ctx, command.partyId);
      // The walk-in party is never owed anything and never owes: every fully
      // paid guest sale points at it, and an opening on it would be a balance
      // belonging to no one.
      this.assertNotSystemReserved(party, 'change');
      // Authorize the requested journal relationship before any idempotent
      // replay lookup: a Customer editor must never post a Supplier opening.
      await this.requireOpeningRole(tx, ctx, party.roles, command.opening.role, 'edit');

      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used with a different opening balance',
          );
        }
        return replayed.response as PartyOpeningResponse;
      }

      await this.postOpening(tx, ctx, command.partyId, party.roles, command.opening, 'API');

      const saved = await this.parties.findOpening(tx, ctx, command.partyId, command.opening.role);
      if (saved === null) throw new AppError(ErrorCode.NOT_FOUND, 'Record not found');

      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response: saved,
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'party.opening.posted',
        aggregateType: 'party_opening',
        aggregateId: saved.id,
        payload: { partyId: command.partyId, role: saved.role },
      });

      return saved;
    });
  }

  /**
   * Corrects an opening already posted (§2.5).
   *
   * **Nothing posted is edited.** The original journal lines stay exactly where
   * they are, and one correction entry reverses them and posts the new figure,
   * so the statement reads: opened at 3,000 · corrected −3,000 · +2,500. A
   * shopkeeper who wonders why a balance changed can see it, which is the whole
   * reason §2.5 forbids editing a line in place.
   *
   * The document itself does take the new figure and gains `CORRECTED` as its
   * entry mode. That is deliberate: 0015 holds one opening per party per role,
   * because a second row is not a correction but a doubled balance — so the
   * correction lives in the journal, where history belongs, and the document
   * keeps saying what the opening currently is.
   */
  async correctOpening(command: CorrectPartyOpeningCommand): Promise<PartyOpeningResponse> {
    const { ctx } = command;
    const { opening } = command;

    return this.uow.run(ctx, async (tx) => {
      const party = await this.requireParty(tx, ctx, command.partyId);
      this.assertNotSystemReserved(party, 'change');
      // No Supplier/Vendor correction or replay via Customer-edit privilege.
      // Deny before inspecting the requested role's historical opening.
      await this.requireOpeningRole(tx, ctx, party.roles, opening.role, 'edit');

      const existing = await this.parties.findOpening(tx, ctx, command.partyId, opening.role);
      if (existing === null) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          'There is no opening balance for that role to correct',
        );
      }

      const today = this.clock.businessDate(ctx.timezone);
      if (opening.businessDate > today) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'An opening balance cannot be dated in the future',
        );
      }
      if (!party.roles.includes(opening.role)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'The opening balance is for a role this party does not have',
        );
      }

      const rejection = rejectOpeningBalance({
        partyId: command.partyId,
        role: opening.role,
        direction: opening.direction,
        amountMinor: opening.amountMinor,
      });
      if (rejection !== null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, OPENING_REJECTION_MESSAGES[rejection]);
      }

      /*
       * Both dates are guarded, not just the new one. Moving an opening out of
       * a closed period is as much a change to that period as posting into it,
       * and a correction that only checked its destination could quietly empty
       * a month that has already been reported on.
       */
      await this.periods.assertOpen(tx, ctx, existing.businessDate);
      await this.periods.assertOpen(tx, ctx, opening.businessDate);

      // The old posting, negated, and the new one — in one balanced entry.
      const reversal = openingBalancePosting({
        partyId: command.partyId,
        role: existing.role,
        direction: existing.direction,
        amountMinor: existing.amountMinor,
      });
      const reposting = openingBalancePosting({
        partyId: command.partyId,
        role: opening.role,
        direction: opening.direction,
        amountMinor: opening.amountMinor,
      });

      const correctionId = Ulid.generate(this.clock);
      const applied = await this.parties.correctOpening(tx, ctx, {
        openingId: existing.id,
        expectedVersion: command.version,
        role: opening.role,
        direction: opening.direction,
        amountMinor: opening.amountMinor,
        businessDate: opening.businessDate,
        entryMode: 'CORRECTED',
        journalEntryId: Ulid.generate(this.clock),
        correctionId,
        /*
         * `OBC`, not the posting type's full name. The series name becomes the
         * document number's prefix, and `OPENING_BALANCE_CORRECTION-2026-000001`
         * was wide enough on its own to push a printed statement into a
         * horizontal scroll. Short prefixes are the house style already — a
         * generated product barcode is `P-2026-000001`.
         */
        correctionNumber: await this.numbering.allocate(
          tx,
          ctx,
          'OBC',
          Number(opening.businessDate.slice(0, 4)),
        ),
        journalLines: [
          ...reversal.journal.lines.map((line) => ({
            id: Ulid.generate(this.clock),
            account: line.account,
            amountMinor: -line.amountMinor,
            partyId: line.partyId,
          })),
          ...reposting.journal.lines.map((line) => ({
            id: Ulid.generate(this.clock),
            account: line.account,
            amountMinor: line.amountMinor,
            partyId: line.partyId,
          })),
        ],
      });

      if (!applied) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this opening balance while you were editing it',
        );
      }

      const saved = await this.parties.findOpening(tx, ctx, command.partyId, opening.role);
      if (saved === null) throw new AppError(ErrorCode.NOT_FOUND, 'Record not found');

      await this.audit.append(tx, ctx, {
        entityType: 'party_opening',
        entityId: existing.id,
        action: 'UPDATE',
        before: {
          role: existing.role,
          direction: existing.direction,
          amountMinor: String(existing.amountMinor),
          businessDate: existing.businessDate,
        },
        after: {
          role: saved.role,
          direction: saved.direction,
          amountMinor: String(saved.amountMinor),
          businessDate: saved.businessDate,
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'party.opening.corrected',
        aggregateType: 'party_opening',
        aggregateId: existing.id,
        payload: { partyId: command.partyId, role: saved.role },
      });

      return saved;
    });
  }

  /* ------------------------------------------------------- shared mechanics */

  /**
   * Everything that must be true of a party before it is stored, in one place so
   * the form and the CSV import (path 2.4) cannot disagree — DRY applies to
   * rules.
   *
   * `existing` is the party being edited, so its own phone does not clash with
   * itself and so a field the shop has hidden keeps the value it already holds.
   */
  async validate(
    tx: Tx,
    ctx: TenantContext,
    input: PartyInput,
    existing: PartyRow | null,
  ): Promise<PartyEdit> {
    const roles = unique(input.roles);
    const values = settingValuesOf(await this.settings.listStored(tx, ctx));

    if (roles.includes('VENDOR') && !isFeatureOn(values, SettingKey.VENDOR_MANAGEMENT_ENABLED)) {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Vendors are switched off in Settings',
      );
    }

    const phone = blankToNull(input.phone);
    const rejection = rejectParty({
      name: input.name,
      roles,
      phone,
      creditLimitMinor: input.creditLimitMinor,
    });
    if (rejection !== null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, REJECTION_MESSAGES[rejection]);
    }

    /*
     * D-02, checked here so the refusal can be explained, and enforced again by
     * the partial unique index in migration 0009 so two cashiers saving the same
     * new customer at the same moment cannot both win.
     */
    if (roles.includes('CUSTOMER') && phone !== null) {
      const owner = await this.parties.findCustomerIdByPhone(tx, ctx, customerPhoneKey(phone));
      if (owner !== null && owner !== existing?.id) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Another customer already uses the phone number ${normalizePhone(phone)}`,
          /*
           * The id of the customer the shop already has, beside the sentence.
           * Phase 12.4's Sync Issues screen needs exactly that to offer "use
           * the one the shop already has" — a merge with nothing to merge onto
           * is a button that can only fail.
           */
          { reason: 'DUPLICATE_CUSTOMER_PHONE', partyId: owner },
        );
      }
    }

    /*
     * §5.6: "Settings may hide/disable optional fields such as NID and
     * Father/Guardian Name from normal forms while preserving stored historical
     * data."
     *
     * A hidden field is therefore **not editable**: on a new record a supplied
     * value is refused, and on an edit the stored value is carried through
     * untouched and whatever arrived is ignored. That asymmetry is deliberate —
     * a form that cannot show a field cannot be trusted to send it back, and
     * treating its silence as "clear it" would destroy exactly the historical
     * data the setting promises to preserve.
     */
    const address = this.optionalField(
      values,
      SettingKey.CUSTOMER_FIELD_ADDRESS_VISIBLE,
      'an address',
      input.address,
      existing?.address ?? null,
    );
    const guardianName = this.optionalField(
      values,
      SettingKey.CUSTOMER_FIELD_GUARDIAN_VISIBLE,
      "a father's or guardian's name",
      input.guardianName,
      existing?.guardianName ?? null,
    );
    const nid = this.optionalField(
      values,
      SettingKey.CUSTOMER_FIELD_NID_VISIBLE,
      'an NID number',
      input.nid,
      existing?.nid ?? null,
    );
    const email = this.optionalField(
      values,
      SettingKey.CUSTOMER_FIELD_EMAIL_VISIBLE,
      'an email address',
      input.email,
      existing?.email ?? null,
    );

    const notes = this.optionalField(
      values,
      SettingKey.CUSTOMER_FIELD_NOTES_VISIBLE,
      'notes about a customer',
      input.notes,
      existing?.notes ?? null,
    );

    let customerGroupId = blankToNull(input.customerGroupId);
    if (customerGroupId !== null) {
      if (!isFeatureOn(values, SettingKey.CUSTOMER_GROUPS_ENABLED)) {
        throw new AppError(
          ErrorCode.FEATURE_DISABLED,
          'Customer groups are switched off in Settings',
        );
      }
      if (!roles.includes('CUSTOMER')) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Only a customer can belong to a customer group',
        );
      }
      if ((await this.parties.findGroup(tx, ctx, customerGroupId)) === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That customer group was not found');
      }
    } else if (
      existing !== null &&
      existing.customerGroupId !== null &&
      !isFeatureOn(values, SettingKey.CUSTOMER_GROUPS_ENABLED)
    ) {
      // Same preservation rule as the hidden fields: switching groups off must
      // not silently unfile every customer that was already in one (§5.21).
      customerGroupId = existing.customerGroupId;
    }

    return {
      name: normalizePartyName(input.name),
      roles,
      phone: phone === null ? null : normalizePhone(phone),
      address,
      guardianName,
      nid,
      email,
      notes,
      customerGroupId,
      creditLimitMinor: input.creditLimitMinor,
    };
  }

  /** One optional customer field, under §5.21's visibility setting. */
  private optionalField(
    values: ReadonlyMap<string, string>,
    key: string,
    label: string,
    incoming: string | null,
    stored: string | null,
  ): string | null {
    if (isFeatureOn(values, key)) return blankToNull(incoming);
    if (stored !== null) return stored;
    if (blankToNull(incoming) !== null) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, `This business does not record ${label}`);
    }
    return null;
  }

  private async assertVendorsOn(tx: Tx, ctx: TenantContext): Promise<void> {
    const values = settingValuesOf(await this.settings.listStored(tx, ctx));
    if (!isFeatureOn(values, SettingKey.VENDOR_MANAGEMENT_ENABLED)) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'Vendors are switched off in Settings');
    }
  }

  /**
   * Opening balances are separate accounting obligations even when Customer,
   * Supplier and Vendor share one Party identity. Check the requested role
   * before reading a source document, checking an idempotency replay, or
   * reversing/reposting any journal lines. Permission denial comes first so
   * users cannot enumerate private roles by comparing error responses.
   */
  private async requireOpeningRole(
    tx: Tx,
    ctx: TenantContext,
    roles: readonly PartyRole[],
    role: PartyRole,
    action: 'view' | 'edit',
  ): Promise<void> {
    await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role][action]);
    if (!roles.includes(role)) {
      throw new AppError(
        action === 'view' ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED,
        action === 'view'
          ? 'Record not found'
          : 'The opening balance is for a role this party does not have',
      );
    }
  }

  /**
   * Any-role authorization is only for identity-level Party edits/status.
   * Opening documents are relationship-specific and must never use this.
   */
  private async requireAnyRole(
    tx: Tx,
    ctx: TenantContext,
    roles: readonly PartyRole[],
    action: 'view' | 'edit' | 'deactivate',
  ): Promise<void> {
    const held = await this.accessControl.permissionsOf(tx, ctx);
    const allowed = roles.some((role) => held.includes(ROLE_PERMISSIONS[role][action]));
    if (allowed) return;

    // `require` raises the denial with the right code, message and audit trail
    // rather than this method inventing a second refusal path (§5.22).
    const first = roles[0] ?? 'CUSTOMER';
    await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[first][action]);
  }

  /**
   * D-02's walk-in party is a fixture of the system, not a customer record. Every
   * fully paid guest sale from Phase 6 onward points at it, so renaming it,
   * deactivating it or removing it would break sales that are already printed.
   */
  private assertNotSystemReserved(party: PartyRow, action: string): void {
    if (!party.isSystemReserved) return;
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `The walk-in customer is part of the system and cannot be ${action}d. ` +
        'It is what fully paid counter sales are recorded against.',
    );
  }

  private async requireParty(tx: Tx, ctx: TenantContext, id: string): Promise<PartyRow> {
    const party = await this.parties.findById(tx, ctx, id);
    // Another tenant's party is simply not found — never a 403 (§5.26).
    if (party === null) throw new AppError(ErrorCode.NOT_FOUND, 'Record not found');
    return party;
  }

  /**
   * §3.6's "only if never used", enforced rather than assumed.
   *
   * This was a no-op stub written when nothing could refer to a party. Opening
   * balances changed that: a party can now have journal lines, and deleting one
   * left those lines pointing at a row that no longer existed — a statement
   * made of orphans, and INV-06 false in the one direction nothing checks.
   *
   * A settled balance is deliberately **not** the test. A customer who owed 500
   * and paid it nets to zero and still has a history worth keeping. The
   * question is whether anything ever posted, not what it comes to now.
   *
   * Phase 5 adds purchases, Phase 6 sales and receipts, Phase 7 expenses. Each
   * posts journal lines, so each is already covered here; anything that refers
   * to a party *without* posting must add its own check to this method.
   */
  private assertNeverUsed(party: PartyRow): void {
    if (party.hasLedgerEntries) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'This party has posted history and cannot be deleted. Deactivate them instead.',
      );
    }
  }
}

/** Fixed order, so the screen and the audit trail read the same way every time. */
function unique(roles: readonly PartyRole[]): readonly PartyRole[] {
  const order: readonly PartyRole[] = ['CUSTOMER', 'SUPPLIER', 'VENDOR'];
  return order.filter((role) => roles.includes(role));
}

/**
 * R-D4: money on both sides of an audited change, as stored integers. Notes and
 * the address are left out — they are free text nobody reconciles, and an audit
 * row is more useful when what it holds is what someone would ask about.
 */
function auditValues(party: PartyEdit | PartyRow): Record<string, string | number | null> {
  return {
    name: party.name,
    roles: [...party.roles].join(','),
    phone: party.phone,
    nid: party.nid,
    email: party.email,
    customerGroupId: party.customerGroupId,
    creditLimitMinor: party.creditLimitMinor,
  };
}

function toResponse(row: PartyRow, selectedReadRole?: PartyRole): PartyResponse {
  // Preserve full internal/edit responses; only selected-role READs mask
  // Customer-only metadata. No source Party values are modified.
  const customerFieldsVisible = selectedReadRole === undefined || selectedReadRole === 'CUSTOMER';
  return {
    id: row.id,
    name: row.name,
    roles: [...row.roles],
    phone: row.phone,
    address: row.address,
    guardianName: row.guardianName,
    nid: row.nid,
    email: row.email,
    notes: row.notes,
    customerGroupId: customerFieldsVisible ? row.customerGroupId : null,
    customerGroupName: customerFieldsVisible ? row.customerGroupName : null,
    creditLimitMinor: customerFieldsVisible ? row.creditLimitMinor : null,
    status: row.status,
    isSystemReserved: row.isSystemReserved,
    version: row.version,
    // INV-06 applied in exactly one place: the repository sums the lines, this
    // turns the sign into the two words the screen shows, and the ledger header
    // calls the same function on the same number.
    balance: partyBalanceOf(row.balanceNetMinor),
    hasLedgerEntries: row.hasLedgerEntries,
  };
}

/**
 * T09C-P2: V2 wire projection. Internal PartyRow keeps its *global* posted
 * history for delete safety; a role VIEW grant never discloses it or sensitive
 * personal data. Both grants are evaluated in the same tenant-scoped UoW as
 * the role permission and balance query (no separate follow-up exposure).
 */
function toReadV2(row: PartyRow, role: PartyRole, held: readonly string[]): PartyReadV2 {
  const {
    address, guardianName, nid, email, notes, hasLedgerEntries,
    ...directory
  } = toResponse(row, role);
  return {
    ...directory,
    readRole: role,
    profile: held.includes(Permission.PARTY_PROFILE_VIEW)
      ? { state: 'VISIBLE', data: { address, guardianName, nid, email, notes } }
      : { state: 'WITHHELD' },
    globalHistory: held.includes(Permission.PARTY_HISTORY_GLOBAL_VIEW)
      ? { state: 'VISIBLE', hasLedgerEntries }
      : { state: 'WITHHELD' },
  };
}
