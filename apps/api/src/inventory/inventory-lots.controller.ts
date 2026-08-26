import { Body, Controller, Get, HttpCode, Inject, Param, Put, Query, UseGuards } from '@nestjs/common';
import type { InventoryLotPage } from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  inventoryLotsQuerySchema,
  setLotExpiryRequestSchema,
} from '@sher/core-contracts';
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

  /**
   * Set or correct one batch's expiry date (§5.13).
   *
   * A `PUT` on the batch rather than a `PATCH` on the product: the date belongs
   * to that lot, and two people dating two different batches of the same
   * product are not editing the same thing.
   */
  @Put(':id/expiry')
  @HttpCode(204)
  async setExpiry(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<void> {
    const parsed = setLotExpiryRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid expiry date');
    await this.inventory.setLotExpiry({ ctx, lotId: id, expiryDate: parsed.data.expiryDate });
  }
}
