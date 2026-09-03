import { LICENSED_MODULES, Permission } from '@sher/core-contracts';
import type { LicenseNotice, LicenseStatusResponse } from '@sher/core-contracts';
import { addSeconds } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { BackupRepository } from '../backup/backup-repository';
import { entitlementFor, entitlesModule, licenseAppliesTo } from './entitlement-binding';
import type { AccessControl } from '../ports/access-control';
import type { Entitlement, EntitlementProvider } from '../ports/entitlement-provider';
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
/** Below this, a backwards clock is an NTP correction and saying so is noise. */
const CLOCK_DRIFT_TOLERANCE_MS = 5 * 60 * 1000;
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

      const raw = this.entitlements.current(this.clock.now());
      const entitlement = entitlementFor(raw, ctx.tenantId);
      // Days remaining are counted from the licence's own clock, never the
      // machine's, so winding the date back cannot make a term look longer.
      const now = entitlement.evaluatedAt;
      const businessName = await this.backups.businessName(tx, ctx);

      const modules = await Promise.all(
        LICENSED_MODULES.map(async (module) => {
          const included = entitlesModule(entitlement, module.code);
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
        /*
         * Judged on the *raw* entitlement, before the business binding: a
         * licence for another shop was read perfectly well, and telling the
         * owner it could not be read would send them looking for a missing
         * file instead of at `foreignBusiness`, which says what is really wrong.
         */
        licenceReadable: !(raw.state === 'READ_ONLY' && raw.validUntil === null),
        /*
         * The business's own id, shown so it can be read out or copied into a
         * message when asking for a licence. It grants nothing: a licence
         * naming it still has to be signed by the vendor's key.
         */
        businessId: ctx.tenantId,
        licenceId: entitlement.licenceId,
        foreignBusiness: !licenseAppliesTo(raw.businessId, ctx.tenantId),
        clockWarning: clockWarningFor(raw),
        modules,
      };
    });
  }

  /** The banner. Every signed-in user gets it, whatever their role. */
  async notice(ctx: TenantContext): Promise<LicenseNotice> {
    return this.uow.run(ctx, async (tx) => this.noticeWithin(tx, ctx));
  }

  async noticeWithin(tx: Tx, ctx: TenantContext): Promise<LicenseNotice> {
    const entitlement = entitlementFor(this.entitlements.current(this.clock.now()), ctx.tenantId);
    const now = entitlement.evaluatedAt;

    const hidden: string[] = [];
    const readOnly: string[] = [];
    for (const module of LICENSED_MODULES) {
      if (entitlesModule(entitlement, module.code)) continue;
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

/**
 * The quiet note about a machine whose clock disagrees with what SherERP has
 * already seen — in either direction.
 *
 * Diagnostic only (owner decision 2026-09-02). The licence is judged at the
 * later of the two instants, so the shop loses nothing either way, and no
 * business date, period or posting is touched by this — it is here because a
 * machine with a wrong clock will date its own paperwork wrong, which the owner
 * wants to know for reasons that have nothing to do with the licence.
 *
 * **`clockBehindMs` is signed, and the negative case is the important one.**
 * Positive is a clock wound back, which buys nothing and is worth a mention.
 * Negative is a clock reading so far ahead that the machine refused to record
 * it — a dead RTC announcing a year that has not happened — and on that reading
 * every licence looks long expired. Saying only "your licence ran out" there
 * would send an owner to buy a renewal for a fault that a corrected date fixes
 * for nothing, so the clock is named first and plainly.
 */
function clockWarningFor(entitlement: Entitlement): string | null {
  if (entitlement.clockBehindMs < 0) {
    const aheadDays = Math.floor(-entitlement.clockBehindMs / MILLISECONDS_PER_DAY);
    return (
      `This computer's date reads about ${String(aheadDays)} day(s) in the future, which is ` +
      'further ahead than SherERP is willing to believe, so it has not been recorded. ' +
      'Until the date is corrected the licence will be judged against that wrong date and may ' +
      'look expired when it is not. Nothing already recorded has been changed. Please set this ' +
      "computer's date and time correctly — a replacement CMOS battery is the usual cure — and " +
      'reopen this page.'
    );
  }

  const days = Math.floor(entitlement.clockBehindMs / MILLISECONDS_PER_DAY);
  if (entitlement.clockBehindMs <= CLOCK_DRIFT_TOLERANCE_MS) return null;
  const tail =
    'The licence is judged on the later of the two dates, so turning the clock back neither ' +
    'shortens nor extends it. Please check this computer\'s date and time.';
  return days >= 1
    ? `This computer's date is about ${String(days)} day(s) behind a date SherERP has already seen. ${tail}`
    : `This computer's clock has moved backwards. ${tail}`;
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
