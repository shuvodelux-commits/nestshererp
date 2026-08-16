import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { RequestPasswordResetService, ResetPasswordService } from '@sher/core-application';
import type { RequestPasswordResetResponse } from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  requestPasswordResetRequestSchema,
  resetPasswordRequestSchema,
} from '@sher/core-contracts';

import {
  REQUEST_PASSWORD_RESET_SERVICE,
  RESET_PASSWORD_SERVICE,
} from './tokens';

/**
 * Forgot password (D-07). Unauthenticated by necessity — someone who has lost
 * their password has nothing to authenticate with, which is the entire point.
 *
 * Validate shape → call use case → map result (R-B5). Whether an identifier has
 * an account is decided in the use case, which answers identically either way.
 */
@Controller('api/v1/auth/password')
export class PasswordRecoveryController {
  constructor(
    @Inject(REQUEST_PASSWORD_RESET_SERVICE)
    private readonly requestReset: RequestPasswordResetService,
    @Inject(RESET_PASSWORD_SERVICE) private readonly reset: ResetPasswordService,
  ) {}

  @Post('otp')
  @HttpCode(200)
  async sendOtp(@Body() body: unknown): Promise<{ data: RequestPasswordResetResponse }> {
    const parsed = requestPasswordResetRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.requestReset.execute(parsed.data) };
  }

  /** 204: a reset returns no session — the new password is used to log in. */
  @Post('reset')
  @HttpCode(204)
  async resetPassword(@Body() body: unknown): Promise<void> {
    const parsed = resetPasswordRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    await this.reset.execute(parsed.data);
  }
}

/** Field names only — a validation message must never echo a password back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
