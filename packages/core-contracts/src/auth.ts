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

/**
 * Signup by Google (§5.3, D-07 revised 2026-08-17).
 *
 * One field. The ID token is the same one the browser already presented to
 * `/auth/login/google` and had answered `GOOGLE_ACCOUNT_UNKNOWN`; the server
 * verifies it again here rather than trusting that exchange, so this endpoint
 * cannot be used to create a tenant for an email the caller does not own.
 *
 * No `username`, `password` or `pin`: the username is derived from the verified
 * email and the two credentials are left NULL.
 */
export const registerWithGoogleRequestSchema = z
  .object({
    idToken: z.string().min(1).max(4096),
    businessName: z.string().min(1).max(200),
  })
  .strict();

export type RegisterWithGoogleRequest = z.infer<typeof registerWithGoogleRequestSchema>;

/* --- forgot password (D-07) ---------------------------------------------- */

export const requestPasswordResetRequestSchema = z
  .object({
    identifier: z.string().min(1).max(120),
  })
  .strict();

export type RequestPasswordResetRequest = z.infer<typeof requestPasswordResetRequestSchema>;

/**
 * Identical in shape to the signup response and deliberately kept separate: the
 * two endpoints answer different questions, and collapsing them into one schema
 * would tie a future change in one flow to the other.
 */
export const requestPasswordResetResponseSchema = z
  .object({
    /** Derived from the *format* of what was typed, so it reveals no account. */
    channel: z.enum(['EMAIL', 'PHONE']),
    /** Development transport only; never populated in production (slice 1.7). */
    devCode: z.string().optional(),
  })
  .strict();

export type RequestPasswordResetResponse = z.infer<typeof requestPasswordResetResponseSchema>;

export const resetPasswordRequestSchema = z
  .object({
    identifier: z.string().min(1).max(120),
    otpCode: z.string().length(6),
    password: z.string().min(1).max(200),
  })
  .strict();

export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/* --- change password / PIN in Settings (§5.3) ---------------------------- */

/**
 * `current*` is **optional in the shape only**. Whether it is actually required
 * is decided server-side from what is stored: an account that has no password
 * yet — a Google signup — is setting a first one and has nothing to prove,
 * while an account that has one must supply it. Omitting the field is never a
 * way past that check.
 */
export const changePasswordRequestSchema = z
  .object({
    /** This device's session, so it survives while every other one is revoked. */
    refreshToken: z.string().min(1).max(200),
    currentPassword: z.string().min(1).max(200).optional(),
    newPassword: z.string().min(1).max(200),
  })
  .strict();

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const changePinRequestSchema = z
  .object({
    currentPin: z.string().min(1).max(20).optional(),
    newPin: z.string().min(1).max(20),
  })
  .strict();

export type ChangePinRequest = z.infer<typeof changePinRequestSchema>;

/**
 * Which credentials the signed-in user holds, so Settings can offer "Set" or
 * "Change" rather than guessing. Carries no hashes and no hints about their
 * content — only whether each exists.
 */
export const securitySettingsResponseSchema = z
  .object({
    hasPassword: z.boolean(),
    hasPin: z.boolean(),
  })
  .strict();

export type SecuritySettingsResponse = z.infer<typeof securitySettingsResponseSchema>;

export const dashboardSummaryResponseSchema = z
  .object({
    businessName: z.string(),
  })
  .strict();

export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponseSchema>;

/**
 * Who is signed in and what they may do — what UI-09's "never render a control
 * that will 403" needs in order to be possible at all.
 *
 * The permission list is for drawing the screen, never for deciding anything:
 * every use case checks for itself server-side (§5.26).
 */
export const myAccessResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().length(26),
        username: z.string(),
        displayName: z.string(),
        roleName: z.string(),
      })
      .strict(),
    businessName: z.string(),
    permissions: z.array(z.string()),
    /**
     * The §5.21 toggles that are on, by setting key.
     *
     * Here rather than behind `settings.setting.view`, because this is what
     * the *shell* needs to draw itself: Vendors and Customer Groups are absent
     * from the navigation while their feature is off (§5.6), and a cashier who
     * may not open Settings still has to get a correct sidebar. It reveals
     * which optional modules the shop uses and nothing else — the same fact
     * the navigation itself reveals — and, like `permissions`, it decides
     * nothing: every endpoint re-checks its own feature gate.
     */
    features: z.array(z.string()),
  })
  .strict();

export type MyAccessResponse = z.infer<typeof myAccessResponseSchema>;
