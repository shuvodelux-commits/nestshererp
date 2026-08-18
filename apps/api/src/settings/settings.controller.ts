import { Body, Controller, Get, Inject, Patch, Post, UseGuards } from '@nestjs/common';
import type { ManageSettingsService, TenantContext } from '@sher/core-application';
import type { SettingsResponse } from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  updateBusinessProfileRequestSchema,
  updateSettingRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_SETTINGS_SERVICE } from './tokens';

/**
 * Settings and feature controls (slice 1.5, §5.21).
 *
 * Saving one setting is `POST /settings/value` rather than a `PATCH` on a
 * settings document: §5.26 keeps state changes as their own action endpoint,
 * and a setting change can cascade other features off, which is not what a
 * field patch means.
 */
@Controller('api/v1/settings')
@UseGuards(TenantContextGuard)
export class SettingsController {
  constructor(@Inject(MANAGE_SETTINGS_SERVICE) private readonly settings: ManageSettingsService) {}

  @Get()
  async get(@Ctx() ctx: TenantContext): Promise<{ data: SettingsResponse }> {
    return { data: await this.settings.get({ ctx }) };
  }

  @Post('value')
  async setValue(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SettingsResponse; warnings: readonly { code: string; message: string }[] }> {
    const parsed = updateSettingRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    const result = await this.settings.updateSetting({ ctx, ...parsed.data });
    // §5.26 returns a warning as a 200 with `warnings` the client must display.
    // A cascade is exactly that: the save succeeded, and something else changed
    // with it that the owner did not click.
    return {
      data: result.settings,
      warnings: result.cascadedOff.map((label) => ({
        code: 'FEATURE_DISABLED',
        message: `${label} was turned off too, because it needs the feature you just turned off.`,
      })),
    };
  }

  @Patch('business')
  async setBusinessProfile(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SettingsResponse }> {
    const parsed = updateBusinessProfileRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.settings.updateBusinessProfile({ ctx, ...parsed.data }) };
  }
}

/** Field names only — a validation message must never echo a password back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
