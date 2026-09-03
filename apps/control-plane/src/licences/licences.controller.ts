import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ControlError, ControlErrorCode } from '../common/errors';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { LicencesService } from './licences.service';
import { LICENCES_SERVICE } from '../tokens';

const issueSchema = z
  .object({
    tenantId: z.string().min(1).max(64),
    /** Null issues a licence for hand delivery — the offline path stays open. */
    installationId: z.string().min(1).max(64).nullable().default(null),
    validUntil: z.string().datetime({ offset: true }),
    modules: z.array(z.string().max(64)).default([]),
    replacementOf: z.string().max(64).nullable().default(null),
    reason: z.string().min(3).max(500),
  })
  .strict();

@Controller('api/control/licences')
@UseGuards(OperatorGuard)
export class LicencesController {
  constructor(@Inject(LICENCES_SERVICE) private readonly licences: LicencesService) {}

  @Get()
  @RequirePermission('licence.view')
  async list(@Query('tenantId') tenantId: string): Promise<unknown> {
    return { licences: await this.licences.listFor(tenantId) };
  }

  @Get('expiring')
  @RequirePermission('licence.view')
  async expiring(): Promise<unknown> {
    return { licences: await this.licences.expiringSoon(30) };
  }

  /** Issue, renew and reissue are the same operation with different dates (§4). */
  @Post()
  @RequirePermission('licence.issue')
  async issue(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    const parsed = issueSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(
        ControlErrorCode.VALIDATION_FAILED,
        'A customer, an expiry date and a reason are required',
      );
    }
    return this.licences.issue(parsed.data, operator);
  }

  /** Re-sends an already-signed licence — after a machine was rebuilt, say. */
  @Post(':id/deliver/:installationId')
  @RequirePermission('licence.issue')
  async deliver(
    @Param('id') id: string,
    @Param('installationId') installationId: string,
    @Operator() operator: OperatorPrincipal,
  ): Promise<{ ok: true }> {
    await this.licences.deliver(id, installationId, operator);
    return { ok: true };
  }

  @Post(':id/revoke')
  @RequirePermission('licence.revoke')
  async revoke(
    @Param('id') id: string,
    @Body() body: unknown,
    @Operator() operator: OperatorPrincipal,
  ): Promise<{ ok: true }> {
    const parsed = z.object({ reason: z.string().min(3).max(500) }).strict().safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'A reason is required');
    await this.licences.revoke(id, parsed.data.reason, operator);
    return { ok: true };
  }
}
