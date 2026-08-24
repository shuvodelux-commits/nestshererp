import { AppError, ErrorCode, TOGGLE_ON } from '@sher/core-contracts';
import type { MyAccessResponse } from '@sher/core-contracts';

import { effectiveSettings, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { TenantRepository, UserRepository } from './registration-repository';

/**
 * Who is signed in, and what they may do.
 *
 * This is what makes UI-09 possible — "never render a control that will 403".
 * Without it the client has to guess, so it renders everything and lets the
 * server refuse, which is the behaviour §5.26 forbids: "hide the control in the
 * UI **and** enforce server-side."
 *
 * **It is not an authorisation decision.** Every use case still calls
 * `AccessControl.require` for itself, so a client that ignored this list, or
 * lied about it, would gain exactly nothing. The list is a convenience for
 * drawing the screen, and the screen is not the security boundary.
 *
 * No permission gates this endpoint. Refusing to tell someone what they may do
 * would leave the app unable to draw itself for them at all, and it reveals
 * nothing they could not learn by clicking.
 */
export class GetMyAccessService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly users: UserRepository,
    private readonly tenants: TenantRepository,
    private readonly settings: SettingsRepository,
  ) {}

  async execute(ctx: TenantContext): Promise<MyAccessResponse> {
    return this.uow.run(ctx, async (tx) => {
      const user = await this.users.findSummary(tx, ctx, ctx.userId);
      // A valid token for a user who has since been disabled or removed reads
      // as not found, never as a server error.
      if (user === null || user.disabled) {
        throw new AppError(ErrorCode.NOT_FOUND, 'User not found');
      }

      const [businessName, permissions, stored] = await Promise.all([
        this.tenants.findName(tx, ctx),
        this.accessControl.permissionsOf(tx, ctx),
        this.settings.listStored(tx, ctx),
      ]);

      /*
       * Which §5.21 toggles are on, so the shell can leave Vendors and Customer
       * Groups out of the navigation while their feature is off (§5.6).
       *
       * Read through `effectiveSettings` rather than off the stored rows, so a
       * setting nobody has touched reports its catalogue default instead of
       * being absent — otherwise a feature that defaults to on would be
       * invisible until someone opened Settings and saved it.
       */
      const values = effectiveSettings(settingValuesOf(stored));
      const features = [...values.entries()]
        .filter(([, value]) => value === TOGGLE_ON)
        .map(([key]) => key);

      return {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          roleName: user.roleName,
        },
        businessName: businessName ?? '',
        permissions: [...permissions],
        features,
      };
    });
  }
}
