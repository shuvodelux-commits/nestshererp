import type { DeviceStatus } from '@sher/core-domain';
import type { SnapshotCounts } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * The stored side of a registered browser profile (§5.23, D-01).
 *
 * `publicKey` is the identity. Not the machine, not the operating system user —
 * the browser profile, because that is what holds the private key. A second
 * browser on the same PC, an incognito window, or a profile whose site data was
 * cleared has a different key and is therefore a different device, which is
 * exactly the behaviour D-01 asks for: copying the storage files to another
 * profile must not carry write authority with them.
 */
export interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  readonly status: DeviceStatus;
  readonly registeredByName: string;
  readonly registeredAt: Date;
  readonly requestedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly approvedByName: string | null;
  readonly revokedAt: Date | null;
  readonly revokedByName: string | null;
  readonly revokeReason: string | null;
  readonly lastSeenAt: Date | null;
  /** The last D-24 report this device sent, for the owner's list. */
  readonly gateInstalled: boolean | null;
  readonly gatePersisted: boolean | null;
  readonly gateAvailableBytes: number | null;
  readonly gateReportedAt: Date | null;
  /**
   * The last snapshot this machine reported storing (Phase 12.3, O-6).
   *
   * Kept so the Offline & Devices card can print what the copy actually cost
   * on this shop's own hardware, and so open item O-6 is eventually closed by
   * real machines rather than by the guessed per-row costs in `snapshot-size`.
   */
  readonly snapshotBytes: number | null;
  readonly snapshotUsageBytes: number | null;
  readonly snapshotQuotaBytes: number | null;
  readonly snapshotElapsedMs: number | null;
  readonly snapshotReportedAt: Date | null;
  /**
   * The permanent short code this machine's documents carry (Phase 12.4, §8).
   *
   * Assigned once, at registration, and never reused: a sale numbered
   * `S-2026-A-000123` is on paper the shop filed, so `A` must mean the same
   * computer for as long as that paper exists. Null only for a device
   * registered before this phase and not yet backfilled.
   */
  readonly deviceCode: string | null;
  /** Where this machine's pull got to, so a reconnect resumes rather than restarts. */
  readonly syncCursor: Date | null;
  readonly lastPushAt: Date | null;
  readonly lastPullAt: Date | null;
}

/** One person who may sign in on the offline machine, as the snapshot carries them. */
export interface OfflineUserRow {
  readonly id: string;
  readonly displayName: string;
  readonly username: string | null;
  /** Argon2, exactly as stored. Verified locally by the same hasher. */
  readonly pinHash: string;
  readonly roleId: string;
  readonly permissions: readonly string[];
}

export interface NewDevice {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  /** Assigned once, here, and never changed (Phase 12.4, §8). */
  readonly deviceCode: string;
}

/** One state change, written with who did it and why (§5.23: every one audited). */
export interface DeviceStatusChange {
  readonly status: DeviceStatus;
  readonly at: Date;
  readonly reason?: string | null;
  /** Set on approval and on a hand-over, cleared by nothing. */
  readonly approved?: boolean;
  readonly revoked?: boolean;
}

export interface DeviceRepository {
  insert(tx: Tx, ctx: TenantContext, device: NewDevice): Promise<void>;
  /**
   * The next free short code for this shop — A, B, C … Z, AA, AB (Phase 12.4).
   *
   * Allocated inside the registering transaction and never reused, even after a
   * device is revoked: an invoice numbered `S-2026-B-000044` is filed paper,
   * and handing `B` to a different machine next year would make two documents
   * claim the same origin. Letters only, because the shop's own central counter
   * is `0`.
   */
  nextDeviceCode(tx: Tx, ctx: TenantContext): Promise<string>;

  /**
   * Who may open the counter on this machine while it cannot reach the server
   * (Phase 12.4, §9).
   *
   * Deliberately separate from roles: a role says what a person may do, this
   * says where they may do it unwatched, and the same cashier can reasonably
   * have different answers for the shop's counter PC and for a phone left in a
   * drawer. An empty list means nobody — the machine can still be used online
   * by anyone who may sign in normally.
   */
  listDeviceUsers(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
  ): Promise<readonly { readonly userId: string; readonly displayName: string }[]>;
  setDeviceUsers(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    userIds: readonly string[],
    ids: readonly string[],
    at: Date,
  ): Promise<void>;
  /**
   * What the snapshot needs to let those people in with a PIN and nothing else.
   *
   * Only the PIN hash travels — never the password hash (§9). A password opens
   * far more than a till: it is the credential for the web, for another shop's
   * machine, for anywhere the person has reused it, and there is no reason for
   * a copy of it to sit on a counter PC. A user with no PIN set simply cannot
   * work offline, and the screen says so rather than falling back.
   */
  offlineUsers(tx: Tx, ctx: TenantContext, deviceId: string): Promise<readonly OfflineUserRow[]>;
  findByPublicKey(tx: Tx, ctx: TenantContext, publicKey: string): Promise<DeviceRow | null>;
  findById(tx: Tx, ctx: TenantContext, deviceId: string): Promise<DeviceRow | null>;
  /** Every device this tenant has ever registered, newest first. */
  list(tx: Tx, ctx: TenantContext): Promise<readonly DeviceRow[]>;
  /**
   * The device holding the shop's single writer slot — `ACTIVE` **or**
   * `DRAINING`. A draining machine still occupies it (see `occupiesWriterSlot`):
   * it has not finished sending up its work, and a second writer alongside it
   * is the one thing D-01 exists to prevent.
   */
  findWriter(tx: Tx, ctx: TenantContext): Promise<DeviceRow | null>;
  rename(tx: Tx, ctx: TenantContext, deviceId: string, name: string): Promise<void>;
  changeStatus(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    change: DeviceStatusChange,
  ): Promise<void>;
  /** `last_seen_at` alone — the browser asked for its own state just now. */
  recordSeen(tx: Tx, ctx: TenantContext, deviceId: string, at: Date): Promise<void>;
  /** The gate report and `last_seen_at`; never touches status (owner decision). */
  recordGate(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    report: {
      readonly installed: boolean;
      readonly persisted: boolean;
      readonly availableBytes: number | null;
      readonly at: Date;
    },
  ): Promise<void>;
  /**
   * The snapshot numbers this device measured. A report, never a gate — it
   * cannot change status, and the live D-24 check never reads it.
   */
  recordSnapshot(
    tx: Tx,
    ctx: TenantContext,
    deviceId: string,
    report: {
      readonly storedBytes: number;
      readonly usageBytes: number | null;
      readonly quotaBytes: number | null;
      readonly elapsedMs: number;
      readonly at: Date;
    },
  ): Promise<void>;
  /**
   * What the offline snapshot would have to carry, counted from the tenant's
   * own tables (§5.23, owner decision 2026-08-31: the space check is measured
   * against this shop's data, not a fixed number).
   */
  snapshotCounts(tx: Tx, ctx: TenantContext, months: number): Promise<SnapshotCounts>;
}
