import { resolve } from 'node:path';

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
  /**
   * Where the installed licence key file lives (D-35).
   *
   * Never fetched over a network, and written only by the Owner installing a
   * licence through Settings → Licence. It has a default because licence mode
   * is now the default: an install that was never configured has to be able to
   * *receive* a licence, not refuse to start for want of a path to put it.
   */
  readonly licenseKeyPath: string;
  /**
   * Where this machine's own licence bookkeeping is kept — the monotonic clock
   * mark, and the end of a term that was later renewed (owner decision
   * 2026-09-02).
   *
   * Beside the key by default, and deliberately **not** in PostgreSQL: it
   * describes this computer, so no archive may carry it, no restore may wind it
   * back and no reset may clear it.
   */
  readonly licenseStatePath: string;
  /**
   * Extra public keys this deployment trusts, as `id|base64[|dev]`, comma
   * separated.
   *
   * The production key is embedded in the build. This is how a development
   * machine trusts a development signing key — which is never the production
   * one — and how a key rotation is rolled out before the build that embeds it.
   */
  readonly licenseTrustedKeys: string;
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

  /**
   * Where the nightly `.sherdb` archives are written (Phase 10, owner decision
   * 2026-08-30). A plain directory on this machine, fourteen files deep.
   */
  readonly backupDir: string;
  /**
   * The restricted key file holding the one backup secret — **outside
   * PostgreSQL**, so a stolen database does not carry the key that opens its
   * own backups (D-15). Empty means no secret is configured yet: nothing can be
   * encrypted, the nightly run fails loudly, and the Backup screen says so.
   */
  readonly backupKeyPath: string;
  /** Where the pre-migration and pre-reset `pg_dump` files go. */
  readonly recoveryDumpDir: string;
  /**
   * Local hour the nightly backup runs, 0–23. Two in the morning by default:
   * after the shop has closed and long before anyone opens it.
   */
  readonly backupHour: number;

  /**
   * Phase 17 — the local management agent, and the vendor's support key.
   *
   * All three default to empty, and empty means **off**. An installation that
   * was never sold with remote management has no management surface at all: the
   * endpoints 404, no grant is accepted, and the ERP behaves exactly as it did
   * before this phase existed. That is the right default for a product sold as
   * an independent install (§20) — the vendor's channel is something a customer
   * opts into at deployment, not something every build carries switched on.
   */

  /** Shared secret the sidecar presents on `/api/v1/management/*`. Empty → 404. */
  readonly managementToken: string;
  /**
   * The vendor's support-grant public key, SPKI DER base64.
   *
   * Empty means this installation refuses every support session, whatever
   * arrives. Pinned in configuration rather than fetched, for the same reason
   * the licence key is embedded: a key that can be fetched can be substituted.
   */
  readonly supportPublicKey: string;
  /** The build's own version, reported in every check-in (§6). */
  readonly appVersion: string;
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

/**
 * Where the API's own files live, whatever directory it was started from.
 *
 * **A relative path here was a real fault, not untidiness.** These paths name
 * files SherERP writes and then reads back — the licence, the machine's clock
 * mark, the nightly archives — and a relative one is resolved against the
 * process's working directory. Started by hand from `apps/api` it means one
 * place; started by systemd, whose `WorkingDirectory` defaults to `/`, it means
 * another; and an installation that was licensed on Monday from a terminal
 * would boot on Tuesday as a service with no licence, no clock mark and an
 * empty backup directory — READ_ONLY, asking for a key it already has, with the
 * old one sitting untouched a few directories away.
 *
 * `__dirname` is the fixed point instead: `dist/` when packaged and `src/` when
 * run from sources sit at the same depth, so both resolve to the API's own
 * directory, which is where `apps/api/licence/` and `apps/api/backups/` already
 * are. Nothing moves; it simply stops depending on who started the process.
 *
 * A configured value goes through the same resolution, because a relative one
 * in the environment file has exactly the same fault. An absolute one is
 * returned untouched.
 */
const INSTALLATION_ROOT = resolve(__dirname, '..');

function installationPath(name: string, fallback: string): string {
  const configured = process.env[name];
  return resolve(
    INSTALLATION_ROOT,
    configured === undefined || configured === '' ? fallback : configured,
  );
}

/** Where the licence file lives. Defaulted, so a fresh install can accept one. */
function licenseKeyPath(): string {
  return installationPath('LICENSE_KEY_PATH', 'licence/sher.licence');
}

/** The backup secret's file, or empty when no secret has been configured yet. */
function backupKeyPath(): string {
  const configured = process.env['BACKUP_KEY_PATH'];
  if (configured === undefined || configured === '') return '';
  return resolve(INSTALLATION_ROOT, configured);
}

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

function hourOfDay(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`${name} must be a whole hour from 0 to 23, not "${value}"`);
  }
  return hour;
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
    /*
     * Licence, not subscription (owner decision 2026-09-02). V1 is a
     * single-business installed product: an install that lost a line from its
     * environment file should be visibly READ_ONLY and asking for a key, not
     * quietly trading for ever on the permissive SaaS stub. The stub is still
     * here for the deferred SaaS build; it now has to be asked for by name.
     */
    entitlementSource: oneOf(
      'ENTITLEMENT_SOURCE',
      ['subscription', 'license'] as const,
      'license',
    ),
    licenseKeyPath: licenseKeyPath(),
    licenseStatePath: installationPath('LICENSE_STATE_PATH', `${licenseKeyPath()}.state.json`),
    licenseTrustedKeys: process.env['LICENSE_TRUSTED_KEYS'] ?? '',
    licensePublicKey: process.env['LICENSE_PUBLIC_KEY'] ?? EMBEDDED_LICENSE_PUBLIC_KEY,
    smsProvider: process.env['SMS_PROVIDER'] ?? 'none',
    billingEnabled: flag('BILLING_ENABLED', true),

    backupDir: installationPath('BACKUP_DIR', 'backups'),
    /*
     * Not resolved, and not the same defect: the default is empty on purpose —
     * "no backup secret is configured yet" (D-15), which the Backup screen says
     * out loud — and resolving an empty string would turn that into a directory
     * path that looks like a configured key. A path that is actually set is
     * resolved with the rest.
     */
    backupKeyPath: backupKeyPath(),
    recoveryDumpDir: installationPath('RECOVERY_DUMP_DIR', 'backups/recovery'),
    backupHour: hourOfDay('BACKUP_HOUR', 2),

    managementToken: process.env['MANAGEMENT_TOKEN'] ?? '',
    supportPublicKey: process.env['SUPPORT_PUBLIC_KEY'] ?? '',
    appVersion: process.env['APP_VERSION'] ?? '1.0.0',
  };
}
