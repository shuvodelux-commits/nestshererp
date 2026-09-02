import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  DeviceListResponse,
  DeviceResponse,
  DeviceUsersResponse,
} from '@sher/core-contracts';
import { nextStatus, occupiesWriterSlot, replacementRoute } from '@sher/core-domain';
import type { DeviceTransition } from '@sher/core-domain';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { UserRepository } from '../auth/registration-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { DeviceRepository, DeviceRow } from './device-repository';
import { toDeviceResponse } from './device-view';

/**
 * Deciding which machine is the shop's one offline writer (§5.23, D-01, owner
 * decisions 2026-08-31).
 *
 * The five acts here are not the same size, and the permissions say so:
 *
 * - list, approve, rename and revoke — Owner **or** Manager. Setting up a new
 *   counter PC is floor work.
 * - force revoke — the **Owner alone**, with the password re-entered and a
 *   reason recorded permanently.
 *
 * The difference is what each one costs when it is wrong. A revoke drains: the
 * machine sends up everything it is still holding, then goes read-only, and
 * nothing is lost. A force revoke cuts the machine off mid-sentence, and every
 * operation it pushes afterwards is quarantined rather than posted — which is
 * the right answer for a stolen laptop and a day's lost takings for a PC that
 * was merely switched off.
 *
 * **No separate view code.** Reading the list is the same trust as acting on
 * it: it names the single machine that holds the shop's offline authority, and
 * the only thing anybody does with that knowledge is move it.
 */
export class ManageDevicesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly devices: DeviceRepository,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async list(ctx: TenantContext, callerPublicKey: string | null): Promise<DeviceListResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.DEVICE_APPROVE);
      const rows = await this.devices.list(tx, ctx);
      const writer = rows.find((row) => occupiesWriterSlot(row.status)) ?? null;
      return {
        devices: rows.map((row) => toDeviceResponse(row, callerPublicKey)),
        activeDeviceId: writer?.id ?? null,
      };
    });
  }

  /** Approve a waiting machine, naming it as it is approved. */
  async approve(command: {
    readonly ctx: TenantContext;
    readonly deviceId: string;
    readonly name: string;
    readonly callerPublicKey: string | null;
  }): Promise<DeviceResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.DEVICE_APPROVE);
      const device = await this.load(tx, ctx, command.deviceId);

      const writer = await this.devices.findWriter(tx, ctx);
      if (writer !== null && writer.id !== device.id) {
        /*
         * The slot is single-occupancy, so this is not a failure to be retried
         * — it is the hand-over decision, and it belongs in Replace Writer
         * where the old machine's fate is decided deliberately.
         */
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `${writer.name} is the offline computer. Replace it to move offline permission.`,
          { reason: 'WRITER_SLOT_TAKEN', deviceName: writer.name, deviceId: writer.id },
        );
      }

      await this.move(tx, ctx, device, 'APPROVE', { name: command.name });
      return toDeviceResponse(
        await this.load(tx, ctx, device.id),
        command.callerPublicKey,
      );
    });
  }

  /**
   * Who may sign in on this machine while it cannot reach the server (§9).
   *
   * Behind `offline.device.approve`, the same permission that decides which
   * machine is the offline computer at all — the two questions are one decision
   * about how the shop trades in an outage, and splitting them would let a
   * manager choose the machine and not the people on it.
   */
  async offlineUsers(ctx: TenantContext, deviceId: string): Promise<DeviceUsersResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.DEVICE_APPROVE);
      await this.load(tx, ctx, deviceId);
      return {
        users: [...(await this.devices.listDeviceUsers(tx, ctx, deviceId))],
        candidates: (await this.users.list(tx, ctx))
          .filter((user) => !user.disabled)
          .map((user) => ({
            userId: user.id,
            displayName: user.displayName,
            hasPin: user.hasPin,
          })),
      };
    });
  }

  async setOfflineUsers(command: {
    readonly ctx: TenantContext;
    readonly deviceId: string;
    readonly userIds: readonly string[];
  }): Promise<DeviceUsersResponse> {
    const { ctx } = command;
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.DEVICE_APPROVE);
      const device = await this.load(tx, ctx, command.deviceId);
      const before = await this.devices.listDeviceUsers(tx, ctx, device.id);

      await this.devices.setDeviceUsers(
        tx,
        ctx,
        device.id,
        command.userIds,
        command.userIds.map(() => Ulid.generate(this.clock)),
        this.clock.now(),
      );

      await this.audit.append(tx, ctx, {
        entityType: 'device_authorization',
        entityId: device.id,
        action: 'SET_OFFLINE_USERS',
        before: { users: before.map((row) => row.displayName).join(', ') },
        after: { count: command.userIds.length },
        source: 'API',
      });

      return {
        users: [...(await this.devices.listDeviceUsers(tx, ctx, device.id))],
        candidates: (await this.users.list(tx, ctx))
          .filter((user) => !user.disabled)
          .map((user) => ({
            userId: user.id,
            displayName: user.displayName,
            hasPin: user.hasPin,
          })),
      };
    });
  }

  async rename(command: {
    readonly ctx: TenantContext;
    readonly deviceId: string;
    readonly name: string;
    readonly callerPublicKey: string | null;
  }): Promise<DeviceResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.DEVICE_RENAME);
      const device = await this.load(tx, ctx, command.deviceId);
      await this.devices.rename(tx, ctx, device.id, command.name);
      await this.audit.append(tx, ctx, {
        entityType: 'device_authorization',
        entityId: device.id,
        action: 'UPDATE',
        before: { name: device.name },
        after: { name: command.name },
        source: 'API',
      });
      return toDeviceResponse(await this.load(tx, ctx, device.id), command.callerPublicKey);
    });
  }

  /**
   * A normal revoke: the machine goes to `DRAINING`.
   *
   * It takes no new offline work from that moment, and it keeps the right to
   * send up what it already holds. It reaches `REVOKED` when it has nothing
   * left — in this module that is the moment it is marked drained, because
   * there is no outbox yet to be empty; the sync phase makes the same call when
   * the last operation lands.
   */
  async revoke(command: {
    readonly ctx: TenantContext;
    readonly deviceId: string;
    readonly callerPublicKey: string | null;
  }): Promise<DeviceResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.DEVICE_REVOKE);
      const device = await this.load(tx, ctx, command.deviceId);
      await this.move(tx, ctx, device, 'REVOKE', {});
      return toDeviceResponse(await this.load(tx, ctx, device.id), command.callerPublicKey);
    });
  }

  /**
   * Cut a machine off without letting it drain — the Owner's act alone.
   *
   * Password and reason are both demanded before anything moves, in that order,
   * because a refusal after the state changed would be the worst of both.
   */
  async forceRevoke(command: {
    readonly ctx: TenantContext;
    readonly deviceId: string;
    readonly password: string;
    readonly reason: string;
    readonly callerPublicKey: string | null;
  }): Promise<DeviceResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.DEVICE_FORCE_REVOKE);
      await this.stepUp(tx, ctx, command.password);
      const device = await this.load(tx, ctx, command.deviceId);
      await this.move(tx, ctx, device, 'FORCE_REVOKE', { reason: command.reason });
      return toDeviceResponse(await this.load(tx, ctx, device.id), command.callerPublicKey);
    });
  }

  /**
   * Replace Writer — the whole hand-over as one act (owner decision
   * 2026-08-31).
   *
   * This is the ordinary path, not the exotic one: clearing site data on the
   * counter PC gives that browser a new keypair, so the same physical machine
   * comes back as a new device while the old record still holds the slot. Two
   * separate steps would mean a shopkeeper had to work out that the machine in
   * front of them is being blocked by a machine that no longer exists.
   *
   * Which route it takes is the old machine's business, not a preference:
   *
   * - **DRAIN** — the old machine can still speak. Owner or Manager, no
   *   password, nothing lost: it drains and the new one takes over.
   * - **FORCE** — the old machine is gone, dead or stolen. Owner only, password
   *   re-entered, a reason required, and everything the old machine pushes from
   *   then on is quarantined.
   *
   * Both halves land in one transaction. A hand-over that half-happened would
   * leave the shop with either two writers or none.
   */
  async replaceWriter(command: {
    readonly ctx: TenantContext;
    readonly deviceId: string;
    readonly name: string;
    readonly forceOldDevice: boolean;
    readonly password?: string | undefined;
    readonly reason?: string | undefined;
    readonly callerPublicKey: string | null;
  }): Promise<DeviceResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.DEVICE_APPROVE);

      const incoming = await this.load(tx, ctx, command.deviceId);
      const current = await this.devices.findWriter(tx, ctx);

      if (current !== null && current.id === incoming.id) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'That computer is already the offline computer',
        );
      }

      const route = replacementRoute(current?.status ?? null, !command.forceOldDevice);

      if (route === 'FORCE') {
        // The force route is the owner's alone, whatever the caller may do to a
        // draining machine. Checked before anything is written.
        await this.access.require(tx, ctx, Permission.DEVICE_FORCE_REVOKE);
        const reason = command.reason?.trim() ?? '';
        if (command.password === undefined || command.password === '' || reason.length < 3) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'Cutting the old computer off needs your password and a reason',
          );
        }
        await this.stepUp(tx, ctx, command.password);
        if (current !== null) {
          await this.move(tx, ctx, current, 'FORCE_REVOKE', { reason });
        }
      } else if (route === 'DRAIN' && current !== null) {
        await this.move(tx, ctx, current, 'REVOKE', {});
        /*
         * Marked drained in the same breath, because in 12.1 there is no outbox
         * for it to still be holding. When the sync engine lands, the drained
         * step moves to where the last operation is pushed and this call goes.
         */
        const draining = await this.load(tx, ctx, current.id);
        await this.move(tx, ctx, draining, 'DRAINED', {});
      }

      const ready = await this.load(tx, ctx, incoming.id);
      // A machine that had been revoked or cut off has to ask again before it
      // can be approved — the state machine says so, and the audit trail then
      // shows the asking as well as the granting.
      const asked =
        ready.status === 'PENDING' ? ready : await this.reask(tx, ctx, ready);
      await this.move(tx, ctx, asked, 'APPROVE', { name: command.name });

      return toDeviceResponse(await this.load(tx, ctx, incoming.id), command.callerPublicKey);
    });
  }

  /** Re-enter the password. Never the PIN — see the contract's note. */
  private async stepUp(tx: Tx, ctx: TenantContext, password: string): Promise<void> {
    const stored = await this.users.findCredentials(tx, ctx, ctx.userId);
    const hash = stored?.passwordHash ?? null;
    if (hash === null || !(await this.hasher.verify(password, hash))) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That password is not right');
    }
  }

  private async reask(tx: Tx, ctx: TenantContext, device: DeviceRow): Promise<DeviceRow> {
    const transition: DeviceTransition = device.status === 'REGISTERED' ? 'REQUEST' : 'REREQUEST';
    await this.move(tx, ctx, device, transition, {});
    return this.load(tx, ctx, device.id);
  }

  /**
   * One legal state change, audited.
   *
   * The domain decides whether the move is allowed; this turns a refusal into
   * the sentence a shopkeeper reads, and writes the trail §5.23 requires on
   * every state change — actor and reason included.
   */
  private async move(
    tx: Tx,
    ctx: TenantContext,
    device: DeviceRow,
    transition: DeviceTransition,
    extra: { readonly name?: string; readonly reason?: string },
  ): Promise<void> {
    const target = nextStatus(device.status, transition);
    if (target === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `${device.name} cannot do that from where it is now`,
        { reason: 'ILLEGAL_TRANSITION', status: device.status, transition },
      );
    }

    await this.devices.changeStatus(tx, ctx, device.id, {
      status: target,
      at: this.clock.now(),
      reason: extra.reason ?? null,
      approved: transition === 'APPROVE',
      revoked: transition === 'REVOKE' || transition === 'FORCE_REVOKE',
    });
    if (extra.name !== undefined && extra.name !== device.name) {
      await this.devices.rename(tx, ctx, device.id, extra.name);
    }

    await this.audit.append(tx, ctx, {
      entityType: 'device_authorization',
      entityId: device.id,
      action: 'UPDATE',
      before: { status: device.status, name: device.name },
      after: { status: target, name: extra.name ?? device.name },
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      source: 'API',
    });
  }

  private async load(tx: Tx, ctx: TenantContext, deviceId: string): Promise<DeviceRow> {
    const row = await this.devices.findById(tx, ctx, deviceId);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'That computer is not registered');
    return row;
  }
}
