import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type {
  BackupService,
  LicenseInstallService,
  LicenseStatusService,
  ManagementProfileRepository,
  TenantContext,
  UnitOfWork,
} from '@sher/core-application';
import {
  AppError,
  ErrorCode,
  managementFlagsRequestSchema,
  managementLicenceRequestSchema,
  managementSupportSessionRequestSchema,
} from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import type { Request } from 'express';

import { BACKUP_SERVICE, LICENSE_INSTALL_SERVICE, LICENSE_STATUS_SERVICE } from '../backup/tokens';
import type { ApiConfig } from '../config';
import { API_CONFIG, CLOCK, UNIT_OF_WORK } from '../infrastructure/tokens';
import { diagnosticsBuffer } from './diagnostics-buffer';
import { managementState } from './management-state';
import { MANAGEMENT_PROFILE_REPOSITORY } from './tokens';

/**
 * The endpoints the local management agent — and only it — may call.
 *
 * **Loopback plus a shared token.** Both processes live on the same machine, so
 * this is not defending against the network; it stops anything *else* on the
 * box driving the ERP's management surface just by knowing the port. The token
 * is set in the environment of both processes by the installer and never
 * travels anywhere else.
 *
 * **Notice how small this is.** Six routes, each doing one thing, and every one
 * of them calling a service that already existed: `LicenseInstallService` for a
 * licence, `BackupService` for a backup. There is no route that runs SQL, reads
 * a file, executes a command or touches a business table (§13, §27) — the
 * management surface is exactly this file, so it can be read in full and
 * checked against what the vendor is supposed to be able to do.
 */
@Controller('api/v1/management')
export class ManagementController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(MANAGEMENT_PROFILE_REPOSITORY) private readonly profiles: ManagementProfileRepository,
    @Inject(LICENSE_INSTALL_SERVICE) private readonly licenceInstalls: LicenseInstallService,
    @Inject(LICENSE_STATUS_SERVICE) private readonly licences: LicenseStatusService,
    @Inject(BACKUP_SERVICE) private readonly backups: BackupService,
  ) {}

  /** Everything the heartbeat reports (§6). Deployment facts only. */
  @Get('status')
  async status(@Req() request: Request): Promise<unknown> {
    this.assertAgent(request);
    const profile = await this.uow.runWithoutTenant(async (tx) => this.profiles.profile(tx));
    if (profile === null) {
      return { tenantId: '', appVersion: this.config.appVersion, schemaVersion: '', ready: false };
    }

    // Cached for the support guard, which needs the timezone and has no
    // database access. See the note in `support-grant.ts`.
    managementState.setInstallationTimezone(profile.timezone);

    const ctx = this.contextFor(profile.tenantId, profile.timezone);
    const licence = await this.licences.status(ctx).catch(() => null);
    /*
     * Backup health, from the ERP's own backup status — not a fresh probe.
     * §6: the heartbeat reports what the shop already knows, and asking the
     * backup service to prove itself on every check-in would mean a nightly
     * job's worth of work every three minutes.
     */
    const backupStatus = await this.backups.status({ ctx }).catch(() => null);
    const backupOk = backupStatus !== null && !backupStatus.automaticFailing;
    const lastBackupAt = backupStatus?.history[0]?.finishedAt ?? '';

    return {
      ready: true,
      tenantId: profile.tenantId,
      appVersion: this.config.appVersion,
      schemaVersion: profile.schemaVersion,
      // The installed licence's own id, which is stable and comparable — not
      // the key text, which is long and which the control plane already holds.
      licenceFingerprint: licence?.licenceId ?? '',
      licenceState: licence?.state ?? 'UNKNOWN',
      licenceValidUntil: licence?.validUntil ?? '',
      lastBackupAt: lastBackupAt,
      lastBackupOk: backupOk,
      syncPending: profile.syncPending,
      syncConflictsOpen: profile.syncConflictsOpen,
      // Codes and counts. Never messages — see `diagnostics-buffer.ts`.
      errorCounters: diagnosticsBuffer.counters(),
    };
  }

  /** Hands over the buffered failures and empties the buffer (§7). */
  @Post('diagnostics')
  @HttpCode(200)
  diagnostics(@Req() request: Request): unknown {
    this.assertAgent(request);
    return { events: diagnosticsBuffer.drain() };
  }

  /**
   * Installs a vendor-delivered licence.
   *
   * Straight into `LicenseInstallService` — the same service the paste box in
   * Settings → Licence calls. Same signature check, same business binding, same
   * anti-rollback rules, same audit row. §4 is explicit that the existing
   * signed model must not be replaced by a server boolean, and the way to
   * honour that is for this route to add nothing to it at all.
   */
  @Post('licence')
  @HttpCode(200)
  async installLicence(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    this.assertAgent(request);
    const parsed = managementLicenceRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A licence key is required');

    const profile = await this.uow.runWithoutTenant(async (tx) => this.profiles.profile(tx));
    if (profile === null) throw new AppError(ErrorCode.NOT_FOUND, 'This installation has no business yet');

    return this.licenceInstalls.install(
      this.contextFor(profile.tenantId, profile.timezone),
      parsed.data.key,
    );
  }

  /** The pre-update backup (§10 step 6), through the ERP's own backup service. */
  @Post('backup')
  @HttpCode(200)
  async backup(@Req() request: Request): Promise<unknown> {
    this.assertAgent(request);
    const profile = await this.uow.runWithoutTenant(async (tx) => this.profiles.profile(tx));
    if (profile === null) throw new AppError(ErrorCode.NOT_FOUND, 'This installation has no business yet');
    /*
     * , not : the manual path demands the owner's
     * password as a step-up, which the sidecar does not have and must never
     * have. This is the same archive the nightly job writes, pruned the same
     * way — so a pre-update backup is a file the restore path has actually
     * been exercised against.
     */
    const archive = await this.backups.runAutomatic(this.contextFor(profile.tenantId, profile.timezone));
    return { reference: archive.fileName };
  }

  /** Caches the vendor's flag set. Absent or unknown always means enabled (§19). */
  @Post('feature-flags')
  @HttpCode(200)
  setFlags(@Body() body: unknown, @Req() request: Request): { ok: true } {
    this.assertAgent(request);
    const parsed = managementFlagsRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A flag list is required');
    managementState.setFlags(parsed.data.flags);
    return { ok: true };
  }

  /**
   * Marks a support session live, or over.
   *
   * This drives the small indicator the shop sees while the vendor is inside
   * (§15). It grants nothing: the authority on every support request is the
   * signed grant checked in `support.guard.ts`, and a lie told here would show
   * a banner without opening a door.
   */
  @Post('support-session')
  @HttpCode(200)
  setSupportSession(@Body() body: unknown, @Req() request: Request): { ok: true } {
    this.assertAgent(request);
    const parsed = managementSupportSessionRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A session or null');
    managementState.setSupportSession(parsed.data.session);
    return { ok: true };
  }

  private assertAgent(request: Request): void {
    const token = request.headers['x-sher-management-token'];
    if (
      this.config.managementToken === '' ||
      typeof token !== 'string' ||
      token !== this.config.managementToken
    ) {
      // 404, not 403: an install with no management agent configured has no
      // management surface, and saying so is simply true. The same reasoning as
      // `SingleTenantRegistrationGuard` (D-34).
      throw new AppError(ErrorCode.NOT_FOUND, 'No such endpoint');
    }
  }

  /**
   * The context management actions run as.
   *
   * A named system actor rather than a borrowed user, so a licence installed by
   * the vendor is distinguishable in the audit trail from one the owner pasted
   * in — which is the whole point of auditing it.
   */
  private contextFor(tenantId: string, timezone: string): TenantContext {
    void this.clock;
    return { tenantId, userId: 'management-agent', timezone };
  }
}
