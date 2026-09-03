import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ControlError, ControlErrorCode } from '../common/errors';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { FlagsService } from './flags.service';
import { FLAGS_SERVICE } from '../tokens';

@Controller('api/control/feature-flags')
@UseGuards(OperatorGuard)
export class FlagsController {
  constructor(@Inject(FLAGS_SERVICE) private readonly flags: FlagsService) {}

  @Get()
  @RequirePermission('installation.view')
  async list(@Query('installationId') installationId?: string): Promise<unknown> {
    return { flags: await this.flags.list(installationId ?? null) };
  }

  @Post()
  @RequirePermission('flags.manage')
  async set(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<{ ok: true }> {
    const parsed = z
      .object({
        installationId: z.string().min(1).max(64).nullable().default(null),
        key: z.string().min(1).max(64),
        enabled: z.boolean(),
        reason: z.string().max(500).default(''),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Which flag, on or off?');
    await this.flags.set(parsed.data, operator);
    return { ok: true };
  }
}
