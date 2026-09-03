import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { Clock } from '@sher/shared-utils';
import { z } from 'zod';

import type { CommandsService } from '../commands/commands.service';
import { CONTROL_CLOCK } from '../db/tokens';
import { ControlError, ControlErrorCode } from '../common/errors';
import type { DiagnosticsService } from '../diagnostics/diagnostics.service';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { SupportService } from '../support/support.service';
import type { InstallationsService } from './installations.service';
import { COMMANDS_SERVICE, DIAGNOSTICS_SERVICE, INSTALLATIONS_SERVICE, SUPPORT_SERVICE } from '../tokens';

const createSchema = z
  .object({
    tenantId: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    deploymentUrl: z.string().max(300).default(''),
  })
  .strict();

const reasonSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

/**
 * The fleet, as an operator sees it, plus the five actions §25 asks for on an
 * installation: refresh licence, collect diagnostics, deploy, back up, and open
 * support.
 *
 * Four of the five are the same shape — queue a signed command and let the
 * sidecar do the work — which is deliberate. Every remote action in this system
 * is a command from the enumerated list in `commandTypeSchema`; there is no
 * second mechanism, no direct call into a shop, and therefore no capability
 * that exists without a name.
 */
@Controller('api/control/installations')
@UseGuards(OperatorGuard)
export class InstallationsController {
  constructor(
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
    @Inject(INSTALLATIONS_SERVICE) private readonly installations: InstallationsService,
    @Inject(COMMANDS_SERVICE) private readonly commands: CommandsService,
    @Inject(DIAGNOSTICS_SERVICE) private readonly diagnostics: DiagnosticsService,
    @Inject(SUPPORT_SERVICE) private readonly support: SupportService,
  ) {}

  @Get()
  @RequirePermission('installation.view')
  async list(@Query('tenantId') tenantId?: string): Promise<unknown> {
    return { installations: await this.installations.list(tenantId) };
  }

  @Get(':id')
  @RequirePermission('installation.view')
  async get(@Param('id') id: string): Promise<unknown> {
    const installation = await this.installations.get(id);
    return {
      installation,
      commands: await this.commands.listFor(id, 25),
      diagnostics: await this.diagnostics.listFor(id, 100),
      supportHistory: await this.support.listFor(id),
    };
  }

  @Post()
  @RequirePermission('installation.enrol')
  async create(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'A customer and a label');
    return this.installations.create(parsed.data, operator);
  }

  /** Shown once, in the dashboard. Only its hash is kept. */
  @Post(':id/enrolment-token')
  @RequirePermission('installation.enrol')
  async enrolmentToken(@Param('id') id: string, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    return this.installations.issueEnrolmentToken(id, operator);
  }

  @Post(':id/revoke')
  @RequirePermission('installation.revoke')
  async revoke(
    @Param('id') id: string,
    @Body() body: unknown,
    @Operator() operator: OperatorPrincipal,
  ): Promise<{ ok: true }> {
    const parsed = reasonSchema.safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'A reason is required');
    await this.installations.revoke(id, parsed.data.reason, operator);
    return { ok: true };
  }

  /**
   * Collect diagnostics, health-check, back up, check for update.
   *
   * Each is one enumerated command type and nothing more. The idempotency key
   * includes the minute, so a double click queues one command while a
   * deliberate retry ten minutes later queues a fresh one — the middle ground
   * between "every click is a new job" and "you can only ever ask once".
   */
  @Post(':id/command/:type')
  @RequirePermission('installation.view')
  async runCommand(
    @Param('id') id: string,
    @Param('type') type: string,
    @Operator() operator: OperatorPrincipal,
  ): Promise<unknown> {
    const allowed = ['COLLECT_DIAGNOSTICS', 'HEALTH_CHECK', 'CREATE_BACKUP', 'CHECK_FOR_UPDATE'] as const;
    const chosen = allowed.find((candidate) => candidate === type);
    if (chosen === undefined) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'That is not an action you can ask for here');
    }
    const installation = await this.installations.get(id);
    const minute = this.clock.now().toISOString().slice(0, 16);
    return this.commands.enqueue({
      tenantId: installation.tenantId,
      installationId: id,
      type: chosen,
      payload: {},
      idempotencyKey: `${chosen}:${minute}`,
      createdBy: operator.id,
    });
  }
}
