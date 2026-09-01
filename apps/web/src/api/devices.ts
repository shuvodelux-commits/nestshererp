import type {
  DeviceListResponse,
  DeviceResponse,
  OfflineSnapshotResponse,
  OfflineStatusResponse,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * Offline devices (§5.23, D-01, D-24).
 *
 * Every call carries this browser profile's public key, because the server's
 * first question is always "which machine is asking?" — and the answer must not
 * come from anything the caller could pick, like a name or a stored id.
 */
export function fetchOfflineStatus(
  token: string,
  deviceKey: string | null,
): Promise<OfflineStatusResponse> {
  return request('/api/v1/offline/status', { token, deviceKey: deviceKey ?? undefined });
}

export function fetchDevices(token: string, deviceKey: string | null): Promise<DeviceListResponse> {
  return request('/api/v1/offline/devices', {
    token,
    deviceKey: deviceKey ?? undefined,
    envelope: true,
  });
}

export function registerDevice(
  token: string,
  payload: { publicKey: string; name: string; platform: string },
): Promise<DeviceResponse> {
  return request('/api/v1/offline/devices/register', { method: 'POST', token, body: payload });
}

export function requestOfflineWrite(token: string, deviceKey: string): Promise<DeviceResponse> {
  return request('/api/v1/offline/devices/request', { method: 'POST', token, deviceKey, body: {} });
}

/**
 * Tell the server what the D-24 gate measured here.
 *
 * It never changes what this machine is allowed to do (owner decision
 * 2026-08-31) — it is what lets the owner's device list show the same truth
 * the machine is showing its own user.
 */
export function reportGate(
  token: string,
  deviceKey: string,
  payload: { installed: boolean; persisted: boolean; availableBytes: number | null },
): Promise<DeviceResponse> {
  return request('/api/v1/offline/devices/gate', {
    method: 'POST',
    token,
    deviceKey,
    body: payload,
  });
}

export function approveDevice(
  token: string,
  deviceKey: string | null,
  payload: { deviceId: string; name: string },
): Promise<DeviceResponse> {
  return request('/api/v1/offline/devices/approve', {
    method: 'POST',
    token,
    deviceKey: deviceKey ?? undefined,
    body: payload,
  });
}

export function renameDevice(
  token: string,
  deviceKey: string | null,
  payload: { deviceId: string; name: string },
): Promise<DeviceResponse> {
  return request('/api/v1/offline/devices/rename', {
    method: 'POST',
    token,
    deviceKey: deviceKey ?? undefined,
    body: payload,
  });
}

/** The kind revoke: the machine drains first, so nothing is lost. */
export function revokeDevice(
  token: string,
  deviceKey: string | null,
  payload: { deviceId: string },
): Promise<DeviceResponse> {
  return request('/api/v1/offline/devices/revoke', {
    method: 'POST',
    token,
    deviceKey: deviceKey ?? undefined,
    body: payload,
  });
}

/** Owner only, password re-entered, reason required (owner decision 2026-08-31). */
export function forceRevokeDevice(
  token: string,
  deviceKey: string | null,
  payload: { deviceId: string; password: string; reason: string },
): Promise<DeviceResponse> {
  return request('/api/v1/offline/devices/force-revoke', {
    method: 'POST',
    token,
    deviceKey: deviceKey ?? undefined,
    body: payload,
  });
}

/** The whole hand-over as one act — drain where possible, force where not. */
export function replaceWriter(
  token: string,
  deviceKey: string | null,
  payload: {
    deviceId: string;
    name: string;
    forceOldDevice: boolean;
    password?: string;
    reason?: string;
  },
): Promise<DeviceResponse> {
  return request('/api/v1/offline/devices/replace-writer', {
    method: 'POST',
    token,
    deviceKey: deviceKey ?? undefined,
    body: payload,
  });
}

/**
 * The shop's readable data, for the machine that holds its offline authority
 * (Phase 12.3).
 *
 * One large GET rather than a screen's worth of calls: it is a read of what
 * this user may already read, assembled server-side so the copy on the machine
 * and the copy on the screen come from the same services.
 */
export function fetchSnapshot(
  token: string,
  deviceKey: string,
): Promise<OfflineSnapshotResponse> {
  return request('/api/v1/offline/snapshot', { token, deviceKey });
}

/**
 * What the copy actually cost this machine (open item O-6, owner direction
 * 2026-08-31: record the real numbers, impose no arbitrary ceiling).
 *
 * Like `reportGate`, it reports and never gates — nothing it says can refuse a
 * device or take authority away, and a failure to send it never undoes a
 * download that succeeded.
 */
export function reportSnapshot(
  token: string,
  deviceKey: string,
  payload: {
    storedBytes: number;
    usageBytes: number | null;
    quotaBytes: number | null;
    elapsedMs: number;
  },
): Promise<DeviceResponse> {
  return request('/api/v1/offline/snapshot/report', {
    method: 'POST',
    token,
    deviceKey,
    body: payload,
  });
}
