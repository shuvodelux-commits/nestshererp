import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  checkInRequestSchema,
  commandResultSchema,
  diagnosticsUploadSchema,
  enrolmentRequestSchema,
} from '@sher/control-contracts';
import type { Request } from 'express';

import { ControlError, ControlErrorCode } from '../common/errors';
import type { CommandsService } from '../commands/commands.service';
import type { DeploymentsService } from '../deployments/deployments.service';
import type { DiagnosticsService } from '../diagnostics/diagnostics.service';
import { Agent, AgentAuthGuard } from './agent-auth.guard';
import type { AgentPrincipal } from './agent-auth.guard';
import type { InstallationsService } from './installations.service';
import { COMMANDS_SERVICE, DEPLOYMENTS_SERVICE, DIAGNOSTICS_SERVICE, INSTALLATIONS_SERVICE } from '../tokens';

/**
 * The wire a customer installation speaks — the only one it ever speaks.
 *
 * **Every route here is outbound-initiated** (§1, §16). The control plane never
 * dials a shop: it answers. That is what removes the need for port forwarding,
 * a public URL or an inbound firewall hole on a shop's router, and it is why a
 * customer behind NAT is supportable at all.
 *
 * Except for `enrol`, which presents a one-time token, every route is behind
 * `AgentAuthGuard` — signed, bound to one installation, replay-protected and
 * clock-bounded. Nothing an installation sends is taken on trust because it
 * arrived on a particular connection.
 */
/**
 * How soon a machine comes back after being handed work.
 *
 * Ten seconds: long enough not to be a busy loop, short enough that an operator
 * who has just opened a support session sees the tunnel come up while they are
 * still looking at the screen.
 */
const FOLLOW_UP_SECONDS = 10;

@Controller('api/agent')
export class AgentController {
  constructor(
    @Inject(INSTALLATIONS_SERVICE) private readonly installations: InstallationsService,
    @Inject(COMMANDS_SERVICE) private readonly commands: CommandsService,
    @Inject(DIAGNOSTICS_SERVICE) private readonly diagnostics: DiagnosticsService,
    @Inject(DEPLOYMENTS_SERVICE) private readonly deployments: DeploymentsService,
  ) {}

  /**
   * The first handshake. Trusted only because of the one-time token, and only
   * once — the token is burned inside the same transaction that stores the key.
   */
  @Post('enrol')
  async enrol(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const parsed = enrolmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'That enrolment request is not valid');
    }
    const result = await this.installations.enrol(
      parsed.data,
      String(request.headers['x-forwarded-for'] ?? request.ip ?? ''),
    );
    return {
      tenant_id: result.tenantId,
      installation_id: result.installationId,
      command_public_key: result.commandPublicKey,
      command_signing_key_id: result.commandSigningKeyId,
      checkin_interval_seconds: result.checkinIntervalSeconds,
    };
  }

  /**
   * The heartbeat, and the delivery mechanism for pending work (§6).
   *
   * One round trip does both because the alternative — a separate poll for
   * commands — doubles the traffic from every shop for no gain, and because
   * commands riding the response is what keeps the channel purely outbound.
   */
  @Post('checkin')
  @UseGuards(AgentAuthGuard)
  async checkIn(@Body() body: unknown, @Agent() agent: AgentPrincipal): Promise<unknown> {
    const parsed = checkInRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'That check-in is not valid');
    }
    /*
     * The report names its own tenant and installation, and both must match the
     * signed identity. A machine may only ever describe itself — otherwise a
     * single compromised shop could rewrite the fleet's view of every other.
     */
    if (
      parsed.data.installation_id !== agent.installationId ||
      parsed.data.tenant_id !== agent.tenantId
    ) {
      throw new ControlError(ControlErrorCode.AGENT_UNAUTHENTICATED, 'Identity mismatch');
    }

    await this.installations.recordCheckIn(agent.installationId, parsed.data);
    const commands = await this.commands.pendingFor(agent.installationId);

    /*
     * How soon to come back.
     *
     * A shop with nothing to do checks in on its ordinary interval — three
     * minutes by default, and there is no reason to make a fleet of two hundred
     * machines chattier than that. But a machine that has just been handed work
     * comes back quickly, because on the other end of every command is either
     * an operator watching a screen or a rollout waiting on a result. Three
     * minutes of silence after clicking "Start support session" reads as broken
     * even when it is working perfectly.
     */
    const revoked = await this.installations.isRevoked(agent.installationId);
    return {
      commands,
      next_checkin_seconds: commands.length > 0 ? FOLLOW_UP_SECONDS : await this.installations.checkInIntervalOf(agent.installationId),
      revoked,
    };
  }

  /** What became of a command. Terminal results are never overwritten (§18). */
  @Post('command-result')
  @UseGuards(AgentAuthGuard)
  async commandResult(@Body() body: unknown, @Agent() agent: AgentPrincipal): Promise<{ ok: true }> {
    const parsed = commandResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'That result is not valid');
    }
    await this.commands.recordResult(agent.installationId, parsed.data);
    await this.deployments.onCommandResult(agent.installationId, parsed.data);
    return { ok: true };
  }

  /** Sanitized error events (§7). Rejected outright if they carry free text. */
  @Post('diagnostics')
  @UseGuards(AgentAuthGuard)
  async uploadDiagnostics(@Body() body: unknown, @Agent() agent: AgentPrincipal): Promise<{ ok: true }> {
    const parsed = diagnosticsUploadSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Those diagnostics are not valid');
    }
    await this.diagnostics.record(agent.installationId, parsed.data.events);
    return { ok: true };
  }

  /**
   * A deployment stage transition (§10: "report every stage to the control
   * plane").
   *
   * Separate from `command-result` because a deployment reports many times
   * before it finishes, and an operator watching a rollout needs to see
   * `MIGRATING` while it is migrating rather than silence until it is over.
   */
  @Post('deployment-stage')
  @UseGuards(AgentAuthGuard)
  async deploymentStage(@Body() body: unknown, @Agent() agent: AgentPrincipal): Promise<{ ok: true }> {
    await this.deployments.recordStage(agent.installationId, body);
    return { ok: true };
  }
}
