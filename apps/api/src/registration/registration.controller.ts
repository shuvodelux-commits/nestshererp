import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type {
  CompleteRegistrationService,
  RegisterWithGoogleService,
  RequestSignupOtpService,
  VerifySignupOtpService,
} from '@sher/core-application';
import type { RegistrationResponse, RequestSignupOtpResponse } from '@sher/core-contracts';
import {
  AppError,
  completeRegistrationRequestSchema,
  ErrorCode,
  registerWithGoogleRequestSchema,
  requestSignupOtpRequestSchema,
  verifySignupOtpRequestSchema,
} from '@sher/core-contracts';

import { SingleTenantRegistrationGuard } from '../deployment/single-tenant.guard';
import {
  COMPLETE_REGISTRATION_SERVICE,
  REGISTER_WITH_GOOGLE_SERVICE,
  REQUEST_SIGNUP_OTP_SERVICE,
  VERIFY_SIGNUP_OTP_SERVICE,
} from './tokens';

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
// D-34: absent, not forbidden, when the deployment holds a single seeded tenant.
@UseGuards(SingleTenantRegistrationGuard)
export class RegistrationController {
  constructor(
    @Inject(REQUEST_SIGNUP_OTP_SERVICE) private readonly requestOtp: RequestSignupOtpService,
    @Inject(VERIFY_SIGNUP_OTP_SERVICE) private readonly verifyOtp: VerifySignupOtpService,
    @Inject(COMPLETE_REGISTRATION_SERVICE) private readonly complete: CompleteRegistrationService,
    @Inject(REGISTER_WITH_GOOGLE_SERVICE) private readonly google: RegisterWithGoogleService,
  ) {}

  @Post('otp')
  @HttpCode(200)
  async sendOtp(@Body() body: unknown): Promise<{ data: RequestSignupOtpResponse }> {
    const parsed = requestSignupOtpRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.requestOtp.execute(parsed.data) };
  }

  /** Checks a code without spending it, so step 2 can answer immediately. */
  @Post('otp/verify')
  @HttpCode(200)
  async verify(@Body() body: unknown): Promise<{ data: { verified: true } }> {
    const parsed = verifySignupOtpRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    await this.verifyOtp.execute(parsed.data);
    return { data: { verified: true } };
  }

  @Post()
  async register(@Body() body: unknown): Promise<{ data: RegistrationResponse }> {
    const parsed = completeRegistrationRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.complete.execute(parsed.data) };
  }

  /** Signup by Google: one field, no OTP (§5.3, D-07 revised 2026-08-17). */
  @Post('google')
  async registerWithGoogle(@Body() body: unknown): Promise<{ data: RegistrationResponse }> {
    const parsed = registerWithGoogleRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.google.execute(parsed.data) };
  }
}

/** Field names only — a validation message must never echo a password back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
