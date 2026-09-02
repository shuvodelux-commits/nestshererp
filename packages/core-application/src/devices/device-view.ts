import type { DeviceResponse } from '@sher/core-contracts';
import { pushesAreQuarantined } from '@sher/core-domain';

import type { DeviceRow } from './device-repository';

/**
 * A stored device as the screens see it.
 *
 * The public key never crosses this line. It is compared against the caller's
 * own key to answer "is this the machine I am sitting at?", and then dropped —
 * a list that prints identities invites somebody to paste one into a support
 * chat, and D-01's authority is worth exactly as much as the key's privacy.
 */
export function toDeviceResponse(row: DeviceRow, callerPublicKey: string | null): DeviceResponse {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    isThisDevice: callerPublicKey !== null && callerPublicKey === row.publicKey,
    platform: row.platform,
    registeredByName: row.registeredByName,
    registeredAt: row.registeredAt.toISOString(),
    requestedAt: row.requestedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByName: row.approvedByName,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByName: row.revokedByName,
    revokeReason: row.revokeReason,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    quarantinesPushes: pushesAreQuarantined(row.status),
    deviceCode: row.deviceCode,
    storedSnapshotBytes: row.snapshotBytes,
    snapshotUsageBytes: row.snapshotUsageBytes,
    snapshotQuotaBytes: row.snapshotQuotaBytes,
    snapshotElapsedMs: row.snapshotElapsedMs,
    snapshotReportedAt: row.snapshotReportedAt?.toISOString() ?? null,
  };
}
