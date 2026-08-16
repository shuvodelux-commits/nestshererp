import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type {
  CompleteRegistrationService,
  RequestSignupOtpService,
} from '@sher/core-application';
import type { RegistrationResponse, RequestSignupOtpResponse } from '@sher/core-contracts';
import {
  AppError,
  completeRegistrationRequestSchema,
  ErrorCode,
  requestSignupOtpRequestSchema,
} from '@sher/core-contracts';

import { COMPLETE_REGISTRATION_SERVICE, REQUEST_SIGNUP_OTP_SERVICE } from './tokens';

/**
 * The only unauthenticated routes in SherERP, which is inherent to signup — the
 * caller has no account to authenticate with yet, which is also why there is no
 * `TenantContextGuard` here.
 *
 * Validate shape → build command → call use case → map result. Nothing else
 * (R-B5): every rule about OTP validity, identifier format and duplicate
 * accounts lives in the domain and the use case, not here.
 */
@Controller('api/v1/auth/registration')
export class RegistrationController {
  constructor(
    @Inject(REQUEST_SIGNUP_OTP_SERVICE) private readonly requestOtp: RequestSignupOtpService,
    @Inject(COMPLETE_REGISTRATION_SERVICE) private readonly complete: CompleteRegistrationService,
  ) {}

  @Post('otp')
  @HttpCode(200)
  async sendOtp(@Body() body: unknown): Promise<{ data: RequestSignupOtpResponse }> {
    const parsed = requestSignupOtpRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.requestOtp.execute(parsed.data) };
  }

  @Post()
  async register(@Body() body: unknown): Promise<{ data: RegistrationResponse }> {
    const parsed = completeRegistrationRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.complete.execute(parsed.data) };
  }
}

/** Field names only — a validation message must never echo a password back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
