import { Inject, Injectable } from '@nestjs/common';
import type { DeviceRepository, TenantContext, UnitOfWork } from '@sher/core-application';

import { DEVICE_REPOSITORY, UNIT_OF_WORK } from '../infrastructure/tokens';

/**
 * Which machine a request came from, in the one form document numbering needs
 * (Phase 12.4, §8).
 *
 * A sale is numbered `S-2026-A-000123`, and `A` is the browser profile that
 * typed it. The profile proves who it is with the same `x-device-key` header
 * every offline endpoint already uses — a public key whose private half never
 * leaves that profile (D-01) — so this is a lookup, not a claim a client makes
 * about itself. R-C4: the device is resolved from a verified identity, never
 * taken from a request body.
 *
 * **Cached for the life of the process, and safely so.** A device code is
 * assigned once at registration and never changes or is reused, so a cached
 * answer cannot go stale. An unregistered browser resolves to nothing, which
 * numbering reads as the shop's own central counter (`0`).
 */
@Injectable()
export class DeviceCodeResolver {
  private readonly cache = new Map<string, string | null>();

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
  ) {}

  /**
   * The caller's own context, plus the machine they are sitting at.
   *
   * Returns it unchanged when there is no key or no such device — the ordinary
   * case for a phone, a manager's laptop, or anything that never asked to work
   * offline.
   */
  async withDevice(ctx: TenantContext, deviceKey: string | undefined): Promise<TenantContext> {
    if (deviceKey === undefined || deviceKey === '') return ctx;

    const cacheKey = `${ctx.tenantId}:${deviceKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached === null ? ctx : { ...ctx, deviceCode: cached };
    }

    const code = await this.uow.run(ctx, async (tx) => {
      const device = await this.devices.findByPublicKey(tx, ctx, deviceKey);
      return device?.deviceCode ?? null;
    });
    this.cache.set(cacheKey, code);
    return code === null ? ctx : { ...ctx, deviceCode: code };
  }
}
