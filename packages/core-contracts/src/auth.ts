import { z } from 'zod';

/**
 * Signup contracts (D-07, §5.3).
 *
 * Shape validation only — whether an identifier is a well-formed email or BD
 * mobile is a domain rule in `core-domain`, not a regex duplicated here (DRY on
 * rules). `tenant_id` appears nowhere: this is the one flow that creates one.
 */
export const requestSignupOtpRequestSchema = z
  .object({
    identifier: z.string().min(1).max(120),
  })
  .strict();

export type RequestSignupOtpRequest = z.infer<typeof requestSignupOtpRequestSchema>;

export const requestSignupOtpResponseSchema = z
  .object({
    /** Which channel the code went to, so the UI can say "sent to your phone". */
    channel: z.enum(['EMAIL', 'PHONE']),
    /**
     * Present only on a development transport, so registration is testable
     * before an SMS gateway exists. Never populated in production (slice 1.7).
     */
    devCode: z.string().optional(),
  })
  .strict();

export type RequestSignupOtpResponse = z.infer<typeof requestSignupOtpResponseSchema>;

export const completeRegistrationRequestSchema = z
  .object({
    identifier: z.string().min(1).max(120),
    otpCode: z.string().length(6),
    businessName: z.string().min(1).max(200),
    username: z.string().min(3).max(50),
    password: z.string().min(1).max(200),
    pin: z.string().min(1).max(20),
  })
  .strict();

export type CompleteRegistrationRequest = z.infer<typeof completeRegistrationRequestSchema>;

export const registrationResponseSchema = z
  .object({
    /** 15-minute access token (§5.3). Refresh tokens arrive with login, slice 1.2. */
    accessToken: z.string(),
    tenant: z.object({ id: z.string().length(26), name: z.string() }).strict(),
    user: z.object({ id: z.string().length(26), username: z.string() }).strict(),
  })
  .strict();

export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

export const dashboardSummaryResponseSchema = z
  .object({
    businessName: z.string(),
  })
  .strict();

export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponseSchema>;
