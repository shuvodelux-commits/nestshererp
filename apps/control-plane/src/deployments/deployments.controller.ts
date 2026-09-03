import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ControlError, ControlErrorCode } from '../common/errors';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { DeploymentsService } from './deployments.service';
import { DEPLOYMENTS_SERVICE } from '../tokens';

const jobSchema = z
  .object({
    releaseId: z.string().min(1).max(64),
    installationIds: z.array(z.string().min(1).max(64)).default([]),
    strategy: z.enum(['SINGLE', 'SELECTED', 'STAGED', 'ALL_ELIGIBLE']),
    /** How many go first in a staged rollout. §10's pilot. */
    pilotCount: z.number().int().min(1).max(50).default(1),
    reason: z.string().min(3).max(500),
  })
  .strict();

@Controller('api/control/deployments')
@UseGuards(OperatorGuard)
export class DeploymentsController {
  constructor(@Inject(DEPLOYMENTS_SERVICE) private readonly deployments: DeploymentsService) {}

  @Get()
  @RequirePermission('deployment.view')
  async list(): Promise<unknown> {
    return { jobs: await this.deployments.listJobs() };
  }

  @Get(':id')
  @RequirePermission('deployment.view')
  async get(@Param('id') id: string): Promise<unknown> {
    return { job: await this.deployments.job(id), targets: await this.deployments.targetsOf(id) };
  }

  @Post()
  @RequirePermission('deployment.run')
  async create(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    const parsed = jobSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Choose a release, targets and a reason');
    }
    return this.deployments.createJob(parsed.data, operator);
  }

  /** The next wave of a staged rollout. Refused while the job is halted (§11). */
  @Post(':id/advance')
  @RequirePermission('deployment.run')
  async advance(
    @Param('id') id: string,
    @Body() body: unknown,
    @Operator() operator: OperatorPrincipal,
  ): Promise<unknown> {
    const parsed = z.object({ count: z.number().int().min(1).max(200).default(5) }).strict().safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'How many?');
    return { dispatched: await this.deployments.advance(id, parsed.data.count, operator) };
  }

  @Post(':id/clear-halt')
  @RequirePermission('deployment.run')
  async clearHalt(
    @Param('id') id: string,
    @Body() body: unknown,
    @Operator() operator: OperatorPrincipal,
  ): Promise<{ ok: true }> {
    const parsed = z.object({ reason: z.string().min(3).max(500) }).strict().safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Say what you found before continuing');
    }
    await this.deployments.clearHalt(id, parsed.data.reason, operator);
    return { ok: true };
  }
}
