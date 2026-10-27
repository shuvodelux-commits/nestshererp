import { Body, Controller, Get, Header, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type {
  BackupService,
  ResetBusinessService,
  RestoreService,
  TenantContext,
} from '@sher/core-application';
import type {
  ArchivePreviewResponse,
  BackupStatusResponse,
  ResetResultResponse,
  RestoreResultResponse,
} from '@sher/core-contracts';
import {
  exportBackupRequestSchema,
  inspectArchiveRequestSchema,
  replaceBackupSecretRequestSchema,
  resetBusinessRequestSchema,
  restoreBackupRequestSchema,
} from '@sher/core-contracts';
import type { Response } from 'express';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { invalidBody } from '../money/accounts.controller';
import { BACKUP_SERVICE, RESET_BUSINESS_SERVICE, RESTORE_SERVICE } from './tokens';

/**
 * Backup, restore and reset over HTTP (Phase 10, §5.25).
 *
 * Validate shape → build command → call use case → map result (R-B5). Who may
 * do any of this, and whether the installation is in a state to allow it, is
 * decided in the use cases — not here.
 *
 * **The backup secret is never in a response on this controller**, in any
 * shape. It can be replaced and it can be reported as configured or not; there
 * is deliberately no route that returns it (owner decision 2026-08-30).
 */
@Controller('api/v1/backup')
@UseGuards(TenantContextGuard)
export class BackupController {
  constructor(
    @Inject(BACKUP_SERVICE) private readonly backups: BackupService,
    @Inject(RESTORE_SERVICE) private readonly restores: RestoreService,
    @Inject(RESET_BUSINESS_SERVICE) private readonly resets: ResetBusinessService,
  ) {}

  /*
   * Wrapped in `{ data }` like every other endpoint (§5.26's envelope).
   *
   * It was the one endpoint in this controller that returned its body bare, and
   * `apps/web/src/api/client.ts` unwraps `.data` from every response — so the
   * Backup settings screen received `undefined`, threw on
   * `status.secretConfigured` while rendering, and never showed the warning
   * that no backup password is set. The only test on this route asserted a 403,
   * so nothing ever looked at the successful shape.
   */
  @Get('status')
  async status(@Ctx() ctx: TenantContext): Promise<{ data: BackupStatusResponse }> {
    return { data: await this.backups.status({ ctx }) };
  }

  /**
   * The archive itself, streamed to the browser.
   *
   * A POST rather than a GET because it carries the step-up password and
   * because it writes a row recording that an export happened — a GET that
   * changes state is a GET a proxy may repeat.
   */
  @Post('export')
  @HttpCode(200)
  @Header('Content-Type', 'application/octet-stream')
  async export(@Body() body: unknown, @Ctx() ctx: TenantContext, @Res() res: Response): Promise<void> {
    const parsed = exportBackupRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    const archive = await this.backups.exportNow({ ctx, confirmPassword: parsed.data.confirmPassword });
    res.setHeader('Content-Disposition', `attachment; filename="${archive.fileName}"`);
    res.setHeader('Content-Length', String(archive.bytes.byteLength));
    res.end(Buffer.from(archive.bytes));
  }

  /** Reads the file and says what is in it. Writes nothing. */
  @Post('inspect')
  @HttpCode(200)
  async inspect(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ArchivePreviewResponse }> {
    const parsed = inspectArchiveRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return {
      data: await this.restores.inspect({
        ctx,
        fileName: parsed.data.fileName,
        content: new Uint8Array(Buffer.from(parsed.data.contentBase64, 'base64')),
      }),
    };
  }

  @Post('restore')
  @HttpCode(200)
  async restore(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: RestoreResultResponse }> {
    const parsed = restoreBackupRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return {
      data: await this.restores.restore({
        ctx,
        fileName: parsed.data.fileName,
        content: new Uint8Array(Buffer.from(parsed.data.contentBase64, 'base64')),
        confirmPassword: parsed.data.confirmPassword,
      }),
    };
  }

  @Post('reset')
  @HttpCode(200)
  async reset(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ResetResultResponse }> {
    const parsed = resetBusinessRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.resets.reset({ ctx, ...parsed.data }) };
  }

  /**
   * Replacing the installation's backup secret.
   *
   * Existing archives stay encrypted under the previous secret and become
   * unopenable by this installation — which is why the screen says so before
   * the button, and why this route returns nothing that could be mistaken for
   * a copy of either secret.
   */
  @Post('secret')
  @HttpCode(200)
  async replaceSecret(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: { configured: true } }> {
    const parsed = replaceBackupSecretRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    await this.backups.replaceSecret({ ctx, ...parsed.data });
    return { data: { configured: true } };
  }
}
