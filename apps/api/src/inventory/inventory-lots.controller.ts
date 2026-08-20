import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import type { InventoryLotPage } from '@sher/core-contracts';
import { AppError, ErrorCode, inventoryLotsQuerySchema } from '@sher/core-contracts';
import type { ManageInventoryService, TenantContext } from '@sher/core-application';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_INVENTORY_SERVICE } from './tokens';

@Controller('api/v1/inventory/lots')
@UseGuards(TenantContextGuard)
export class InventoryLotsController {
  constructor(@Inject(MANAGE_INVENTORY_SERVICE) private readonly inventory: ManageInventoryService) {}

  @Get()
  async list(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: InventoryLotPage }> {
    const parsed = inventoryLotsQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid lot filters');
    return { data: await this.inventory.lots(ctx, parsed.data) };
  }
}
