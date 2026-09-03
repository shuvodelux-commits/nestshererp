import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Control-plane configuration, resolved once and validated at boot.
 *
 * The ERP's `config.ts` refuses to start half-configured rather than
 * discovering a missing variable on the first request that needs it, and this
 * follows the same rule for the same reason — except that here a missing
 * variable can mean "signs nothing", "trusts everyone" or "cannot revoke", and
 * a control plane in that state is worse than one that is down.
 */
export interface ControlPlaneConfig {
  /** The control plane's OWN database. Never a customer's (§22). */
  readonly databaseUrl: string;
  readonly port: number;
  /** Origin the operator console is served from, for CORS. */
  readonly consoleOrigin: string;
  /** HS256 secret for operator session tokens. */
  readonly jwtSecret: string;
  /**
   * AES-256-GCM key (base64, 32 bytes) sealing TOTP secrets at rest.
   *
   * A leaked database backup should not hand over the second factor along with
   * the first, which is the whole reason the column is sealed rather than plain.
   */
  readonly secretKey: string;
  /**
   * Where the isolated signing service answers — localhost only, by design.
   *
   * §5: the licence private key is not in this process, not in this database,
   * and not reachable from the internet. The control plane asks a neighbour to
   * sign and never sees the key.
   */
  readonly signerUrl: string;
  /** Shared bearer for the signer, so nothing else on the box can ask it to sign. */
  readonly signerToken: string;
  /** Directory holding published release tarballs. */
  readonly releaseDir: string;
  /** Public base URL the agent downloads releases from. */
  readonly publicBaseUrl: string;
  /**
   * Minutes after which an installation that has not checked in is OFFLINE.
   *
   * Generous by default: a shop on a bad line is not an incident, and a fleet
   * view that cries wolf is a fleet view nobody reads.
   */
  readonly offlineAfterMinutes: number;
}

export function loadConfig(): ControlPlaneConfig {
  return {
    databaseUrl: required('CONTROL_DATABASE_URL'),
    port: Number(process.env['CONTROL_PORT'] ?? '3100'),
    consoleOrigin: process.env['CONTROL_CONSOLE_ORIGIN'] ?? 'http://localhost:5175',
    jwtSecret: required('CONTROL_JWT_SECRET'),
    secretKey: required('CONTROL_SECRET_KEY'),
    signerUrl: process.env['CONTROL_SIGNER_URL'] ?? 'http://127.0.0.1:3200',
    signerToken: required('CONTROL_SIGNER_TOKEN'),
    releaseDir: process.env['CONTROL_RELEASE_DIR'] ?? join(homedir(), '.sher', 'releases'),
    publicBaseUrl: process.env['CONTROL_PUBLIC_BASE_URL'] ?? 'http://localhost:3100',
    offlineAfterMinutes: Number(process.env['CONTROL_OFFLINE_AFTER_MINUTES'] ?? '15'),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required but not set`);
  }
  return value;
}

/**
 * Refusals that must happen before anything is constructed.
 *
 * Mirrors `apps/api/src/deployment/boot-validation.ts`: a deployment configured
 * into one of these states must never reach the point of answering a request.
 */
export function validateBootConfig(config: ControlPlaneConfig): void {
  const key = Buffer.from(config.secretKey, 'base64');
  if (key.length !== 32) {
    throw new Error('CONTROL_SECRET_KEY must be 32 bytes, base64 encoded');
  }
  if (config.jwtSecret.length < 32) {
    throw new Error('CONTROL_JWT_SECRET must be at least 32 characters');
  }
  if (config.signerToken.length < 24) {
    throw new Error('CONTROL_SIGNER_TOKEN must be at least 24 characters');
  }
  // A signer reachable from anywhere is a signing key reachable from anywhere.
  const signer = new URL(config.signerUrl);
  if (signer.hostname !== '127.0.0.1' && signer.hostname !== 'localhost') {
    throw new Error('CONTROL_SIGNER_URL must be loopback — the signer is never exposed (§5)');
  }
}
