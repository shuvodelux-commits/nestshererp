import type { Tx } from './unit-of-work';

/**
 * What the management agent is allowed to learn about this installation.
 *
 * **Every field is about the deployment, not the business** (§22). The shop's
 * own identifier and timezone, the schema it is on, how much its offline queue
 * is holding — the things a vendor needs to know to keep an installation
 * running, and nothing that answers a commercial question. There is no method
 * here that returns a sale, a party, a price or a balance, and there must never
 * be one: this port is the entire surface the sidecar can read, so its shape is
 * the privacy boundary rather than a promise about how it is used.
 *
 * `tenantId` doubles as the Business ID a licence names. That is deliberate —
 * §2 requires identity to come from a stable identifier rather than a mutable
 * domain name, and the tenant's own primary key is the most stable thing this
 * installation has.
 */
export interface InstallationProfile {
  readonly tenantId: string;
  readonly tenantName: string;
  /** Business dates are computed in it, so a support correction needs it. */
  readonly timezone: string;
  /** The newest applied migration — what the control plane calls schema version. */
  readonly schemaVersion: string;
  /** Offline operations still waiting to be replayed (Phase 12). */
  readonly syncPending: number;
  /** Conflicts a human has not resolved yet (Phase 12). */
  readonly syncConflictsOpen: number;
}

export interface ManagementProfileRepository {
  /**
   * The single tenant this installation serves.
   *
   * Returns null on a machine with no tenant yet — a fresh install before its
   * first registration — because the sidecar has to be able to say "not ready"
   * rather than crash on a shop that has not been set up.
   */
  profile(tx: Tx): Promise<InstallationProfile | null>;
}
