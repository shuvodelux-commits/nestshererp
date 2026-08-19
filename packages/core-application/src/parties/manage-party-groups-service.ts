import { catalogNameKey, isValidCatalogName, normalizeCatalogName } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type {
  PartySetupResponse,
  RemoveCatalogEntryResponse,
} from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { Outbox } from '../ports/outbox';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { PartyRepository } from './party-repository';

/**
 * Customer groups, and everything else the parties screens need before they can
 * draw (§5.6, §5.21).
 *
 * **WRITE CLASS: M** (R-D). A group is configuration: tenant context →
 * permission → feature gate → load → invariant → persist → audit + outbox →
 * commit. No period guard, no journal, no stock.
 *
 * `setup` is a **read** and deliberately cheap on permissions: it is admitted by
 * being allowed to see any kind of party at all. A cashier who may save a
 * customer at the counter must be able to draw that form, and requiring
 * `settings.setting.view` to learn whether the shop asks for an NID would put
 * the whole Settings screen behind adding a customer (UI-09).
 */
export interface PartySetupCommand {
  readonly ctx: TenantContext;
}

export interface CreateCustomerGroupCommand {
  readonly ctx: TenantContext;
  readonly name: string;
}

export interface RenameCustomerGroupCommand {
  readonly ctx: TenantContext;
  readonly groupId: string;
  readonly name: string;
}

export interface RemoveCustomerGroupCommand {
  readonly ctx: TenantContext;
  readonly groupId: string;
}

const ENTITY_TYPE = 'customer_group';

const PARTY_VIEW_PERMISSIONS = [
  Permission.CUSTOMER_VIEW,
  Permission.SUPPLIER_VIEW,
  Permission.VENDOR_VIEW,
  Permission.CUSTOMER_CREATE,
  Permission.SUPPLIER_CREATE,
  Permission.VENDOR_CREATE,
];

export class ManagePartyGroupsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly parties: PartyRepository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async setup(command: PartySetupCommand): Promise<PartySetupResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const held = await this.accessControl.permissionsOf(tx, ctx);
      if (!PARTY_VIEW_PERMISSIONS.some((code) => held.includes(code))) {
        // Raised through `require` so the refusal carries the usual code,
        // message and denial audit rather than a second refusal path (§5.22).
        await this.accessControl.require(tx, ctx, Permission.CUSTOMER_VIEW);
      }

      const values = settingValuesOf(await this.settings.listStored(tx, ctx));
      const customerGroups = isFeatureOn(values, SettingKey.CUSTOMER_GROUPS_ENABLED);

      return {
        // No groups while the feature is off: the screen must not offer a
        // control the server would refuse (UI-09). The rows stay in the table,
        // because §5.21 preserves historical data when a feature is switched off.
        groups: customerGroups ? [...(await this.parties.listGroups(tx, ctx))] : [],
        features: {
          customerGroups,
          vendors: isFeatureOn(values, SettingKey.VENDOR_MANAGEMENT_ENABLED),
        },
        fields: {
          address: isFeatureOn(values, SettingKey.CUSTOMER_FIELD_ADDRESS_VISIBLE),
          guardianName: isFeatureOn(values, SettingKey.CUSTOMER_FIELD_GUARDIAN_VISIBLE),
          nid: isFeatureOn(values, SettingKey.CUSTOMER_FIELD_NID_VISIBLE),
          email: isFeatureOn(values, SettingKey.CUSTOMER_FIELD_EMAIL_VISIBLE),
          notes: isFeatureOn(values, SettingKey.CUSTOMER_FIELD_NOTES_VISIBLE),
        },
      };
    });
  }

  async create(command: CreateCustomerGroupCommand): Promise<PartySetupResponse> {
    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PARTY_GROUP_MANAGE);
      await this.assertGroupsOn(tx, ctx);

      const name = this.validName(command.name);
      await this.assertNameFree(tx, ctx, name, null);

      const id = Ulid.generate(this.clock);
      await this.parties.insertGroup(tx, ctx, { id, name });

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: id,
        action: 'CREATE',
        before: null,
        after: { name },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'customer_group.created',
        aggregateType: ENTITY_TYPE,
        aggregateId: id,
        payload: { name },
      });
    });

    return this.setup({ ctx });
  }

  async rename(command: RenameCustomerGroupCommand): Promise<PartySetupResponse> {
    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PARTY_GROUP_MANAGE);
      await this.assertGroupsOn(tx, ctx);

      const before = await this.requireGroup(tx, ctx, command.groupId);
      const name = this.validName(command.name);
      await this.assertNameFree(tx, ctx, name, before.id);

      await this.parties.renameGroup(tx, ctx, before.id, name);

      // Renaming a group renames it everywhere at once, which is the reason it
      // is a row rather than a text field on each customer.
      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: before.id,
        action: 'UPDATE',
        before: { name: before.name },
        after: { name },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'customer_group.updated',
        aggregateType: ENTITY_TYPE,
        aggregateId: before.id,
        payload: { name },
      });
    });

    return this.setup({ ctx });
  }

  /**
   * §3.6: a group nothing is filed under is deleted outright; one customers
   * already carry is archived, so those customers keep showing it and it is
   * merely no longer offered. The caller is told which happened — they are
   * different promises.
   */
  async remove(command: RemoveCustomerGroupCommand): Promise<RemoveCatalogEntryResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.PARTY_GROUP_MANAGE);
      await this.assertGroupsOn(tx, ctx);

      const group = await this.requireGroup(tx, ctx, command.groupId);
      const inUse = await this.parties.countInGroup(tx, ctx, group.id);

      if (inUse === 0) {
        await this.parties.deleteGroup(tx, ctx, group.id);
      } else {
        await this.parties.archiveGroup(tx, ctx, group.id);
      }

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: group.id,
        action: inUse === 0 ? 'DELETE' : 'ARCHIVE',
        before: { name: group.name, customers: inUse },
        after: null,
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: inUse === 0 ? 'customer_group.deleted' : 'customer_group.archived',
        aggregateType: ENTITY_TYPE,
        aggregateId: group.id,
        payload: { name: group.name },
      });

      return { outcome: inUse === 0 ? 'DELETED' : 'ARCHIVED' };
    });
  }

  /* ------------------------------------------------------- shared mechanics */

  private validName(value: string): string {
    if (!isValidCatalogName(value)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter a group name');
    }
    return normalizeCatalogName(value);
  }

  /**
   * Case-insensitive, matching the `lower(name)` unique index in migration 0009:
   * `Dealer` and `dealer` are one group, and two of them would split a price
   * list in half.
   */
  private async assertNameFree(
    tx: Tx,
    ctx: TenantContext,
    name: string,
    selfId: string | null,
  ): Promise<void> {
    const key = catalogNameKey(name);
    const clash = (await this.parties.listGroups(tx, ctx)).find(
      (group) => catalogNameKey(group.name) === key && group.id !== selfId,
    );
    if (clash !== undefined) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, `There is already a group called ${name}`);
    }
  }

  private async assertGroupsOn(tx: Tx, ctx: TenantContext): Promise<void> {
    const values = settingValuesOf(await this.settings.listStored(tx, ctx));
    if (!isFeatureOn(values, SettingKey.CUSTOMER_GROUPS_ENABLED)) {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        'Customer groups are switched off in Settings',
      );
    }
  }

  private async requireGroup(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<{ id: string; name: string }> {
    const group = await this.parties.findGroup(tx, ctx, id);
    if (group === null) throw new AppError(ErrorCode.NOT_FOUND, 'Customer group not found');
    return group;
  }
}
