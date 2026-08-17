import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { ChangeCredentialsService, TenantContext } from '@sher/core-application';
import type { SecuritySettingsResponse } from '@sher/core-contracts';
import {
  AppError,
  changePasswordRequestSchema,
  changePinRequestSchema,
  ErrorCode,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { CHANGE_CREDENTIALS_SERVICE } from './tokens';

/**
 * Settings → Security: change your own password or PIN (§5.3).
 *
 * Guarded, unlike recovery: you must already be signed in, and the use case
 * additionally requires the current credential. The user id comes from the
 * verified token via `@Ctx`, never from the body — which is what makes "your
 * own" true rather than merely intended (R-C4).
 */
@Controller('api/v1/settings/security')
@UseGuards(TenantContextGuard)
export class SecurityController {
  constructor(
    @Inject(CHANGE_CREDENTIALS_SERVICE) private readonly credentials: ChangeCredentialsService,
  ) {}

  /** Which credentials exist, so the screen offers Set or Change (never both). */
  @Get()
  async read(@Ctx() ctx: TenantContext): Promise<{ data: SecuritySettingsResponse }> {
    return { data: await this.credentials.read(ctx) };
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(@Body() body: unknown, @Ctx() ctx: TenantContext): Promise<void> {
    const parsed = changePasswordRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    await this.credentials.changePassword({ ctx, ...parsed.data });
  }

  @Post('pin')
  @HttpCode(204)
  async changePin(@Body() body: unknown, @Ctx() ctx: TenantContext): Promise<void> {
    const parsed = changePinRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    await this.credentials.changePin({ ctx, ...parsed.data });
  }
}

/** Field names only — a validation message must never echo a password back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
