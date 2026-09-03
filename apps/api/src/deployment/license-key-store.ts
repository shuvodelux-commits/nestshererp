import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LicenseKeyStore, LicenseVerifier, VerifiedLicense } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import type { MachineLicenseState } from './license-machine-state';

/**
 * The licence file on this machine, and the verified state kept in memory
 * (owner decisions 2026-09-02).
 *
 * **Verified once, not per request.** Ed25519 verification is cheap, reading a
 * file is not free, and a licence changes perhaps twice a year: doing both on
 * every API call would be a syscall and a signature check on the path of every
 * sale for no gain. So the verified licence is cached, and the file is looked
 * at again only when it might have changed — its size or modification time
 * moving — and at most once a minute.
 *
 * **A renewal still takes effect immediately.** `install` refreshes the cache
 * itself, so the very next request is judged by the new licence. That matters
 * more than it sounds: the alternative is telling a shopkeeper whose term just
 * lapsed to restart their server.
 *
 * **The write is atomic.** The key is written beside its destination and
 * renamed over it, so a machine that loses power during an install still has
 * exactly one of the two licences and never half of either.
 */

/** How often the file is re-examined when nothing has asked us to reload. */
const STAT_INTERVAL_MS = 60 * 1000;

interface CachedLicense {
  readonly licence: VerifiedLicense | null;
  /** Size and mtime of the file the licence was read from, or null if absent. */
  readonly fingerprint: string | null;
  readonly checkedAtMs: number;
}

export class FileLicenseKeyStore implements LicenseKeyStore {
  private cached: CachedLicense | null = null;

  constructor(
    private readonly path: string,
    private readonly verifier: LicenseVerifier,
    private readonly state: MachineLicenseState,
    private readonly clock: Clock,
  ) {}

  current(): VerifiedLicense | null {
    const nowMs = this.clock.now().getTime();
    const cached = this.cached;

    if (cached !== null && nowMs - cached.checkedAtMs < STAT_INTERVAL_MS) {
      return cached.licence;
    }

    const fingerprint = this.fingerprint();
    if (cached !== null && cached.fingerprint === fingerprint) {
      this.cached = { ...cached, checkedAtMs: nowMs };
      return cached.licence;
    }

    const licence = this.readAndVerify();
    this.cached = { licence, fingerprint, checkedAtMs: nowMs };
    return licence;
  }

  async install(raw: string): Promise<void> {
    const previous = this.current();

    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.installing`;
    // 0600: the licence is not a secret, but it is machine configuration and
    // has no business being world-writable next to the backup key.
    writeFileSync(temporary, `${raw.trim()}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);

    this.cached = null;
    const installed = this.current();

    /*
     * D-36's `RESTORED` means "you are back", and it is only true when the
     * previous term had actually run out. The machine is the only thing that
     * knows that after the fact — the new licence says nothing about what it
     * replaced — so it is recorded here, and cleared on an ordinary renewal
     * made in time, which must not read as a restoration.
     */
    const { effectiveNow } = this.state.observe(this.clock.now());
    const lapsed =
      previous !== null &&
      installed !== null &&
      previous.validUntil.getTime() < effectiveNow.getTime();
    this.state.recordRenewal(lapsed ? previous.validUntil : null);
  }

  /** Size and mtime, the two cheap things that change when a file is replaced. */
  private fingerprint(): string | null {
    try {
      const stats = statSync(this.path);
      return `${String(stats.size)}:${String(stats.mtimeMs)}`;
    } catch {
      return null;
    }
  }

  private readAndVerify(): VerifiedLicense | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      // No licence yet — a fresh install, or one whose key file was removed.
      // D-35: that is READ_ONLY, never a crash.
      return null;
    }

    const verification = this.verifier.verify(raw);
    return verification.ok ? verification.licence : null;
  }
}
