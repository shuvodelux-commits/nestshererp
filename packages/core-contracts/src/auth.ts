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

/** Checks a code without spending it, so the UI can react as it is typed. */
export const verifySignupOtpRequestSchema = z
  .object({
    identifier: z.string().min(1).max(120),
    otpCode: z.string().length(6),
  })
  .strict();

export type VerifySignupOtpRequest = z.infer<typeof verifySignupOtpRequestSchema>;

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
    /** 15 minutes (§5.3). */
    accessToken: z.string(),
    /** 30 days, rotating and revocable — signing up leaves you signed in. */
    refreshToken: z.string(),
    tenant: z.object({ id: z.string().length(26), name: z.string() }).strict(),
    user: z.object({ id: z.string().length(26), username: z.string() }).strict(),
  })
  .strict();

export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

/* --- login (D-07) -------------------------------------------------------- */

export const loginWithPasswordRequestSchema = z
  .object({
    identifier: z.string().min(1).max(120),
    password: z.string().min(1).max(200),
  })
  .strict();

export type LoginWithPasswordRequest = z.infer<typeof loginWithPasswordRequestSchema>;

export const loginWithGoogleRequestSchema = z
  .object({
    /** The ID token Google Identity Services hands the browser. */
    idToken: z.string().min(1).max(4096),
  })
  .strict();

export type LoginWithGoogleRequest = z.infer<typeof loginWithGoogleRequestSchema>;

export const loginWithPinRequestSchema = z
  .object({
    /** Proves the device already holds a session — a PIN alone never signs in. */
    refreshToken: z.string().min(1).max(200),
    pin: z.string().min(1).max(20),
  })
  .strict();

export type LoginWithPinRequest = z.infer<typeof loginWithPinRequestSchema>;

export const refreshRequestSchema = z
  .object({ refreshToken: z.string().min(1).max(200) })
  .strict();

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const loginResponseSchema = z
  .object({
    /** 15 minutes (§5.3). */
    accessToken: z.string(),
    /** 30 days, rotating and revocable — replaced on every use. */
    refreshToken: z.string(),
    user: z.object({ id: z.string().length(26), username: z.string() }).strict(),
  })
  .strict();

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const dashboardSummaryResponseSchema = z
  .object({
    businessName: z.string(),
  })
  .strict();

export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponseSchema>;
