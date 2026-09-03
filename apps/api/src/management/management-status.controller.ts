import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { Clock } from '@sher/shared-utils';

import { TenantContextGuard } from '../auth/tenant-context.guard';
import { CLOCK } from '../infrastructure/tokens';
import { managementState } from './management-state';

/**
 * What a shop's own users are told about the vendor (§15, §19).
 *
 * Two facts, both read by the app shell on every page load:
 *
 * - **A support session indicator.** A small, non-blocking line saying the
 *   software provider is currently in (owner decision 2026-09-03). Not a
 *   consent prompt — access is pre-authorized by the support arrangement — and
 *   not a history screen, which the owner explicitly did not want. But not
 *   hidden either: a vendor session that a shop cannot see happening is the one
 *   thing §15 rules out.
 * - **The feature flags in force.** So a screen the vendor has switched off
 *   stops rendering. Absent, unknown, or never delivered all resolve to
 *   enabled, so a control-plane outage cannot take a customer's features away.
 *
 * Behind the ordinary tenant guard and gated on no permission: a cashier
 * standing at the till needs to see both, and hiding them behind a role the
 * owner holds would defeat the purpose of showing them at all.
 */
@Controller('api/v1/provider')
@UseGuards(TenantContextGuard)
export class ManagementStatusController {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  @Get('status')
  status(): unknown {
    const session = managementState.supportSession(this.clock.now());
    return {
      supportSession:
        session === null
          ? null
          : {
              operatorName: session.operator_name,
              reason: session.reason,
              startedAt: session.issued_at,
            },
      featureFlags: managementState.listFlags(),
    };
  }
}
