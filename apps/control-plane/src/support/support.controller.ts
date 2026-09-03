import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ControlError, ControlErrorCode } from '../common/errors';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { SupportService } from './support.service';
import type { TunnelRegistry } from './tunnel-registry';
import { SUPPORT_SERVICE, TUNNEL_REGISTRY } from '../tokens';

const openSchema = z
  .object({
    installationId: z.string().min(1).max(64),
    /** Mandatory, and it travels inside the signed grant (§12). */
    reason: z.string().min(3).max(500),
  })
  .strict();

@Controller('api/control/support-sessions')
@UseGuards(OperatorGuard)
export class SupportController {
  constructor(
    @Inject(SUPPORT_SERVICE) private readonly support: SupportService,
    @Inject(TUNNEL_REGISTRY) private readonly tunnel: TunnelRegistry,
  ) {}

  @Get()
  @RequirePermission('support.view')
  async listActive(): Promise<unknown> {
    const sessions = await this.support.listActive();
    return {
      sessions: sessions.map((session) => ({
        ...session,
        // Whether the shop is actually reachable right now, which is a
        // different question from whether the session record is open.
        connected: this.tunnel.isConnected(session.installationId),
      })),
    };
  }

  @Get(':id')
  @RequirePermission('support.view')
  async get(@Param('id') id: string): Promise<unknown> {
    return {
      session: await this.support.get(id),
      actions: await this.support.actionsOf(id),
      connected: this.tunnel.isConnected((await this.support.get(id)).installationId),
    };
  }

  @Post()
  @RequirePermission('support.open')
  async open(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    const parsed = openSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(
        ControlErrorCode.VALIDATION_FAILED,
        'Choose an installation and say why you are opening a session',
      );
    }
    const result = await this.support.open(parsed.data, operator);
    // The grant itself is not returned to the browser. It is a credential
    // inside the shop's ERP, and the console never needs to hold one: the
    // gateway attaches it server-side on every proxied request.
    return { session: result.session };
  }

  @Post(':id/close')
  @RequirePermission('support.open')
  async close(@Param('id') id: string, @Operator() operator: OperatorPrincipal): Promise<{ ok: true }> {
    await this.support.close(id, operator);
    const session = await this.support.get(id);
    this.tunnel.disconnect(session.installationId);
    return { ok: true };
  }

  /**
   * Revocation — the immediate one.
   *
   * Three things happen and all three matter: the record is closed, the tunnel
   * is dropped so an in-flight request cannot complete, and a signed terminate
   * command is queued so the installation stops honouring the grant even if it
   * reconnects. The grant's own short expiry covers the case where the shop is
   * offline and never receives the command.
   */
  @Post(':id/revoke')
  @RequirePermission('support.revoke')
  async revoke(
    @Param('id') id: string,
    @Body() body: unknown,
    @Operator() operator: OperatorPrincipal,
  ): Promise<{ ok: true }> {
    const parsed = z.object({ reason: z.string().min(3).max(500) }).strict().safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'A reason is required');
    const session = await this.support.get(id);
    await this.support.revoke(id, parsed.data.reason, operator);
    this.tunnel.disconnect(session.installationId);
    return { ok: true };
  }
}
