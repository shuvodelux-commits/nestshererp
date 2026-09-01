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
}

export interface NewDevice {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
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
