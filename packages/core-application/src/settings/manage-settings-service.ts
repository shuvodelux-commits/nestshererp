import {
  AppError,
  ErrorCode,
  Permission,
  SETTING_CATALOGUE,
  SUPPORTED_TIMEZONES,
  TOGGLE_OFF,
} from '@sher/core-contracts';
import type { SettingDescriptor, SettingsResponse } from '@sher/core-contracts';
import type { UserRepository } from '../auth/registration-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import {
  cascadeOff,
  effectiveSettings,
  effectiveValue,
  isAllowedValue,
  settingDescriptor,
  unmetParents,
} from './feature-dependencies';
import type { BusinessProfileRepository, SettingsRepository } from './settings-repository';

/**
 * Tenant settings and feature controls (slice 1.5, §5.21).
 *
 * **WRITE CLASS: M.** Configuration, not a document: tenant context →
 * permission (and step-up where §5.3 requires it) → load → invariant → persist
 * → audit → commit. There is no period guard, no numbering, no journal and no
 * stock movement, because changing a setting posts nothing. Inventing those
 * steps here is exactly what R-D forbids.
 *
 * No idempotency key either. Class M writes take one "when a retry could create
 * a duplicate" (R-D3), and a settings write cannot: it is keyed on
 * `(tenant, key)` and replaying it lands on the same row with the same value.
 *
 * **A changed setting takes effect on the next request, not on the next login.**
 * Nothing here is cached and nothing is carried in a token, for the same reason
 * permissions are not (§5.3) — a shop that turned a feature off should not have
 * to send everybody home to make it stop.
 */
export interface GetSettingsCommand {
  readonly ctx: TenantContext;
}

export interface UpdateSettingCommand {
  readonly ctx: TenantContext;
  readonly key: string;
  readonly value: string;
  /**
   * Required only for the settings whose descriptor says `stepUp` (§5.3).
   * Explicitly `| undefined` because the workspace runs
   * `exactOptionalPropertyTypes` — an absent password and one sent as
   * `undefined` are the same thing here, and both are refused.
   */
  readonly confirmPassword?: string | undefined;
}

export interface UpdateBusinessProfileCommand {
  readonly ctx: TenantContext;
  readonly businessName: string;
  readonly timezone: string;
}

/**
 * What a save changed. `cascadedOff` names the dependent features that had to
 * go off with it (§5.21) — the owner is told, never left to discover it.
 */
export interface UpdateSettingResult {
  readonly settings: SettingsResponse;
  readonly cascadedOff: readonly string[];
}

function stepUpFailed(): AppError {
  return new AppError(ErrorCode.UNAUTHENTICATED, 'Your password is not correct');
}

export class ManageSettingsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly settings: SettingsRepository,
    private readonly profiles: BusinessProfileRepository,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
  ) {}

  async get(command: GetSettingsCommand): Promise<SettingsResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.SETTING_VIEW);
      return this.snapshot(tx, ctx);
    });
  }

  async updateSetting(command: UpdateSettingCommand): Promise<UpdateSettingResult> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const descriptor = settingDescriptor(command.key);
      // An unknown key is refused rather than stored. Writing one would put a
      // value in the database that nothing ever reads — it would look like a
      // configured business rule and be none.
      if (descriptor === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Unknown setting', { key: command.key });
      }

      // §5.26: turning a module on or off is its own permission, separate from
      // choosing how an already-running one behaves. A manager may be trusted
      // to switch costing between the two methods the SRS allows without being
      // able to switch selling off for the whole shop.
      await this.accessControl.require(
        tx,
        ctx,
        descriptor.kind === 'TOGGLE' ? Permission.SETTING_TOGGLE : Permission.SETTING_EDIT,
      );

      if (!isAllowedValue(descriptor, command.value)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That is not a value this setting takes', {
          key: descriptor.key,
          allowed: descriptor.options.join(', '),
        });
      }

      // §5.3 lists "change costing method … or accounting settings" among the
      // step-up actions. Asserted here in the use case, not in a UI dialog.
      if (descriptor.stepUp) {
        await this.assertStepUp(tx, ctx, command.confirmPassword ?? '');
      }

      const stored = await this.loadValues(tx, ctx);
      const before = effectiveValue(descriptor, stored);
      if (before === command.value) {
        // Nothing moved. Writing an audit row saying `FIFO` became `FIFO` would
        // pad the trail with events that record no change (§5.22).
        return { settings: await this.snapshot(tx, ctx), cascadedOff: [] };
      }

      // §5.21: "invalid combinations are prevented, not merely discouraged."
      const missing = unmetParents(descriptor, command.value, stored);
      if (missing.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Turn on ${missing.map((parent) => quoted(parent)).join(' and ')} first — ${descriptor.label} needs ${missing.length === 1 ? 'it' : 'them'}.`,
          { key: descriptor.key, requires: missing.map((parent) => parent.key).join(', ') },
        );
      }

      // §5.21: "Turning off a parent feature must either cascade or be refused
      // with an explanation — never leave a dependent feature enabled and
      // broken." It cascades, inside this same transaction, and the result says
      // what went with it.
      const falling = cascadeOff(descriptor, command.value, stored);

      await this.settings.put(tx, ctx, descriptor.key, command.value);
      await this.audit.append(tx, ctx, {
        entityType: 'setting',
        entityId: descriptor.key,
        action: 'UPDATE',
        before: { value: before },
        after: { value: command.value },
        source: 'API',
      });

      for (const child of falling) {
        await this.settings.put(tx, ctx, child.key, TOGGLE_OFF);
        await this.audit.append(tx, ctx, {
          entityType: 'setting',
          entityId: child.key,
          action: 'UPDATE',
          before: { value: effectiveValue(child, stored) },
          after: { value: TOGGLE_OFF },
          // Why it changed, not just that it did: this row was not something
          // the owner clicked, and the trail has to be able to say so.
          reason: `Turned off with ${descriptor.label}`,
          source: 'API',
        });
      }

      return {
        settings: await this.snapshot(tx, ctx),
        cascadedOff: falling.map((child) => child.label),
      };
    });
  }

  /**
   * The business name and timezone (§5.2, §3.5).
   *
   * Timezone is not cosmetic: `business_date` is computed in it, so moving it
   * moves which day a transaction belongs to. It is restricted to the zones
   * SherERP supports rather than accepting any string — an unrecognised zone
   * would make every later business date a runtime error.
   */
  async updateBusinessProfile(command: UpdateBusinessProfileCommand): Promise<SettingsResponse> {
    const { ctx } = command;
    const businessName = command.businessName.trim();

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.SETTING_EDIT);

      if (businessName.length < 2) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter the name of the business');
      }
      if (!SUPPORTED_TIMEZONES.includes(command.timezone as (typeof SUPPORTED_TIMEZONES)[number])) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'SherERP does not support that timezone', {
          timezone: command.timezone,
        });
      }

      const before = await this.profiles.findProfile(tx, ctx);
      if (before === null) throw new AppError(ErrorCode.NOT_FOUND, 'Business not found');

      if (before.businessName === businessName && before.timezone === command.timezone) {
        return this.snapshot(tx, ctx);
      }

      await this.profiles.updateProfile(tx, ctx, { businessName, timezone: command.timezone });
      await this.audit.append(tx, ctx, {
        entityType: 'tenant',
        entityId: ctx.tenantId,
        action: 'UPDATE',
        before: { businessName: before.businessName, timezone: before.timezone },
        after: { businessName, timezone: command.timezone },
        source: 'API',
      });

      return this.snapshot(tx, ctx);
    });
  }

  /** Stored values only — the defaults are filled in where they are read. */
  private async loadValues(tx: Tx, ctx: TenantContext): Promise<Map<string, string>> {
    const stored = await this.settings.listStored(tx, ctx);
    return new Map(stored.map((row) => [row.key, row.value]));
  }

  private async snapshot(tx: Tx, ctx: TenantContext): Promise<SettingsResponse> {
    const profile = await this.profiles.findProfile(tx, ctx);
    if (profile === null) throw new AppError(ErrorCode.NOT_FOUND, 'Business not found');

    const values = effectiveSettings(await this.loadValues(tx, ctx));

    return {
      businessName: profile.businessName,
      timezone: profile.timezone,
      supportedTimezones: [...SUPPORTED_TIMEZONES],
      catalogue: SETTING_CATALOGUE.map((descriptor) => ({
        ...descriptor,
        options: [...descriptor.options],
        requires: [...descriptor.requires],
      })),
      values: Object.fromEntries(values),
    };
  }

  /** §5.3: a fresh credential, the caller's own. A PIN never satisfies step-up. */
  private async assertStepUp(tx: Tx, ctx: TenantContext, confirmPassword: string): Promise<void> {
    if (confirmPassword === '') throw stepUpFailed();

    const self = await this.users.findCredentials(tx, ctx, ctx.userId);
    if (self === null) throw stepUpFailed();
    if (self.passwordHash === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Set a password in Settings → Security before changing this',
      );
    }
    if (!(await this.hasher.verify(confirmPassword, self.passwordHash))) throw stepUpFailed();
  }
}

function quoted(descriptor: SettingDescriptor): string {
  return `“${descriptor.label}”`;
}
