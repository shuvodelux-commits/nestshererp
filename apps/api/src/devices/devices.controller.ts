import { Body, Controller, Get, Headers, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import type {
  ManageDevicesService,
  OfflineStatusService,
  SnapshotService,
  TenantContext,
} from '@sher/core-application';
import type {
  DeviceListResponse,
  DeviceResponse,
  DeviceUsersResponse,
  OfflineSnapshotResponse,
  OfflineStatusResponse,
} from '@sher/core-contracts';
import {
  AppError,
  approveDeviceRequestSchema,
  ErrorCode,
  forceRevokeDeviceRequestSchema,
  registerDeviceRequestSchema,
  renameDeviceRequestSchema,
  replaceWriterRequestSchema,
  reportGateRequestSchema,
  reportSnapshotRequestSchema,
  revokeDeviceRequestSchema,
  setDeviceUsersRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_DEVICES_SERVICE, OFFLINE_STATUS_SERVICE, SNAPSHOT_SERVICE } from './tokens';

/**
 * Offline devices (§5.23, D-01, D-24).
 *
 * **`X-Device-Key` is the browser profile's public key**, sent on every call so
 * the server knows which machine is asking. It is an identity, not a
 * credential: holding it proves nothing on its own, which is why it decides
 * only *which row* the caller is talking about and never what they may do —
 * that is `TenantContextGuard` and the permission checks inside each service.
 * The private half never leaves the browser (D-01), and later phases sign push
 * batches with it.
 */
@Controller('api/v1/offline')
@UseGuards(TenantContextGuard)
export class DevicesController {
  constructor(
    @Inject(OFFLINE_STATUS_SERVICE) private readonly offline: OfflineStatusService,
    @Inject(MANAGE_DEVICES_SERVICE) private readonly devices: ManageDevicesService,
    @Inject(SNAPSHOT_SERVICE) private readonly snapshots: SnapshotService,
  ) {}

  @Get('status')
  async status(
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: OfflineStatusResponse }> {
    return { data: await this.offline.status(ctx, key(deviceKey)) };
  }

  @Get('devices')
  async list(
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<DeviceListResponse> {
    return this.devices.list(ctx, key(deviceKey));
  }

  @Post('devices/register')
  async register(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: DeviceResponse }> {
    const parsed = registerDeviceRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid('Those computer details are not valid');
    return {
      data: await this.offline.register({
        ctx,
        publicKey: parsed.data.publicKey,
        name: parsed.data.name,
        platform: parsed.data.platform,
      }),
    };
  }

  @Post('devices/request')
  async request(
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: DeviceResponse }> {
    return { data: await this.offline.requestOfflineWrite(ctx, required(deviceKey)) };
  }

  @Post('devices/gate')
  async gate(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: DeviceResponse }> {
    const parsed = reportGateRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid('That storage report is not valid');
    return {
      data: await this.offline.reportGate({
        ctx,
        publicKey: required(deviceKey),
        installed: parsed.data.installed,
        persisted: parsed.data.persisted,
        availableBytes: parsed.data.availableBytes,
      }),
    };
  }

  @Post('devices/approve')
  async approve(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: DeviceResponse }> {
    const parsed = approveDeviceRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid('Choose a computer and give it a name');
    return {
      data: await this.devices.approve({
        ctx,
        deviceId: parsed.data.deviceId,
        name: parsed.data.name,
        callerPublicKey: key(deviceKey),
      }),
    };
  }

  @Post('devices/rename')
  async rename(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: DeviceResponse }> {
    const parsed = renameDeviceRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid('That name is not valid');
    return {
      data: await this.devices.rename({
        ctx,
        deviceId: parsed.data.deviceId,
        name: parsed.data.name,
        callerPublicKey: key(deviceKey),
      }),
    };
  }

  @Post('devices/revoke')
  async revoke(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: DeviceResponse }> {
    const parsed = revokeDeviceRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid('Choose a computer');
    return {
      data: await this.devices.revoke({
        ctx,
        deviceId: parsed.data.deviceId,
        callerPublicKey: key(deviceKey),
      }),
    };
  }

  /** Owner only, password re-entered, reason required — enforced in the service. */
  @Post('devices/force-revoke')
  async forceRevoke(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: DeviceResponse }> {
    const parsed = forceRevokeDeviceRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid('Cutting a computer off needs your password and a reason');
    return {
      data: await this.devices.forceRevoke({
        ctx,
        deviceId: parsed.data.deviceId,
        password: parsed.data.password,
        reason: parsed.data.reason,
        callerPublicKey: key(deviceKey),
      }),
    };
  }

  @Post('devices/replace-writer')
  async replaceWriter(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: DeviceResponse }> {
    const parsed = replaceWriterRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid('Choose the computer that should take over');
    return {
      data: await this.devices.replaceWriter({
        ctx,
        deviceId: parsed.data.deviceId,
        name: parsed.data.name,
        forceOldDevice: parsed.data.forceOldDevice,
        password: parsed.data.password,
        reason: parsed.data.reason,
        callerPublicKey: key(deviceKey),
      }),
    };
  }
  /**
   * The shop's readable data, for the machine that holds its offline authority
   * (Phase 12.3).
   *
   * A GET, and deliberately a large one: it is a read of what the caller may
   * already read, assembled in one place instead of a screen making forty
   * calls. The service refuses any machine but the shop's offline computer.
   */
  @Get('snapshot')
  async snapshot(
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: OfflineSnapshotResponse }> {
    return { data: await this.snapshots.build(ctx, required(deviceKey)) };
  }

  /**
   * What the device measured after storing it (owner direction 2026-08-31:
   * record the real numbers so O-6 closes from real shops).
   *
   * A report, never a gate — like the D-24 gate report, nothing it says can
   * refuse a device or take authority away. It exists so the open item can be
   * tuned against machines that are actually in shops.
   */
  @Post('snapshot/report')
  async reportSnapshot(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
    @Headers('x-device-key') deviceKey?: string,
  ): Promise<{ data: DeviceResponse }> {
    const parsed = reportSnapshotRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid('That storage report is not valid');
    return {
      data: await this.offline.reportSnapshot({
        ctx,
        publicKey: required(deviceKey),
        storedBytes: parsed.data.storedBytes,
        usageBytes: parsed.data.usageBytes,
        quotaBytes: parsed.data.quotaBytes,
        elapsedMs: parsed.data.elapsedMs,
      }),
    };
  }

  /**
   * Who may sign in on this machine while it is disconnected (Phase 12.4, §9).
   *
   * The list and the people who could be on it come back together, because the
   * screen that shows one always needs the other and two round trips would let
   * them disagree for a moment.
   */
  @Get(':id/offline-users')
  async offlineUsers(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: DeviceUsersResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'That computer is not here');
    return { data: await this.devices.offlineUsers(ctx, id) };
  }

  @Put(':id/offline-users')
  async setOfflineUsers(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: DeviceUsersResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'That computer is not here');
    const parsed = setDeviceUsersRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That is not a list of people');
    }
    return {
      data: await this.devices.setOfflineUsers({ ctx, deviceId: id, userIds: parsed.data.userIds }),
    };
  }
}

function key(header: string | undefined): string | null {
  const value = header?.trim() ?? '';
  return value === '' ? null : value;
}

function required(header: string | undefined): string {
  const value = key(header);
  if (value === null) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'This computer has not registered itself yet');
  }
  return value;
}

function invalid(message: string): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, message);

}
