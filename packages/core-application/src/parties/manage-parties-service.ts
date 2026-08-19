import {
  blankToNull,
  customerPhoneKey,
  normalizePartyName,
  normalizePhone,
  rejectParty,
} from '@sher/core-domain';
import type { PartyRejection, PartyRole, PartyStatus } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type { PartyListResponse, PartyResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
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
 * **No opening balance is written here.** §5.0 requires opening receivables and
 * payables and §5.6 imports them, but a party's balance is the sum of its
 * journal lines (INV-06). The opening entry goes through the posting service in
 * Phase 4, exactly as opening stock goes through Phase 3's. A figure typed on
 * this form would be a balance with nothing behind it, and INV-06 would be false
 * the moment it was saved.
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
}

export interface PartyIdCommand {
  readonly ctx: TenantContext;
  readonly partyId: string;
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
  ) {}

  async list(command: ListPartiesCommand): Promise<PartyListResponse> {
    const { ctx, role } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].view);
      if (role === 'VENDOR') await this.assertVendorsOn(tx, ctx);

      const limit = command.limit ?? DEFAULT_LIMIT;
      const filter: PartyFilter = {
        role,
        search: command.search ?? null,
        groupId: command.groupId ?? null,
        status: command.status ?? null,
        cursor: command.cursor ?? null,
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

      return {
        data: page.map(toResponse),
        page: { nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null, hasMore },
        summary: counts,
      };
    });
  }

  async get(command: PartyIdCommand): Promise<PartyResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const party = await this.requireParty(tx, ctx, command.partyId);
      // Read it under whichever of its roles the caller is allowed to see. A
      // supplier who is also a customer is readable by someone who may see
      // either; someone who may see neither gets the 404 a stranger gets.
      await this.requireAnyRole(tx, ctx, party.roles, 'view');
      return toResponse(party);
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

      const clean = await this.validate(tx, ctx, command.input, null);
      const id = Ulid.generate(this.clock);

      await this.parties.insert(tx, ctx, { id, ...clean, isSystemReserved: false });

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: id,
        action: 'CREATE',
        before: null,
        after: auditValues(clean),
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'party.created',
        aggregateType: ENTITY_TYPE,
        aggregateId: id,
        payload: { name: clean.name, roles: clean.roles.join(',') },
      });

      const response = toResponse(await this.requireParty(tx, ctx, id));

      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }

  async update(command: UpdatePartyCommand): Promise<PartyResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const before = await this.requireParty(tx, ctx, command.partyId);
      this.assertNotSystemReserved(before, 'change');

      // Both sides: you may not edit a party you cannot already reach, and you
      // may not hand it a role you are not trusted to create.
      await this.requireAnyRole(tx, ctx, before.roles, 'edit');
      for (const role of unique(command.input.roles)) {
        if (!before.roles.includes(role)) {
          await this.accessControl.require(tx, ctx, ROLE_PERMISSIONS[role].create);
        }
      }

      const clean = await this.validate(tx, ctx, command.input, before);

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
      await this.requireAnyRole(tx, ctx, before.roles, 'deactivate');

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
      await this.requireAnyRole(tx, ctx, before.roles, 'deactivate');
      await this.assertNeverUsed();

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
   * Admits a caller who holds the named right for **any** role the party has.
   * A person who is both a customer and a supplier is one record; someone
   * trusted with either side of them may read and correct that record.
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
   * Nothing refers to a party yet. Phase 5 adds purchases, Phase 6 sales and
   * receipts, Phase 7 expenses: each must add its count here, and each is a
   * reason to refuse the delete and offer deactivation instead (§3.6).
   */
  private async assertNeverUsed(): Promise<void> {
    return Promise.resolve();
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

function toResponse(row: PartyRow): PartyResponse {
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
    customerGroupId: row.customerGroupId,
    customerGroupName: row.customerGroupName,
    creditLimitMinor: row.creditLimitMinor,
    status: row.status,
    isSystemReserved: row.isSystemReserved,
    version: row.version,
  };
}
