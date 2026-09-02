import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { DeviceResponse, OfflineStatusResponse } from '@sher/core-contracts';
import { occupiesWriterSlot, requiredOfflineBytes, estimateSnapshotBytes, SNAPSHOT_MONTHS } from '@sher/core-domain';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { DeviceRepository, DeviceRow } from './device-repository';
import { toDeviceResponse } from './device-view';

/**
 * What *this browser* is and may do — register itself, ask for offline
 * authority, and report what the D-24 gate measured (§5.23, D-01, D-24).
 *
 * Split from `ManageDevicesService` because the two answer different questions
 * with different authority. Everything here acts on the caller's own browser,
 * identified by the public key it holds the private half of; nothing here can
 * touch another machine. Deciding *which* machine is the shop's writer is the
 * other service, and it is gated by the codes an owner or manager holds.
 *
 * **Registering grants nothing.** It creates identity and the right to ask,
 * which is why every seeded role including the Cashier holds
 * `offline.device.register` (owner decision 2026-08-31): the counter machine is
 * usually the one that will work offline, and the cashier is who sits at it.
 */
export class OfflineStatusService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly devices: DeviceRepository,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * This browser's state, the room its snapshot needs, and which buttons the
   * screen may draw (UI-09).
   *
   * No permission is required to read it. It describes the caller's own
   * browser and their own role, exactly like the security page reads their own
   * credentials — and a machine that may not ask what state it is in cannot
   * tell a cashier why the app will not work offline.
   */
  async status(ctx: TenantContext, publicKey: string | null): Promise<OfflineStatusResponse> {
    return this.uow.run(ctx, async (tx) => {
      const held = await this.access.permissionsOf(tx, ctx);
      const device =
        publicKey === null ? null : await this.devices.findByPublicKey(tx, ctx, publicKey);
      const writer = await this.devices.findWriter(tx, ctx);
      const counts = await this.devices.snapshotCounts(tx, ctx, SNAPSHOT_MONTHS);

      if (device !== null) {
        await this.devices.recordSeen(tx, ctx, device.id, this.clock.now());
      }

      return {
        device: device === null ? null : toDeviceResponse(device, publicKey),
        tenantId: ctx.tenantId,
        requiredBytes: requiredOfflineBytes(counts),
        snapshotBytes: estimateSnapshotBytes(counts),
        activeDeviceName: writer?.name ?? null,
        activeIsThisDevice: writer !== null && device !== null && writer.id === device.id,
        canRegister: held.includes(Permission.DEVICE_REGISTER),
        canApprove: held.includes(Permission.DEVICE_APPROVE),
        canRename: held.includes(Permission.DEVICE_RENAME),
        canRevoke: held.includes(Permission.DEVICE_REVOKE),
        canForceRevoke: held.includes(Permission.DEVICE_FORCE_REVOKE),
      };
    });
  }

  /**
   * Register this browser profile.
   *
   * Registering the same key twice is not an error and does not reset anything:
   * a shop that presses the button again after a refresh must not lose an
   * approval it already has. The name is updated, because that is the only part
   * of a re-registration that can honestly have changed.
   */
  async register(command: {
    readonly ctx: TenantContext;
    readonly publicKey: string;
    readonly name: string;
    readonly platform: string;
  }): Promise<DeviceResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.DEVICE_REGISTER);

      const existing = await this.devices.findByPublicKey(tx, ctx, command.publicKey);
      if (existing !== null) {
        if (existing.name !== command.name) {
          await this.devices.rename(tx, ctx, existing.id, command.name);
        }
        const again = await this.reread(tx, ctx, existing.id);
        return toDeviceResponse(again, command.publicKey);
      }

      const id = Ulid.generate(this.clock);
      /*
       * The permanent short code (Phase 12.4, §8). Given at registration rather
       * than at approval, because a machine that never becomes the offline
       * writer still numbers the sales typed on it, and a code handed out later
       * would leave a gap in the middle of that machine's own run.
       */
      const deviceCode = await this.devices.nextDeviceCode(tx, ctx);
      await this.devices.insert(tx, ctx, {
        id,
        name: command.name,
        publicKey: command.publicKey,
        platform: command.platform,
        deviceCode,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'device_authorization',
        entityId: id,
        action: 'CREATE',
        before: null,
        // The key itself is never audited. It is an identity, and an identity
        // copied into a trail anybody may read is one that has been shared.
        after: {
          name: command.name,
          platform: command.platform,
          status: 'REGISTERED',
          deviceCode,
        },
        source: 'API',
      });

      const created = await this.reread(tx, ctx, id);
      return toDeviceResponse(created, command.publicKey);
    });
  }

  /**
   * Ask to become the shop's offline writer.
   *
   * The request is refused outright when another machine already holds or is
   * still draining the slot — but the refusal carries that machine's name, so
   * the screen can offer Replace Writer instead of leaving a shopkeeper to work
   * out why the button did nothing.
   */
  async requestOfflineWrite(ctx: TenantContext, publicKey: string): Promise<DeviceResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.DEVICE_REGISTER);
      const device = await this.mine(tx, ctx, publicKey);

      if (device.status === 'PENDING') return toDeviceResponse(device, publicKey);
      if (device.status === 'ACTIVE' || device.status === 'DRAINING') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This computer already has offline permission',
        );
      }

      const writer = await this.devices.findWriter(tx, ctx);
      if (writer !== null && occupiesWriterSlot(writer.status)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `${writer.name} is already the offline computer`,
          { reason: 'WRITER_SLOT_TAKEN', deviceName: writer.name },
        );
      }

      await this.devices.changeStatus(tx, ctx, device.id, {
        status: 'PENDING',
        at: this.clock.now(),
      });
      await this.audit.append(tx, ctx, {
        entityType: 'device_authorization',
        entityId: device.id,
        action: 'UPDATE',
        before: { status: device.status },
        after: { status: 'PENDING' },
        source: 'API',
      });

      return toDeviceResponse(await this.reread(tx, ctx, device.id), publicKey);
    });
  }

  /**
   * What the browser measured for the D-24 gate.
   *
   * Recorded so the owner's device list shows the same truth the machine is
   * showing its own user — a manager asked "why can't the counter work
   * offline?" should be able to answer from their own screen.
   *
   * **It never changes authority** (owner decision 2026-08-31). A cleared
   * storage permission stops this browser writing offline the moment it is
   * noticed, locally; it does not un-approve the machine, because re-granting
   * storage is a browser fix and making the owner re-approve a PC for it would
   * teach the shop to treat approval as noise.
   */
  async reportGate(command: {
    readonly ctx: TenantContext;
    readonly publicKey: string;
    readonly installed: boolean;
    readonly persisted: boolean;
    readonly availableBytes: number | null;
  }): Promise<DeviceResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      const device = await this.mine(tx, ctx, command.publicKey);
      await this.devices.recordGate(tx, ctx, device.id, {
        installed: command.installed,
        persisted: command.persisted,
        availableBytes: command.availableBytes,
        at: this.clock.now(),
      });
      return toDeviceResponse(await this.reread(tx, ctx, device.id), command.publicKey);
    });
  }

  /**
   * What this machine measured after storing a snapshot (Phase 12.3, O-6,
   * owner direction 2026-08-31).
   *
   * The twin of `reportGate`, and bound by the same rule: it records and it
   * never decides. The owner's instruction was to close O-6 from shops rather
   * than from a lab, and this is the wire that carries those numbers home.
   */
  async reportSnapshot(command: {
    readonly ctx: TenantContext;
    readonly publicKey: string;
    readonly storedBytes: number;
    readonly usageBytes: number | null;
    readonly quotaBytes: number | null;
    readonly elapsedMs: number;
  }): Promise<DeviceResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      const device = await this.mine(tx, ctx, command.publicKey);
      await this.devices.recordSnapshot(tx, ctx, device.id, {
        storedBytes: command.storedBytes,
        usageBytes: command.usageBytes,
        quotaBytes: command.quotaBytes,
        elapsedMs: command.elapsedMs,
        at: this.clock.now(),
      });
      return toDeviceResponse(await this.reread(tx, ctx, device.id), command.publicKey);
    });
  }

  private async mine(
    tx: Parameters<DeviceRepository['findById']>[0],
    ctx: TenantContext,
    publicKey: string,
  ): Promise<DeviceRow> {
    const device = await this.devices.findByPublicKey(tx, ctx, publicKey);
    if (device === null) {
      throw new AppError(ErrorCode.NOT_FOUND, 'This computer is not registered yet');
    }
    return device;
  }

  private async reread(
    tx: Parameters<DeviceRepository['findById']>[0],
    ctx: TenantContext,
    deviceId: string,
  ): Promise<DeviceRow> {
    const row = await this.devices.findById(tx, ctx, deviceId);
    if (row === null) throw new AppError(ErrorCode.INTERNAL_ERROR, 'The computer was not saved');
    return row;
  }
}
