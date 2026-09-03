import { Body, Controller, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ControlError, ControlErrorCode } from '../common/errors';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { TenantsService } from './tenants.service';
import { TENANTS_SERVICE } from '../tokens';

const tenantSchema = z
  .object({
    name: z.string().min(1).max(200),
    contactName: z.string().max(120).default(''),
    contactPhone: z.string().max(60).default(''),
    contactEmail: z.string().max(200).default(''),
    notes: z.string().max(5000).default(''),
  })
  .strict();

@Controller('api/control/tenants')
@UseGuards(OperatorGuard)
export class TenantsController {
  constructor(@Inject(TENANTS_SERVICE) private readonly tenants: TenantsService) {}

  @Get()
  @RequirePermission('tenant.view')
  async list(): Promise<unknown> {
    return { tenants: await this.tenants.list() };
  }

  @Get(':id')
  @RequirePermission('tenant.view')
  async get(@Param('id') id: string): Promise<unknown> {
    return this.tenants.get(id);
  }

  @Post()
  @RequirePermission('tenant.manage')
  async create(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    const parsed = tenantSchema.safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'A business name is required');
    return this.tenants.create(parsed.data, operator);
  }

  @Put(':id')
  @RequirePermission('tenant.manage')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Operator() operator: OperatorPrincipal,
  ): Promise<unknown> {
    const parsed = tenantSchema.safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'A business name is required');
    return this.tenants.update(id, parsed.data, operator);
  }
}
