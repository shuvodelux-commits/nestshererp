import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { InventoryValuationResponse } from '@sher/core-contracts';
import type { ManageInventoryService, TenantContext } from '@sher/core-application';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_INVENTORY_SERVICE } from './tokens';

@Controller('api/v1/inventory/valuation')
@UseGuards(TenantContextGuard)
export class InventoryValuationController {
  constructor(@Inject(MANAGE_INVENTORY_SERVICE) private readonly inventory: ManageInventoryService) {}

  @Get()
  async get(@Ctx() ctx: TenantContext): Promise<{ data: InventoryValuationResponse }> {
    return { data: await this.inventory.valuation(ctx) };
  }
}
