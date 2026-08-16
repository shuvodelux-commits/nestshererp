import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { LoginService } from '@sher/core-application';
import type { LoginResponse } from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  loginWithGoogleRequestSchema,
  loginWithPasswordRequestSchema,
  loginWithPinRequestSchema,
  refreshRequestSchema,
} from '@sher/core-contracts';

import { LOGIN_SERVICE } from './tokens';

/**
 * Daily login (D-07). Unauthenticated by design — these are the routes that
 * produce a session, so there is nothing to guard with yet.
 *
 * Validate shape → call use case → map result (R-B5). Every "is this login
 * correct" decision lives in the use case, which answers identically whether
 * the identifier is unknown or the password is wrong.
 */
@Controller('api/v1/auth')
export class LoginController {
  constructor(@Inject(LOGIN_SERVICE) private readonly login: LoginService) {}

  @Post('login')
  @HttpCode(200)
  async withPassword(@Body() body: unknown): Promise<{ data: LoginResponse }> {
    const parsed = loginWithPasswordRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.login.withPassword(parsed.data) };
  }

  @Post('login/google')
  @HttpCode(200)
  async withGoogle(@Body() body: unknown): Promise<{ data: LoginResponse }> {
    const parsed = loginWithGoogleRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.login.withGoogle(parsed.data) };
  }

  @Post('login/pin')
  @HttpCode(200)
  async withPin(@Body() body: unknown): Promise<{ data: LoginResponse }> {
    const parsed = loginWithPinRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.login.withPin(parsed.data) };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown): Promise<{ data: LoginResponse }> {
    const parsed = refreshRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.login.refresh(parsed.data.refreshToken) };
  }

  /** Idempotent: logging out twice, or with a stale token, is not an error. */
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown): Promise<void> {
    const parsed = refreshRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    await this.login.logout(parsed.data.refreshToken);
  }
}

/** Field names only — a validation message must never echo a password back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
