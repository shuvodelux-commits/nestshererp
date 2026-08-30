import { licenceIncludes, LICENSED_MODULES, Permission } from '@sher/core-contracts';
import type { LicenseNotice, LicenseStatusResponse } from '@sher/core-contracts';
import { addSeconds } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { BackupRepository } from '../backup/backup-repository';
import type { AccessControl } from '../ports/access-control';
import type { EntitlementProvider } from '../ports/entitlement-provider';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';

/**
 * Telling the shop where its licence stands (Phase 10, §5.4, D-35, D-36, owner
 * decision 2026-08-30).
 *
 * **Read-only, in the strongest sense: there is no write path in this file.**
 * Entitlement comes from the signed key file on this machine and from nowhere
 * else, so there is nothing a client could post that would change what this
 * service returns — which is also why a restore cannot restore, extend or
 * bypass a licence.
 *
 * Two methods, because two different audiences ask. `status` is the Settings →
 * Licence page and needs `license.term.view`. `notice` is the banner, and is
 * deliberately **ungated**: a cashier whose sale will not save has to be told
 * why on the screen they are standing at, and hiding the reason behind a
 * permission they do not hold would leave them staring at a failure with no
 * explanation.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** D-36's ladder: EXPIRING starts 30 days out, GRACE runs 30 days past the end. */
const GRACE_DAYS = 30;
const SECONDS_PER_DAY = 24 * 60 * 60;

export class LicenseStatusService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly entitlements: EntitlementProvider,
    private readonly backups: BackupRepository,
    private readonly clock: Clock,
  ) {}

  async status(ctx: TenantContext): Promise<LicenseStatusResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.LICENSE_VIEW);

      const now = this.clock.now();
      const entitlement = this.entitlements.current(now);
      const businessName = await this.backups.businessName(tx, ctx);

      const modules = await Promise.all(
        LICENSED_MODULES.map(async (module) => {
          const included = licenceIncludes(entitlement.modules, module.code);
          return {
            code: module.code,
            label: module.label,
            labelBn: module.labelBn,
            included,
            readOnlyHistorical:
              !included && (await this.backups.hasRowsIn(tx, ctx, module.dataTables)),
          };
        }),
      );

      return {
        state: entitlement.state,
        businessName,
        validUntil: entitlement.validUntil?.toISOString() ?? null,
        daysRemaining: daysUntil(entitlement.validUntil, now),
        graceDaysRemaining: graceRemaining(entitlement.state, entitlement.validUntil, now),
        /*
         * "Could not read a licence at all" is exactly one situation: READ_ONLY
         * with no end date, which is what D-35 resolves a missing, deleted or
         * forged key file to ("never a crash, never data loss"). Saying so
         * plainly tells a shop to look for the key file rather than ring about
         * a renewal they have already paid for.
         *
         * A term-less ACTIVE is a different thing entirely — it is the SaaS
         * entitlement provider, which answers from a subscription rather than a
         * file — and must not be reported as an unreadable licence.
         */
        licenceReadable: !(entitlement.state === 'READ_ONLY' && entitlement.validUntil === null),
        modules,
      };
    });
  }

  /** The banner. Every signed-in user gets it, whatever their role. */
  async notice(ctx: TenantContext): Promise<LicenseNotice> {
    return this.uow.run(ctx, async (tx) => this.noticeWithin(tx, ctx));
  }

  async noticeWithin(tx: Tx, ctx: TenantContext): Promise<LicenseNotice> {
    const now = this.clock.now();
    const entitlement = this.entitlements.current(now);

    const hidden: string[] = [];
    const readOnly: string[] = [];
    for (const module of LICENSED_MODULES) {
      if (licenceIncludes(entitlement.modules, module.code)) continue;
      const used = await this.backups.hasRowsIn(tx, ctx, module.dataTables);
      (used ? readOnly : hidden).push(module.code);
    }

    return {
      state: entitlement.state,
      validUntil: entitlement.validUntil?.toISOString() ?? null,
      daysRemaining: daysUntil(entitlement.validUntil, now),
      graceDaysRemaining: graceRemaining(entitlement.state, entitlement.validUntil, now),
      hiddenModules: hidden,
      readOnlyModules: readOnly,
    };
  }
}

function daysUntil(validUntil: Date | null, now: Date): number | null {
  if (validUntil === null) return null;
  return Math.ceil((validUntil.getTime() - now.getTime()) / MILLISECONDS_PER_DAY);
}

function graceRemaining(state: string, validUntil: Date | null, now: Date): number | null {
  if (state !== 'GRACE' || validUntil === null) return null;
  const graceEnds = addSeconds(validUntil, GRACE_DAYS * SECONDS_PER_DAY);
  return Math.max(0, Math.ceil((graceEnds.getTime() - now.getTime()) / MILLISECONDS_PER_DAY));
}
