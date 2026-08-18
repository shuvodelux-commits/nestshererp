/** Runtime configuration. Boot fails loudly rather than starting half-configured. */

/**
 * Deployment mode (§4.4, D-33…D-36).
 *
 * **SaaS and on-premise are the same build.** Signup, OTP and subscription are
 * disabled by configuration, never deleted, and a separate on-premise fork is
 * forbidden. Everything that differs between the two deployments is one of the
 * flags below, resolved once here and turned into a provider choice in
 * `PersistenceModule` — never an `if (isOnPrem)` scattered through the code.
 */
export type IdentityVerifierMode = 'dev' | 'otp' | 'none';
export type EntitlementSourceMode = 'subscription' | 'license';

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly port: number;
  /** Origin the Vue app is served from, for CORS. Defaults to the Vite dev server. */
  readonly webOrigin: string;
  /**
   * Google OAuth client id (D-07). Empty disables Google sign-in — the server
   * then refuses every Google token rather than skipping the `aud` check, which
   * is what stops a token minted for another application being replayed here.
   */
  readonly googleClientId: string;

  /** D-34: one tenant, seeded by the installer. Registration routes 404. */
  readonly singleTenantMode: boolean;
  /** D-33. `dev` echoes the code back and is refused in production. */
  readonly identityVerifier: IdentityVerifierMode;
  /** D-35. */
  readonly entitlementSource: EntitlementSourceMode;
  /** D-35, on-premise only. Read once at boot; never fetched over a network. */
  readonly licenseKeyPath: string;
  /**
   * The Ed25519 public key licences are verified against, base64.
   *
   * D-35 calls it "embedded", and it is: the constant below ships with the
   * build. It is overridable by configuration so that a test, and a customer
   * running their own signing authority, do not have to rebuild — but a
   * deployment that sets neither cannot validate any licence, which resolves to
   * READ_ONLY rather than to a crash.
   */
  readonly licensePublicKey: string;
  /** §5.24. `none` means no SMS transport is configured. */
  readonly smsProvider: string;
  /** D-34/§4.4: billing belongs to SaaS. */
  readonly billingEnabled: boolean;
}

/**
 * The public key SherERP's own licences are signed against.
 *
 * Empty in the repository on purpose: the private half is a production secret
 * that must never live in source control, and shipping a placeholder that
 * *looked* like a key would mean a build that appears to validate licences and
 * does not. An on-premise build sets this at package time.
 */
const EMBEDDED_LICENSE_PUBLIC_KEY = '';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required but not set`);
  }
  return value;
}

/** Unset means the SaaS default — the deployment that needs the other one says so. */
function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false", not "${value}"`);
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, not "${value}"`);
  }
  return value as T;
}

export function loadConfig(): ApiConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: required('JWT_SECRET'),
    port: Number(process.env['PORT'] ?? 3000),
    webOrigin: process.env['WEB_ORIGIN'] ?? 'http://localhost:5173',
    googleClientId: process.env['GOOGLE_CLIENT_ID'] ?? '',

    singleTenantMode: flag('SINGLE_TENANT_MODE', false),
    identityVerifier: oneOf('IDENTITY_VERIFIER', ['dev', 'otp', 'none'] as const, 'dev'),
    entitlementSource: oneOf(
      'ENTITLEMENT_SOURCE',
      ['subscription', 'license'] as const,
      'subscription',
    ),
    licenseKeyPath: process.env['LICENSE_KEY_PATH'] ?? '',
    licensePublicKey: process.env['LICENSE_PUBLIC_KEY'] ?? EMBEDDED_LICENSE_PUBLIC_KEY,
    smsProvider: process.env['SMS_PROVIDER'] ?? 'none',
    billingEnabled: flag('BILLING_ENABLED', true),
  };
}
