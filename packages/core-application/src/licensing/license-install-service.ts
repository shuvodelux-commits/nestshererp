import { licenseRegression, licenseStateAt } from '@sher/core-domain';
import type { LicenseTerms } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { LicenseInstallResponse, LicenseRejection } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

import type { AuditWriter } from '../ports/audit-writer';
import type { AccessControl } from '../ports/access-control';
import type { EntitlementProvider } from '../ports/entitlement-provider';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { LicenseKeyStore, LicenseVerifier, VerifiedLicense } from './license-ports';
import { licenseAppliesTo } from './entitlement-binding';

/**
 * Installing and renewing the licence (owner decisions 2026-09-02).
 *
 * Phase 10 gave the licence a screen that could only report; a shop whose term
 * had ended was told to renew by a page that could not renew anything, and the
 * key file had to be put in place by somebody with access to the machine. This
 * is the missing half: the Owner pastes the line the vendor sent, and the
 * server decides.
 *
 * **The server decides — that is the whole design.** The client sends one
 * string. Nothing in the request says which business, which modules, or how
 * long: all of that is inside a payload signed by the vendor's key, and every
 * one of the seven checks below runs here, in order, before a single byte is
 * written. A refused key changes nothing at all.
 *
 * **Nothing here posts.** No journal entry, no document number, no period
 * guard — the same rule the rest of Phase 10 follows, and the constructor has
 * none of the collaborators that would let it break it.
 */
export class LicenseInstallService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly verifier: LicenseVerifier,
    private readonly keys: LicenseKeyStore,
    private readonly entitlements: EntitlementProvider,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async install(ctx: TenantContext, raw: string): Promise<LicenseInstallResponse> {
    await this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.LICENSE_INSTALL);
    });

    const current = this.keys.current();

    /*
     * What the regression rule is allowed to compare against: the licence on
     * this machine **that applies to this business**.
     *
     * A key file for somebody else's shop is not this shop's licence, however
     * long it runs. Comparing against it would be the trap where a technician's
     * mistaken copy, valid until 2040, refuses every genuine key the real owner
     * pastes — the protection against going backwards turned into a lock on the
     * door. It still appears in the audit trail as what was there before.
     */
    const standing =
      current !== null && licenseAppliesTo(current.businessId, ctx.tenantId) ? current : null;

    /*
     * Judged on the monotonic licence clock, never the raw system clock: a
     * machine whose date was wound back must not be able to install a licence
     * that has already run out and have it look current.
     */
    const now = this.entitlements.current(this.clock.now()).evaluatedAt;

    const verification = this.verifier.verify(raw);
    if (!verification.ok) {
      throw await this.rejection(ctx, null, current, verification.reason, verification.message);
    }
    const candidate = verification.licence;

    if (!licenseAppliesTo(candidate.businessId, ctx.tenantId)) {
      throw await this.rejection(
        ctx,
        candidate,
        current,
        'FOREIGN_BUSINESS',
        'This licence was issued for a different business, so it cannot be installed here. ' +
          'Send the supplier the Business ID shown on this page and ask for a licence for it.',
      );
    }

    if (candidate.validUntil.getTime() <= candidate.issuedAt.getTime()) {
      throw await this.rejection(
        ctx,
        candidate,
        current,
        'DATES_INVALID',
        'This licence ends before it starts, so it cannot be used. Ask the supplier to send it again.',
      );
    }

    /*
     * A licence whose term *and* grace have both already run out would install
     * as READ_ONLY — the shop would paste a key and still not be able to trade,
     * which reads as the key not working. Refuse it by name instead.
     */
    const state = licenseStateAt(
      { validUntil: candidate.validUntil, issuedAt: candidate.issuedAt },
      now,
    );
    if (state === 'READ_ONLY') {
      throw await this.rejection(
        ctx,
        candidate,
        current,
        'DATES_INVALID',
        'This licence has already run out, so installing it would change nothing. ' +
          'Ask the supplier for the current one.',
      );
    }

    const regression = licenseRegression(
      termsOf(candidate),
      standing === null ? null : termsOf(standing),
    );
    if (regression === 'EARLIER_EXPIRY') {
      throw await this.rejection(
        ctx,
        candidate,
        current,
        'EARLIER_EXPIRY',
        `The licence already on this computer runs to ${dayText(standing?.validUntil ?? null)}, ` +
          `and this key ends earlier, on ${dayText(candidate.validUntil)}. ` +
          'Nothing has been changed. Check whether an older key was pasted by mistake.',
      );
    }
    if (regression === 'FEWER_MODULES') {
      throw await this.rejection(
        ctx,
        candidate,
        current,
        'FEWER_MODULES',
        'This key includes less than the licence already on this computer, so nothing has been ' +
          'changed. Ask the supplier to send a licence that covers everything this shop uses.',
      );
    }

    try {
      await this.keys.install(raw);
    } catch (cause) {
      throw await this.rejection(
        ctx,
        candidate,
        current,
        'NOT_WRITABLE',
        'The licence is genuine, but it could not be saved on this computer. ' +
          `The licence already here is untouched. (${messageOf(cause)})`,
      );
    }

    await this.uow.run(ctx, async (tx) => {
      await this.audit.append(tx, ctx, {
        entityType: 'license',
        entityId: candidate.licenceId,
        action: 'INSTALLED',
        before: current === null ? null : recordOf(current),
        after: recordOf(candidate),
        source: 'API',
      });
    });

    return {
      licenceId: candidate.licenceId,
      validUntil: candidate.validUntil.toISOString(),
      modules: [...candidate.modules],
      previousLicenceId: current?.licenceId ?? null,
    };
  }

  /**
   * Record the refusal, then refuse.
   *
   * The audit row is committed in its own transaction *before* the error is
   * thrown, because an audit written inside the failing transaction would roll
   * back with it — and a rejected install that leaves no trace is exactly the
   * one somebody will ask about later (owner decision 2026-09-02: successful
   * and rejected alike). The key itself is never recorded: what is useful is
   * which licence, from which signing key, and why it was refused.
   */
  private async rejection(
    ctx: TenantContext,
    candidate: VerifiedLicense | null,
    current: VerifiedLicense | null,
    reason: LicenseRejection,
    message: string,
  ): Promise<AppError> {
    await this.uow.run(ctx, async (tx) => {
      await this.audit.append(tx, ctx, {
        entityType: 'license',
        entityId: candidate?.licenceId ?? 'NONE',
        action: 'INSTALL_REJECTED',
        before: current === null ? null : recordOf(current),
        after: candidate === null ? null : recordOf(candidate),
        reason,
        source: 'API',
      });
    });

    return new AppError(ErrorCode.VALIDATION_FAILED, message, { reason });
  }
}

function termsOf(licence: VerifiedLicense): LicenseTerms {
  return {
    licenceId: licence.licenceId,
    validUntil: licence.validUntil,
    modules: licence.modules,
    replacementOf: licence.replacementOf,
  };
}

function recordOf(licence: VerifiedLicense): Record<string, string | number | null> {
  return {
    licenceId: licence.licenceId,
    signingKeyId: licence.signingKeyId,
    businessId: licence.businessId,
    issuedAt: licence.issuedAt.toISOString(),
    validUntil: licence.validUntil.toISOString(),
    modules: licence.modules.length === 0 ? 'ALL' : [...licence.modules].join(','),
    replacementOf: licence.replacementOf,
  };
}

function dayText(value: Date | null): string {
  return value === null ? 'an unknown date' : value.toISOString().slice(0, 10);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown error';
}
